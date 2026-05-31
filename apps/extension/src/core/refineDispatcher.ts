// Facade — refinePolicy를 익스텐션 settings에서 해석해 코어 runRefine에 전달.

import * as core from '@agentbridge/core';
import type { CliKind } from '../shared/types';
import { getConfig } from '../settings/config';
import { getEnvProbe, getLogger, getQuotaTracker } from './coreInstances';

export { RefineOffError, RefineFailedError } from '@agentbridge/core';
export type { RefineModelChoice } from '@agentbridge/core';

function resolveDecision(activeModel: CliKind): core.RefineDecision {
  const cfg = getConfig();
  switch (cfg.refinePolicy) {
    case 'off':
      return { policy: 'off' };
    case 'fixed':
      return { policy: 'fixed', cli: cfg.refineFixedCli };
    case 'active':
      return { policy: 'active', cli: activeModel };
    case 'priority':
      return { policy: 'priority', order: Array.from(new Set(cfg.refinePriorityOrder)) };
  }
}

export async function runRefine(args: {
  activeModel: CliKind;
  prompt: string;
  cwd?: string;
  timeoutMs?: number;
}): Promise<core.RefineModelChoice> {
  const quota = getQuotaTracker();
  return core.runRefine({
    decision: resolveDecision(args.activeModel),
    prompt: args.prompt,
    cwd: args.cwd,
    timeoutMs: args.timeoutMs,
    envProbe: getEnvProbe(),
    logger: getLogger(),
    onAttempt: async (event) => {
      // 익스텐션은 UI 미설치 — quota 강제 폴백만 저장 (데이터 모델 통일).
      if (event.status === 'quota') {
        await quota.markForcedFallback(event.cli);
      }
    },
  });
}
