// Facade — refinePolicy를 익스텐션 settings에서 해석해 코어 runRefine에 전달.

import * as core from '@agentbridge/core';
import type { CliKind } from '../shared/types';
import { getConfig } from '../settings/config';
import { getEnvProbe, getLogger } from './coreInstances';

export { RefineOffError, RefineFailedError } from '@agentbridge/core';
export type { RefineModelChoice } from '@agentbridge/core';

function resolveOrder(activeModel: CliKind): { order: CliKind[]; singleCandidate: boolean } {
  const cfg = getConfig();
  switch (cfg.refinePolicy) {
    case 'off':
      return { order: [], singleCandidate: false };
    case 'fixed':
      return { order: [cfg.refineFixedCli], singleCandidate: true };
    case 'active':
      return { order: [activeModel], singleCandidate: true };
    case 'priority':
      return { order: Array.from(new Set(cfg.refinePriorityOrder)), singleCandidate: false };
  }
}

export async function runRefine(args: {
  activeModel: CliKind;
  prompt: string;
  cwd?: string;
  timeoutMs?: number;
}): Promise<core.RefineModelChoice> {
  const { order, singleCandidate } = resolveOrder(args.activeModel);
  return core.runRefine({
    order,
    singleCandidate,
    prompt: args.prompt,
    cwd: args.cwd,
    timeoutMs: args.timeoutMs,
    envProbe: getEnvProbe(),
    logger: getLogger(),
  });
}
