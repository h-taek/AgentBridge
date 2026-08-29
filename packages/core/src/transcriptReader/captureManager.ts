// CaptureManager — 설계 §E "로직은 core 한 곳, 호스트는 호출만". 등록된 세션마다 종료 훅 신호를
// 구독하고, 신호가 오면 그 신호가 실어 온 transcript를 증분으로 읽어 CaptureSession을 구동한다.
//
// 0.5.0 A-2 이전에는 파일이 자랐는지 1초마다 훔쳐보고 경로를 하니스별 규칙으로 유추했다. 이제
// 언제·어디를 읽을지 둘 다 훅이 알려준다 — 경로 유추(resolvePath)와 폴링이 함께 사라졌다.
//
// 신호는 트리거일 뿐이라 놓쳐도 다음 신호에 따라잡힌다. 다만 claude·codex는 훅이 뜨는 시점에
// 그 턴을 닫는 레코드가 아직 파일에 없어(research 04 §6-2, 수십 ms) 신호 1건마다 짧게 재시도한다.
//
// 멱등성·dedup·하류 트리거는 CaptureSession이 담당(여기선 lifecycle/스케줄링만).
import type { CliKind } from '../shared/cli';
import type { TurnsAssistantDetail } from '../shared/turns';
import type { Logger } from '../interfaces';
import { noopLogger } from '../interfaces';
import { CaptureSession, type CaptureSchedulerLike, type CaptureSessionOptions } from './manager';
import { watchTurnSignals, type TurnSignal, type TurnSignalWatcher } from '../cliAdapter/turnSignal';

// 신호 1건에 대한 재시도 간격(ms). 훅이 뜬 뒤 턴을 닫는 레코드가 파일에 닿기까지의 지연을 흡수한다.
// 반복 읽기는 무해하다 — cursor-hold + 결정적 id dedup이 중복을 막는다.
const SIGNAL_RETRY_DELAYS_MS = [0, 150, 500, 1500];

export interface RegisterSessionOptions {
  workspaceId: string;
  workspaceRoot: string;
  workspacePath: string;
  sessionId: string;
  model: CliKind;
  // 훅이 이 세션의 종료 신호를 쓰는 파일. 없으면 이 세션은 기록되지 않는다.
  signalFilePath: string;
  getDetail: () => TurnsAssistantDetail;
  scheduler: CaptureSchedulerLike;
  onTurnFlushed?: CaptureSessionOptions['onTurnFlushed'];
  // 신호 파일 폴링 안전망 주기. 기본 5000. 테스트가 작게 주입.
  signalPollMs?: number;
  // 재시도 간격 override(테스트용).
  retryDelaysMs?: number[];
}

export interface CaptureManagerDeps {
  logger?: Logger;
  // 훅이 값을 안 준다는 사실을 드러내는 통로. 신호가 왔는데 쓸 수 없을 때 호출한다.
  onSignalUnusable?: (info: { sessionId: string; model: CliKind; reason: string }) => void;
}

interface Entry {
  opts: RegisterSessionOptions;
  session: CaptureSession | null;
  transcriptPath: string | null;
  // 마지막 신호가 "턴이 온전히 끝났다"였는가. agy의 턴 닫기 근거로 리더까지 내려간다.
  turnClosed: boolean;
  watcher: TurnSignalWatcher | null;
  abort: AbortController;
  timers: Set<ReturnType<typeof setTimeout>>;
  inflight: Promise<void> | null;
  disposed: boolean;
}

export class CaptureManager {
  private readonly entries = new Map<string, Entry>();
  private readonly log: Logger;
  private readonly onSignalUnusable: CaptureManagerDeps['onSignalUnusable'];

  constructor(deps: CaptureManagerDeps = {}) {
    this.log = deps.logger ?? noopLogger;
    this.onSignalUnusable = deps.onSignalUnusable;
  }

  // 세션 등록. 첫 종료 신호가 올 때까지 아무것도 읽지 않는다.
  register(opts: RegisterSessionOptions): void {
    if (this.entries.has(opts.sessionId)) {
      this.log.warn(`CaptureManager: 세션 ${opts.sessionId} 이미 등록됨 — register 무시`);
      return;
    }
    const entry: Entry = {
      opts,
      session: null,
      transcriptPath: null,
      turnClosed: false,
      watcher: null,
      abort: new AbortController(),
      timers: new Set(),
      inflight: null,
      disposed: false,
    };
    this.entries.set(opts.sessionId, entry);
    entry.watcher = watchTurnSignals({
      signalFilePath: opts.signalFilePath,
      intervalMs: opts.signalPollMs,
      signal: entry.abort.signal,
      logger: this.log,
      onSignal: (sig) => this.onSignal(entry, sig),
    });
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

  private stopDriver(entry: Entry): void {
    entry.abort.abort();
    entry.watcher?.stop();
    entry.watcher = null;
    for (const t of entry.timers) clearTimeout(t);
    entry.timers.clear();
  }

  private onSignal(entry: Entry, sig: TurnSignal): void {
    if (entry.disposed) return;
    if (!sig.transcriptPath) {
      // 신호는 왔는데 읽을 자리를 안 알려줬다. 유추하지 않는다 — 드러내고 넘어간다.
      this.onSignalUnusable?.({
        sessionId: entry.opts.sessionId,
        model: entry.opts.model,
        reason: `${sig.event} 신호에 transcript 경로가 없다`,
      });
      return;
    }
    if (!entry.transcriptPath) {
      entry.transcriptPath = sig.transcriptPath;
    } else if (entry.transcriptPath !== sig.transcriptPath) {
      // 세션 도중 경로가 바뀌는 경우는 관측된 적이 없다. 조용히 갈아타면 커서가 어긋나므로 기록만 한다.
      this.log.warn(
        `CaptureManager: transcript 경로가 바뀌었다 (${entry.opts.sessionId}) — 첫 경로를 유지한다`,
      );
    }
    entry.turnClosed = sig.complete;
    // 훅이 뜬 시점엔 그 턴을 닫는 레코드가 아직 없을 수 있다 → 짧게 재시도.
    const delays = entry.opts.retryDelaysMs ?? SIGNAL_RETRY_DELAYS_MS;
    for (const ms of delays) {
      const t = setTimeout(() => {
        entry.timers.delete(t);
        void this.tick(entry);
      }, ms);
      entry.timers.add(t);
    }
  }

  // tick 1회. inflight면 그 promise를 공유(중첩 실행 방지).
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
    if (entry.disposed || !entry.transcriptPath) return;
    if (!entry.session) {
      entry.session = new CaptureSession({
        workspaceId: entry.opts.workspaceId,
        workspaceRoot: entry.opts.workspaceRoot,
        workspacePath: entry.opts.workspacePath,
        sessionId: entry.opts.sessionId,
        model: entry.opts.model,
        transcriptPath: entry.transcriptPath,
        getDetail: entry.opts.getDetail,
        scheduler: entry.opts.scheduler,
        onTurnFlushed: entry.opts.onTurnFlushed,
        logger: this.log,
      });
    }
    await entry.session.tick(entry.turnClosed);
  }
}
