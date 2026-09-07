import type { SpawnOptions } from '../../pty/types';
import type { ProbeResult, SpawnExtras } from '@agentbridge/core';
import { getCliAdapters } from '../coreInstances';

export function isAvailable(): ProbeResult {
  return getCliAdapters().claude.isAvailable();
}

export async function buildSpawnOptions(
  cwd: string,
  workspaceId: string,
  resumeSessionId?: string,
  extras?: SpawnExtras,
): Promise<SpawnOptions> {
  return getCliAdapters().claude.buildSpawnOptions(cwd, workspaceId, resumeSessionId, extras);
}
