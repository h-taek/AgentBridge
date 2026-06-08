import electronLog from 'electron-log/main'
import type { TurnRecord } from '@shared/turns'
import {
  appendTurn as coreAppendTurn,
  readAllTurns as coreReadAllTurns,
  rewriteTurns as coreRewriteTurns,
  rotateIfNeeded as coreRotateIfNeeded,
  stageCompactedTurns as coreStageCompactedTurns,
  commitArchive as coreCommitArchive,
  abortArchive as coreAbortArchive,
  listArchives as coreListArchives,
  sumBytes as coreSumBytes,
  type StagedArchive,
  type TurnsStoreOptions,
  type ArchiveSnapshotMeta,
  type Logger
} from '@agentbridge/core'
import { getWorkspacePaths } from './workspaceStore'

const log: Logger = {
  log: (m) => electronLog.info(m),
  warn: (m) => electronLog.warn(m)
}

// TurnsStore — core turnsStore의 데스크탑 어댑터.
// 핵심 책임은 workspaceId → workspaceRoot(절대경로) 변환뿐. 모든 로직은 core 위임.
// architecture §15.3.

export type { StagedArchive, TurnsStoreOptions, ArchiveSnapshotMeta }

function rootOf(workspaceId: string): string {
  return getWorkspacePaths(workspaceId).dir
}

export async function appendTurn(workspaceId: string, turn: TurnRecord): Promise<void> {
  return coreAppendTurn(rootOf(workspaceId), turn)
}

export async function readAllTurns(workspaceId: string): Promise<TurnRecord[]> {
  return coreReadAllTurns(rootOf(workspaceId))
}

export async function rewriteTurns(workspaceId: string, turns: TurnRecord[]): Promise<void> {
  return coreRewriteTurns(rootOf(workspaceId), turns)
}

export async function rotateIfNeeded(
  workspaceId: string
): Promise<{ rotated: boolean }> {
  const rotated = await coreRotateIfNeeded(rootOf(workspaceId), { logger: log })
  return { rotated }
}

export async function stageCompactedTurns(
  workspaceId: string,
  processed: TurnRecord[],
  irSnapshot: unknown
): Promise<StagedArchive> {
  return coreStageCompactedTurns(rootOf(workspaceId), processed, irSnapshot)
}

export async function commitArchive(
  staged: StagedArchive,
  opts: TurnsStoreOptions
): Promise<void> {
  return coreCommitArchive(staged, { ...opts, logger: opts.logger ?? log })
}

export async function abortArchive(staged: StagedArchive): Promise<void> {
  return coreAbortArchive(staged)
}

export async function listArchives(
  workspaceId: string,
  opts: TurnsStoreOptions
): Promise<ArchiveSnapshotMeta[]> {
  return coreListArchives(rootOf(workspaceId), { ...opts, logger: opts.logger ?? log })
}

export function sumBytes(turns: TurnRecord[]): number {
  return coreSumBytes(turns)
}
