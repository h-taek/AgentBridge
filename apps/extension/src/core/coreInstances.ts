// 코어 팩토리로 만든 인스턴스 모음. extension.ts의 activate()에서 initializeCore()를 호출해
// 모든 인스턴스를 셋업한다. 이후 다른 모듈은 이 파일에서 가져다 쓴다.

import * as path from 'path';
import * as vscode from 'vscode';
import {
  createWorkspaceStore,
  createHookStatusStore,
  createEnvProbe,
  createHookInstaller,
  getCanonicalHelperPath,
  createCliAdapters,
  createCompactionScheduler,
  createQuotaTracker,
  resolveRefineDecisionFromConfig,
  type WorkspaceStore,
  type HookStatusStore,
  type EnvProbe,
  type HookInstaller,
  type CliAdapterSet,
  type CompactionScheduler,
  type CompactionNotifications,
  type QuotaTracker,
  type Logger,
} from '@agentbridge/core';
import * as output from '../log/output';
import { getConfig } from '../settings/config';
import * as notifications from './notifications';
import { setAttachmentLogger } from './attachmentStore';
import { createQuotaStore } from './quotaStore';

const logger: Logger = {
  log: (m) => output.log(m),
  warn: (m) => output.warn(m),
};

let _workspaceStore: WorkspaceStore | null = null;
let _hookStatusStore: HookStatusStore | null = null;
let _envProbe: EnvProbe | null = null;
let _hookInstaller: HookInstaller | null = null;
let _cliAdapters: CliAdapterSet | null = null;
let _compactionScheduler: CompactionScheduler | null = null;
let _quotaTracker: QuotaTracker | null = null;
let _bundledHelperPath: string | null = null;

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
export function getHookInstaller(): HookInstaller {
  return ensureInitialized(_hookInstaller, 'hookInstaller');
}
export function getCliAdapters(): CliAdapterSet {
  return ensureInitialized(_cliAdapters, 'cliAdapters');
}
export function getCompactionScheduler(): CompactionScheduler {
  return ensureInitialized(_compactionScheduler, 'compactionScheduler');
}
// 외부 미사용 — initializeCore의 onRefineAttempt 콜백에서만 호출.
function getQuotaTracker(): QuotaTracker {
  return ensureInitialized(_quotaTracker, 'quotaTracker');
}

export function getLogger(): Logger {
  return logger;
}

// extension.ts activate()가 helper 설치에 사용.
export function getBundledHelperPath(): string {
  return ensureInitialized(_bundledHelperPath, 'bundledHelperPath');
}

export function initializeCore(
  context: vscode.ExtensionContext,
  // ⚠️ 테스트 전용 — 프로덕션 호출(extension.ts)은 두 번째 인자를 넘기지 않는다.
  testOverrides?: { storageRootForTesting?: string },
): void {
  _workspaceStore = createWorkspaceStore({
    logger,
    rootPathForTesting: testOverrides?.storageRootForTesting,
  });
  _hookStatusStore = createHookStatusStore();
  _envProbe = createEnvProbe({ logger });

  // resources/bin/agentbridge-memory.js 위치. dev: src/.. 빌드: out/.. 모두에서 동작하게
  // extensionPath 기준 resolve. 번들 경로는 activate()의 helper 설치에 쓰려고 보관.
  const bundledHelperPath = path.join(context.extensionPath, 'resources', 'bin', 'agentbridge-memory.js');
  _bundledHelperPath = bundledHelperPath;
  const storageRoot = _workspaceStore.getGlobalStoragePath();

  _hookInstaller = createHookInstaller({
    // hook 명령은 번들 안 경로가 아니라 양 앱 공용 canonical 경로(~/.agentbridge/bin/)를 가리킨다 (V-12).
    helperPath: getCanonicalHelperPath(storageRoot),
    // 저장소 루트와 hook --user-data가 같은 곳을 가리키도록 store에서 가져옴 (테스트 포함 일관성)
    globalStoragePath: storageRoot,
    logger,
  });

  // attachmentStore에 logger 단방향 주입 (circular dep 제거).
  setAttachmentLogger(logger);

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
    workspaceStore: _workspaceStore!,
    // refine attempt 부가효과 — 익스텐션은 PTY probe 미설치, quota 강제 폴백 마킹만 (데이터 모델 통일).
    // 데스크탑은 같은 hook으로 markForcedFallback + background probe까지 수행.
    // (hook은 refine 실행 시점에 호출되므로 아래 _quotaTracker 초기화 순서와 무관.)
    onRefineAttempt: async (event) => {
      if (event.status === 'quota') {
        await getQuotaTracker().markForcedFallback(event.cli);
      }
    },
    resolveRefineDecision: (activeModel) => {
      // 변환 switch는 core resolveRefineDecisionFromConfig 단일 구현 사용 (V-11).
      // 빈 priority 목록 → 기본 순서 폴백도 core가 처리.
      const cfg = getConfig();
      return resolveRefineDecisionFromConfig(
        {
          policy: cfg.refinePolicy,
          fixedCli: cfg.refineFixedCli,
          priorityOrder: cfg.refinePriorityOrder,
          useClaude: cfg.refineUseClaude,
        },
        activeModel,
      );
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
