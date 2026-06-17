import { strict as assert } from 'assert';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  runProposalTrigger, appendTurn, getGlobalDir, DEFAULT_PROFILE_ID, type TurnRecord,
} from '@agentbridge/core';

const turn = (id: string): TurnRecord => ({
  id, model: 'claude', completedAt: '2026-06-13T00:00:01Z', user: 'durable preference',
  assistantBody: 'ok', toolCalls: [], userBytes: 2, assistantBodyBytes: 2,
} as TurnRecord);

async function setup() {
  const root = await fsp.mkdtemp(join(tmpdir(), 'ab-trigger-'));
  const globalDir = getGlobalDir(join(root, 'ud'));
  const workspaceRoot = join(root, 'ws');
  await fsp.mkdir(workspaceRoot, { recursive: true });
  return { globalDir, workspaceRoot };
}

const refineConfig = {
  policy: 'priority', fixedCli: 'agy', priorityOrder: ['agy'], useClaude: false,
} as any;

describe('runProposalTrigger', () => {
  it('매 호출 카운터 증가, everyN 배수에서만 분석 실행 + onUpdated 통지', async () => {
    const { globalDir, workspaceRoot } = await setup();
    await appendTurn(workspaceRoot, turn('a'));
    let calls = 0;
    let updated = 0;
    const base = {
      workspaceId: 'ws1', workspaceRoot, globalDir, profileId: DEFAULT_PROFILE_ID,
      activeModel: 'claude' as any, refineConfig, envProbe: {} as any,
      runAnalysis: async () => { calls++; return { result: { assistantText: '[]' } } as any; },
      everyN: 2, onUpdated: () => { updated++; },
    };
    await runProposalTrigger(base);   // count=1, 1%2!==0 → 분석/통지 없음
    assert.equal(calls, 0);
    assert.equal(updated, 0);
    await runProposalTrigger(base);   // count=2, 2%2===0 → 분석 1회 + 통지
    assert.equal(calls, 1);
    assert.equal(updated, 1);
  });

  it('everyN<=0이면 절대 실행 안 함(비활성) — 카운트는 그래도 증가', async () => {
    const { globalDir, workspaceRoot } = await setup();
    let calls = 0;
    let updated = 0;
    await runProposalTrigger({
      workspaceId: 'ws2', workspaceRoot, globalDir, profileId: DEFAULT_PROFILE_ID,
      activeModel: 'claude' as any, refineConfig, envProbe: {} as any,
      runAnalysis: async () => { calls++; return { result: { assistantText: '[]' } } as any; },
      everyN: 0, onUpdated: () => { updated++; },
    });
    assert.equal(calls, 0);
    assert.equal(updated, 0);
  });
});
