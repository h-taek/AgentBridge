// CaptureManager facade — 2026-06-07 M2-5: 턴 기록을 PTY 스크래핑 → transcript 읽기로 전환(설계 §E).
// chatPanel은 세션을 매니저에 등록만 하고, 매니저가 각 CLI transcript 파일을 fs.watch/폴링으로 읽어
// turns.jsonl을 쌓는다. 표시는 PTY 유지(webview output + replay.log는 chatPanel이 그대로 기록).

import { CaptureManager, type TurnsAssistantDetail } from '@agentbridge/core';
import type { CliKind } from '../../shared/types';
import * as workspaceStore from '../workspaceStore';
import { getCompactionScheduler, getWorkspaceStore, getLogger } from '../coreInstances';
import { getConfig } from '../../settings/config';

// logger는 호출 시점에 lazily 조회 (모듈 로드 시 coreInstances 미초기화 가능).
const manager = new CaptureManager({
  logger: {
    log: (m) => getLogger().log(m),
    warn: (m) => getLogger().warn(m),
  },
});

export function registerCapture(args: {
  workspaceId: string;
  sessionId: string;
  model: CliKind;
  workspacePath: string;
  // claude: jsonl 파일명(=sessionId, 통일 규약). codex/agy: native id(없으면 null → setCaptureModelSessionId 대기).
  modelSessionId: string | null;
}): void {
  manager.register({
    workspaceId: args.workspaceId,
    workspaceRoot: workspaceStore.getWorkspacePath(args.workspaceId),
    workspacePath: args.workspacePath,
    sessionId: args.sessionId,
    model: args.model,
    modelSessionId: args.modelSessionId,
    cwd: args.workspacePath,
    getDetail: () => getConfig().assistantDetail as TurnsAssistantDetail,
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
  });
}

// codex/agy 비동기 modelSessionId 캡처 시 호출 — 매니저가 그때 경로를 해석해 캡처 시작.
export function setCaptureModelSessionId(sessionId: string, modelSessionId: string, cwd: string): void {
  manager.setModelSessionId(sessionId, modelSessionId, cwd);
}

// 세션 종료 — finalize로 carry의 마지막 열린 턴 flush. deactivate는 panel별 disposeAndFlush가 호출.
export function unregisterCapture(sessionId: string): Promise<void> {
  return manager.unregister(sessionId);
}
