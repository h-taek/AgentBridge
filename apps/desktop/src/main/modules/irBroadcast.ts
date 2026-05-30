import { IpcChannel, type IrUpdatedEvent } from '@shared/ipc'
import { sendToWorkspaceWindow } from './windowManager'

// M3.6 C — workspaceId 매칭 윈도우에만 전송. 다른 워크스페이스 윈도우에 노이즈 broadcast는 무의미.
export function broadcastIrUpdated(evt: IrUpdatedEvent): void {
  sendToWorkspaceWindow(evt.workspaceId, IpcChannel.IrUpdated, evt)
}
