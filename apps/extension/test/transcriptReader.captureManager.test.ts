// CaptureManager — 0.5.0 A-2로 드라이버가 폴링에서 종료 훅 신호로 바뀌었다. 등록만으로는 아무것도
// 읽지 않고, 신호가 오면 그 신호가 실어 온 transcript를 증분으로 읽는다.
// 여기서는 신호 파일을 직접 써서 훅을 흉내낸다.
import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CaptureManager, readAllTurns, resolveTurnSignalFile } from '@agentbridge/core';

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
async function until(fn: () => Promise<boolean>, timeout = 3000, step = 10): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await delay(step);
  }
  throw new Error('until() timed out');
}

describe('CaptureManager (종료 훅 신호 구동)', () => {
  let root: string;
  let transcript: string;
  let signalFile: string;
  let at: number;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'capmgr-'));
    transcript = join(root, 's1.jsonl');
    await fs.writeFile(transcript, '');
    // 신호 파일 자리는 어댑터가 쓰는 규칙과 같아야 한다 — 여기서 규칙 자체도 함께 지킨다.
    signalFile = resolveTurnSignalFile(root, 's1');
    await fs.mkdir(join(root, 'sessions', 's1'), { recursive: true });
    at = 1;
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  // 훅이 종료 신호를 쓰는 것을 흉내낸다. 매 호출마다 at을 올려 새 신호로 인식되게 한다.
  async function fireStop(
    extra: Record<string, unknown> = {},
    model: 'claude' | 'codex' | 'agy' = 'claude',
  ): Promise<void> {
    await fs.writeFile(
      signalFile,
      JSON.stringify({
        agent: model,
        event: 'Stop',
        sessionId: 'native-1',
        transcriptPath: transcript,
        complete: true,
        at: at++,
        ...extra,
      }),
    );
  }

  function makeManager(sched = fakeScheduler(), deps: Record<string, unknown> = {}) {
    const mgr = new CaptureManager(deps);
    mgr.register({
      workspaceId: 'w1',
      workspaceRoot: root,
      workspacePath: '/proj',
      sessionId: 's1',
      model: 'claude',
      signalFilePath: signalFile,
      getDetail: () => 'full' as const,
      scheduler: sched,
      signalPollMs: 20,
      retryDelaysMs: [0, 20],
    });
    return mgr;
  }

  it('등록만으로는 아무것도 읽지 않는다 — 신호가 트리거다', async () => {
    await fs.writeFile(transcript, [U('q1', 'u1'), A('a1', 'a1'), U('q2', 'u2')].join('\n') + '\n');
    const mgr = makeManager();
    await delay(120);
    assert.equal((await readAllTurns(root)).length, 0, '신호 없이 읽으면 안 된다');
    await mgr.disposeAll();
  });

  it('신호가 오면 닫힌 턴을 turns.jsonl에 append한다', async () => {
    const sched = fakeScheduler();
    const mgr = makeManager(sched);
    await fs.writeFile(transcript, [U('q1', 'u1'), A('a1', 'a1'), U('q2', 'u2')].join('\n') + '\n');
    await fireStop();
    await until(async () => (await readAllTurns(root)).length === 1);
    const turns = await readAllTurns(root);
    assert.equal(turns[0].user, 'q1');
    assert.equal(turns[0].assistantBody, 'a1');
    assert.equal(turns[0].id, 'claude:u1');
    assert.ok(sched.calls.updated >= 1 && sched.calls.ran >= 1);
    await mgr.disposeAll();
  });

  it('훅이 뜬 뒤 레코드가 늦게 닿아도 재시도가 잡는다', async () => {
    const mgr = makeManager();
    // 신호가 먼저, 그 턴을 닫는 레코드는 그 뒤에 (claude·codex 실측: 수십 ms 지연)
    await fireStop();
    await delay(5);
    await fs.writeFile(transcript, [U('q1', 'u1'), A('a1', 'a1'), U('q2', 'u2')].join('\n') + '\n');
    await until(async () => (await readAllTurns(root)).length === 1);
    assert.equal((await readAllTurns(root))[0].user, 'q1');
    await mgr.disposeAll();
  });

  it('턴마다 오는 신호를 증분으로 따라간다', async () => {
    const mgr = makeManager();
    await fs.writeFile(transcript, [U('q1', 'u1'), A('a1', 'a1'), U('q2', 'u2')].join('\n') + '\n');
    await fireStop();
    await until(async () => (await readAllTurns(root)).length === 1);
    await fs.appendFile(transcript, [A('a2', 'a2'), U('q3', 'u3')].join('\n') + '\n');
    await fireStop();
    await until(async () => (await readAllTurns(root)).length === 2);
    assert.equal((await readAllTurns(root))[1].user, 'q2');
    await mgr.disposeAll();
  });

  it('자식(서브에이전트) 신호는 부모 턴으로 치지 않는다', async () => {
    const mgr = makeManager();
    await fs.writeFile(transcript, [U('q1', 'u1'), A('a1', 'a1'), U('q2', 'u2')].join('\n') + '\n');
    await fireStop({ agentId: 'child-1' });
    await delay(150);
    assert.equal((await readAllTurns(root)).length, 0, '자식 신호로 읽으면 안 된다');
    // 부모 신호가 오면 그때 읽는다.
    await fireStop();
    await until(async () => (await readAllTurns(root)).length === 1);
    await mgr.disposeAll();
  });

  it('transcript 경로가 없는 신호는 유추하지 않고 드러낸다', async () => {
    const seen: string[] = [];
    const sched = fakeScheduler();
    const mgr = new CaptureManager({ onSignalUnusable: (i) => seen.push(i.reason) });
    mgr.register({
      workspaceId: 'w1', workspaceRoot: root, workspacePath: '/proj', sessionId: 's1',
      model: 'codex', signalFilePath: signalFile, getDetail: () => 'full' as const,
      scheduler: sched, signalPollMs: 20, retryDelaysMs: [0],
    });
    await fs.writeFile(transcript, [U('q1', 'u1'), A('a1', 'a1'), U('q2', 'u2')].join('\n') + '\n');
    await fireStop({ transcriptPath: '' }, 'codex');
    await until(async () => seen.length === 1);
    assert.match(seen[0], /transcript 경로가 없다/);
    assert.equal((await readAllTurns(root)).length, 0);
    await mgr.disposeAll();
  });

  it('unregister: carry의 마지막 열린 턴을 flush', async () => {
    const mgr = makeManager();
    // stop=tool_use → 완료 태그 없음 → carry에 열린 채 → unregister가 finalize로 flush.
    await fs.writeFile(transcript, [U('유일', 'u1'), A('답', 'a1', 'tool_use')].join('\n') + '\n');
    await fireStop();
    await delay(120);
    assert.equal((await readAllTurns(root)).length, 0);
    await mgr.unregister('s1');
    const turns = await readAllTurns(root);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].user, '유일');
  });

  it('atomic-read 규칙1: 완료 태그 없으면 기록 안 하고, 태그 오면 미완 부분까지 통째로 기록', async () => {
    const mgr = makeManager();
    await fs.writeFile(transcript, [U('q1', 'u1'), A('부분답변', 'a1', 'tool_use')].join('\n') + '\n');
    await fireStop();
    await delay(120);
    assert.equal((await readAllTurns(root)).length, 0);
    await fs.appendFile(transcript, A('최종답변', 'a2', 'end_turn') + '\n');
    await fireStop();
    await until(async () => (await readAllTurns(root)).length === 1);
    const t = (await readAllTurns(root))[0];
    assert.ok(t.assistantBody.includes('부분답변'), `부분답변 누락: ${t.assistantBody}`);
    assert.ok(t.assistantBody.includes('최종답변'), `최종답변 누락: ${t.assistantBody}`);
    await mgr.disposeAll();
  });

  it('atomic-read 규칙2: 완료 태그 없이 다음 user가 오면 직전 미완 내용을 강제 기록', async () => {
    const mgr = makeManager();
    await fs.writeFile(transcript, [U('q1', 'u1'), A('부분답변', 'a1', 'tool_use')].join('\n') + '\n');
    await fireStop();
    await delay(120);
    assert.equal((await readAllTurns(root)).length, 0);
    await fs.appendFile(transcript, U('q2', 'u2') + '\n');
    await fireStop();
    await until(async () => (await readAllTurns(root)).length === 1);
    const t = (await readAllTurns(root))[0];
    assert.equal(t.user, 'q1');
    assert.equal(t.assistantBody, '부분답변');
    await mgr.disposeAll();
  });

  it('재시작 멱등성: 새 매니저 같은 root → 중복 append 없음', async () => {
    await fs.writeFile(transcript, [U('q1', 'u1'), A('a1', 'a1'), U('q2', 'u2')].join('\n') + '\n');
    const m1 = makeManager();
    await fireStop();
    await until(async () => (await readAllTurns(root)).length === 1);
    await m1.disposeAll();
    const after1 = (await readAllTurns(root)).length;

    const m2 = makeManager();
    await fireStop();
    await delay(150);
    await m2.disposeAll();
    assert.equal((await readAllTurns(root)).length, after1, '중복 0 (cursor + 결정적 id)');
  });
});
