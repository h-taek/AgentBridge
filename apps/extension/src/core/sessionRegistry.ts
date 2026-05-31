// Facade — 코어 SessionRegistry로 위임. 원본은 (workspaceId)만 받았으나 코어는 (workspaceId, workspaceRoot)
// 둘 다 필요. workspaceRoot는 workspaceStore facade로 resolve.

import type { CliKind } from '../shared/types';
import * as workspaceStore from './workspaceStore';
import { getSessionRegistry } from './coreInstances';

export type { LegacySessionMeta as SessionMeta } from '@agentbridge/core';

function root(workspaceId: string): string {
  return workspaceStore.getWorkspacePath(workspaceId);
}

export async function registerSession(
  workspaceId: string,
  sessionId: string,
  model: CliKind,
): Promise<import('@agentbridge/core').LegacySessionMeta> {
  return getSessionRegistry().register(workspaceId, root(workspaceId), sessionId, model);
}

export async function updateSessionActivity(workspaceId: string, sessionId: string): Promise<void> {
  return getSessionRegistry().updateActivity(workspaceId, root(workspaceId), sessionId);
}

export async function setModelSessionId(
  workspaceId: string,
  sessionId: string,
  modelSessionId: string,
): Promise<void> {
  return getSessionRegistry().setModelSessionId(
    workspaceId,
    root(workspaceId),
    sessionId,
    modelSessionId,
  );
}

export async function markSessionClosed(workspaceId: string, sessionId: string): Promise<void> {
  return getSessionRegistry().markClosed(workspaceId, root(workspaceId), sessionId);
}

export async function resetAllSessionsActive(workspaceId: string): Promise<void> {
  return getSessionRegistry().resetAllActive(workspaceId, root(workspaceId));
}

export async function markSessionActive(workspaceId: string, sessionId: string): Promise<void> {
  return getSessionRegistry().markActive(workspaceId, root(workspaceId), sessionId);
}

export async function renameSession(
  workspaceId: string,
  sessionId: string,
  name: string,
): Promise<void> {
  return getSessionRegistry().rename(workspaceId, root(workspaceId), sessionId, name);
}

export async function deleteSession(workspaceId: string, sessionId: string): Promise<void> {
  return getSessionRegistry().delete(workspaceId, root(workspaceId), sessionId);
}

export async function getSessions(
  workspaceId: string,
): Promise<import('@agentbridge/core').LegacySessionMeta[]> {
  return getSessionRegistry().list(root(workspaceId));
}
