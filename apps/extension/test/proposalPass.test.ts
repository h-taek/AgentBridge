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
    assert.equal((await readProposalState(workspaceRoot)).lastProcessedId, 'a');
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
    assert.equal((await readProposalState(workspaceRoot)).lastProcessedId, null); // 전진 안 됨
  });
});

// 0.5.0 B-1 — scope로 두 프로필에 갈라 쓴다. 중복 판정은 합본 인덱스로 한다.
describe('runProposalPass — scope 분배', () => {
  const PROJECT = 'h-taek-agentbridge-deadbeef';
  const analysisWith = (items: unknown[]) => async () =>
    ({ result: { assistantText: JSON.stringify(items) } }) as any;

  const run = (
    globalDir: string,
    workspaceRoot: string,
    items: unknown[],
    projectProfileId?: string | null,
  ) =>
    runProposalPass({
      workspaceRoot,
      globalDir,
      profileId: DEFAULT_PROFILE_ID,
      projectProfileId,
      decision: { policy: 'priority', order: ['agy'] } as any,
      envProbe: {} as any,
      runAnalysis: analysisWith(items),
    });

  const item = (scope: string | undefined, title: string) => ({
    category: 'conventions',
    ...(scope ? { scope } : {}),
    title,
    summary: 's',
    body: 'b',
    confidence: 0.9,
  });

  it('user는 사용자 프로필, project는 프로젝트 프로필로 간다', async () => {
    const { globalDir, workspaceRoot } = await setup();
    await appendTurn(workspaceRoot, turn('a', '2026-06-13T00:00:01Z', 'q'));
    const res = await run(
      globalDir,
      workspaceRoot,
      [item('user', '사용자 규칙'), item('project', '이 저장소 규칙')],
      PROJECT,
    );
    assert.equal(res.written, 2);

    const user = await readProposals(globalDir, DEFAULT_PROFILE_ID);
    const project = await readProposals(globalDir, PROJECT);
    assert.deepEqual(user.map((p) => p.title), ['사용자 규칙']);
    assert.deepEqual(project.map((p) => p.title), ['이 저장소 규칙']);
  });

  it('scope가 없으면 사용자 것으로 본다 — 0.5.0 이전 출력 호환', async () => {
    const { globalDir, workspaceRoot } = await setup();
    await appendTurn(workspaceRoot, turn('a', '2026-06-13T00:00:01Z', 'q'));
    await run(globalDir, workspaceRoot, [item(undefined, '스코프 없음')], PROJECT);
    assert.equal((await readProposals(globalDir, DEFAULT_PROFILE_ID)).length, 1);
    assert.equal((await readProposals(globalDir, PROJECT)).length, 0);
  });

  it('remote가 없으면 project 제안은 버리고 user만 쌓는다', async () => {
    const { globalDir, workspaceRoot } = await setup();
    await appendTurn(workspaceRoot, turn('a', '2026-06-13T00:00:01Z', 'q'));
    const res = await run(globalDir, workspaceRoot, [
      item('user', '사용자 규칙'),
      item('project', '버려질 프로젝트 규칙'),
    ]);
    assert.equal(res.written, 1);
    assert.deepEqual(
      (await readProposals(globalDir, DEFAULT_PROFILE_ID)).map((p) => p.title),
      ['사용자 규칙'],
    );
  });

  it('프로젝트 제안이 없으면 프로젝트 프로필을 만들지 않는다', async () => {
    const { globalDir, workspaceRoot } = await setup();
    await appendTurn(workspaceRoot, turn('a', '2026-06-13T00:00:01Z', 'q'));
    await run(globalDir, workspaceRoot, [item('user', '사용자 규칙')], PROJECT);
    await assert.rejects(() => fsp.stat(join(globalDir, 'profiles', PROJECT)));
  });

  it('경로 탈출 profileId는 거절한다', async () => {
    const { globalDir, workspaceRoot } = await setup();
    await appendTurn(workspaceRoot, turn('a', '2026-06-13T00:00:01Z', 'q'));
    await assert.rejects(
      () => run(globalDir, workspaceRoot, [item('project', 'x')], '../escape'),
      /single path segment/,
    );
  });
});
