import { app, BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'
import log from 'electron-log/main'
import { autoUpdater } from 'electron-updater'
import { IpcChannel, type AppUpdaterStatus } from '@shared/ipc'

// AgentBridge auto-update (electron-updater + electron-builder GitHub publish 채널).
//
// 동작:
//   - 부팅 직후 1회 + 6시간 주기로 GitHub Releases의 `latest-mac.yml` 조회
//   - 새 버전 발견 시 백그라운드 다운로드 → 다음 앱 종료 후 자동 설치 (native dialog 노출)
//   - 진행 상황 / 오류는 electron-log로 main.log에 누적 + renderer에 status broadcast
//   - renderer는 `app:checkForUpdates` IPC로 즉시 체크 trigger 가능 (설정 모달 "업데이트 확인" 버튼)
//
// 제약:
//   - dev 모드(electron-vite dev) 자체는 skip — 패키지된 .app만 실제 update 가능
//   - ad-hoc 서명(identity '-') 상태에선 macOS가 자동 설치를 거부할 수 있음. 다운로드까진 동작.
//     Apple Developer ID 인증서 + notarytool 통과 후에 update 흐름 완전 동작.

const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6시간

let scheduledPoll: NodeJS.Timeout | null = null
// 마지막 status를 메모리 캐시. 신규 구독자(예: 설정 모달 첫 오픈)에 즉시 전달.
let lastStatus: AppUpdaterStatus = { phase: 'idle' }
// 동시 in-flight 차단 — 사용자가 버튼 연타해도 한 번만 체크.
let inflight = false
// 초기화 됐는지(= dev 아니어서 listener 등록 끝났는지) 플래그.
let initialized = false

function setStatus(next: AppUpdaterStatus): void {
  lastStatus = next
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send(IpcChannel.AppUpdaterStatus, next)
  }
}

export function getCurrentUpdaterStatus(): AppUpdaterStatus {
  return lastStatus
}

// 외부 호출 — IPC 핸들러에서 사용. ok=false면 즉시 사유 반환.
export async function triggerManualCheck(): Promise<{
  ok: boolean
  reason?: string
}> {
  if (!initialized) {
    return { ok: false, reason: 'dev 모드라 자동 업데이트 비활성' }
  }
  if (inflight) {
    return { ok: false, reason: '이미 확인 중' }
  }
  inflight = true
  try {
    setStatus({ phase: 'checking' })
    await autoUpdater.checkForUpdates()
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn('appUpdater — manual check 실패', { err: message })
    setStatus({ phase: 'error', message })
    return { ok: false, reason: message }
  } finally {
    inflight = false
  }
}

export function initAppUpdater(): void {
  // dev에선 dev-app-update.yml이 존재해야만 동작. 본 프로젝트는 그 stub을 untrack(`HANDOFF.md`
  // 운영 정책)이라 일반 dev 흐름에선 skip이 안전. 사용자가 직접 dry-run을 원하면 stub을 둔 채로
  // forceDevUpdateConfig=true를 직접 toggle.
  if (is.dev) {
    log.info('appUpdater — dev 모드 skip')
    setStatus({ phase: 'skipped-dev' })
    return
  }

  autoUpdater.logger = log
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    log.info('appUpdater — checking for update')
    setStatus({ phase: 'checking' })
  })
  autoUpdater.on('update-available', (info) => {
    log.info('appUpdater — update available', { version: info.version })
    setStatus({ phase: 'available', version: info.version })
  })
  autoUpdater.on('update-not-available', (info) => {
    log.info('appUpdater — update not available', { version: info.version })
    setStatus({ phase: 'not-available', version: info.version })
  })
  autoUpdater.on('download-progress', (progress) => {
    log.info('appUpdater — download progress', {
      percent: Math.round(progress.percent),
      bytesPerSecond: progress.bytesPerSecond
    })
    // version은 update-available 시점 status에 들어가있지만, downloading payload엔 별도 필드 없음.
    // last status가 available/downloading이면 그 version 재사용, 그 외엔 빈 문자열.
    const version =
      lastStatus.phase === 'available' || lastStatus.phase === 'downloading'
        ? lastStatus.version
        : ''
    setStatus({
      phase: 'downloading',
      version,
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond
    })
  })
  autoUpdater.on('update-downloaded', (info) => {
    log.info('appUpdater — update downloaded (다음 종료 시 설치)', { version: info.version })
    setStatus({ phase: 'downloaded', version: info.version })
  })
  autoUpdater.on('error', (err) => {
    const message = err?.message ?? String(err)
    log.warn('appUpdater — error', { message })
    setStatus({ phase: 'error', message })
  })

  initialized = true

  const runCheck = (): void => {
    autoUpdater
      .checkForUpdatesAndNotify()
      .catch((err) => log.warn('appUpdater — checkForUpdates 실패', { err: String(err) }))
  }

  runCheck()
  scheduledPoll = setInterval(runCheck, POLL_INTERVAL_MS)
  app.on('before-quit', () => {
    if (scheduledPoll) {
      clearInterval(scheduledPoll)
      scheduledPoll = null
    }
  })
}
