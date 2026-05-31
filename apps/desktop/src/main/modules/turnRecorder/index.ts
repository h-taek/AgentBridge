import log from 'electron-log/main'
import { IpcChannel, type CliKind, type TurnsUpdatedEvent } from '@shared/ipc'
import { TurnRecorder as CoreTurnRecorder, type TurnsAssistantDetail } from '@agentbridge/core'
import { sendToWorkspaceWindow } from '../windowManager'
import { getCoreCompactionScheduler } from '../compactionScheduler'
import { loadSettings } from '../settings'
import { getWorkspacePaths, updateSessionMeta } from '../workspaceStore'

// 2026-06-01 Phase 6.7: 코어 TurnRecorder 인스턴스로 전환.
// 옛 470줄(자체 RecorderState + ANSI skip + flush 로직)을 코어로 위임. 호스트 책임:
//   - ptySessionId → CoreTurnRecorder 인스턴스 매핑
//   - onTurnFlushed 콜백에서 updateSessionMeta(lastChattedAt) + broadcastTurnsUpdated

// M3.6 C — workspaceId 매칭 윈도우에만 전송.
export function broadcastTurnsUpdated(workspaceId: string): void {
  const evt: TurnsUpdatedEvent = { workspaceId }
  sendToWorkspaceWindow(workspaceId, IpcChannel.TurnsUpdated, evt)
}

const recorders = new Map<string, CoreTurnRecorder>()

export function registerRecorder(args: {
  workspaceId: string
  sessionId: string
  ptySessionId: string
  model: CliKind
  workspacePath: string
}): void {
  // 코어 TurnRecorder 인스턴스 생성. workspaceRoot는 workspaceStore에서 lookup.
  const workspaceRoot = getWorkspacePaths(args.workspaceId).dir
  void (async () => {
    try {
      const scheduler = await getCoreCompactionScheduler()
      const settings = await loadSettings()
      const recorder = new CoreTurnRecorder({
        workspaceId: args.workspaceId,
        workspaceRoot,
        workspacePath: args.workspacePath,
        sessionId: args.sessionId,
        model: args.model,
        getAssistantDetail: () => settings.turnsAssistantDetail as TurnsAssistantDetail,
        scheduler,
        onTurnFlushed: async ({ workspaceId, sessionId, flushedAt }) => {
          try {
            await updateSessionMeta(workspaceId, sessionId, { lastChattedAt: flushedAt })
          } catch (err) {
            log.warn('TurnRecorder lastChattedAt 갱신 실패 (non-fatal)', {
              workspaceId,
              sessionId,
              err: String(err)
            })
          }
          broadcastTurnsUpdated(workspaceId)
        },
        logger: {
          log: (m) => log.info(m),
          warn: (m) => log.warn(m)
        }
      })
      recorders.set(args.ptySessionId, recorder)
      log.info('TurnRecorder registered', {
        workspaceId: args.workspaceId,
        sessionId: args.sessionId,
        ptySessionId: args.ptySessionId,
        model: args.model
      })
    } catch (err) {
      log.warn('TurnRecorder register 실패', {
        ptySessionId: args.ptySessionId,
        err: String(err)
      })
    }
  })()
}

export function unregisterRecorder(ptySessionId: string): void {
  const r = recorders.get(ptySessionId)
  if (!r) return
  void r.disposeAndFlush().catch((err) => {
    log.warn('TurnRecorder unregister flush 실패', { ptySessionId, err: String(err) })
  })
  recorders.delete(ptySessionId)
}

export function onUserInput(ptySessionId: string, data: string): void {
  const r = recorders.get(ptySessionId)
  if (!r) {
    log.debug('TurnRecorder.onUserInput — recorder 미등록 (drop)', {
      ptySessionId,
      dataLen: data.length
    })
    return
  }
  r.onUserInput(data)
}

export function onAssistantData(ptySessionId: string, data: string): void {
  const r = recorders.get(ptySessionId)
  if (!r) return
  r.onAssistantData(data)
}
