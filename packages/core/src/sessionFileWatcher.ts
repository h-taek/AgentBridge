// 세션 파일 워처 (Plan 2b, host-agnostic) — 스토리지 루트를 recursive watch하며 특정
// 파일명(owner.json, transfer-request.json 등)의 변화만 골라 통지한다. replay.log append 등
// 다른 파일 이벤트는 무시하고, 버스트(atomic write의 tmp→rename, 락 파일)는 debounce로 합친다.
//
// owner watcher / transfer watcher는 "어떤 파일을 보고 무엇을 할지"만 다르고 감시 메커니즘은
// 동일하므로 이 공통 엔진을 공유한다 (createOwnerWatcher / createTransferWatcher 참고).

import { watch, type FSWatcher } from 'fs';

export interface SessionFileWatcher {
  stop(): void;
}

export interface SessionFileWatcherOptions {
  root: string;
  // 감시 대상 파일명 (root 이하 어느 깊이든 이 이름으로 끝나는 경로만 매칭).
  filename: string;
  onChange(): void;
  debounceMs?: number;
  logger?: { warn(message: string, err?: unknown): void };
}

const DEFAULT_DEBOUNCE_MS = 150;

export function createSessionFileWatcher(opts: SessionFileWatcherOptions): SessionFileWatcher {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  let watcher: FSWatcher | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!stopped) opts.onChange();
    }, debounceMs);
  }

  try {
    watcher = watch(opts.root, { recursive: true }, (_event, eventPath) => {
      if (!eventPath) return;
      // eventPath는 root 기준 상대경로. atomic write의 tmp(.../owner.json.<pid>.<ts>.tmp)는
      // .tmp로 끝나 제외되고, 최종 rename 대상(filename)과 rm만 매칭된다.
      if (eventPath.endsWith(opts.filename)) schedule();
    });
    watcher.on('error', (err) => {
      opts.logger?.warn(`sessionFileWatcher fs.watch error (${opts.root}/${opts.filename})`, err);
    });
  } catch (err) {
    opts.logger?.warn(`sessionFileWatcher fs.watch 미지원 (${opts.root}/${opts.filename})`, err);
  }

  return {
    stop(): void {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (watcher) {
        try {
          watcher.close();
        } catch {
          /* noop */
        }
        watcher = null;
      }
    },
  };
}
