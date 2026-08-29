// CaptureManager facade — 2026-06-07 M2-5: 턴 기록을 PTY 스크래핑 → transcript 읽기로 전환(설계 §E).
// chatPanel은 세션을 매니저에 등록만 하고, 매니저가 종료 훅 신호를 받아 그 신호가 실어 온
// transcript를 읽어 turns.jsonl을 쌓는다(0.5.0 A-2). 표시는 PTY 유지.

import { CaptureManager, maybeAutoNameSession, type TurnsAssistantDetail } from '@agentbridge/core';
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
  // 훅이 이 세션의 종료 신호를 쓰는 파일. 어댑터가 SpawnOptions로 넘긴다.
  signalFilePath: string;
  // 자동 명명이 실제로 제목을 정했을 때 호출 — 호스트가 열린 탭 제목을 갱신(panel.title은 생성 시 1회성).
  onAutoNamed?: (title: string) => void;
}): void {
  manager.register({
    workspaceId: args.workspaceId,
    workspaceRoot: workspaceStore.getWorkspacePath(args.workspaceId),
    workspacePath: args.workspacePath,
    sessionId: args.sessionId,
    model: args.model,
    signalFilePath: args.signalFilePath,
    getDetail: () => getConfig().assistantDetail as TurnsAssistantDetail,
    scheduler: getCompactionScheduler(),
    onTurnFlushed: async ({ workspaceId, sessionId, flushedAt }) => {
      const store = getWorkspaceStore();
      // 옛 sessionRegistry.updateActivity 대체 — workspace.json sessions[]에 lastChattedAt 갱신.
      try {
        await store.updateSessionMeta(workspaceId, sessionId, {
          lastChattedAt: flushedAt,
        });
      } catch {
        /* non-fatal */
      }
      // 자동 세션 이름 — 첫 nameable 턴으로 1회 명명(기존 title 보호). 실패는 무시.
      try {
        await maybeAutoNameSession({
          workspaceRoot: workspaceStore.getWorkspacePath(workspaceId),
          sessionId,
          getCurrentTitle: async () => (await store.loadSession(workspaceId, sessionId)).title,
          setTitle: async (title) => {
            await store.updateSessionMeta(workspaceId, sessionId, { title });
            args.onAutoNamed?.(title);
          },
        });
      } catch {
        /* non-fatal */
      }
    },
  });
}

// 세션 종료 — finalize로 carry의 마지막 열린 턴 flush. deactivate는 panel별 disposeAndFlush가 호출.
export function unregisterCapture(sessionId: string): Promise<void> {
  return manager.unregister(sessionId);
}
