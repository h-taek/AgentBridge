// 코어 팩토리로 만든 인스턴스 모음. extension.ts의 activate()에서 initializeCore()를 호출해
// 모든 인스턴스를 셋업한다. 이후 다른 모듈은 이 파일에서 가져다 쓴다.

import * as path from 'path';
import * as vscode from 'vscode';
import {
  createHookStatusStore,
  createEnvProbe,
  createHookInstaller,
  createSessionRegistry,
  createCliAdapters,
  createCompactionScheduler,
  createQuotaTracker,
  type HookStatusStore,
  type EnvProbe,
  type HookInstaller,
  type SessionRegistry,
  type CliAdapterSet,
  type CompactionScheduler,
  type CompactionNotifications,
  type QuotaTracker,
  type Logger,
} from '@agentbridge/core';
import * as output from '../log/output';
import { getConfig } from '../settings/config';
import * as notifications from './notifications';
import { cleanupSessionAttachments } from './attachmentStore';
import { createQuotaStore } from './quotaStore';
import { createWorkspaceStore, type WorkspaceStore } from './workspaceStore';

const logger: Logger = {
  log: (m) => output.log(m),
  warn: (m) => output.warn(m),
};

let _workspaceStore: WorkspaceStore | null = null;
let _hookStatusStore: HookStatusStore | null = null;
let _envProbe: EnvProbe | null = null;
let _hookInstaller: HookInstaller | null = null;
let _sessionRegistry: SessionRegistry | null = null;
let _cliAdapters: CliAdapterSet | null = null;
let _compactionScheduler: CompactionScheduler | null = null;
let _quotaTracker: QuotaTracker | null = null;

function ensureInitialized<T>(v: T | null, name: string): T {
  if (v === null) {
    throw new Error(`coreInstances: ${name} accessed before initializeCore()`);
  }
  return v;
}

export function getWorkspaceStore(): WorkspaceStore {
  return ensureInitialized(_workspaceStore, 'workspaceStore');
}
export function getHookStatusStore(): HookStatusStore {
  return ensureInitialized(_hookStatusStore, 'hookStatusStore');
}
export function getEnvProbe(): EnvProbe {
  return ensureInitialized(_envProbe, 'envProbe');
}
export function getHookInstaller(): HookInstaller {
  return ensureInitialized(_hookInstaller, 'hookInstaller');
}
export function getSessionRegistry(): SessionRegistry {
  return ensureInitialized(_sessionRegistry, 'sessionRegistry');
}
export function getCliAdapters(): CliAdapterSet {
  return ensureInitialized(_cliAdapters, 'cliAdapters');
}
export function getCompactionScheduler(): CompactionScheduler {
  return ensureInitialized(_compactionScheduler, 'compactionScheduler');
}
export function getQuotaTracker(): QuotaTracker {
  return ensureInitialized(_quotaTracker, 'quotaTracker');
}

export function getLogger(): Logger {
  return logger;
}

export function initializeCore(context: vscode.ExtensionContext): void {
  // VS Code globalStorageUri는 익스텐션 전용 스토리지 경로.
  const globalStoragePath = context.globalStorageUri.fsPath;

  _workspaceStore = createWorkspaceStore(globalStoragePath, { logger });
  _hookStatusStore = createHookStatusStore();
  _envProbe = createEnvProbe({ logger });

  // resources/bin/agentbridge-memory.js 위치. dev: src/.. 빌드: out/.. 모두에서 동작하게
  // extensionPath 기준 resolve.
  const helperPath = path.join(context.extensionPath, 'resources', 'bin', 'agentbridge-memory.js');

  _hookInstaller = createHookInstaller({
    helperPath,
    globalStoragePath,
    logger,
  });

  _sessionRegistry = createSessionRegistry({
    logger,
    onAfterDelete: async (_workspaceId, sessionId) => {
      // VS Code workspaceFolders[0]를 cwd로. 다른 워크스페이스로 전환된 후 trigger되는 케이스는
      // sessionRegistry가 이미 처리(워크스페이스별로 cwd가 다를 수 있음). attachmentStore는
      // 현재 워크스페이스만 청소한다 — 익스텐션 원본 동작과 동일.
      await cleanupSessionAttachments(_workspaceId, sessionId);
    },
  });

  _cliAdapters = createCliAdapters({
    envProbe: _envProbe,
    hookInstaller: _hookInstaller,
    hookStatusStore: _hookStatusStore,
    workspaceClaudeDir: (workspaceId) => _workspaceStore!.getWorkspacePath(workspaceId),
    logger,
  });

  const compactionNotifications: CompactionNotifications = {
    notifyRefineOff: () => notifications.notifyRefineOff(),
    notifyRefineFailed: (msg) => notifications.notifyRefineFailed(msg),
    notifyRefineFallback: (tried, spawned, reason) =>
      notifications.notifyRefineFallback(tried as never, spawned, reason),
  };

  _compactionScheduler = createCompactionScheduler({
    notifications: compactionNotifications,
    envProbe: _envProbe,
    resolveRefineDecision: (activeModel) => {
      const cfg = getConfig();
      switch (cfg.refinePolicy) {
        case 'off':
          return { policy: 'off' };
        case 'fixed':
          return { policy: 'fixed', cli: cfg.refineFixedCli };
        case 'active':
          return { policy: 'active', cli: activeModel };
        case 'priority':
          return {
            policy: 'priority',
            order: Array.from(new Set(cfg.refinePriorityOrder)),
          };
      }
    },
    maxArchiveSnapshots: getConfig().maxArchiveSnapshots,
    logger,
  });

  _quotaTracker = createQuotaTracker({
    store: createQuotaStore(context),
    logger,
    // UI 미설치 — onChange는 일단 no-op. 미래 sidebar/statusbar 추가 시 broadcast 연결.
  });
}
