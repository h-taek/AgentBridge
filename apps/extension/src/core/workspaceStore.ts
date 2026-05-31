// 워크스페이스 → UUID 매핑과 워크스페이스별 디렉토리(workspaces/<id>) 관리.
//
// 이전: packages/core/src/workspaceStore.ts. 익스텐션 전용 (데스크탑은 자체 workspaceStore 824줄 사용)
// 이라 2026-06-01 코어에서 extension/src/core/로 이전.

import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, copyFileSync } from 'fs';
import { join } from 'path';
import { type Logger, noopLogger } from '@agentbridge/core';
import { getWorkspaceStore } from './coreInstances';

interface WorkspaceMap {
  [folderFsPath: string]: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WorkspaceStore {
  getGlobalStoragePath(): string;
  getOrCreateWorkspaceId(folderFsPath: string): string;
  getWorkspacePath(workspaceId: string): string;
}

export type WorkspaceStoreOptions = {
  logger?: Logger;
};

export function createWorkspaceStore(
  globalStoragePath: string,
  opts: WorkspaceStoreOptions = {},
): WorkspaceStore {
  const log = opts.logger ?? noopLogger;
  mkdirSync(globalStoragePath, { recursive: true });

  function mapFilePath(): string {
    return join(globalStoragePath, 'workspaces.json');
  }

  function loadMap(): WorkspaceMap {
    const p = mapFilePath();
    if (!existsSync(p)) return {};
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch (err) {
      const backup = `${p}.broken.${Date.now()}.bak`;
      try {
        copyFileSync(p, backup);
        log.warn(
          `workspaceStore: corrupt workspaces.json backed up to ${backup} — ${err instanceof Error ? err.message : String(err)}`,
        );
      } catch (backupErr) {
        log.warn(
          `workspaceStore: corrupt workspaces.json (backup also failed) — ${err instanceof Error ? err.message : String(err)}; backup: ${backupErr instanceof Error ? backupErr.message : String(backupErr)}`,
        );
      }
      return {};
    }
  }

  function saveMap(map: WorkspaceMap): void {
    const p = mapFilePath();
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8');
    renameSync(tmp, p);
  }

  return {
    getGlobalStoragePath: () => globalStoragePath,

    getOrCreateWorkspaceId(folderFsPath: string): string {
      const map = loadMap();
      if (map[folderFsPath] && UUID_RE.test(map[folderFsPath])) {
        log.log(`workspaceStore: reusing id=${map[folderFsPath]} for ${folderFsPath}`);
        return map[folderFsPath];
      }
      const id = randomUUID();
      map[folderFsPath] = id;
      saveMap(map);

      const wsDir = join(globalStoragePath, 'workspaces', id);
      mkdirSync(join(wsDir, 'settings'), { recursive: true });
      mkdirSync(join(wsDir, 'sessions'), { recursive: true });

      log.log(`workspaceStore: created id=${id} for ${folderFsPath}`);
      return id;
    },

    getWorkspacePath(workspaceId: string): string {
      if (!UUID_RE.test(workspaceId)) {
        throw new Error(`workspaceStore: invalid workspaceId "${workspaceId}"`);
      }
      return join(globalStoragePath, 'workspaces', workspaceId);
    },
  };
}

// ─── Facade: 기존 호출처(extension.ts) 호환용 ─────────────────────────

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
