import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import log from 'electron-log/main'
import icon from '../../../resources/icon.png?asset'
import type { IpcChannelName } from '@shared/ipc'

// 외부 URL allowlist — `app:openExternal` IPC + `setWindowOpenHandler` 양쪽에서 사용.
// 현재 renderer가 여는 외부 URL은 GitHub 리포지토리/releases/issues 3 패턴(전부 github.com).
// renderer 변조 시에도 임의 호스트 reveal을 차단한다 (디펜스-인-뎁스).
const ALLOWED_EXTERNAL_HOSTS = new Set(['github.com'])

export function isAllowedExternalUrl(rawUrl: unknown): boolean {
  if (typeof rawUrl !== 'string') return false
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
  return ALLOWED_EXTERNAL_HOSTS.has(parsed.hostname)
}

// 워크스페이스 메타 → 윈도우 제목바 / dock 메뉴 라벨 조회용 콜백. 청크 5에서 register됨.
type WorkspaceTitleResolver = (workspaceId: string) => string | null
let titleResolver: WorkspaceTitleResolver | null = null
export function registerWorkspaceTitleResolver(fn: WorkspaceTitleResolver): void {
  titleResolver = fn
}

// 워크스페이스 윈도우 closed 시 callback — workspacesHandlers가 활성 PTY를 정리하도록 hook.
// layering: windowManager는 ptySession/workspaceStore에 의존하지 않고 callback만 호출.
type WindowClosedHandler = (workspaceId: string) => void
let closedHandler: WindowClosedHandler | null = null
export function registerWindowClosedHandler(fn: WindowClosedHandler): void {
  closedHandler = fn
}

// M3.6 C — 멀티 윈도우. 각 워크스페이스를 별도 BrowserWindow로 띄울 수 있게 main 측 윈도우 관리
// 인프라를 일원화한다. 청크 1은 단일 윈도우 동등 동작 보존이 목표 — 실제 워크스페이스 attach
// 분기는 청크 2(window:openWorkspace IPC + URL bootstrap) 이후.
//
// 윈도우는 두 부류:
//  - 워크스페이스 윈도우 (workspaceId !== null) — windowsByWorkspace Map. 한 워크스페이스당 1개 윈도우 정책(중복 열림 불허, 분기 2).
//  - 홈 윈도우 (workspaceId === null) — homeWindows Set. ⌘N으로 여러 개 열 수 있고 좌 사이드바에서 다른 워크스페이스 진입 lobby.

const windowsByWorkspace = new Map<string, BrowserWindow>()
const homeWindows = new Set<BrowserWindow>()
// close() 호출 후 destroyed 완료 전까지 — broadcast 대상에서 즉시 제외. close는 비동기라
// 그 사이 broadcast가 renderer에 도착하면 사용자가 home 전환 깜빡임을 본다.
const closingWindows = new WeakSet<BrowserWindow>()

export type OpenWindowOptions = {
  workspaceId: string | null
}

export function applyAppIcon(): void {
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(icon)
  }
}

function buildBrowserWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin'
  return new BrowserWindow({
    width: 1180,
    height: 760,
    // 최소 — MacBook 14인치 logical 해상도(1512×982)의 1/3. 좁은 화면에서는 AppShell이
    // 양 사이드바를 자동 접어 본문 영역만 보이도록 함.
    minWidth: 504,
    minHeight: 327,
    show: false,
    autoHideMenuBar: true,
    title: 'AgentBridge',
    backgroundColor: isMac ? '#00000000' : '#0c0c10',
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: 12, y: 9 },
          vibrancy: 'under-window',
          visualEffectState: 'active'
        }
      : {}),
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
}

