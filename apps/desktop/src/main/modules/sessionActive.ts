import type { CliKind } from '@shared/ipc'

// M3 L1 청크 — workspace 단위 다중 active session 추적 (휘발성, main 프로세스 메모리만).
// 한 워크스페이스에 *여러 모델 PTY*가 동시 활성 가능 — 사용자가 탭 추가하면 그만큼 sessionActive에 등록.
//
// architecture §14.3 새 모듈 (threadActive를 단일 active 가정에서 다중 지원으로 진화).
// threadActive는 M2 H 흐름(handoff:commit) 그대로 유지 — L 청크에서 UI가 새 IPC로
// 전환 완료 후 deprecate.

export type ActiveSession = {
  workspaceId: string
  sessionId: string
  ptySessionId: string
  // null = 모델 native session ID 비동기 캡처 대기 중 (codex 패턴)
  modelSessionId: string | null
  model: CliKind
}

// key = `${workspaceId}:${sessionId}` — workspace 단위로 여러 sessions 동시 가능
const active = new Map<string, ActiveSession>()

function makeKey(workspaceId: string, sessionId: string): string {
  return `${workspaceId}:${sessionId}`
}

export function setActiveSession(s: ActiveSession): void {
  active.set(makeKey(s.workspaceId, s.sessionId), s)
}

export function getActiveSession(
  workspaceId: string,
  sessionId: string
): ActiveSession | undefined {
  return active.get(makeKey(workspaceId, sessionId))
}

export function clearActiveSession(workspaceId: string, sessionId: string): void {
  active.delete(makeKey(workspaceId, sessionId))
}

// handoff/commit과 동일 패턴 — 새 spawn이 직전 활성을 등록한 후 *직전 PTY*의 onExit이
// 늦게 도착해 새 매핑을 잘못 지우는 race 방지. 지정한 ptySessionId일 때만 clear.
export function clearActiveSessionIfMatches(
  workspaceId: string,
  sessionId: string,
  ptySessionId: string
): boolean {
  const cur = getActiveSession(workspaceId, sessionId)
  if (!cur) return false
  if (cur.ptySessionId !== ptySessionId) return false
  active.delete(makeKey(workspaceId, sessionId))
  return true
}

export function updateActiveSessionModelId(
  workspaceId: string,
  sessionId: string,
  modelSessionId: string
): void {
  const cur = getActiveSession(workspaceId, sessionId)
  if (!cur) return
  cur.modelSessionId = modelSessionId
}

// workspace 안 모든 active session — UI activity feed / 다중 탭 표시용
export function listActiveSessionsInWorkspace(workspaceId: string): ActiveSession[] {
  const out: ActiveSession[] = []
  for (const s of active.values()) {
    if (s.workspaceId === workspaceId) out.push(s)
  }
  return out
}

// ptySessionId 역인덱스 — IPC sender 소유권 가드(pty:*) 전용.
// 한 워크스페이스 = 한 윈도우 정책상 ptySessionId → workspaceId 매핑이 유일.
export function findActiveSessionByPty(ptySessionId: string): ActiveSession | undefined {
  for (const s of active.values()) {
    if (s.ptySessionId === ptySessionId) return s
  }
  return undefined
}
