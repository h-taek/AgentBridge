// turns.jsonl이 threshold를 넘으면 oldest 청크를 refine → IR로 흡수하고 turns.jsonl을 rewrite한다.
//
// 호스트 차이 흡수:
//   - workspaceRoot: 호스트가 계산해 전달 (.agentbridge/workspaces/<id>)
//   - Notifications: 호스트별 UI (VS Code window.show* / Electron 알림창) 인터페이스로 주입
//   - refineOrder: 호스트가 settings에서 refinePolicy 해석해 전달
//   - envProbe, gitProbe: 호스트가 인스턴스/콜백 전달

import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import { join } from 'path';
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
import { runRefine, RefineOffError, type RefineDecision } from './refineDispatcher';
import type { EnvProbe } from './envProbe';
import type { Logger } from './interfaces';
import { noopLogger } from './interfaces';

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
  // 호스트가 cwd를 받아 git 정보 반환. 미제공 시 IR.meta의 gitBranch/gitHead는 undefined.
  gitProbe?: (cwd: string) => Promise<GitInfo>;
  // 호스트가 settings를 보고 refine 정책을 결정. policy: 'off'면 RefineOffError.
  resolveRefineDecision: (activeModel: CliKind) => RefineDecision;
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
  acquireDiskLock(workspaceRoot: string): Promise<boolean>;
  releaseDiskLock(workspaceRoot: string): Promise<void>;
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

type WorkspaceLockState = {
  compactionInProgress?: { pid: number; startedAt: number };
};

export function createCompactionScheduler(
  opts: CompactionSchedulerOptions,
): CompactionScheduler {
  const log = opts.logger ?? noopLogger;
  const events = opts.events ?? new EventEmitter();
  const inFlight = new Set<string>();

  function lockFilePath(workspaceRoot: string): string {
    return join(workspaceRoot, 'workspace.json');
  }

  async function readLock(workspaceRoot: string): Promise<WorkspaceLockState> {
    try {
      const raw = await fs.readFile(lockFilePath(workspaceRoot), 'utf8');
      return JSON.parse(raw) as WorkspaceLockState;
    } catch {
      return {};
    }
  }

  async function writeLock(workspaceRoot: string, state: WorkspaceLockState): Promise<void> {
    const p = lockFilePath(workspaceRoot);
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(tmp, p);
  }

  async function acquireDiskLock(workspaceRoot: string): Promise<boolean> {
    const state = await readLock(workspaceRoot);
    const existing = state.compactionInProgress;
    if (existing) {
      const age = Date.now() - existing.startedAt;
      if (age < LOCK_STALE_MS) return false;
      log.warn(
        `compaction: stale lock detected (age=${age}ms, pid=${existing.pid}) — overriding`,
      );
    }
    state.compactionInProgress = { pid: process.pid, startedAt: Date.now() };
    await writeLock(workspaceRoot, state);
    const verify = await readLock(workspaceRoot);
    if (
      verify.compactionInProgress?.pid !== process.pid ||
      verify.compactionInProgress?.startedAt !== state.compactionInProgress.startedAt
    ) {
      return false;
    }
    return true;
  }

  async function releaseDiskLock(workspaceRoot: string): Promise<void> {
    try {
      const state = await readLock(workspaceRoot);
      if (state.compactionInProgress?.pid === process.pid) {
        delete state.compactionInProgress;
        await writeLock(workspaceRoot, state);
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

  async function loadIR(workspaceRoot: string): Promise<IR | null> {
    const irPath = join(workspaceRoot, 'ir.json');
    try {
      const raw = await fs.readFile(irPath, 'utf8');
      const parsed = JSON.parse(raw);
      // 손상된 ir.json이 빈 객체/배열로 파싱되면 meta 누락 → assembleIR throw 가능. 방어적 검증.
      if (!parsed || typeof parsed !== 'object' || !('meta' in parsed)) return null;
      return parsed as IR;
    } catch {
      return null;
    }
  }

  async function saveIR(workspaceRoot: string, ir: IR): Promise<void> {
    const irPath = join(workspaceRoot, 'ir.json');
    const tmp = `${irPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(ir, null, 2), 'utf8');
    await fs.rename(tmp, irPath);
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

        holdsDiskLock = await acquireDiskLock(workspaceRoot);
        if (!holdsDiskLock) {
          log.log(`compaction: another process holds the lock, skipping`);
          return;
        }

        const processCount = turns.length - COMPACTION_TRIGGER.keepRecent;
        if (processCount <= 0) return;

        const oldest = turns.slice(0, processCount);
        const remaining = turns.slice(processCount);
        const currentIR = await loadIR(workspaceRoot);

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
          await saveIR(workspaceRoot, ir);
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
        if (holdsDiskLock) await releaseDiskLock(workspaceRoot);
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

        holdsDiskLock = await acquireDiskLock(workspaceRoot);
        if (!holdsDiskLock) {
          return empty('다른 프로세스가 락을 잡고 있어 manual compaction 스킵');
        }

        const keep = COMPACTION_TRIGGER.keepRecent;
        const processCount = Math.max(turns.length - keep, 0);
        const oldest = turns.slice(0, processCount);
        const remaining = turns.slice(processCount);
        const currentIR = await loadIR(workspaceRoot);

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
          await saveIR(workspaceRoot, ir);
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
        if (holdsDiskLock) await releaseDiskLock(workspaceRoot);
        this.unmarkInFlight(workspaceId);
      }
    },
  };
}