function loadRenderer(win: BrowserWindow): void {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

export function openWindow(opts: OpenWindowOptions): BrowserWindow {
  const { workspaceId } = opts
  // 이미 같은 워크스페이스를 연 윈도우가 있으면 그쪽으로 focus만 (분기 2 — 중복 열림 불허).
  if (workspaceId) {
    const existing = windowsByWorkspace.get(workspaceId)
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.focus()
      return existing
    }
  }

  const win = buildBrowserWindow()
  if (workspaceId) {
    windowsByWorkspace.set(workspaceId, win)
  } else {
    homeWindows.add(win)
  }

  win.on('ready-to-show', () => {
    win.show()
  })

  win.webContents.setWindowOpenHandler((details) => {
    if (isAllowedExternalUrl(details.url)) {
      void shell.openExternal(details.url)
    } else {
      log.warn('windowOpenHandler 거부 — allowlist 위반', { url: details.url })
    }
    return { action: 'deny' }
  })

  // closed 콜백은 *현재 매핑* 기준으로 처리 — claim/release로 윈도우의 workspaceId가 reassign될 수
  // 있어 closure로 잡으면 안 됨. 윈도우 객체 참조로 windowsByWorkspace를 역추적해 현재 wid를 찾음.
  win.on('closed', () => {
    let currentWid: string | null = null
    for (const [wid, w] of windowsByWorkspace.entries()) {
      if (w === win) {
        currentWid = wid
        break
      }
    }
    if (currentWid) {
      windowsByWorkspace.delete(currentWid)
      if (closedHandler) {
        try {
          closedHandler(currentWid)
        } catch (err) {
          log.warn('windowManager closedHandler 실패', {
            workspaceId: currentWid,
            err: String(err)
          })
        }
      }
    } else {
      homeWindows.delete(win)
    }
    log.debug('windowManager — window closed', { workspaceId: currentWid })
    rebuildDockMenu()
  })

  loadRenderer(win)
  // 청크 2 URL bootstrap이 단순 IPC로 처리되므로 여기선 별도 query 없이 그냥 로드.
  // 제목바는 ready-to-show 후 비동기 갱신(refreshWindowTitle).
  if (workspaceId) refreshWindowTitle(workspaceId)
  rebuildDockMenu()
  return win
}

// 워크스페이스 제목으로 윈도우 제목바 갱신. titleResolver는 비동기 메모리 캐시이므로 호출 시점에
// 캐시 미스면 null — 그 경우 main이 비동기 loadWorkspace 후 다시 부르면 된다.
export function refreshWindowTitle(workspaceId: string): void {
  const win = windowsByWorkspace.get(workspaceId)
  if (!win || win.isDestroyed()) return
  const title = titleResolver?.(workspaceId)
  if (title && title.length > 0) {
    win.setTitle(title)
    rebuildDockMenu()
  }
}

// macOS dock 우클릭 메뉴 — 활성 워크스페이스 윈도우 list + 새 윈도우 액션.
// 비 macOS는 no-op. 호출은 윈도우 생성/종료/제목 변경 시점.
export function rebuildDockMenu(): void {
  if (process.platform !== 'darwin' || !app.dock) return
  const items: MenuItemConstructorOptions[] = []
  for (const [wid, w] of windowsByWorkspace.entries()) {
    if (w.isDestroyed()) continue
    const title = titleResolver?.(wid) ?? w.getTitle() ?? wid
    items.push({
      label: title,
      click: () => {
        if (w.isDestroyed()) return
        if (w.isMinimized()) w.restore()
        w.focus()
      }
    })
  }
  if (items.length > 0) items.push({ type: 'separator' })
  items.push({
    label: '새 윈도우',
    click: () => openWindow({ workspaceId: null })
  })
  app.dock.setMenu(Menu.buildFromTemplate(items))
}

export function getWorkspaceIdByWindow(win: BrowserWindow): string | null {
  for (const [wid, w] of windowsByWorkspace.entries()) {
    if (w === win) return wid
  }
  return null
}

