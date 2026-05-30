import { ipcMain, IpcMainInvokeEvent, BrowserWindow } from 'electron'
import log from 'electron-log/main'
import { IpcChannel } from '@shared/ipc'
import type {
  WindowBootstrap,
  WindowClaimWorkspaceRequest,
  WindowClaimWorkspaceResult,
  WindowOpenWorkspaceRequest
} from '@shared/ipc'
import {
  claimWorkspaceForWindow,
  getWorkspaceIdByWindow,
  openWindow,
  releaseWorkspaceForWindow
} from '../modules/windowManager'
import { loadWorkspace } from '../modules/workspaceStore'

// M3.6 C — 멀티 윈도우 IPC.
//   window:openWorkspace — renderer가 "이 워크스페이스를 새/기존 윈도우로 열어줘" 요청.
//     중복 열림은 windowManager.openWindow에서 focus만으로 처리.
//   window:getBootstrap — renderer 부팅 직후 자기 윈도우가 어느 워크스페이스인지 조회.
//     null이면 HomePane을 렌더한다.
async function handleWindowOpenWorkspace(
  _event: IpcMainInvokeEvent,
  req: WindowOpenWorkspaceRequest
): Promise<void> {
  if (!req || typeof req !== 'object') return
  const workspaceId = req.workspaceId === null ? null : String(req.workspaceId)
  if (workspaceId !== null && workspaceId.length === 0) return
  // workspaceId가 있으면 캐시 보장 — 다른 윈도우가 한 번도 list/load 안 했을 수 있으므로 여기서
  // loadWorkspace로 title 캐시를 채워야 윈도우 제목바가 정확하게 표시된다. 메타 미존재(stale)는
  // 조용히 무시 — openWindow는 그대로 호출하되 제목바는 'AgentBridge' 폴백.
  if (workspaceId !== null) {
    try {
      await loadWorkspace(workspaceId)
    } catch (err) {
      log.warn('window:openWorkspace — loadWorkspace 실패 (title cache 미충전)', {
        workspaceId,
        err: String(err)
      })
    }
  }
  openWindow({ workspaceId })
}

async function handleWindowGetBootstrap(event: IpcMainInvokeEvent): Promise<WindowBootstrap> {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) {
    log.warn('window:getBootstrap — sender BrowserWindow 매핑 실패, null 반환')
    return { workspaceId: null }
  }
  return { workspaceId: getWorkspaceIdByWindow(win) }
}

// 한 워크스페이스 = 한 윈도우 정책 강화 — renderer가 ws attach 전에 호출.
async function handleWindowClaimWorkspace(
  event: IpcMainInvokeEvent,
  req: WindowClaimWorkspaceRequest
): Promise<WindowClaimWorkspaceResult> {
  const senderWin = BrowserWindow.fromWebContents(event.sender)
  if (!senderWin) {
    log.warn('window:claimWorkspace — sender BrowserWindow 매핑 실패')
    // sender 매핑이 깨졌으면 attach 진행 보류가 안전.
    return { outcome: 'focused-other' }
  }
  if (typeof req?.workspaceId !== 'string' || req.workspaceId.length === 0) {
    return { outcome: 'focused-other' }
  }
  // 캐시 보장 — claim 후 즉시 제목바 갱신을 위해.
  try {
    await loadWorkspace(req.workspaceId)
  } catch {
    /* title 캐시 미충전 — 'AgentBridge' 폴백 */
  }
  const outcome = claimWorkspaceForWindow(senderWin, req.workspaceId)
  return { outcome }
}

async function handleWindowReleaseWorkspace(event: IpcMainInvokeEvent): Promise<void> {
  const senderWin = BrowserWindow.fromWebContents(event.sender)
  if (!senderWin) return
  releaseWorkspaceForWindow(senderWin)
}

export function registerWindowHandlers(): void {
  ipcMain.handle(IpcChannel.WindowOpenWorkspace, handleWindowOpenWorkspace)
  ipcMain.handle(IpcChannel.WindowGetBootstrap, handleWindowGetBootstrap)
  ipcMain.handle(IpcChannel.WindowClaimWorkspace, handleWindowClaimWorkspace)
  ipcMain.handle(IpcChannel.WindowReleaseWorkspace, handleWindowReleaseWorkspace)
}
