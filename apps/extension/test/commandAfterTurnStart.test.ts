// 첫 턴이 시작된 뒤 넣는 명령 — agy는 --remote-control을 켠 채 -i로 띄우면 첫 턴을 화면에
// 그리지 않는다. 그래서 원격 컨트롤을 기동 인자 대신 첫 턴 시작 뒤의 입력으로 켠다.
import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveTurnStartFile, resolveTurnSignalFile, sendAfterTurnStart } from '@agentbridge/core';

describe('sendAfterTurnStart — 첫 턴 시작 뒤 한 번 넣기', () => {
  const SID = 'sess-after-start-1';
  let ws: string;
  let ctrl: AbortController;

  beforeEach(async () => {
    ws = await fs.mkdtemp(join(tmpdir(), 'ab-after-start-'));
    await fs.mkdir(join(ws, 'sessions', SID), { recursive: true });
    ctrl = new AbortController();
  });

  afterEach(async () => {
    ctrl.abort();
    await fs.rm(ws, { recursive: true, force: true });
  });

  const start = (sent: string[]) =>
    sendAfterTurnStart({
      workspaceDir: ws,
      sessionId: SID,
      text: '/remote-control',
      send: (t) => sent.push(t),
      signal: ctrl.signal,
      intervalMs: 20,
    });

  it('턴 시작 신호가 생기면 한 번만 넣는다', async () => {
    const sent: string[] = [];
    const done = start(sent);
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(sent, []);

    await fs.writeFile(resolveTurnStartFile(ws, SID), '{}');
    assert.equal(await done, true);
    await fs.writeFile(resolveTurnSignalFile(ws, SID), '{}');
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(sent, ['/remote-control']);
  });

  it('시작 신호 없이 종료 신호만 와도 넣는다', async () => {
    const sent: string[] = [];
    const done = start(sent);
    await fs.writeFile(resolveTurnSignalFile(ws, SID), '{}');
    assert.equal(await done, true);
    assert.deepEqual(sent, ['/remote-control']);
  });

  it('신호 전에 멈추면 넣지 않는다', async () => {
    const sent: string[] = [];
    const done = start(sent);
    ctrl.abort();
    assert.equal(await done, false);
    await fs.writeFile(resolveTurnStartFile(ws, SID), '{}');
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(sent, []);
  });
});
