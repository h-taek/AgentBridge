// 서브에이전트 명령 중 혼자 끝내는 셋 (0.5.0 4단계 W4) — list·read·check.
// 호스트를 부르는 넷(start·send·stop·close)은 통로 왕복이라 hostRequest 테스트가 덮는다.
//
// 근거: docs/0.5.0/spec/01_orca_adoption.md B-6, docs/0.5.0/plan/04_stage4_subagents.md W4.
import { strict as assert } from 'assert';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  listSubs,
  agentList,
  agentRead,
  agentCheck,
  resolveReportReadFile,
  resolveTurnSignalFile,
} from '@agentbridge/core';

const PARENT = 'parent-1';

async function makeWorkspace(): Promise<string> {
  const ws = await fsp.mkdtemp(join(tmpdir(), 'ab-sub-'));
  await fsp.mkdir(join(ws, 'sessions'), { recursive: true });
  return ws;
}

interface SessionSeed {
  sessionId: string;
  model?: string;
  parentSessionId?: string;
  agentName?: string;
  title?: string;
  closedAt?: string | null;
}

async function writeSessions(ws: string, sessions: SessionSeed[]): Promise<void> {
  const full = sessions.map((s) => ({
    model: 'codex',
    modelSessionId: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    closedAt: null,
    ...s,
  }));
  await fsp.writeFile(
    join(ws, 'workspace.json'),
    JSON.stringify({ workspaceId: 'ws', sessions: full }),
    'utf8',
  );
  for (const s of sessions) {
    await fsp.mkdir(join(ws, 'sessions', s.sessionId), { recursive: true });
  }
}

async function writeSignal(ws: string, sessionId: string, complete: boolean, at: number): Promise<void> {
  await fsp.writeFile(
    resolveTurnSignalFile(ws, sessionId),
    JSON.stringify({
      agent: 'codex',
      event: 'Stop',
      sessionId,
      transcriptPath: '/tmp/t.jsonl',
      complete,
      at,
    }),
    'utf8',
  );
}

async function writeTurns(ws: string, sessionId: string, count: number): Promise<void> {
  const lines = [];
  for (let i = 0; i < count; i++) {
    lines.push(
      JSON.stringify({
        id: `t${i}`,
        sessionId,
        model: 'codex',
        user: `질문 ${i}`,
        assistantBody: `답 ${i}`,
        completedAt: `2026-09-01T00:0${i}:00.000Z`,
      }),
    );
  }
  await fsp.writeFile(join(ws, 'sessions', sessionId, 'turns.jsonl'), lines.join('\n') + '\n', 'utf8');
}

