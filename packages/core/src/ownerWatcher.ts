// owner.json 변화 워처 (Plan 2b, host-agnostic) — 스토리지 루트를 recursive watch하며
// 세션 소유권 변화(acquire/release/resize로 owner.json이 생기거나 사라지거나 갱신됨)만
// 골라 통지한다. replay.log append 등 다른 파일 이벤트는 무시한다.
//
// 호스트는 onChange에서 자기 방식대로 반응한다 (데스크탑: broadcastWorkspacesChanged).
// 버스트(atomic write의 tmp→rename, 락 파일 등)는 debounce로 1회로 합친다.

import { watch, type FSWatcher } from 'fs';

export interface OwnerWatcher {
  stop(): void;
}

export interface OwnerWatcherOptions {
  root: string;
  onChange(): void;
  debounceMs?: number;
  logger?: { warn(message: string, err?: unknown): void };
}

const DEFAULT_DEBOUNCE_MS = 150;
const OWNER_FILE = 'owner.json';

export function createOwnerWatcher(opts: OwnerWatcherOptions): OwnerWatcher {
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
    watcher = watch(opts.root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      // filename은 root 기준 상대경로. atomic write의 tmp(.../owner.json.<pid>.<ts>.tmp)는
      // .tmp로 끝나 제외되고, 최종 rename 대상(owner.json)과 release의 rm만 매칭된다.
      if (filename.endsWith(OWNER_FILE)) schedule();
    });
    watcher.on('error', (err) => {
      opts.logger?.warn(`ownerWatcher fs.watch error (${opts.root})`, err);
    });
  } catch (err) {
    opts.logger?.warn(`ownerWatcher fs.watch 미지원 (${opts.root})`, err);
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
