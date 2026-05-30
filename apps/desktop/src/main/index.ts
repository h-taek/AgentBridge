import { app, shell, BrowserWindow, ipcMain, dialog, Menu } from 'electron'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import log from 'electron-log/main'
import * as path from 'node:path'
import { IpcChannel } from '@shared/ipc'
import type { AppHealth, AppUpdaterCheckResult } from '@shared/ipc'
import { probeEnvOnce, getCliPath, getShellPath } from './modules/envProbe'
import { buildAdapterEnv } from './modules/cliAdapter/env'
import { ensureConversationDirs } from './modules/conversationStore'
import {
  ensureWorkspaceDirs,
  getCachedWorkspaceTitle,
  listWorkspaces,
  migrateThreadsToWorkspaces
} from './modules/workspaceStore'
import {
  killAllForce,
  killPty,
  killPtyAsync,
  resizePty,
  startPty,
  writePty
} from './modules/ptySession'
import { onUserInput } from './modules/turnRecorder'
import { registerProbeDeps } from './modules/cliQuotaTracker'
import { getCurrentUpdaterStatus, initAppUpdater, triggerManualCheck } from './modules/appUpdater'
import {
  applyAppIcon,
  getWorkspaceIdByWindow,
  hasAnyWindow,
  isAllowedExternalUrl,
  openWindow,
  registerWindowClosedHandler,
  registerWorkspaceTitleResolver
} from './modules/windowManager'
import {
  clearActiveSession,
  findActiveSessionByPty,
  listActiveSessionsInWorkspace
} from './modules/sessionActive'
import { registerIrHandlers } from './ipc/irHandlers'
import { registerMemoryHandlers } from './ipc/memoryHandlers'
import { registerWorkspacesHandlers } from './ipc/workspacesHandlers'
import { registerSettingsHandlers } from './ipc/settingsHandlers'
import { registerAttachHandlers } from './ipc/attachHandlers'
import { registerWindowHandlers } from './ipc/windowHandlers'

log.initialize()
log.transports.file.level = 'info'
log.transports.console.level = is.dev ? 'debug' : 'info'

// macOS 메뉴바 첫 항목 / About 다이얼로그 / 시스템 알림 sender 등에서 'Electron' 대신 표시.
// whenReady 전 호출 권장 (Electron docs). dev 모드 dock 라벨은 Electron.app/Contents/Info.plist
// CFBundleName이 우선이라 setName으로 못 잡음 — postinstall로 plist 패치 별도 적용.
app.setName('AgentBridge')

