// Facade — 코어의 turnsStore 함수에 workspaceRoot를 채워서 위임.

import * as core from '@agentbridge/core';
import type { TurnRecord } from '../shared/types';
import * as workspaceStore from './workspaceStore';
import { getLogger } from './coreInstances';
import { getConfig } from '../settings/config';

function opts(): { maxArchiveSnapshots: number; logger: core.Logger } {
  return { maxArchiveSnapshots: getConfig().maxArchiveSnapshots, logger: getLogger() };
}

export async function readAllTurns(workspaceId: string): Promise<TurnRecord[]> {
  return core.readAllTurns(workspaceStore.getWorkspacePath(workspaceId));
}

export async function listArchives(
  workspaceId: string,
): Promise<core.ArchiveSnapshotMeta[]> {
  return core.listArchives(workspaceStore.getWorkspacePath(workspaceId), opts());
}
