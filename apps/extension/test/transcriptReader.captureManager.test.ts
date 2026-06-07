// CaptureManager — 설계 §E "로직은 core 한 곳, 호스트는 호출만". 등록 세션의 transcript 경로를
// 해석하고 CaptureSession을 poll/watch로 구동한다. resolve는 테스트에서 temp 파일로 주입.
import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CaptureManager, readAllTurns } from '@agentbridge/core';

function fakeScheduler() {
  const calls = { updated: 0, ran: 0 };
  return {
    calls,
    events: { emit: () => { calls.updated++; } },
    checkAndRun: async () => { calls.ran++; },
  };
}

const U = (text: string, uuid: string) =>
  JSON.stringify({ type: 'user', promptSource: 'typed', uuid, timestamp: '2026-06-07T00:00:00.000Z', message: { role: 'user', content: text } });
const A = (text: string, uuid: string, stop = 'end_turn') =>
  JSON.stringify({ type: 'assistant', uuid, timestamp: '2026-06-07T00:00:01.000Z', message: { role: 'assistant', stop_reason: stop, content: [{ type: 'text', text }] } });

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => Promise<boolean>, timeout = 1500, step = 10): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await delay(step);
  }
  throw new Error('until() timed out');
}

async function setup() {
  const root = await fs.mkdtemp(join(tmpdir(), 'capmgr-'));
  const transcript = join(root, 's1.jsonl');
  await fs.writeFile(transcript, '');
  return { root, transcript };
}

function baseOpts(root: string, sched: ReturnType<typeof fakeScheduler>, extra: Record<string, unknown> = {}) {
  return {
    workspaceId: 'w1', workspaceRoot: root, workspacePath: '/proj',
    sessionId: 's1', model: 'claude' as const, modelSessionId: 'm1', cwd: '/proj',
    getDetail: () => 'full' as const, scheduler: sched, pollMs: 10, ...extra,
  };
}