describe('agent list·read·check (0.5.0 W4)', () => {
  let ws: string;

  beforeEach(async () => {
    ws = await makeWorkspace();
  });

  afterEach(async () => {
    await fsp.rm(ws, { recursive: true, force: true });
  });

  it('부르는 세션의 자식만 목록에 나온다', async () => {
    await writeSessions(ws, [
      { sessionId: PARENT },
      { sessionId: 'mine', parentSessionId: PARENT, agentName: 'golden-gate' },
      { sessionId: 'theirs', parentSessionId: 'other-parent', agentName: 'hangang' },
      { sessionId: 'nameless', parentSessionId: PARENT },
    ]);
    const subs = await listSubs(ws, PARENT);
    assert.deepEqual(
      subs.map((s) => s.name),
      ['golden-gate'],
    );
  });

  it('서브가 없으면 목록이 그 사실을 말한다', async () => {
    await writeSessions(ws, [{ sessionId: PARENT }]);
    assert.match(await agentList(ws, PARENT), /띄운 서브가 없다/);
  });

  it('check가 기다리기 전에 이미 끝나 있는 것을 먼저 낸다', async () => {
    await writeSessions(ws, [
      { sessionId: PARENT },
      { sessionId: 'sub', parentSessionId: PARENT, agentName: 'golden-gate' },
    ]);
    await writeSignal(ws, 'sub', true, Date.now());
    // wait를 안 줬는데도 나와야 한다 — 부르기 전에 끝난 것을 놓치지 않는다.
    assert.match(await agentCheck(ws, PARENT), /golden-gate/);
  });

  it('미완 표시가 달린 신호는 check를 깨우지 않는다', async () => {
    await writeSessions(ws, [
      { sessionId: PARENT },
      { sessionId: 'sub', parentSessionId: PARENT, agentName: 'golden-gate' },
    ]);
    await writeSignal(ws, 'sub', false, Date.now());
    assert.match(await agentCheck(ws, PARENT), /안 읽은 서브가 없다/);
  });

  it('--wait이 켜지는 순간 즉시 반환한다', async () => {
    await writeSessions(ws, [
      { sessionId: PARENT },
      { sessionId: 'sub', parentSessionId: PARENT, agentName: 'golden-gate' },
    ]);
    // 세 번째 폴링에서 신호가 온다. 상한(60초)까지 안 기다리고 그때 바로 돌아와야 한다.
    let ticks = 0;
    const out = await agentCheck(ws, PARENT, {
      wait: true,
      sleep: async () => {
        ticks += 1;
        if (ticks === 3) await writeSignal(ws, 'sub', true, Date.now());
      },
    });
    assert.match(out, /golden-gate/);
    assert.equal(ticks, 3);
  });

  it('아무도 안 끝나면 상한에서 빈손으로 돌아온다', async () => {
    await writeSessions(ws, [
      { sessionId: PARENT },
      { sessionId: 'sub', parentSessionId: PARENT, agentName: 'golden-gate' },
    ]);
    let clock = 0;
    const out = await agentCheck(ws, PARENT, {
      wait: true,
      forSec: 3,
      now: () => clock,
      sleep: async () => {
        clock += 1000;
      },
    });
    assert.match(out, /기다리는 동안 끝난 서브가 없다/);
  });

  it('신호 없이 닫힌 서브는 화면 기록의 꼬리와 함께 나온다', async () => {
    await writeSessions(ws, [
      { sessionId: PARENT },
      {
        sessionId: 'sub',
        parentSessionId: PARENT,
        agentName: 'golden-gate',
        closedAt: '2026-09-01T00:10:00.000Z',
      },
    ]);
    await fsp.writeFile(join(ws, 'sessions', 'sub', 'replay.log'), '마지막 화면 줄\n', 'utf8');
    const out = await agentCheck(ws, PARENT);
    assert.match(out, /완료 신호 없이 끝났다/);
    assert.match(out, /마지막 화면 줄/);
  });

  it('read가 읽음 표시를 쓰고 그 뒤 check가 조용해진다. check는 아무것도 안 쓴다', async () => {
    await writeSessions(ws, [
      { sessionId: PARENT },
      { sessionId: 'sub', parentSessionId: PARENT, agentName: 'golden-gate' },
    ]);
    await writeSignal(ws, 'sub', true, Date.now());
    await writeTurns(ws, 'sub', 2);

    // check는 순수 조회다 — 읽음 표시를 만들지 않는다.
    await agentCheck(ws, PARENT);
    await assert.rejects(fsp.access(resolveReportReadFile(ws, 'sub')));

    const read = await agentRead(ws, PARENT, 'golden-gate');
    assert.match(read, /질문 0/);
    await fsp.access(resolveReportReadFile(ws, 'sub')); // 이제 있다
    assert.match(await agentCheck(ws, PARENT), /안 읽은 서브가 없다/);
  });

  it('read --last N은 뒤에서 N턴만 낸다', async () => {
    await writeSessions(ws, [
      { sessionId: PARENT },
      { sessionId: 'sub', parentSessionId: PARENT, agentName: 'golden-gate' },
    ]);
    await writeTurns(ws, 'sub', 3);
    const out = await agentRead(ws, PARENT, 'golden-gate', 1);
    assert.match(out, /질문 2/);
    assert.doesNotMatch(out, /질문 0/);
  });

  it('없는 이름은 있는 것들을 알려주며 거절한다', async () => {
    await writeSessions(ws, [
      { sessionId: PARENT },
      { sessionId: 'sub', parentSessionId: PARENT, agentName: 'golden-gate' },
    ]);
    await assert.rejects(agentRead(ws, PARENT, 'hangang'), /golden-gate/);
  });
});
