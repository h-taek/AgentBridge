import type { CliKind } from '../shared/types';
import { getEnvProbe } from './coreInstances';

export type { ProbeResult } from '@agentbridge/core';

export function probe(binaryName: CliKind): import('@agentbridge/core').ProbeResult {
  return getEnvProbe().probe(binaryName);
}

export function getShellEnv(): Record<string, string> {
  return getEnvProbe().getShellEnv();
}
