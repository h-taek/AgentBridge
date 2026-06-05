// 세션 미러 엔진 (Plan 2b, host-agnostic) — 다른 프로세스가 라이브로 소유한 세션을
// *읽기 전용*으로 따라 그린다. replay.log tail + owner.json 감시. PTY를 띄우지 않는다
// (대화 분기 방지).
//
// 호스트별로 다른 건 오직 바이트 전달 방식뿐이라 MirrorSink로 추상화한다:
//   - 데스크탑(Electron main): WebContents.send / isDestroyed
//   - 익스텐션(VS Code 호스트): webview.postMessage / dispose 플래그
// fs.watch·setInterval·fs는 양쪽 다 Node 런타임이라 그대로 동작한다.
//
// 감시 방식: fs.watch(세션 디렉토리) primary + 폴링 폴백(fs.watch 미지원/누락 환경).
// 두 경로 모두 drain()을 호출하고, drain은 in-flight 가드 + 오프셋으로 중복/순서 문제를 막는다.

import { watch, type FSWatcher } from 'fs';
import { readAppendedBytes } from './fileTail';
import { readOwner, isOwnerAlive, type OwnerInfo } from './sessionOwner';

// 미러 출력 싱크 — 호스트가 바이트 전달·생존판정·종료통보 방식을 주입한다.
export interface MirrorSink {
  onData(data: string): void;
  onEnded(): void;
  isAlive(): boolean;
}

// 선택적 로거 — 미주입 시 무음.
export interface MirrorLogger {
  info(message: string, meta?: unknown): void;
  warn(message: string, err?: unknown): void;
}

export interface SessionMirrorOptions {
  sessionDir: string;
  replayPath: string;
  sink: MirrorSink;
  logger?: MirrorLogger;
  pollMs?: number;
}

export interface MirrorStartSnapshot {
  // replay.log 전체 스냅샷 — mount 직후 1회 렌더. 없으면 빈 문자열.
  replay: string;
  // 시작 시점 owner.json. 이미 종료됐으면 null.
  owner: OwnerInfo | null;
}

export interface SessionMirror {
  // 스냅샷 + 소유자 반환 후 tail/owner 감시 시작. 1회만 호출.
  start(): Promise<MirrorStartSnapshot>;
  // 감시 중단 (호스트 주도 teardown). onEnded는 부르지 않는다.
  stop(): void;
}

const DEFAULT_POLL_MS = 1000;

export function createSessionMirror(opts: SessionMirrorOptions): SessionMirror {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const logger = opts.logger;

  let offset = 0;
  let watcher: FSWatcher | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  let draining = false;
  let stopped = false; // stop() 또는 endMirror() 후 true — in-flight drain 차단.
  let started = false;

  function cleanup(): void {
    if (watcher) {
      try {
        watcher.close();
      } catch {
        /* noop */
      }
      watcher = null;
    }
    if (poll) {
      clearInterval(poll);
      poll = null;
    }
  }

  // 소유 종료 감지 시 — 감시를 멈추고 싱크에 통보.
  function endMirror(): void {
    if (stopped) return;
    stopped = true;
    cleanup();
    if (opts.sink.isAlive()) opts.sink.onEnded();
  }

  async function drain(): Promise<void> {
    if (draining || stopped) return;
    draining = true;
    try {
      const { data, newOffset } = await readAppendedBytes(opts.replayPath, offset);
      offset = newOffset;
      if (data && opts.sink.isAlive()) opts.sink.onData(data);
      // 소유 종료 감지 — owner.json 소멸 또는 pid 사망.
      const owner = await readOwner(opts.sessionDir);
      if (!owner || !isOwnerAlive(owner)) endMirror();
    } catch (err) {
      logger?.warn(`sessionMirror drain 실패 (${opts.sessionDir})`, err);
    } finally {
      draining = false;
    }
  }

  return {
    async start(): Promise<MirrorStartSnapshot> {
      if (started) throw new Error('SessionMirror.start는 1회만 호출할 수 있습니다');
      started = true;

      const snapshot = await readAppendedBytes(opts.replayPath, 0);
      const ownerRec = await readOwner(opts.sessionDir);
      const owner = ownerRec && isOwnerAlive(ownerRec) ? ownerRec : null;
      offset = snapshot.newOffset;

      // primary: 세션 디렉토리 watch (replay.log append / owner.json 소멸 모두 change로 잡음).
      try {
        watcher = watch(opts.sessionDir, () => {
          void drain();
        });
        watcher.on('error', (err) => {
          logger?.warn(`sessionMirror fs.watch error (${opts.sessionDir})`, err);
        });
      } catch (err) {
        logger?.warn(`sessionMirror fs.watch 미지원 — 폴링만 사용 (${opts.sessionDir})`, err);
      }
      // fallback: 폴링 (fs.watch 누락/미지원 환경).
      poll = setInterval(() => {
        void drain();
      }, pollMs);

      logger?.info('sessionMirror start', {
        sessionDir: opts.sessionDir,
        startOffset: offset,
        owner,
      });
      return { replay: snapshot.data, owner };
    },

    stop(): void {
      stopped = true;
      cleanup();
    },
  };
}
