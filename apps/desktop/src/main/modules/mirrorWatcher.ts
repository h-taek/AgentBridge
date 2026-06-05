import type { WebContents } from 'electron'
import log from 'electron-log/main'
import { createSessionMirror, type SessionMirror, type MirrorSink } from '@agentbridge/core'
import {
  IpcChannel,
  type MirrorDataEvent,
  type MirrorEndedEvent,
  type MirrorStartResult,
  type SessionOwnerInfo
} from '@shared/ipc'
import { getSessionPaths } from './workspaceStore'

// 데스크탑 어댑터 (Plan 2b) — 호스트 무관 미러 엔진(@agentbridge/core)에 Electron 바이트 전달과
// 세션 경로 해석을 주입한다. tail/owner 감시 등 본체 로직은 전부 core에 있다.

const mirrors = new Map<string, SessionMirror>()

function key(workspaceId: string, sessionId: string): string {
  return `${workspaceId}:${sessionId}`
}

// WebContents로 바이트를 흘리는 싱크. isDestroyed로 생존 판정.
function webContentsSink(sender: WebContents, sessionId: string): MirrorSink {
  return {
    onData(data: string) {
      const evt: MirrorDataEvent = { sessionId, data }
      sender.send(IpcChannel.MirrorData, evt)
    },
    onEnded() {
      const evt: MirrorEndedEvent = { sessionId }
      sender.send(IpcChannel.MirrorEnded, evt)
    },
    isAlive() {
      return !sender.isDestroyed()
    }
  }
}

// 읽기 전용 미러 시작. replay 스냅샷 + 소유자(IPC 형태) 반환 후 tail/owner 감시 시작.
export async function startMirror(
  workspaceId: string,
  sessionId: string,
  sender: WebContents
): Promise<MirrorStartResult> {
  // 기존 미러 있으면 정리 (재진입 방어).
  stopMirror(workspaceId, sessionId)

  const paths = getSessionPaths(workspaceId, sessionId)
  const mirror = createSessionMirror({
    sessionDir: paths.dir,
    replayPath: paths.replayLog,
    sink: webContentsSink(sender, sessionId),
    logger: log
  })
  mirrors.set(key(workspaceId, sessionId), mirror)

  const { replay, owner } = await mirror.start()
  const ownerInfo: SessionOwnerInfo | null = owner
    ? { sessionId, app: owner.app, cols: owner.cols, rows: owner.rows }
    : null
  return { replay, owner: ownerInfo }
}

export function stopMirror(workspaceId: string, sessionId: string): void {
  const k = key(workspaceId, sessionId)
  const mirror = mirrors.get(k)
  if (!mirror) return
  mirror.stop()
  mirrors.delete(k)
  log.info('mirrorWatcher stop', { workspaceId, sessionId })
}

// 윈도우/앱 종료 시 일괄 정리.
export function stopAllMirrors(): void {
  for (const [k, mirror] of mirrors) {
    mirror.stop()
    mirrors.delete(k)
  }
}
