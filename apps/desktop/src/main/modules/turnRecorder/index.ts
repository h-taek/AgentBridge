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

// V-08: registerRecorder는 scheduler/settings를 await한 뒤에야 recorder를 set한다. 그 사이 도착한
// 입력/출력을 drop하지 않고 ptySessionId별 버퍼에 모았다가, recorder 준비되면 도착 순서대로 재생.
// 등록 실패/취소 시 버퍼는 폐기. 비정상적으로 등록이 안 끝나는 경우 대비 버퍼 상한(메모리 보호).
type PendingEvent = { type: 'user' | 'assistant'; data: string }
const pendingEvents = new Map<string, PendingEvent[]>()
const PENDING_BUFFER_MAX_BYTES = 512 * 1024
const pendingBytes = new Map<string, number>()

export function registerRecorder(args: {
  workspaceId: string
  sessionId: string
  ptySessionId: string
  model: CliKind
  workspacePath: string
}): void {
  // 코어 TurnRecorder 인스턴스 생성. workspaceRoot는 workspaceStore에서 lookup.
  const workspaceRoot = getWorkspacePaths(args.workspaceId).dir
  // 등록 완료 전 도착하는 입력/출력을 버퍼링하도록 즉시(동기) 표시 (V-08).
  pendingEvents.set(args.ptySessionId, [])
  pendingBytes.set(args.ptySessionId, 0)
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
      // 등록 전 버퍼링된 입력/출력을 도착 순서대로 재생 (V-08).
      const buffered = pendingEvents.get(args.ptySessionId)
      pendingEvents.delete(args.ptySessionId)
      pendingBytes.delete(args.ptySessionId)
      if (buffered) {
        for (const e of buffered) {
          if (e.type === 'user') recorder.onUserInput(e.data)
          else recorder.onAssistantData(e.data)
        }
      }
      log.info('TurnRecorder registered', {
        workspaceId: args.workspaceId,
        sessionId: args.sessionId,
        ptySessionId: args.ptySessionId,
        model: args.model,
        replayed: buffered?.length ?? 0
      })
    } catch (err) {
      pendingEvents.delete(args.ptySessionId)
      pendingBytes.delete(args.ptySessionId)
      log.warn('TurnRecorder register 실패', {
        ptySessionId: args.ptySessionId,
        err: String(err)
      })
    }
  })()
}

export function unregisterRecorder(ptySessionId: string): void {
  // recorder 준비 전에 unregister된 경우 대비 — 버퍼도 폐기.
  pendingEvents.delete(ptySessionId)
  pendingBytes.delete(ptySessionId)
  const r = recorders.get(ptySessionId)
  if (!r) return
  void r.disposeAndFlush().catch((err) => {
    log.warn('TurnRecorder unregister flush 실패', { ptySessionId, err: String(err) })
  })
  recorders.delete(ptySessionId)
}

// 등록 전이면 도착 이벤트를 버퍼에 모은다(상한 내). 버퍼링/상한초과 처리 시 true,
// pending도 아니면 false(진짜 미등록 → 호출자가 drop 로그).
function bufferIfPending(ptySessionId: string, type: 'user' | 'assistant', data: string): boolean {
  const buf = pendingEvents.get(ptySessionId)
  if (!buf) return false
  const used = pendingBytes.get(ptySessionId) ?? 0
  if (used + data.length > PENDING_BUFFER_MAX_BYTES) {
    log.warn('TurnRecorder pending 버퍼 상한 초과 — 이후 이벤트 drop', { ptySessionId })
    return true
  }
  buf.push({ type, data })
  pendingBytes.set(ptySessionId, used + data.length)
  return true
}

// 앱 종료(before-quit) 시 모든 활성 recorder의 진행 중 turn을 flush 완료까지 await (V-07).
// 호출자가 await한 뒤 종료해야 마지막 턴이 turns.jsonl에 남는다.
export async function disposeAndFlushAll(): Promise<void> {
  const all = Array.from(recorders.values())
  recorders.clear()
  await Promise.allSettled(all.map((r) => r.disposeAndFlush()))
}

export function onUserInput(ptySessionId: string, data: string): void {
  const r = recorders.get(ptySessionId)
  if (r) {
    r.onUserInput(data)
    return
  }
  if (bufferIfPending(ptySessionId, 'user', data)) return
  log.debug('TurnRecorder.onUserInput — recorder 미등록 (drop)', {
    ptySessionId,
    dataLen: data.length
  })
}

export function onAssistantData(ptySessionId: string, data: string): void {
  const r = recorders.get(ptySessionId)
  if (r) {
    r.onAssistantData(data)
    return
  }
  bufferIfPending(ptySessionId, 'assistant', data)
}