// 워크스페이스 hard delete cascade — main 측에서 그 워크스페이스 윈도우를 처리한다.
// - 다른 윈도우가 더 남아 있으면: 그 ws 윈도우 close (멀티 윈도우 환경)
// - 그 윈도우가 유일한 윈도우라면: close 대신 home 상태로 reassign — 앱이 죽은 듯한 경험 회피.
//   renderer는 후속 `workspaces:changed(removedWorkspaceId)` broadcast 도착으로 HomePane 자동 폴백.
// 다른 윈도우의 좌 사이드바 list는 `workspaces:changed` broadcast로 별도 갱신.
export function closeWindowByWorkspaceId(workspaceId: string): void {
  const win = windowsByWorkspace.get(workspaceId)
  if (!win) return
  windowsByWorkspace.delete(workspaceId)
  if (win.isDestroyed()) {
    rebuildDockMenu()
    return
  }
  const remainingWindows = windowsByWorkspace.size + homeWindows.size
  if (remainingWindows === 0) {
    // 유일한 윈도우 — home으로 reassign.
    homeWindows.add(win)
    win.setTitle('AgentBridge')
    rebuildDockMenu()
    return
  }
  // close 진행 마커 — broadcastToAll이 이 윈도우에 메시지 안 보내도록 (renderer가 home 전환을
  // 한 프레임 그리는 깜빡임 회피).
  closingWindows.add(win)
  win.close()
}

export type ClaimOutcome = 'claimed' | 'focused-other' | 'already-mine'

// 한 워크스페이스 = 한 윈도우 정책 강화 진입점. renderer가 자기 윈도우(sender)에서 ws를 열려고 할 때
// 호출. 이미 다른 윈도우가 그 ws를 잡고 있으면 그 윈도우를 focus하고 'focused-other'를 반환 — 자기
// 윈도우는 attach하지 말아야 한다. sender가 그 ws를 이미 잡고 있으면 'already-mine'. 누구도 안 잡았으면
// sender가 claim(자기 윈도우의 이전 매핑은 제거 + homeWindows에서 제외).
export function claimWorkspaceForWindow(win: BrowserWindow, workspaceId: string): ClaimOutcome {
  const existing = windowsByWorkspace.get(workspaceId)
  if (existing && !existing.isDestroyed()) {
    if (existing === win) return 'already-mine'
    if (existing.isMinimized()) existing.restore()
    existing.focus()
    return 'focused-other'
  }
  // 자기 윈도우의 이전 매핑(다른 ws)이 있다면 제거 — 한 윈도우는 한 ws만.
  for (const [wid, w] of windowsByWorkspace.entries()) {
    if (w === win) windowsByWorkspace.delete(wid)
  }
  homeWindows.delete(win)
  windowsByWorkspace.set(workspaceId, win)
  refreshWindowTitle(workspaceId)
  rebuildDockMenu()
  return 'claimed'
}

// 자기 윈도우를 home 상태로 되돌림 — handleGoHome 호출 시. 워크스페이스 매핑 해제 + home 등록 +
// 제목바 리셋.
export function releaseWorkspaceForWindow(win: BrowserWindow): void {
  for (const [wid, w] of windowsByWorkspace.entries()) {
    if (w === win) windowsByWorkspace.delete(wid)
  }
  if (!win.isDestroyed()) {
    homeWindows.add(win)
    win.setTitle('AgentBridge')
  }
  rebuildDockMenu()
}

export function hasAnyWindow(): boolean {
  for (const w of windowsByWorkspace.values()) {
    if (!w.isDestroyed()) return true
  }
  for (const w of homeWindows) {
    if (!w.isDestroyed()) return true
  }
  return false
}

// broadcast scope —
//   sendToWorkspaceWindow : workspaceId 매칭 윈도우 1개에만 (ir:updated / turns:updated 등 workspace-scoped 이벤트)
//   broadcastToAll        : 모든 윈도우 (quota:updated / workspaces:removed 등 전역 이벤트)
// 매칭 윈도우 없는 workspaceId면 silent drop — 그 워크스페이스를 연 윈도우 없으므로 broadcast 의미 없음.
export function sendToWorkspaceWindow(
  workspaceId: string,
  channel: IpcChannelName,
  payload: unknown
): void {
  const win = windowsByWorkspace.get(workspaceId)
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send(channel, payload)
}

export function broadcastToAll(channel: IpcChannelName, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || w.webContents.isDestroyed()) continue
    if (closingWindows.has(w)) continue
    w.webContents.send(channel, payload)
  }
}
