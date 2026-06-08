import type { SpawnOptions } from '../../pty/types';
import type { ProbeResult } from '@agentbridge/core';
import { getCliAdapters } from '../coreInstances';

export function isAvailable(): ProbeResult {
  return getCliAdapters().claude.isAvailable();
}

export async function buildSpawnOptions(
  cwd: string,
  workspaceId: string,
  resumeSessionId?: string,
): Promise<SpawnOptions> {
  return getCliAdapters().claude.buildSpawnOptions(cwd, workspaceId, resumeSessionId);
}
