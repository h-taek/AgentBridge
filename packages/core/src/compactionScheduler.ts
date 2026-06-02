// turns.jsonl이 threshold를 넘으면 oldest 청크를 refine → IR로 흡수하고 turns.jsonl을 rewrite한다.
//
// 호스트 차이 흡수:
//   - workspaceRoot: 호스트가 계산해 전달 (.agentbridge/workspaces/<id>)
//   - Notifications: 호스트별 UI (VS Code window.show* / Electron 알림창) 인터페이스로 주입
//   - refineOrder: 호스트가 settings에서 refinePolicy 해석해 전달
//   - envProbe, gitProbe: 호스트가 인스턴스/콜백 전달

import { EventEmitter } from 'events';
import type { CliKind } from './shared/cli';
import type { IR } from './shared/ir';
import type { TurnRecord } from './shared/turns';
import { COMPACTION_TRIGGER } from './shared/turns';
import {
  readAllTurns,
  rewriteTurns,
  stageCompactedTurns,
  commitArchive,
  abortArchive,
  sumBytes,
  type StagedArchive,
} from './turnsStore';
import { buildCompactionPrompt } from './irModule/prompt';
import { parseRefineOutput, assembleIR, type GitInfo } from './irModule/parse';
import { readIR, writeIR } from './irStore';
import {
  runRefine,
  RefineOffError,
  type RefineDecision,
  type RefineAttemptEvent,
} from './refineDispatcher';
import type { EnvProbe } from './envProbe';
import type { Logger } from './interfaces';
import { noopLogger } from './interfaces';
import type { WorkspaceStore } from './workspaceStore';

const COMPACTION_TIMEOUT_MS = 60_000;
const LOCK_STALE_MS = 5 * 60 * 1000;

export interface CompactionNotifications {
  notifyRefineOff(): void;
  notifyRefineFailed(message: string): void;
  notifyRefineFallback(
    triedCli: CliKind | string,
    spawnedModel: CliKind,
    reason: 'unavailable' | 'quota' | 'spawn-error',
  ): void;
}

export type CompactionSchedulerOptions = {
  notifications: CompactionNotifications;
  envProbe: EnvProbe;
  // workspace.json 갱신을 single SSOT(WorkspaceStore)로 일원화 — compactionInProgress 마킹도
  // updateWorkspaceMeta로 처리해 다른 메타 변경과 같은 락 안에서 직렬화됨.
  workspaceStore: WorkspaceStore;
  // 호스트가 cwd를 받아 git 정보 반환. 미제공 시 IR.meta의 gitBranch/gitHead는 undefined.
  gitProbe?: (cwd: string) => Promise<GitInfo>;
  // 호스트가 settings를 보고 refine 정책을 결정. policy: 'off'면 RefineOffError.
  resolveRefineDecision: (activeModel: CliKind) => RefineDecision;
  // refine attempt별 호스트 부가효과 hook — quota 추적(markForcedFallback) / PTY probe 트리거 등.
  // runRefine onAttempt로 그대로 전달됨. 미제공 시 부가효과 없음.
  onRefineAttempt?: (event: RefineAttemptEvent) => void | Promise<void>;
  logger?: Logger;
  // 압축 아카이브 최대 보관 개수 (turnsStore.commitArchive에 전달).
  maxArchiveSnapshots: number;
  // ir:updated / turns:updated 이벤트를 발행할 EventEmitter (호스트가 구독).
  events?: EventEmitter;
};

// 사용자 명시 trigger(manual)의 풍부한 결과 객체. auto는 void 반환이라 진단 정보 없음.
// renderer가 표시하는 'IR 새로 정제' 모달이 이 결과를 받아 ok/error/raw 응답 노출.
export type ManualCompactionResult = {
  ok: boolean;
  error?: string;
  ir?: IR;
  rawAssistantText: string;
  durationMs: number;
  exitCode: number | null;
  stderr: string;
  rawLineCount: number;
};