describe('CaptureManager', () => {
  it('register: 닫힌 턴을 turns.jsonl에 append (poll 구동)', async () => {
    const { root, transcript } = await setup();
    const sched = fakeScheduler();
    const mgr = new CaptureManager({ resolve: async () => transcript });
    await fs.writeFile(transcript, [U('q1', 'u1'), A('a1', 'a1'), U('q2', 'u2')].join('\n') + '\n');
    mgr.register(baseOpts(root, sched));
    await until(async () => (await readAllTurns(root)).length === 1);
    const turns = await readAllTurns(root);
    assert.equal(turns[0].user, 'q1');
    assert.equal(turns[0].assistantBody, 'a1');
    assert.equal(turns[0].id, 'claude:u1');
    assert.ok(sched.calls.updated >= 1 && sched.calls.ran >= 1);
    await mgr.disposeAll();
  });

  it('증분: register 후 append된 새 턴도 잡는다', async () => {
    const { root, transcript } = await setup();
    const mgr = new CaptureManager({ resolve: async () => transcript });
    await fs.writeFile(transcript, [U('q1', 'u1'), A('a1', 'a1'), U('q2', 'u2')].join('\n') + '\n');
    mgr.register(baseOpts(root, fakeScheduler()));
    await until(async () => (await readAllTurns(root)).length === 1);
    await fs.appendFile(transcript, [A('a2', 'a2'), U('q3', 'u3')].join('\n') + '\n');
    await until(async () => (await readAllTurns(root)).length === 2);
    assert.equal((await readAllTurns(root))[1].user, 'q2');
    await mgr.disposeAll();
  });

  it('unregister: carry의 마지막 열린 턴을 flush', async () => {
    const { root, transcript } = await setup();
    const mgr = new CaptureManager({ resolve: async () => transcript });
    // stop=tool_use → end_turn 즉시 flush 안 됨 → carry에 열린 채 → unregister가 finalize로 flush.
    await fs.writeFile(transcript, [U('유일', 'u1'), A('답', 'a1', 'tool_use')].join('\n') + '\n');
    mgr.register(baseOpts(root, fakeScheduler()));
    await delay(50); // poll 몇 번 — end_turn 없어 닫힌 턴 없음
    assert.equal((await readAllTurns(root)).length, 0);
    await mgr.unregister('s1');
    const turns = await readAllTurns(root);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].user, '유일');
  });

  it('atomic-read 규칙1: 완료 태그 없으면 기록 안 하고, 태그 오면 미완 부분까지 통째로 기록(cursor-hold)', async () => {
    const { root, transcript } = await setup();
    const mgr = new CaptureManager({ resolve: async () => transcript });
    // 미완 턴: 부분 답변 + stop=tool_use(end_turn 아님) → 완료 태그 없음
    await fs.writeFile(transcript, [U('q1', 'u1'), A('부분답변', 'a1', 'tool_use')].join('\n') + '\n');
    mgr.register(baseOpts(root, fakeScheduler()));
    await delay(60);
    assert.equal((await readAllTurns(root)).length, 0); // 완료 태그 없어 기록 안 됨(cursor 유지)
    // 완료 태그 도착(end_turn + text)
    await fs.appendFile(transcript, A('최종답변', 'a2', 'end_turn') + '\n');
    await until(async () => (await readAllTurns(root)).length === 1);
    const t = (await readAllTurns(root))[0];
    // cursor가 안 옮겨졌으므로 재읽기가 '부분답변'까지 포함 → 통째로 기록
    assert.ok(t.assistantBody.includes('부분답변'), `부분답변 누락: ${t.assistantBody}`);
    assert.ok(t.assistantBody.includes('최종답변'), `최종답변 누락: ${t.assistantBody}`);
    await mgr.disposeAll();
  });

  it('atomic-read 규칙2: 완료 태그 없이 다음 user가 오면 직전 미완 내용을 강제 기록', async () => {
    const { root, transcript } = await setup();
    const mgr = new CaptureManager({ resolve: async () => transcript });
    await fs.writeFile(transcript, [U('q1', 'u1'), A('부분답변', 'a1', 'tool_use')].join('\n') + '\n');
    mgr.register(baseOpts(root, fakeScheduler()));
    await delay(60);
    assert.equal((await readAllTurns(root)).length, 0);
    // 다음 user 도착 → 직전 미완 턴 강제 마감(내용 보존)
    await fs.appendFile(transcript, U('q2', 'u2') + '\n');
    await until(async () => (await readAllTurns(root)).length === 1);
    const t = (await readAllTurns(root))[0];
    assert.equal(t.user, 'q1');
    assert.equal(t.assistantBody, '부분답변');
    await mgr.disposeAll();
  });

  it('재시작 멱등성: 새 매니저 같은 root → 중복 append 없음', async () => {
    const { root, transcript } = await setup();
    await fs.writeFile(transcript, [U('q1', 'u1'), A('a1', 'a1'), U('q2', 'u2')].join('\n') + '\n');
    const m1 = new CaptureManager({ resolve: async () => transcript });
    m1.register(baseOpts(root, fakeScheduler()));
    await until(async () => (await readAllTurns(root)).length === 1);
    await m1.disposeAll(); // finalize로 열린 q2가 flush될 수 있음
    const after1 = (await readAllTurns(root)).length;
    const m2 = new CaptureManager({ resolve: async () => transcript });
    m2.register(baseOpts(root, fakeScheduler()));
    await delay(50);
    await m2.disposeAll();
    assert.equal((await readAllTurns(root)).length, after1); // 중복 0 (cursor + 결정적 id)
  });

  it('setModelSessionId: modelSessionId 없으면 대기, 설정되면 캡처 시작 (codex 비동기 캡처)', async () => {
    const { root } = await setup();
    const transcript = join(root, 'rollout.jsonl');
    const item = (role: string, type: string, text: string) =>
      JSON.stringify({ type: 'response_item', timestamp: '2026-06-07T00:00:00.000Z', payload: { type, role, content: [{ type: 'input_text', text }] } });
    await fs.writeFile(transcript, [
      item('user', 'message', '코덱스 질문'),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '코덱스 답' }] } }),
      item('user', 'message', '둘째'),
    ].join('\n') + '\n');

    const mgr = new CaptureManager({ resolve: async () => transcript });
    mgr.register(baseOpts(root, fakeScheduler(), { model: 'codex', modelSessionId: null }));
    await delay(50);
    assert.equal((await readAllTurns(root)).length, 0); // modelSessionId 미확보 → 대기
    mgr.setModelSessionId('s1', 'codex-thread-1', '/proj');
    await until(async () => (await readAllTurns(root)).length === 1);
    assert.equal((await readAllTurns(root))[0].user, '코덱스 질문');
    await mgr.disposeAll();
  });
});
