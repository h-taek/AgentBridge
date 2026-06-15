import { IpcChannel, type ProposalsUpdatedEvent } from '@shared/ipc'
import { broadcastToAll } from './windowManager'

// main → renderer. 제안/문서는 default 프로필 단위로 모든 워크스페이스가 공유하므로
// workspace-scoped인 broadcastIrUpdated와 달리 전체 윈도우에 통지한다.
// (proposal:approve/discard IPC 핸들러 + 자동제안 패스(runProposalTrigger) 양쪽이 호출.)
// irBroadcast.ts와 같은 modules/ 위치 — 핸들러(ipc/)·스케줄러(modules/) 둘 다 여기서 import해
// modules/→ipc/ 역방향 의존을 없앤다.
export function broadcastProposalsUpdated(workspaceId: string): void {
  const evt: ProposalsUpdatedEvent = { workspaceId }
  broadcastToAll(IpcChannel.ProposalsUpdated, evt)
}
