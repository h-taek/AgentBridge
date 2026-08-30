// 2026-06-01 Phase 6.B: 옛 코어 sessionRegistry(sessions.json 별도 파일 패턴) 폐기.
// 새 schema(workspace.json sessions[] 통합) + workspaceStore.addSession 등 호출로 위임.
//
// 필드 매핑 (LegacySessionMeta → SessionMeta):
//   active            → closedAt === null
//   name              → title ?? CLI_DISPLAY_NAME[model]
//   lastActiveAt      → lastChattedAt ?? createdAt
//   turnCount         → (drop, UI 미사용)

import type { CliKind } from '../shared/types';
import {
  CLI_DISPLAY_NAME,
  readCapturedSessionId,
  resolveHookCaptureFile,
  type SessionMeta as CoreSessionMeta,
} from '@agentbridge/core';
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
  active: boolean;
  modelSessionId?: string;
  parentSessionId?: string;
  lastOpenedAt?: string;
}

function toLegacy(workspaceId: string, s: CoreSessionMeta): SessionMeta {
  return {
    sessionId: s.sessionId,
    workspaceId,
    model: s.model,
    name: s.title ?? CLI_DISPLAY_NAME[s.model],
    createdAt: s.createdAt,
    lastActiveAt: s.lastChattedAt ?? s.createdAt,
    active: s.closedAt === null,
    modelSessionId: s.modelSessionId ?? undefined,
    parentSessionId: s.parentSessionId,
    lastOpenedAt: s.lastOpenedAt,
  };
}

export async function registerSession(
  workspaceId: string,
  sessionId: string,
  model: CliKind,
): Promise<SessionMeta> {
  // 호출처가 발급한 sessionId(= AgentBridge 세션 ID: PTY spawn·webview state·패널 키)를
  // 그대로 workspace.json에 저장한다. 과거엔 이 id를 버리고 addSession이 새 UUID를 발급해,
  // 이후 setModelSessionId(workspaceId, 이 sessionId)가 "session not found"로 실패(삼켜짐)
  // → codex/agy의 modelSessionId가 영속화되지 않아 resume이 항상 깨졌다 (V-04).
  const created = await getWorkspaceStore().addSession(workspaceId, model, 'cli', sessionId);
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

// 사용자가 이 세션을 열어본 시각을 갱신한다. 완료 표시를 끄는 기준 (0.5.0 B-2).
export async function markSessionOpened(workspaceId: string, sessionId: string): Promise<void> {
  await getWorkspaceStore().updateSessionMeta(workspaceId, sessionId, {
    lastOpenedAt: new Date().toISOString(),
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

// 미확정으로 남은 세션 id를 회수한다 (0.5.0 A-1).
//
// codex·agy는 세션 id를 훅이 알려준다. 훅이 캡처 파일을 쓰기 전에 탭이 닫히면 감시자는 죽지만
// 파일은 세션 폴더에 남는다. 다음에 그 세션을 열 때 그 값을 읽어 소급 귀속시켜, 기동 인자를
// 만들기 전에 resume 대상이 잡히게 한다. claude는 우리가 id를 발급하므로 대상이 아니다.
export async function reclaimPendingModelSessionId(session: SessionMeta): Promise<string | undefined> {
  if (session.modelSessionId) return session.modelSessionId;
  if (session.model === 'claude') return undefined;
  const wsDir = getWorkspaceStore().getWorkspacePath(session.workspaceId);
  const captured = await readCapturedSessionId(resolveHookCaptureFile(wsDir, session.sessionId));
  if (!captured) return undefined;
  await setModelSessionId(session.workspaceId, session.sessionId, captured);
  return captured;
}
