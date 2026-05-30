// workspace.json read-modify-write 직렬화용 비동기 mutex.
//
// 같은 workspaceId의 모든 메타 변경(addSession / updateSessionMeta / updateWorkspaceMeta /
// deleteSession / touchWorkspace)이 lock을 거쳐 한 줄로 처리된다. 다른 workspaceId끼리는
// 병렬 가능. 단일 main process 안에서만 작동하는 in-process lock — OS fcntl/flock은 아니다.
// AgentBridge가 workspace.json의 유일한 writer이므로 in-process 보호로 race 차단 충분.
//
// 보호하려는 race (이게 없으면):
//   T=0  작업 A: loadWorkspace → 사본 v1
//   T=1  작업 B: loadWorkspace → 사본 v1 (A가 아직 write 안 함)
//   T=2  작업 A: writeAtomic(v1 + A의 변경)
//   T=3  작업 B: writeAtomic(v1 + B의 변경) ← A의 변경 통째로 덮어짐
//
// 구현 패턴: workspaceId별 promise tail을 유지. 다음 작업은 tail에 chain한다.
// 직전 작업이 throw해도 다음 작업이 대기 풀리도록 catch().

const tails = new Map<string, Promise<unknown>>()

export async function withWorkspaceLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(workspaceId) ?? Promise.resolve()
  const next: Promise<T> = prev.catch(() => undefined).then(() => fn())
  tails.set(workspaceId, next)
  try {
    return await next
  } finally {
    // 자기가 tail의 마지막이면 정리. 뒤에 줄 선 작업이 있으면 그게 tail을 차지하고 있어 정리 X.
    if (tails.get(workspaceId) === next) tails.delete(workspaceId)
  }
}