export interface CompactionScheduler {
  readonly events: EventEmitter;
  acquireDiskLock(workspaceId: string): Promise<boolean>;
  releaseDiskLock(workspaceId: string): Promise<void>;
  markInFlight(workspaceId: string): boolean;
  unmarkInFlight(workspaceId: string): void;
  checkAndRun(args: {
    workspaceId: string;
    workspaceRoot: string;
    workspacePath: string; // 사용자의 프로젝트 cwd
    activeModel: CliKind;
  }): Promise<void>;
  // manual trigger — auto와 같은 락/2-phase commit 사용하되 trigger 조건 무시 + 모든 turn 처리.
  runManual(args: {
    workspaceId: string;
    workspaceRoot: string;
    workspacePath: string;
    activeModel: CliKind;
    timeoutMs?: number;
  }): Promise<ManualCompactionResult>;
}

export function createCompactionScheduler(
  opts: CompactionSchedulerOptions,
): CompactionScheduler {
  const log = opts.logger ?? noopLogger;
  const events = opts.events ?? new EventEmitter();
  const inFlight = new Set<string>();
  const workspaceStore = opts.workspaceStore;

  // disk lock — workspace.json의 compactionInProgress 필드로 표현. 갱신은 workspaceStore의
  // updateWorkspaceMeta(같은 in-memory mutex) 안에서 일어나 다른 메타 변경과 직렬화됨.
  async function acquireDiskLock(workspaceId: string): Promise<boolean> {
    try {
      const meta = await workspaceStore.loadWorkspace(workspaceId);
      const existing = meta.compactionInProgress;
      if (existing) {
        const age = Date.now() - existing.startedAt;
        if (age < LOCK_STALE_MS) return false;
        log.warn(
          `compaction: stale lock detected (age=${age}ms, pid=${existing.pid}) — overriding`,
        );
      }
      await workspaceStore.updateWorkspaceMeta(workspaceId, {
        compactionInProgress: { pid: process.pid, startedAt: Date.now() },
      });
      return true;
    } catch (err) {
      log.warn(
        `compaction: lock acquire failed — ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  async function releaseDiskLock(workspaceId: string): Promise<void> {
    try {
      const meta = await workspaceStore.loadWorkspace(workspaceId);
      if (meta.compactionInProgress?.pid === process.pid) {
        await workspaceStore.updateWorkspaceMeta(workspaceId, {
          compactionInProgress: null,
        });
      }
    } catch (err) {
      log.warn(
        `compaction: lock release failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  function shouldTrigger(turns: TurnRecord[]): boolean {
    if (turns.length >= COMPACTION_TRIGGER.countThreshold) return true;
    if (sumBytes(turns) >= COMPACTION_TRIGGER.bytesThreshold) return true;
    return false;
  }


  return {
    events,

    acquireDiskLock,
    releaseDiskLock,

    markInFlight(workspaceId) {
      if (inFlight.has(workspaceId)) return false;
      inFlight.add(workspaceId);
      return true;
    },

    unmarkInFlight(workspaceId) {
      inFlight.delete(workspaceId);
    },

    async checkAndRun(args) {
      const { workspaceId, workspaceRoot, workspacePath, activeModel } = args;
      if (!this.markInFlight(workspaceId)) return;
      let holdsDiskLock = false;
      try {
        const turns = await readAllTurns(workspaceRoot);
        if (!shouldTrigger(turns)) return;

        holdsDiskLock = await acquireDiskLock(workspaceId);
        if (!holdsDiskLock) {
          log.log(`compaction: another process holds the lock, skipping`);
          return;
        }

        const processCount = turns.length - COMPACTION_TRIGGER.keepRecent;
        if (processCount <= 0) return;

        const oldest = turns.slice(0, processCount);
        const remaining = turns.slice(processCount);
        const currentIR = await readIR(workspaceRoot);

        log.log(`compaction: starting (${turns.length} turns, processing ${processCount})`);

        const prompt = buildCompactionPrompt({
          fromModel: activeModel,
          workspacePath,
          turns: oldest,
          currentIR,
        });

        const decision = opts.resolveRefineDecision(activeModel);

        let dispatch;
        try {
          dispatch = await runRefine({
            decision,
            prompt,
            cwd: workspacePath,
            timeoutMs: COMPACTION_TIMEOUT_MS,
            envProbe: opts.envProbe,
            logger: log,
            onAttempt: opts.onRefineAttempt,
          });
        } catch (err) {
          if (err instanceof RefineOffError) {
            opts.notifications.notifyRefineOff();
            return;
          }
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`compaction: refine failed — ${msg}`);
          opts.notifications.notifyRefineFailed(msg);
          return;
        }

        if (dispatch.fallback && dispatch.fallbackReason) {
          const triedFirst = dispatch.triedCli[0] ?? 'previous CLI';
          opts.notifications.notifyRefineFallback(
            triedFirst,
            dispatch.spawnedModel,
            dispatch.fallbackReason,
          );
        }

        const refine = dispatch.result;
        log.log(
          `compaction: refine result — exit=${refine.exitCode} textLen=${refine.assistantText.length} stderr=${refine.stderr.slice(0, 200)}`,
        );
        if (refine.exitCode !== 0 && refine.assistantText.length === 0) {
          log.warn(`compaction: refine exit=${refine.exitCode}, empty response`);
          return;
        }

        const parsed = parseRefineOutput(refine.assistantText);
        if (!parsed.ok) {
          log.warn(`compaction: parse failed — ${parsed.error}`);
          log.warn(
            `compaction: raw response (first 500 chars): ${refine.assistantText.slice(0, 500)}`,
          );
          return;
        }

        const gitInfo = opts.gitProbe ? await opts.gitProbe(workspacePath) : undefined;
        const ir = assembleIR({
          contextId: workspaceId,
          body: parsed.body,
          fromModel: activeModel,
          workspacePath,
          previousIR: currentIR,
          gitInfo,
        });

        try {
          await writeIR(workspaceRoot, ir);
          log.log(`compaction: ir.json saved (intent.goal="${ir.intent.goal?.slice(0, 50)}")`);
        } catch (err) {
          log.warn(
            `compaction: ir.json write failed — ${err instanceof Error ? err.message : String(err)}`,
          );
          return;
        }

        // 2-phase commit. 첫 compaction(currentIR===null)일 때 archive 누락 이슈는 별도 리뷰에서 추적.
        let stagedArchive: StagedArchive | null = null;
        if (currentIR) {
          try {
            stagedArchive = await stageCompactedTurns(workspaceRoot, oldest, currentIR);
          } catch (err) {
            log.warn(
              `compaction: archive stage failed — ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        try {
          await rewriteTurns(workspaceRoot, remaining);
        } catch (err) {
          log.warn(
            `compaction: turns rewrite failed — ${err instanceof Error ? err.message : String(err)}`,
          );
          if (stagedArchive) await abortArchive(stagedArchive);
          return;
        }

        if (stagedArchive) {
          try {
            await commitArchive(stagedArchive, {
              maxArchiveSnapshots: opts.maxArchiveSnapshots,
              logger: log,
            });
          } catch (err) {
            log.warn(
              `compaction: archive commit failed — ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        log.log(
          `compaction: done (${dispatch.spawnedModel}, processed=${oldest.length}, kept=${remaining.length})`,
        );
        events.emit('ir:updated', workspaceId);
      } catch (err) {
        const msg = err instanceof Error ? err.stack ?? err.message : String(err);
        log.warn(`compaction: unexpected error — ${msg}`);
      } finally {
        if (holdsDiskLock) await releaseDiskLock(workspaceId);
        this.unmarkInFlight(workspaceId);
      }
    },

    async runManual(args): Promise<ManualCompactionResult> {
      const { workspaceId, workspaceRoot, workspacePath, activeModel } = args;
      const empty = (error?: string): ManualCompactionResult => ({
        ok: false,
        error,
        rawAssistantText: '',
        durationMs: 0,
        exitCode: null,
        stderr: '',
        rawLineCount: 0,
      });

      // 동시 호출 방어 — auto와 같은 inFlight + disk lock 채택. 데스크탑 옛 runManualCompaction의
      // 락 누락 버그를 통합 시점에 자동 수정.
      if (!this.markInFlight(workspaceId)) {
        return empty('이미 다른 compaction이 진행 중입니다');
      }
      let holdsDiskLock = false;
      try {
        const turns = await readAllTurns(workspaceRoot);
        if (turns.length === 0) {
          return empty('turns.jsonl이 비어있어 정제할 내용 없음');
        }

        holdsDiskLock = await acquireDiskLock(workspaceId);
        if (!holdsDiskLock) {
          return empty('다른 프로세스가 락을 잡고 있어 manual compaction 스킵');
        }

        const keep = COMPACTION_TRIGGER.keepRecent;
        const processCount = Math.max(turns.length - keep, 0);
        const oldest = turns.slice(0, processCount);
        const remaining = turns.slice(processCount);
        const currentIR = await readIR(workspaceRoot);

        const prompt = buildCompactionPrompt({
          fromModel: activeModel,
          workspacePath,
          // 처리 대상 0개여도 IR refine은 의미 있음 — 최근 raw로 IR 추출.
          turns: oldest.length > 0 ? oldest : remaining,
          currentIR,
        });

        const decision = opts.resolveRefineDecision(activeModel);

        let dispatch;
        try {
          dispatch = await runRefine({
            decision,
            prompt,
            cwd: workspacePath,
            timeoutMs: args.timeoutMs ?? COMPACTION_TIMEOUT_MS,
            envProbe: opts.envProbe,
            logger: log,
            onAttempt: opts.onRefineAttempt,
          });
        } catch (err) {
          if (err instanceof RefineOffError) {
            opts.notifications.notifyRefineOff();
            return empty("refine 비활성 (settings.refineModel='off')");
          }
          throw err;
        }

        if (dispatch.fallback && dispatch.fallbackReason) {
          const triedFirst = dispatch.triedCli[0] ?? 'previous CLI';
          opts.notifications.notifyRefineFallback(
            triedFirst,
            dispatch.spawnedModel,
            dispatch.fallbackReason,
          );
        }

        const refine = dispatch.result;
        if (refine.exitCode !== 0 && refine.assistantText.length === 0) {
          return {
            ok: false,
            error: `refine spawn 실패 (exit=${refine.exitCode}). stderr 일부: ${refine.stderr.slice(0, 400)}`,
            rawAssistantText: refine.assistantText,
            durationMs: refine.durationMs,
            exitCode: refine.exitCode,
            stderr: refine.stderr,
            rawLineCount: refine.rawLines.length,
          };
        }

        const parsed = parseRefineOutput(refine.assistantText);
        if (!parsed.ok) {
          return {
            ok: false,
            error: parsed.error,
            rawAssistantText: refine.assistantText,
            durationMs: refine.durationMs,
            exitCode: refine.exitCode,
            stderr: refine.stderr,
            rawLineCount: refine.rawLines.length,
          };
        }

        const gitInfo = opts.gitProbe ? await opts.gitProbe(workspacePath) : undefined;
        const ir = assembleIR({
          contextId: workspaceId,
          body: parsed.body,
          fromModel: activeModel,
          workspacePath,
          previousIR: currentIR,
          gitInfo,
        });

        try {
          await writeIR(workspaceRoot, ir);
        } catch (err) {
          return {
            ok: false,
            error: `ir.json write 실패: ${String(err)}`,
            ir,
            rawAssistantText: refine.assistantText,
            durationMs: refine.durationMs,
            exitCode: refine.exitCode,
            stderr: refine.stderr,
            rawLineCount: refine.rawLines.length,
          };
        }

        if (processCount > 0) {
          let stagedArchive: StagedArchive | null = null;
          if (currentIR) {
            try {
              stagedArchive = await stageCompactedTurns(workspaceRoot, oldest, currentIR);
            } catch (err) {
              log.warn(
                `runManual: archive stage failed — ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
          try {
            await rewriteTurns(workspaceRoot, remaining);
            if (stagedArchive) {
              await commitArchive(stagedArchive, {
                maxArchiveSnapshots: opts.maxArchiveSnapshots,
                logger: log,
              });
            }
          } catch (err) {
            log.warn(
              `runManual: turns rewrite 실패 — IR은 갱신됨: ${err instanceof Error ? err.message : String(err)}`,
            );
            if (stagedArchive) await abortArchive(stagedArchive);
          }
        }

        events.emit('ir:updated', workspaceId);
        return {
          ok: true,
          ir,
          error: parsed.warnings.length > 0 ? parsed.warnings.join(' / ') : undefined,
          rawAssistantText: refine.assistantText,
          durationMs: refine.durationMs,
          exitCode: refine.exitCode,
          stderr: refine.stderr,
          rawLineCount: refine.rawLines.length,
        };
      } finally {
        if (holdsDiskLock) await releaseDiskLock(workspaceId);
        this.unmarkInFlight(workspaceId);
      }
    },
  };
}
