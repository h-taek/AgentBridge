import { ipcMain } from 'electron'
import log from 'electron-log/main'
import {
  IpcChannel,
  type AppSettings,
  type QuotaProbeRequest,
  type QuotaProbeResult,
  type QuotaSnapshotsByCli
} from '@shared/ipc'
import { loadSettings, saveSettings } from '../modules/settings'
import { getAllQuotaSnapshots, probeQuotaInBackground } from '../modules/cliQuotaTracker'
import { broadcastToAll } from '../modules/windowManager'

// settings:get/set — refineModel 정책 토글에 사용.
async function handleSettingsGet(): Promise<AppSettings> {
  return loadSettings()
}

async function handleSettingsSet(_e: unknown, patch: Partial<AppSettings>): Promise<AppSettings> {
  log.info('settings:set', patch)
  const next = await saveSettings(patch)
  // 다른 패널/윈도우에 즉시 반영 (RefineSettingsPanel/IrPanel 활성 CLI 라벨 등).
  broadcastToAll(IpcChannel.SettingsUpdated, next)
  return next
}

// quota:get — 세 CLI 영속화된 snapshot 일괄. UI 폴링.
async function handleQuotaGet(): Promise<QuotaSnapshotsByCli> {
  return getAllQuotaSnapshots()
}

// quota:probe — 특정 CLI를 background PTY spawn + 슬래시 명령 + 응답 캡처 + cleanup.
// 사용자 명시 액션(RefineSettingsPanel "지금 확인" 버튼) 또는 refine 후 자동 호출.
async function handleQuotaProbe(_e: unknown, req: QuotaProbeRequest): Promise<QuotaProbeResult> {
  log.info('quota:probe 호출', { cli: req.cli })
  return probeQuotaInBackground(req.cli)
}

export function registerSettingsHandlers(): void {
  ipcMain.handle(IpcChannel.SettingsGet, handleSettingsGet)
  ipcMain.handle(IpcChannel.SettingsSet, handleSettingsSet)
  ipcMain.handle(IpcChannel.QuotaGet, handleQuotaGet)
  ipcMain.handle(IpcChannel.QuotaProbe, handleQuotaProbe)
}
