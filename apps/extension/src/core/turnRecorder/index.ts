// Facade — 코어 TurnRecorder를 익스텐션 원본 생성자(positional 인자) 시그니처로 wrap.

import { TurnRecorder as CoreTurnRecorder, type TurnsAssistantDetail } from '@agentbridge/core';
import type { CliKind } from '../../shared/types';
import * as workspaceStore from '../workspaceStore';
import { getCompactionScheduler, getWorkspaceStore, getLogger } from '../coreInstances';
import { getConfig } from '../../settings/config';

export class TurnRecorder {
  private readonly inner: CoreTurnRecorder;

  constructor(workspaceId: string, sessionId: string, model: CliKind, workspacePath: string) {
    this.inner = new CoreTurnRecorder({
      workspaceId,
      workspaceRoot: workspaceStore.getWorkspacePath(workspaceId),
      workspacePath,
      sessionId,
      model,
      getAssistantDetail: () => getConfig().assistantDetail as TurnsAssistantDetail,
      scheduler: getCompactionScheduler(),
      onTurnFlushed: async ({ workspaceId, sessionId, flushedAt }) => {
        // 옛 sessionRegistry.updateActivity 대체 — workspace.json sessions[]에 lastChattedAt 갱신.
        try {
          await getWorkspaceStore().updateSessionMeta(workspaceId, sessionId, {
            lastChattedAt: flushedAt,
          });
        } catch {
          /* non-fatal */
        }
      },
      logger: getLogger(),
    });
  }

  onUserInput(data: string): void {
    this.inner.onUserInput(data);
  }

  onAssistantData(data: string): void {
    this.inner.onAssistantData(data);
  }

  dispose(): void {
    this.inner.dispose();
  }

  // 비동기 flush가 필요한 종료 경로(deactivate)에서 사용.
  async disposeAndFlush(): Promise<void> {
    return this.inner.disposeAndFlush();
  }
}
