import type { SpawnOptions } from '../../pty/types';
import type { ProbeResult, SpawnExtras } from '@agentbridge/core';
import { getCliAdapters } from '../coreInstances';

export function isAvailable(): ProbeResult {
  return getCliAdapters().agy.isAvailable();
}

export async function buildSpawnOptions(
  cwd: string,
  workspaceId: string,
  resumeSessionId?: string,
  resumeModelSessionId?: string,
  extras?: SpawnExtras,
): Promise<SpawnOptions> {
  return getCliAdapters().agy.buildSpawnOptions(
    cwd,
    workspaceId,
    resumeSessionId,
    resumeModelSessionId,
    extras,
  );
}
