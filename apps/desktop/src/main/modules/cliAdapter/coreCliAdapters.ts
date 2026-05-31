// 코어 createCliAdapters 인스턴스 lazy singleton.
//
// 2026-06-01 Phase 5: 데스크탑이 코어 createCliAdapters로 buildSpawnOptions 위임.
// 데스크탑 자체 hookInstaller(함수 export 패턴)를 코어 HookInstaller 인터페이스에 wrap.

import { app } from 'electron'
import log from 'electron-log/main'
import { createCliAdapters, type CliAdapterSet, type HookInstaller } from '@agentbridge/core'
import { installHooksForSession } from '../hookInstaller'
import { getCoreEnvProbe } from '../envProbe'
import { getWorkspacePaths } from '../workspaceStore'

function createDesktopHookInstaller(): HookInstaller {
  const userDataPath = app.getPath('userData')
  return {
    async installClaudeHooks(workspaceClaudeDir: string, workspaceId: string): Promise<string> {
      const result = await installHooksForSession({
        model: 'claude',
        workspaceId,
        workspaceCwd: '',
        workspaceSettingsDir: workspaceClaudeDir,
        userDataPath
      })
      return result.claudeSettingsPath ?? ''
    },
    async installCodexHooks(cwd: string, workspaceId: string) {
      const result = await installHooksForSession({
        model: 'codex',
        workspaceId,
        workspaceCwd: cwd,
        workspaceSettingsDir: '',
        userDataPath
      })
      return { hooksJsonPath: result.codexHooksJsonPath ?? '', configTomlPath: '' }
    },
    async installAgyHooks(cwd: string, workspaceId: string) {
      const result = await installHooksForSession({
        model: 'agy',
        workspaceId,
        workspaceCwd: cwd,
        workspaceSettingsDir: '',
        userDataPath
      })
      return { hooksJsonPath: result.agyHooksJsonPath ?? '' }
    }
  }
}

let _coreCliAdapters: CliAdapterSet | null = null

export function getCoreCliAdapters(): CliAdapterSet {
  if (!_coreCliAdapters) {
    _coreCliAdapters = createCliAdapters({
      envProbe: getCoreEnvProbe(),
      hookInstaller: createDesktopHookInstaller(),
      // hookStatusStore 미주입 — 데스크탑은 hook 실패 처리 자체 시스템 (workspacesHandlers).
      workspaceClaudeDir: (workspaceId) => getWorkspacePaths(workspaceId).settingsDir,
      logger: {
        log: (m) => log.info(m),
        warn: (m) => log.warn(m)
      }
    })
  }
  return _coreCliAdapters
}