// macOS 메뉴바 — ⌘N(새 빈 윈도우 = HomePane) 액셀러레이터 + 표준 Edit 메뉴(복붙/잘라내기 등).
// autoHideMenuBar는 윈도우 단위로 켜져있어 메뉴 자체는 보이지 않지만 accelerator는 작동한다.
function buildApplicationMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CommandOrControl+N',
          click: () => openWindow({ workspaceId: null })
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? ([
              { type: 'separator' },
              { role: 'front' },
              { type: 'separator' },
              { role: 'window' }
            ] as Electron.MenuItemConstructorOptions[])
          : ([{ role: 'close' }] as Electron.MenuItemConstructorOptions[]))
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function registerIpcHandlers(userDataDir: string): void {
  ipcMain.handle(IpcChannel.AppHealth, async (): Promise<AppHealth> => {
    return {
      ok: true,
      version: app.getVersion(),
      electron: process.versions.electron ?? 'unknown',
      node: process.versions.node ?? 'unknown',
      chrome: process.versions.chrome ?? 'unknown',
      platform: process.platform,
      arch: process.arch,
      userDataDir,
      cwd: process.cwd()
    }
  })

  // 설정 모달 등에서 폴더/파일 reveal — shell.openPath. 허용 prefix만 통과.
  //   1) userData 디렉토리 안 (health.userDataDir 노출용)
  //   2) 등록된 워크스페이스 cwd 안 (instruction 파일 reveal용)
  //   renderer 변조 시 임의 로컬 파일/앱 트리거 차단.
  ipcMain.handle(IpcChannel.AppOpenPath, async (_e, target: string) => {
    if (typeof target !== 'string' || target.length === 0) return
    const resolved = path.resolve(target)
    const userData = app.getPath('userData')
    const inUserData = resolved === userData || resolved.startsWith(userData + path.sep)
    let allowed = inUserData
    if (!allowed) {
      try {
        const workspaces = await listWorkspaces()
        for (const ws of workspaces) {
          const wsPath = path.resolve(ws.workspacePath)
          if (resolved === wsPath || resolved.startsWith(wsPath + path.sep)) {
            allowed = true
            break
          }
        }
      } catch (err) {
        log.warn('app:openPath workspace lookup 실패', { err: String(err) })
      }
    }
    if (!allowed) {
      log.warn('app:openPath 거부 — prefix allowlist 위반', { target: resolved })
      return
    }
    await shell.openPath(resolved)
  })
  // 외부 URL (GitHub 등) — shell.openExternal. host allowlist 통과한 URL만 허용.
  ipcMain.handle(IpcChannel.AppOpenExternal, async (_e, url: string) => {
    if (!isAllowedExternalUrl(url)) {
      log.warn('app:openExternal 거부 — allowlist 위반', { url })
      return
    }
    await shell.openExternal(url)
  })

  // EnvProbe는 부팅 시 1회 캐시. 사용자가 CLI를 새로 설치한 경우 forceRefresh=true 옵션 추가는 후속.
  ipcMain.handle(IpcChannel.EnvProbe, async () => probeEnvOnce())

  // sender 윈도우가 ptySessionId를 소유한 워크스페이스의 윈도우인지 검증.
  // 한 워크스페이스 = 한 윈도우 정책상 sender의 BrowserWindow → workspaceId로 변환 후
  // 그 워크스페이스 안에 그 PTY가 active로 등록돼 있는지 확인.
  function senderOwnsPtySession(event: Electron.IpcMainInvokeEvent, ptySessionId: string): boolean {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return false
    const senderWorkspaceId = getWorkspaceIdByWindow(win)
    if (!senderWorkspaceId) return false
    const sess = findActiveSessionByPty(ptySessionId)
    return Boolean(sess && sess.workspaceId === senderWorkspaceId)
  }

  // pty:start는 임의 명령 실행 표면이라 IPC로 노출 안 함. PTY spawn은 sessions:create/open이
  // main 내부에서 어댑터 경유로 처리한다.
  ipcMain.handle(IpcChannel.PtyWrite, (event, sessionId: string, data: string) => {
    if (!senderOwnsPtySession(event, sessionId)) {
      log.warn('pty:write 거부 — sender 소유권 불일치', { sessionId })
      return
    }
    // TurnRecorder는 PTY write *전*에 통지 — Enter/DEL/Ctrl-C는 PTY 도달 전 buffer에 반영해야
    // 사용자 시점과 turns.jsonl이 일치한다 (race 무관, 단 통지 순서만 보장).
    onUserInput(sessionId, data)
    writePty(sessionId, data)
  })
  ipcMain.handle(IpcChannel.PtyResize, (event, sessionId: string, cols: number, rows: number) => {
    if (!senderOwnsPtySession(event, sessionId)) {
      log.warn('pty:resize 거부 — sender 소유권 불일치', { sessionId })
      return
    }
    resizePty(sessionId, cols, rows)
  })
  ipcMain.handle(IpcChannel.PtyKill, (event, sessionId: string) => {
    if (!senderOwnsPtySession(event, sessionId)) {
      log.warn('pty:kill 거부 — sender 소유권 불일치', { sessionId })
      return
    }
    killPty(sessionId)
  })

  // 워크스페이스 폴더 native picker — Renderer는 input 직접 타이핑도 그대로 허용 (advanced 사용자용).
  ipcMain.handle(IpcChannel.DialogPickWorkspace, async (event, defaultPath?: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const opts: Electron.OpenDialogOptions = {
      title: '워크스페이스 폴더 선택',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: defaultPath && defaultPath.length > 0 ? defaultPath : undefined
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })

  // 자동 업데이트 — renderer "업데이트 확인" 버튼이 호출. 즉시 status 반환 + 후속 broadcast.
  ipcMain.handle(IpcChannel.AppUpdaterCheck, async (): Promise<AppUpdaterCheckResult> => {
    const res = await triggerManualCheck()
    return { ok: res.ok, reason: res.reason, status: getCurrentUpdaterStatus() }
  })
  // 마지막 status 즉시 조회 — 설정 모달 마운트 시 초기 표시용. trigger 없음.
  ipcMain.handle(IpcChannel.AppUpdaterGet, () => getCurrentUpdaterStatus())

  registerIrHandlers()
  registerMemoryHandlers()
  registerWorkspacesHandlers()
  registerSettingsHandlers()
  registerAttachHandlers()
  registerWindowHandlers()
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.htaek.agentbridge')
  applyAppIcon()

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  const dirs = await ensureConversationDirs()
  // M3 K — workspace 디렉토리 구조 + 비파괴 마이그레이션 (기존 threads/는 그대로 유지).
  // L 청크에서 UI가 새 IPC로 전환할 때 마이그레이션 결과 활용.
  await ensureWorkspaceDirs()
  try {
    const migration = await migrateThreadsToWorkspaces(dirs.threads)
    if (migration.scanned > 0) {
      log.info('thread → workspace 마이그레이션', {
        scanned: migration.scanned,
        migrated: migration.migrated,
        skipped: migration.skipped,
        recovered: migration.recovered,
        alreadyMigrated: migration.alreadyMigrated,
        errorCount: migration.errors.length
      })
      if (migration.recovered > 0) {
        log.info(
          `마이그레이션 — 손상 thread JSON ${migration.recovered}건 복구 (race condition 잔재)`
        )
      }
      if (migration.errors.length > 0) {
        log.warn('마이그레이션 일부 실패', migration.errors)
      }
    }
  } catch (err) {
    log.warn('thread → workspace 마이그레이션 실패 (M1/M2 흐름엔 영향 없음)', err)
  }
  // 빈 워크스페이스 자동 정리 폐기 — 사용자가 빈 세션을 삭제했더라도 워크스페이스 자체는
  // 유지되어야 한다 (+ 로 세션 재추가 / 휴지통으로 명시 삭제). UI에서도 빈 ws를 표시한다.
  // EnvProbe 캐시 워밍 — 어댑터(claude/codex/gemini)가 동기 조회로 절대경로/shellPath 사용.
  // 실패해도 throw하지 않고 IPC 핸들러가 다시 시도할 수 있도록 best-effort.
  try {
    const env = await probeEnvOnce()
    log.info('EnvProbe ready', {
      shellPathError: env.shellPathError,
      clis: env.clis.map((c) => ({ kind: c.kind, found: c.found, path: c.path }))
    })
  } catch (err) {
    log.warn('EnvProbe 초기 워밍 실패 — 첫 IPC 호출에서 재시도', err)
  }
  // Background quota probe — cliQuotaTracker가 ptySession을 *순환 import 없이* 사용하도록 inject.
  // getCliPath는 매 probe 호출 시점에 평가 — EnvProbe 캐시가 늦게 채워지더라도 최신 path 반영.
  registerProbeDeps({
    startPty: (req, sender, hooks) => startPty(req, sender, hooks),
    killPty: (sessionId) => killPty(sessionId),
    writePty: (sessionId, data) => writePty(sessionId, data),
    getCliPath: (cli) => getCliPath(cli) ?? null,
    buildEnv: () => buildAdapterEnv({ shellPath: getShellPath() })
  })
  log.info('AgentBridge ready', { userData: dirs.root, version: app.getVersion() })
  registerIpcHandlers(dirs.root)
  buildApplicationMenu()

  // 윈도우 제목바 / dock 메뉴 라벨 — workspaceStore의 동기 캐시에서 조회.
  registerWorkspaceTitleResolver(getCachedWorkspaceTitle)
  // 워크스페이스 윈도우 닫기 → 그 워크스페이스의 활성 PTY 정리(SIGTERM grace). 멀티 윈도우에서
  // 윈도우 close = 그 워크스페이스 작업 중단으로 해석. 안 죽이면 sessionActive Map에 좀비 잔존.
  registerWindowClosedHandler((workspaceId) => {
    const actives = listActiveSessionsInWorkspace(workspaceId)
    if (actives.length === 0) return
    log.info('window closed — cleaning active PTYs', {
      workspaceId,
      count: actives.length
    })
    for (const s of actives) {
      void killPtyAsync(s.ptySessionId).catch(() => undefined)
      clearActiveSession(workspaceId, s.sessionId)
    }
  })

  openWindow({ workspaceId: null })

  app.on('activate', function () {
    if (!hasAnyWindow()) openWindow({ workspaceId: null })
  })

  // GitHub Releases 기반 auto-update — dev 모드 skip / ad-hoc 빌드에선 다운로드까지만 동작.
  initAppUpdater()
})

