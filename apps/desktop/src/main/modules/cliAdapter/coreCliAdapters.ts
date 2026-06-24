// 코어 createCliAdapters 인스턴스 lazy singleton.
//
// 2026-06-01 Phase 5: 데스크탑이 코어 createCliAdapters로 buildSpawnOptions 위임.
// 2026-06-01 Phase A: hookStatusStore 코어 인스턴스 주입 — UI 배지는 코어가 캡처한
// 사유를 spawn 후 읽어 전달.
// 2026-06-01 Phase C: 코어 createHookInstaller 직접 사용 — 데스크탑 wrapper 제거.
// legacy `.gemini/settings.json` 정리는 agy install 후 별도로 호출.

import log from 'electron-log/main'
import {
  createCliAdapters,
  createHookStatusStore,
  type CliAdapterSet,
  type HookInstaller,
  type HookStatusStore
} from '@agentbridge/core'
import { getDesktopHookInstaller, cleanupLegacyGeminiSettings } from '../hookInstaller'
import { getCoreEnvProbe } from '../envProbe'
import { getWorkspacePaths } from '../workspaceStore'

// 코어 HookInstaller를 그대로 사용하되, agy install 후 legacy gemini settings 정리만 추가.
function getCoreHookInstallerWithLegacyCleanup(): HookInstaller {
  const inner = getDesktopHookInstaller()
  return {
    installClaudeHooks: (workspaceClaudeDir, workspaceId) =>
      inner.installClaudeHooks(workspaceClaudeDir, workspaceId),
    installCodexHooks: (cwd, workspaceId) => inner.installCodexHooks(cwd, workspaceId),
    async installAgyHooks(cwd, workspaceId) {
      const result = await inner.installAgyHooks(cwd, workspaceId)
      try {
        await cleanupLegacyGeminiSettings(cwd)
      } catch (err) {
        log.warn('agy install 후 legacy .gemini cleanup 실패 (non-fatal)', {
          cwd,
          err: String(err)
        })
      }
      return result
    }
  }
}

let _coreCliAdapters: CliAdapterSet | null = null
let _coreHookStatusStore: HookStatusStore | null = null

export function getCoreHookStatusStore(): HookStatusStore {
  if (!_coreHookStatusStore) {
    _coreHookStatusStore = createHookStatusStore()
  }
  return _coreHookStatusStore
}

export function getCoreCliAdapters(): CliAdapterSet {
  if (!_coreCliAdapters) {
    _coreCliAdapters = createCliAdapters({
      envProbe: getCoreEnvProbe(),
      hookInstaller: getCoreHookInstallerWithLegacyCleanup(),
      hookStatusStore: getCoreHookStatusStore(),
      // 코어 installClaudeHooks가 `<workspaceClaudeDir>/settings/claude-settings.json`에 씀.
      // 데스크탑은 settingsDir=`<workspaceRoot>/settings`이므로 워크스페이스 루트를 넘기면 동일 경로.
      workspaceClaudeDir: (workspaceId) => getWorkspacePaths(workspaceId).dir,
      // 훅 wsDir(<storageRoot>/workspaces/<id>) == getWorkspacePaths(id).dir.
      hookCaptureDir: (workspaceId) => getWorkspacePaths(workspaceId).dir,
      logger: {
        log: (m) => log.info(m),
        warn: (m) => log.warn(m)
      }
    })
  }
  return _coreCliAdapters
}
