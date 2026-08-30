// CaptureManager facade — 2026-06-07 M2-5: 턴 기록을 PTY 스크래핑 → transcript 읽기로 전환(설계 §E).
// chatPanel은 세션을 매니저에 등록만 하고, 매니저가 종료 훅 신호를 받아 그 신호가 실어 온
// transcript를 읽어 turns.jsonl을 쌓는다(0.5.0 A-2). 표시는 PTY 유지.

import {
  CaptureManager,
  maybeAutoNameSession,
  runSessionNaming,
  buildSessionNamePrompt,
  parseSessionName,
  type TurnsAssistantDetail,
} from '@agentbridge/core';
import type { CliKind } from '../../shared/types';
import * as workspaceStore from '../workspaceStore';
import {
  getCompactionScheduler,
  getWorkspaceStore,
  getCoreEnvProbe,
  getLogger,
  resolveRefineDecision,
} from '../coreInstances';
import { getConfig } from '../../settings/config';
import { setHookDisabled } from '../hookStatusStore';
import { getSessions, pickNamingCli } from '../sessionRegistry';

// 자동 명명 헤드리스 호출 상한. 정제·자동제안과 다른 값 — 명명은 짧은 첫 턴 하나만 보내는
// 가벼운 호출이라 더 짧게 잡는다(B-2 W7).
const SESSION_NAMING_TIMEOUT_MS = 20_000;

// logger는 호출 시점에 lazily 조회 (모듈 로드 시 coreInstances 미초기화 가능).
const manager = new CaptureManager({
  logger: {
    log: (m) => getLogger().log(m),
    warn: (m) => getLogger().warn(m),
  },
  // 신호가 왔는데 쓸 수 없으면 유추하지 않고 드러낸다 (0.5.0 A-2).
  onSignalUnusable: ({ sessionId, model, reason }) => {
    const workspaceId = signalWorkspaceIds.get(sessionId);
    if (workspaceId) setHookDisabled(workspaceId, model, reason, 'runtime');
  },
});

// onSignalUnusable이 워크스페이스를 알려면 등록 시점 매핑이 필요하다.
const signalWorkspaceIds = new Map<string, string>();

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
  signalWorkspaceIds.set(args.sessionId, args.workspaceId);
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
          // 헤드리스 모델 호출로 이름을 짓는다(runHeadlessAnalysis의 세 번째 소비자). refine 결정은
          // compaction 정제와 같은 계산을 쓴다. 실패는 non-fatal — maybeAutoNameSession이 절단으로
          // 폴백한다.
          generateName: async (userText) => {
            const cli = pickNamingCli(await getSessions(workspaceId), args.model);
            const choice = await runSessionNaming({
              decision: resolveRefineDecision(cli),
              prompt: buildSessionNamePrompt({ userText }),
              envProbe: getCoreEnvProbe(),
              logger: { log: (m) => getLogger().log(m), warn: (m) => getLogger().warn(m) },
              timeoutMs: SESSION_NAMING_TIMEOUT_MS,
            });
            const parsed = parseSessionName(choice.result.assistantText);
            return parsed.ok ? parsed.name : null;
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
  signalWorkspaceIds.delete(sessionId);
  return manager.unregister(sessionId);
}