app.on('window-all-closed', () => {
  // dev 환경에서는 macOS에서도 창 닫기 = 완전 종료. 프로덕션 빌드는 macOS 표준(dock 잔존) 유지.
  // dev에서 표준을 따르면 X 닫아도 npm/electron 프로세스가 살아남아 다음 dev 실행 시 포트 충돌·
  // 좀비 프로세스 누적 등 부담 발생.
  if (process.platform !== 'darwin' || is.dev) {
    app.quit()
  }
})

// 앱 종료 — 모든 PTY 즉시 SIGKILL + 1.5초 hard exit timeout.
//   grace SIGTERM은 일부 자식(login shell, claude/codex/gemini 일부 상황)이 응답 안 해
//   stdio pipe가 살아남아 main process가 hang하는 케이스가 있음. 종료 시점엔 데이터 보존 의미
//   없으므로 즉시 SIGKILL. 그래도 다른 이벤트 루프 작업(파일 flush, child_process, 등)이
//   pending이면 hard timeout으로 process.exit(0). 정상 흐름이면 timeout 전에 자연 종료.
let isQuitting = false
app.on('before-quit', () => {
  if (isQuitting) return
  isQuitting = true
  log.info('before-quit — PTY SIGKILL all + arming hard exit timeout')
  killAllForce()
  setTimeout(() => {
    log.warn('before-quit — hard exit timeout fired, calling process.exit(0)')
    process.exit(0)
  }, 1500)
})
