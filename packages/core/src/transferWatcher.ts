// transfer-request.json 변화 워처 (Plan 2b 이어가기) — 뷰어가 "채팅 이어가기"를 누르면
// 세션 디렉토리에 transfer-request.json이 생긴다. 소유 앱이 이를 감지해 자기 세션을 양보한다.
// 감시 메커니즘은 createSessionFileWatcher 공유 — 여기선 transfer-request.json 파일명만 고정한다.

import { createSessionFileWatcher, type SessionFileWatcher } from './sessionFileWatcher';

export type TransferWatcher = SessionFileWatcher;

export interface TransferWatcherOptions {
  root: string;
  onChange(): void;
  debounceMs?: number;
  logger?: { warn(message: string, err?: unknown): void };
}

export function createTransferWatcher(opts: TransferWatcherOptions): TransferWatcher {
  return createSessionFileWatcher({ ...opts, filename: 'transfer-request.json' });
}
