// Facade — 코어의 turnsStore 함수에 workspaceRoot를 채워서 위임.

import * as core from '@agentbridge/core';
import type { TurnRecord } from '../shared/types';
import * as workspaceStore from './workspaceStore';
import { getLogger } from './coreInstances';
import { getConfig } from '../settings/config';

export type { StagedArchive, ArchiveSnapshotMeta } from '@agentbridge/core';

function opts(): { maxArchiveSnapshots: number; logger: core.Logger } {
  return { maxArchiveSnapshots: getConfig().maxArchiveSnapshots, logger: getLogger() };
}

export async function appendTurn(workspaceId: string, turn: TurnRecord): Promise<void> {
  return core.appendTurn(workspaceStore.getWorkspacePath(workspaceId), turn);
}

export async function readAllTurns(workspaceId: string): Promise<TurnRecord[]> {
  return core.readAllTurns(workspaceStore.getWorkspacePath(workspaceId));
}

export async function rewriteTurns(workspaceId: string, turns: TurnRecord[]): Promise<void> {
  return core.rewriteTurns(workspaceStore.getWorkspacePath(workspaceId), turns);
}

export async function stageCompactedTurns(
  workspaceId: string,
  processed: TurnRecord[],
  irSnapshot: unknown,
): Promise<core.StagedArchive> {
  return core.stageCompactedTurns(
    workspaceStore.getWorkspacePath(workspaceId),
    processed,
    irSnapshot,
  );
}

export async function commitArchive(staged: core.StagedArchive): Promise<void> {
  return core.commitArchive(staged, opts());
}

export async function abortArchive(staged: core.StagedArchive): Promise<void> {
  return core.abortArchive(staged);
}

export async function rotateIfNeeded(workspaceId: string): Promise<boolean> {
  return core.rotateIfNeeded(workspaceStore.getWorkspacePath(workspaceId), {
    logger: getLogger(),
  });
}

export async function listArchives(
  workspaceId: string,
): Promise<core.ArchiveSnapshotMeta[]> {
  return core.listArchives(workspaceStore.getWorkspacePath(workspaceId), opts());
}

export { sumBytes } from '@agentbridge/core';
