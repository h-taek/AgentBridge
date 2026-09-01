// 코어 팩토리로 만든 인스턴스 모음. extension.ts의 activate()에서 initializeCore()를 호출해
// 모든 인스턴스를 셋업한다. 이후 다른 모듈은 이 파일에서 가져다 쓴다.

import * as path from 'path';
import * as vscode from 'vscode';
import {
  createWorkspaceStore,
  createHookStatusStore,
  createEnvProbe,
  createHookInstaller,
  getCanonicalBinPath,
  createSkillInstaller,
  renderRunPrefix,
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
  type RefineDecision,
} from '@agentbridge/core';
import type { CliKind } from '../shared/types';
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
let _bundledCliPath: string | null = null;

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
// 설정값 → refine 결정. compaction 정제와 세션 자동 명명이 같은 계산을 쓴다.
// 변환 switch는 core resolveRefineDecisionFromConfig 단일 구현 (V-11).
export function resolveRefineDecision(activeModel: CliKind): RefineDecision {
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
}

// 자동제안 트리거(runProposalTrigger)에 넘길 envProbe.
export function getCoreEnvProbe(): EnvProbe {
  return ensureInitialized(_envProbe, 'envProbe');
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

// extension.ts activate()가 에이전트용 CLI 설치에 사용 (0.5.0 B-5).
export function getBundledCliPath(): string {
  return ensureInitialized(_bundledCliPath, 'bundledCliPath');
}

export function initializeCore(
  context: vscode.ExtensionContext,
  // ⚠️ 테스트 전용 — 프로덕션 호출(extension.ts)은 두 번째 인자를 넘기지 않는다.
  testOverrides?: { storageRootForTesting?: string; homeDirForTesting?: string },
): void {
  _workspaceStore = createWorkspaceStore({
    logger,
    rootPathForTesting: testOverrides?.storageRootForTesting,
  });
  _hookStatusStore = createHookStatusStore();
  _envProbe = createEnvProbe({ logger });

  // resources/bin/ 위치. dev: src/.. 빌드: out/.. 모두에서 동작하게 extensionPath 기준 resolve.
  // 번들 경로는 activate()의 설치에 쓰려고 보관한다.
  const binDir = path.join(context.extensionPath, 'resources', 'bin');
  _bundledHelperPath = path.join(binDir, 'agentbridge-memory.js');
  _bundledCliPath = path.join(binDir, 'agentbridge.js');
  const storageRoot = _workspaceStore.getGlobalStoragePath();

  // 스킬 본문과 훅의 허용 규칙에 박히는 것은 번들 안 경로가 아니라 저장소 canonical 경로다.
  const cliRun = { execPath: process.execPath, cliPath: getCanonicalBinPath(storageRoot, 'cli') };

  _hookInstaller = createHookInstaller({
    // hook 명령은 번들 안 경로가 아니라 저장소 canonical 경로(<루트>/bin/)를 가리킨다 (V-12).
    helperPath: getCanonicalBinPath(storageRoot, 'helper'),
    // 훅을 돌릴 런타임 — 익스텐션 호스트의 실행 파일이다. ELECTRON_RUN_AS_NODE=1을 붙이면
    // VS Code가 그대로 node로 동작하므로 사용자 PATH의 node 설치 여부와 무관해진다 (A-3).
    execPath: process.execPath,
    // 모델이 우리 CLI를 승인 없이 부를 수 있게 하는 허용 규칙이 여기서 전역 설정에 들어간다.
    // 스킬이 모델에게 가르치는 문자열과 같은 값이어야 한다 — 어긋나면 부르는 족족 승인 창이 뜬다.
    cliRunPrefix: renderRunPrefix(cliRun),
    // 테스트만 오버라이드 — 실제 홈의 전역 설정을 건드리지 않게 한다.
    homeDir: testOverrides?.homeDirForTesting,
    logger,
  });

  // attachmentStore에 logger 단방향 주입 (circular dep 제거).
  setAttachmentLogger(logger);

  const skillInstaller = createSkillInstaller({
    ...cliRun,
    homeDir: testOverrides?.homeDirForTesting,
    logger,
  });

  _cliAdapters = createCliAdapters({
    envProbe: _envProbe,
    hookInstaller: _hookInstaller,
    skillInstaller,
    hookStatusStore: _hookStatusStore,
    workspaceDir: (workspaceId) => _workspaceStore!.getWorkspacePath(workspaceId),
    storageRoot,
    homeDir: testOverrides?.homeDirForTesting,
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
    // 빈 priority 목록 → 기본 순서 폴백은 core가 처리.
    resolveRefineDecision,
    maxArchiveSnapshots: getConfig().maxArchiveSnapshots,
    logger,
  });

  _quotaTracker = createQuotaTracker({
    store: createQuotaStore(context),
    logger,
    // UI 미설치 — onChange는 일단 no-op. 미래 sidebar/statusbar 추가 시 broadcast 연결.
  });
}
