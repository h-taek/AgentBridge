// owner.json 변화 워처 (Plan 2b) — 세션 소유권 변화(acquire/release/resize)를 통지한다.
// 호스트는 onChange에서 자기 방식대로 반응한다 (데스크탑: broadcastWorkspacesChanged).
// 감시 메커니즘은 createSessionFileWatcher 공유 — 여기선 owner.json 파일명만 고정한다.

import { createSessionFileWatcher, type SessionFileWatcher } from './sessionFileWatcher';

export type OwnerWatcher = SessionFileWatcher;

export interface OwnerWatcherOptions {
  root: string;
  onChange(): void;
  debounceMs?: number;
  logger?: { warn(message: string, err?: unknown): void };
}

export function createOwnerWatcher(opts: OwnerWatcherOptions): OwnerWatcher {
  return createSessionFileWatcher({ ...opts, filenames: ['owner.json'] });
}
