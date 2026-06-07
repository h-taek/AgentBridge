// CaptureManager — 설계 §E "로직은 core 한 곳, 호스트는 호출만". 등록된 세션마다 transcript 경로를
// 해석하고 CaptureSession을 fs.watch(jsonl 즉시성)/폴링(안전망·agy)으로 구동한다.
//   - claude: register 시 modelSessionId 이미 앎 → 즉시 경로 해석·구동.
//   - codex·agy: spawn 후 비동기 캡처 → 호스트가 setModelSessionId로 알려주면 그때 구동.
//   - unregister/disposeAll: 진행 중 tick을 비운 뒤 finalize로 carry의 마지막 열린 턴 flush.
// 멱등성·dedup·하류 트리거는 CaptureSession이 담당(여기선 lifecycle/스케줄링만).
import { watch, type FSWatcher } from 'fs';
import type { CliKind } from '../shared/cli';
import type { TurnsAssistantDetail } from '../shared/turns';
import type { Logger } from '../interfaces';
import { noopLogger } from '../interfaces';
import { CaptureSession, type CaptureSchedulerLike, type CaptureSessionOptions } from './manager';
import { resolveTranscriptPath } from './resolvePath';

const DEFAULT_POLL_MS = 1000;

export interface RegisterSessionOptions {
  workspaceId: string;
  workspaceRoot: string;
  workspacePath: string;
  sessionId: string;
  model: CliKind;
  modelSessionId?: string | null; // claude: 즉시. codex/agy: null이면 setModelSessionId 대기.
  cwd?: string; // claude enc-cwd 경로 해석용. 기본 workspacePath.
  getDetail: () => TurnsAssistantDetail;
  scheduler: CaptureSchedulerLike;
  onTurnFlushed?: CaptureSessionOptions['onTurnFlushed'];
  pollMs?: number; // 폴링 주기. 기본 1000(설계 §D). 테스트가 작게 주입.
}

export interface CaptureManagerDeps {
  // 경로 해석 주입(테스트가 temp 파일로 대체). 기본은 실제 resolveTranscriptPath.
  resolve?: (model: CliKind, modelSessionId: string, cwd: string) => Promise<string | null>;
  logger?: Logger;
}

interface Entry {
  opts: RegisterSessionOptions;
  modelSessionId: string | null;
  cwd: string;
  session: CaptureSession | null;
  watcher: FSWatcher | null;
  poll: ReturnType<typeof setInterval> | null;
  inflight: Promise<void> | null;
  disposed: boolean;
}

export class CaptureManager {
  private readonly entries = new Map<string, Entry>();
  private readonly resolve: NonNullable<CaptureManagerDeps['resolve']>;
  private readonly log: Logger;

  constructor(deps: CaptureManagerDeps = {}) {
    this.resolve = deps.resolve ?? resolveTranscriptPath;
    this.log = deps.logger ?? noopLogger;
  }

  // 세션 등록. modelSessionId가 있으면 즉시, 없으면 setModelSessionId까지 폴링은 no-op으로 돈다.
  register(opts: RegisterSessionOptions): void {
    if (this.entries.has(opts.sessionId)) {
      this.log.warn(`CaptureManager: 세션 ${opts.sessionId} 이미 등록됨 — register 무시`);
      return;
    }
    const entry: Entry = {
      opts,
      modelSessionId: opts.modelSessionId ?? null,
      cwd: opts.cwd ?? opts.workspacePath,
      session: null,
      watcher: null,
      poll: null,
      inflight: null,
      disposed: false,
    };
    this.entries.set(opts.sessionId, entry);
    this.startPoll(entry);
  }

  // codex/agy의 비동기 캡처 경로에서 modelSessionId 확보 시 호출. 다음 tick이 경로 해석·구동.
  setModelSessionId(sessionId: string, modelSessionId: string, cwd?: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    entry.modelSessionId = modelSessionId;
    if (cwd) entry.cwd = cwd;
    void this.tick(entry); // 즉시성: 폴링 주기 기다리지 않고 한 번 깨움.
  }

  // 세션 종료. 드라이버 정지 → 진행 중 tick 대기 → finalize로 마지막 열린 턴 flush.
  async unregister(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.entries.delete(sessionId);
    entry.disposed = true;
    this.stopDriver(entry);
    if (entry.inflight) {
      try {
        await entry.inflight;
      } catch {
        /* tick 오류는 CaptureSession이 이미 삼킴 */
      }
    }
    if (entry.session) {
      try {
        await entry.session.finalize();
      } catch (err) {
        this.log.warn(`CaptureManager finalize 실패 (${sessionId}): ${String(err)}`);
      }
    }
  }

  // 앱 종료 시 모든 세션 flush 완료까지 await (V-07 동작 보존).
  async disposeAll(): Promise<void> {
    await Promise.allSettled(Array.from(this.entries.keys()).map((id) => this.unregister(id)));
  }

  private startPoll(entry: Entry): void {
    if (entry.poll) return;
    const ms = entry.opts.pollMs ?? DEFAULT_POLL_MS;
    entry.poll = setInterval(() => {
      void this.tick(entry);
    }, ms);
    void this.tick(entry); // 즉시 1회 — 이미 쌓인(붙기 전) 턴까지 catch-up.
  }

  private stopDriver(entry: Entry): void {
    if (entry.poll) {
      clearInterval(entry.poll);
      entry.poll = null;
    }
    if (entry.watcher) {
      try {
        entry.watcher.close();
      } catch {
        /* noop */
      }
      entry.watcher = null;
    }
  }

  // tick 1회. inflight면 그 promise를 공유(중첩 실행 방지 — 느린 tick에 인터벌이 쌓여도 무해).
  private tick(entry: Entry): Promise<void> {
    if (entry.disposed) return Promise.resolve();
    if (entry.inflight) return entry.inflight;
    const p = this.runTick(entry).finally(() => {
      entry.inflight = null;
    });
    entry.inflight = p;
    return p;
  }

  private async runTick(entry: Entry): Promise<void> {
    if (entry.disposed) return;
    if (!entry.session) {
      if (!entry.modelSessionId) return; // modelSessionId 대기(codex/agy 비동기 캡처).
      let path: string | null;
      try {
        path = await this.resolve(entry.opts.model, entry.modelSessionId, entry.cwd);
      } catch (err) {
        this.log.warn(`CaptureManager 경로 해석 실패 (${entry.opts.sessionId}): ${String(err)}`);
        return;
      }
      if (!path) return; // codex rollout 아직 미생성 — 다음 폴링에 재시도.
      if (entry.disposed) return;
      entry.session = new CaptureSession({
        workspaceId: entry.opts.workspaceId,
        workspaceRoot: entry.opts.workspaceRoot,
        workspacePath: entry.opts.workspacePath,
        sessionId: entry.opts.sessionId,
        model: entry.opts.model,
        transcriptPath: path,
        getDetail: entry.opts.getDetail,
        scheduler: entry.opts.scheduler,
        onTurnFlushed: entry.opts.onTurnFlushed,
        logger: this.log,
      });
      this.attachWatch(entry, path);
    }
    await entry.session.tick();
  }

  // 즉시성용 best-effort fs.watch(jsonl). 미생성·미지원·오류면 폴링이 안전망(설계 §D).
  private attachWatch(entry: Entry, path: string): void {
    if (entry.opts.model === 'agy') return; // sqlite는 바이트 tail 불가 → 폴링만.
    if (entry.watcher) return;
    try {
      entry.watcher = watch(path, () => {
        void this.tick(entry);
      });
    } catch {
      entry.watcher = null; // 폴링으로 수렴.
    }
  }
}
