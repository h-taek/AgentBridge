import { strict as assert } from 'assert';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  runProposalPass, readProposals, readProposalState, appendTurn, getGlobalDir,
  DEFAULT_PROFILE_ID, type TurnRecord,
} from '@agentbridge/core';

const turn = (id: string, at: string, user: string): TurnRecord => ({
  id, model: 'claude', completedAt: at, user, assistantBody: 'ok', toolCalls: [],
  userBytes: 2, assistantBodyBytes: 2,
} as TurnRecord);

async function setup() {
  const root = await fsp.mkdtemp(join(tmpdir(), 'ab-pass-'));
  const globalDir = getGlobalDir(join(root, 'ud'));
  const workspaceRoot = join(root, 'ws');
  await fsp.mkdir(workspaceRoot, { recursive: true });
  return { globalDir, workspaceRoot };
}

describe('runProposalPass', () => {
  it('수집→분석→파싱→저장 + 커서 전진', async () => {
    const { globalDir, workspaceRoot } = await setup();
    await appendTurn(workspaceRoot, turn('a', '2026-06-13T00:00:01Z', '나는 산문 설명을 선호'));
    const fakeAnalysis = async () => ({
      result: { assistantText: JSON.stringify([
        { category: 'role', title: '산문 설명 선호', summary: '표보다 산문', body: 'x', confidence: 0.9 },
      ]) },
    } as any);
    const res = await runProposalPass({
      workspaceRoot, globalDir, profileId: DEFAULT_PROFILE_ID,
      decision: { policy: 'priority', order: ['agy'] } as any, envProbe: {} as any,
      runAnalysis: fakeAnalysis,
    });
    assert.equal(res.written, 1);
    assert.equal((await readProposals(globalDir, DEFAULT_PROFILE_ID)).length, 1);
    assert.equal((await readProposalState(workspaceRoot)).lastCompletedAt, '2026-06-13T00:00:01Z');
  });

  it('새 턴이 없으면 분석 호출 없이 조기 종료', async () => {
    const { globalDir, workspaceRoot } = await setup();
    let called = false;
    const res = await runProposalPass({
      workspaceRoot, globalDir, profileId: DEFAULT_PROFILE_ID,
      decision: { policy: 'priority', order: ['agy'] } as any, envProbe: {} as any,
      runAnalysis: async () => { called = true; return {} as any; },
    });
    assert.equal(res.written, 0);
    assert.equal(res.skippedReason, 'no-new-turns');
    assert.equal(called, false);
  });

  it('분석 실패(throw)면 커서 전진 안 함', async () => {
    const { globalDir, workspaceRoot } = await setup();
    await appendTurn(workspaceRoot, turn('a', '2026-06-13T00:00:01Z', 'x'));
    const res = await runProposalPass({
      workspaceRoot, globalDir, profileId: DEFAULT_PROFILE_ID,
      decision: { policy: 'priority', order: ['agy'] } as any, envProbe: {} as any,
      runAnalysis: async () => { throw new Error('spawn fail'); },
    });
    assert.equal(res.written, 0);
    assert.equal(res.skippedReason, 'analysis-failed');
    assert.equal((await readProposalState(workspaceRoot)).lastCompletedAt, null); // 전진 안 됨
  });
});
