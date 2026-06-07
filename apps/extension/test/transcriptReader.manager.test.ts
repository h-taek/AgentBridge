// CaptureSession — reader를 turnsStore 하류에 잇는 엔진. transcriptPath·scheduler 주입(테스트 가능).
// tick(): 증분 읽기 → consume → dedup → appendTurn → scheduler. finalize(): 마지막 열린 턴 flush.
import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CaptureSession, readAllTurns } from '@agentbridge/core';

function fakeScheduler() {
  const calls: { updated: number; ran: number } = { updated: 0, ran: 0 };
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

async function setup() {
  const root = await fs.mkdtemp(join(tmpdir(), 'mgr-'));
  const transcript = join(root, 'transcript.jsonl');
  await fs.writeFile(transcript, '');
  return { root, transcript };
}

function newSession(root: string, transcript: string, sched: ReturnType<typeof fakeScheduler>) {
  return new CaptureSession({
    workspaceId: 'w1', workspaceRoot: root, workspacePath: '/proj',
    sessionId: 's1', model: 'claude', transcriptPath: transcript,
    getDetail: () => 'full', scheduler: sched,
  });
}

describe('CaptureSession', () => {
  it('tick: 닫힌 턴을 turns.jsonl에 append하고 scheduler를 친다', async () => {
    const { root, transcript } = await setup();
    const sched = fakeScheduler();
    const s = newSession(root, transcript, sched);
    // user1 + assistant + user2 → 첫 턴 닫힘
    await fs.writeFile(transcript, [U('첫 질문', 'u1'), A('첫 답변', 'a1'), U('둘째 질문', 'u2')].join('\n') + '\n');
    await s.tick();
    const turns = await readAllTurns(root);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].user, '첫 질문');
    assert.equal(turns[0].assistantBody, '첫 답변');
    assert.equal(turns[0].id, 'claude:u1');
    assert.ok(sched.calls.updated >= 1 && sched.calls.ran >= 1);
  });

  it('finalize: carry에 남은 마지막 턴을 flush', async () => {
    const { root, transcript } = await setup();
    const s = newSession(root, transcript, fakeScheduler());
    await fs.writeFile(transcript, [U('유일 질문', 'u1'), A('유일 답변', 'a1')].join('\n') + '\n');
    await s.tick();
    assert.equal((await readAllTurns(root)).length, 0); // 안 닫힘
    await s.finalize();
    const turns = await readAllTurns(root);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].user, '유일 질문');
  });

  it('재시작 멱등성: 같은 cursor 파일로 새 세션 → 중복 append 없음', async () => {
    const { root, transcript } = await setup();
    await fs.writeFile(transcript, [U('q1', 'u1'), A('a1', 'a1'), U('q2', 'u2')].join('\n') + '\n');
    await newSession(root, transcript, fakeScheduler()).tick();
    assert.equal((await readAllTurns(root)).length, 1);
    // 재시작(새 인스턴스, 같은 root의 cursor 파일) → 새 데이터 없으니 추가 0, 중복 0
    await newSession(root, transcript, fakeScheduler()).tick();
    assert.equal((await readAllTurns(root)).length, 1);
  });

  it('증분: tick 사이 append된 새 턴만 처리', async () => {
    const { root, transcript } = await setup();
    const s = newSession(root, transcript, fakeScheduler());
    await fs.writeFile(transcript, [U('q1', 'u1'), A('a1', 'a1'), U('q2', 'u2')].join('\n') + '\n');
    await s.tick();
    assert.equal((await readAllTurns(root)).length, 1);
    await fs.appendFile(transcript, [A('a2', 'a2'), U('q3', 'u3')].join('\n') + '\n');
    await s.tick();
    const turns = await readAllTurns(root);
    assert.equal(turns.length, 2);
    assert.equal(turns[1].user, 'q2');
  });
});
