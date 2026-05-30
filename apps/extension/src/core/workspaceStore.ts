// Facade — 코어의 WorkspaceStore 인스턴스로 위임. init()은 더 이상 필요 없지만(coreInstances가 처리)
// 기존 호출처(extension.ts)와의 호환을 위해 no-op으로 남겨둠.

import { mkdirSync } from 'fs';
import { getWorkspaceStore } from './coreInstances';

export function init(storagePath: string): void {
  mkdirSync(storagePath, { recursive: true });
  // 실제 셋업은 coreInstances.initializeCore()에서 수행됨.
}

export function getGlobalStoragePath(): string {
  return getWorkspaceStore().getGlobalStoragePath();
}

export function getOrCreateWorkspaceId(folderFsPath: string): string {
  return getWorkspaceStore().getOrCreateWorkspaceId(folderFsPath);
}

export function getWorkspacePath(workspaceId: string): string {
  return getWorkspaceStore().getWorkspacePath(workspaceId);
}
