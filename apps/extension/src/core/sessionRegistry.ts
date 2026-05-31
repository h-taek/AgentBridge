// 2026-06-01 Phase 6.B: 옛 코어 sessionRegistry(sessions.json 별도 파일 패턴) 폐기.
// 새 schema(workspace.json sessions[] 통합) + workspaceStore.addSession 등 호출로 위임.
//
// 필드 매핑 (LegacySessionMeta → SessionMeta):
//   active            → closedAt === null
//   name              → title ?? CLI_DISPLAY_NAME[model]
//   lastActiveAt      → lastChattedAt ?? createdAt
//   turnCount         → (drop, UI 미사용)

import type { CliKind } from '../shared/types';
import { CLI_DISPLAY_NAME, type SessionMeta as CoreSessionMeta } from '@agentbridge/core';
import { getWorkspaceStore } from './coreInstances';

// 옛 호출처가 sessionId를 외부 발급해 넘기던 패턴을 유지하기 위해 sessionId override 지원 wrapper.
// 진짜로는 코어 workspaceStore.addSession이 sid를 자체 발급하지만, 익스텐션 코드 다수가
// 외부에서 미리 발급된 sid를 사용해 등록하므로 단계적 마이그레이션을 위해 보존.

export interface SessionMeta {
  sessionId: string;
  workspaceId: string;
  model: CliKind;
  // 옛 LegacySessionMeta 필드 호환용 — 호출처는 점진적으로 새 필드로 마이그레이션.
  name: string;
  createdAt: string;
  lastActiveAt: string;
  turnCount: number;
  active: boolean;
  modelSessionId?: string;
}

function toLegacy(workspaceId: string, s: CoreSessionMeta): SessionMeta {
  return {
    sessionId: s.sessionId,
    workspaceId,
    model: s.model,
    name: s.title ?? CLI_DISPLAY_NAME[s.model],
    createdAt: s.createdAt,
    lastActiveAt: s.lastChattedAt ?? s.createdAt,
    turnCount: 0,
    active: s.closedAt === null,
    modelSessionId: s.modelSessionId ?? undefined,
  };
}

export async function registerSession(
  workspaceId: string,
  sessionId: string,
  model: CliKind,
): Promise<SessionMeta> {
  // 옛 호출처는 sessionId를 외부 발급. 코어 addSession은 자체 발급이므로 발급된 메타에
  // 외부 sessionId를 덮어쓰지 않고 그대로 사용 — 호출처가 반환 sid를 받아 쓰도록 유도.
  // 단 옛 sessionId가 이미 의미를 가질 경우 호출처가 반환 sid로 갱신 필요.
  const _ = sessionId; // 추적 위해 변수 유지, 사용은 안 함
  void _;
  const created = await getWorkspaceStore().addSession(workspaceId, model, 'cli');
  return toLegacy(workspaceId, created);
}

export async function updateSessionActivity(workspaceId: string, sessionId: string): Promise<void> {
  await getWorkspaceStore().updateSessionMeta(workspaceId, sessionId, {
    lastChattedAt: new Date().toISOString(),
  });
}

export async function setModelSessionId(
  workspaceId: string,
  sessionId: string,
  modelSessionId: string,
): Promise<void> {
  await getWorkspaceStore().updateSessionMeta(workspaceId, sessionId, { modelSessionId });
}

export async function markSessionClosed(workspaceId: string, sessionId: string): Promise<void> {
  await getWorkspaceStore().updateSessionMeta(workspaceId, sessionId, {
    closedAt: new Date().toISOString(),
  });
}

export async function resetAllSessionsActive(workspaceId: string): Promise<void> {
  const ws = await getWorkspaceStore().loadWorkspace(workspaceId);
  const now = new Date().toISOString();
  for (const s of ws.sessions) {
    if (s.closedAt === null) {
      await getWorkspaceStore().updateSessionMeta(workspaceId, s.sessionId, { closedAt: now });
    }
  }
}

export async function markSessionActive(workspaceId: string, sessionId: string): Promise<void> {
  await getWorkspaceStore().updateSessionMeta(workspaceId, sessionId, {
    closedAt: null,
    lastChattedAt: new Date().toISOString(),
  });
}

export async function renameSession(
  workspaceId: string,
  sessionId: string,
  name: string,
): Promise<void> {
  await getWorkspaceStore().updateSessionMeta(workspaceId, sessionId, { title: name });
}

export async function deleteSession(workspaceId: string, sessionId: string): Promise<void> {
  await getWorkspaceStore().deleteSession(workspaceId, sessionId);
}

export async function getSessions(workspaceId: string): Promise<SessionMeta[]> {
  const ws = await getWorkspaceStore().loadWorkspace(workspaceId);
  return ws.sessions
    .slice()
    .sort((a, b) => {
      // active(closedAt === null) 우선, 그 다음 lastChattedAt/createdAt 내림차순
      const aActive = a.closedAt === null;
      const bActive = b.closedAt === null;
      if (aActive !== bActive) return aActive ? -1 : 1;
      const aTs = a.lastChattedAt ?? a.createdAt;
      const bTs = b.lastChattedAt ?? b.createdAt;
      return bTs.localeCompare(aTs);
    })
    .map((s) => toLegacy(workspaceId, s));
}
