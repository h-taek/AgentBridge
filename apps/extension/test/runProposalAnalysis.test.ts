import { strict as assert } from 'assert';
import { runProposalAnalysis, RefineOffError, type EnvProbe } from '@agentbridge/core';

// envProbe 스텁 — CLI 없음으로 처리되게.
const probeStub: EnvProbe = {
  probe: () => ({ found: false, resolvedPath: null } as any),
  getShellEnv: () => ({}),
} as any;

describe('runProposalAnalysis', () => {
  it('decision off면 RefineOffError', async () => {
    await assert.rejects(
      () => runProposalAnalysis({ decision: { policy: 'off' }, prompt: 'p', envProbe: probeStub }),
      RefineOffError,
    );
  });
});
