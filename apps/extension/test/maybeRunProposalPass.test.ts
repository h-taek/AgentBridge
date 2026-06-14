import { strict as assert } from 'assert';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  maybeRunProposalPass, appendTurn, getGlobalDir, DEFAULT_PROFILE_ID, type TurnRecord,
} from '@agentbridge/core';

const turn = (id: string): TurnRecord => ({
  id, model: 'claude', completedAt: '2026-06-13T00:00:01Z', user: 'durable preference',
  assistantBody: 'ok', toolCalls: [], userBytes: 2, assistantBodyBytes: 2,
} as TurnRecord);

async function setup() {
  const root = await fsp.mkdtemp(join(tmpdir(), 'ab-maybe-'));
  const globalDir = getGlobalDir(join(root, 'ud'));
  const workspaceRoot = join(root, 'ws');
  await fsp.mkdir(workspaceRoot, { recursive: true });
  return { globalDir, workspaceRoot };
}

describe('maybeRunProposalPass', () => {
  it('매 호출 카운터 증가, everyN의 배수에서만 분석 실행', async () => {
    const { globalDir, workspaceRoot } = await setup();
    await appendTurn(workspaceRoot, turn('a'));
    let calls = 0;
    const fake = async () => { calls++; return { result: { assistantText: '[]' } } as any; };
    const base = {
      workspaceRoot, globalDir, profileId: DEFAULT_PROFILE_ID,
      decision: { policy: 'priority', order: ['agy'] } as any, envProbe: {} as any,
      runAnalysis: fake, everyN: 2,
    };
    const r1 = await maybeRunProposalPass(base);
    assert.equal(r1.ran, false);   // count=1, 1%2!==0
    assert.equal(calls, 0);        // 분석 호출 안 됨
    const r2 = await maybeRunProposalPass(base);
    assert.equal(r2.ran, true);    // count=2, 2%2===0
    assert.equal(calls, 1);        // 분석 1회
  });

  it('everyN<=0이면 절대 실행 안 함(비활성)', async () => {
    const { globalDir, workspaceRoot } = await setup();
    let calls = 0;
    const r = await maybeRunProposalPass({
      workspaceRoot, globalDir, profileId: DEFAULT_PROFILE_ID,
      decision: { policy: 'priority', order: ['agy'] } as any, envProbe: {} as any,
      runAnalysis: async () => { calls++; return { result: { assistantText: '[]' } } as any; },
      everyN: 0,
    });
    assert.equal(r.ran, false);
    assert.equal(calls, 0);
  });
});
