import { watch, type FSWatcher } from 'fs'
import type { WebContents } from 'electron'
import log from 'electron-log/main'
import { readAppendedBytes, readOwner, isOwnerAlive } from '@agentbridge/core'
import {
  IpcChannel,
  type MirrorDataEvent,
  type MirrorEndedEvent,
  type MirrorStartResult,
  type SessionOwnerInfo
} from '@shared/ipc'
import { getSessionPaths } from './workspaceStore'

// 다른 프로세스가 라이브로 소유한 세션을 *읽기 전용*으로 따라 그리기 위한 replay.log tail +
// owner.json 감시. PTY를 띄우지 않는다 (대화 분기 방지, Plan 2b).
//
// 소유 앱(익스텐션 등)이 replay.log에 append하면 그 새 bytes만 renderer로 흘린다.
// owner.json이 사라지거나 소유 pid가 죽으면 mirror:ended 통보 후 감시 종료.
//
// 감시 방식: fs.watch(세션 디렉토리) primary + 1초 폴링 폴백(fs.watch 미지원/누락 환경).
// 두 경로 모두 drain()을 호출하고, drain은 in-flight 가드 + 오프셋으로 중복/순서 문제를 막는다.

type Mirror = {
  workspaceId: string
  sessionId: string
  sessionDir: string
  replayPath: string
  sender: WebContents
  offset: number
  watcher: FSWatcher | null
  poll: ReturnType<typeof setInterval> | null
  draining: boolean
  ended: boolean
}

const mirrors = new Map<string, Mirror>()
const POLL_MS = 1000

function key(workspaceId: string, sessionId: string): string {
  return `${workspaceId}:${sessionId}`
}

// owner.json을 읽어 SessionOwnerInfo로. 없거나 죽었으면 null.
async function readLiveOwner(
  sessionDir: string,
  sessionId: string
): Promise<SessionOwnerInfo | null> {
  const owner = await readOwner(sessionDir)
  if (!owner || !isOwnerAlive(owner)) return null
  return { sessionId, app: owner.app, cols: owner.cols, rows: owner.rows }
}

async function drain(m: Mirror): Promise<void> {
  if (m.draining || m.ended) return
  m.draining = true
  try {
    const { data, newOffset } = await readAppendedBytes(m.replayPath, m.offset)
    m.offset = newOffset
    if (data && !m.sender.isDestroyed()) {
      const evt: MirrorDataEvent = { sessionId: m.sessionId, data }
      m.sender.send(IpcChannel.MirrorData, evt)
    }
    // 소유 종료 감지 — owner.json 소멸 또는 pid 사망.
    const owner = await readOwner(m.sessionDir)
    if (!owner || !isOwnerAlive(owner)) {
      endMirror(m)
    }
  } catch (err) {
    log.warn(`mirrorWatcher drain 실패 (${key(m.workspaceId, m.sessionId)})`, err)
  } finally {
    m.draining = false
  }
}

function endMirror(m: Mirror): void {
  if (m.ended) return
  m.ended = true
  if (m.watcher) {
    try {
      m.watcher.close()
    } catch {
      /* noop */
    }
    m.watcher = null
  }
  if (m.poll) {
    clearInterval(m.poll)
    m.poll = null
  }
  if (!m.sender.isDestroyed()) {
    const evt: MirrorEndedEvent = { sessionId: m.sessionId }
    m.sender.send(IpcChannel.MirrorEnded, evt)
  }
  // 엔트리는 유지 — stopMirror가 명시 정리한다 (renderer가 화면을 계속 보여줄 수 있음).
}

// 읽기 전용 미러 시작. replay 스냅샷 + 소유자 반환 후 tail/owner 감시 시작.
export async function startMirror(
  workspaceId: string,
  sessionId: string,
  sender: WebContents
): Promise<MirrorStartResult> {
  // 기존 미러 있으면 정리 (재진입 방어).
  stopMirror(workspaceId, sessionId)

  const paths = getSessionPaths(workspaceId, sessionId)
  const snapshot = await readAppendedBytes(paths.replayLog, 0)
  const owner = await readLiveOwner(paths.dir, sessionId)

  const m: Mirror = {
    workspaceId,
    sessionId,
    sessionDir: paths.dir,
    replayPath: paths.replayLog,
    sender,
    offset: snapshot.newOffset,
    watcher: null,
    poll: null,
    draining: false,
    ended: false
  }
  mirrors.set(key(workspaceId, sessionId), m)

  // primary: 세션 디렉토리 watch (replay.log append / owner.json 소멸 모두 change로 잡음).
  try {
    m.watcher = watch(paths.dir, () => {
      void drain(m)
    })
    m.watcher.on('error', (err) => {
      log.warn(`mirrorWatcher fs.watch error (${key(workspaceId, sessionId)})`, err)
    })
  } catch (err) {
    log.warn(`mirrorWatcher fs.watch 미지원 — 폴링만 사용 (${key(workspaceId, sessionId)})`, err)
  }
  // fallback: 1초 폴링 (fs.watch 누락/미지원 환경).
  m.poll = setInterval(() => {
    void drain(m)
  }, POLL_MS)

  log.info('mirrorWatcher start', { workspaceId, sessionId, startOffset: m.offset, owner })
  return { replay: snapshot.data, owner }
}

export function stopMirror(workspaceId: string, sessionId: string): void {
  const k = key(workspaceId, sessionId)
  const m = mirrors.get(k)
  if (!m) return
  if (m.watcher) {
    try {
      m.watcher.close()
    } catch {
      /* noop */
    }
  }
  if (m.poll) clearInterval(m.poll)
  mirrors.delete(k)
  log.info('mirrorWatcher stop', { workspaceId, sessionId })
}

// 윈도우/앱 종료 시 일괄 정리.
export function stopAllMirrors(): void {
  for (const k of [...mirrors.keys()]) {
    const m = mirrors.get(k)
    if (!m) continue
    if (m.watcher) {
      try {
        m.watcher.close()
      } catch {
        /* noop */
      }
    }
    if (m.poll) clearInterval(m.poll)
    mirrors.delete(k)
  }
}
