import { strict as assert } from 'assert';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  sendHostRequest,
  claimHostRequest,
  completeHostRequest,
  hostRequestPath,
  hostResultPath,
  startHostRequestHandler,
} from '@agentbridge/core';

// 호스트 핸드셰이크 통로 (0.5.0 3단계 W6, B-5).
// 요청은 세션 폴더에 놓이고 그 세션을 소유한 호스트만 집는다. 기다림에는 시한이 있다.
describe('hostRequest — 왕복·시한·경합 (0.5.0 W6)', () => {
  let tmp: string;
  let storageRoot: string;
  let sessionDir: string;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(join(tmpdir(), 'ab-hostreq-'));
    storageRoot = join(tmp, 'storage');
    sessionDir = join(storageRoot, 'workspaces', 'ws-1', 'sessions', 'sid-1');
    await fsp.mkdir(sessionDir, { recursive: true });
  });

  afterEach(async () => {
    if (tmp) await fsp.rm(tmp, { recursive: true, force: true });
  });

  it('왕복 — 자식 프로세스가 요청하고 호스트가 답한다', async () => {
    // CLI는 별도 프로세스라 같은 메모리를 공유하지 않는다. 자식으로 띄워 파일만으로 오가는지 본다.
    const script = `
      const { sendHostRequest } = require(${JSON.stringify(require.resolve('@agentbridge/core'))});
      sendHostRequest(${JSON.stringify(sessionDir)}, { id: 'r1', kind: 'ping', at: Date.now() }, { timeoutMs: 8000 })
        .then((r) => { process.stdout.write(JSON.stringify(r)); });
    `;
    const watcher = startHostRequestHandler({
      storageRoot,
      handlers: { ping: (req) => `pong:${req.id}` },
      ownsSession: async () => true,
    });
    try {
      const { stdout } = await promisify(execFile)('node', ['-e', script], { timeout: 15000 });
      const res = JSON.parse(stdout);
      assert.equal(res.ok, true, `왕복 실패: ${stdout}`);
      assert.equal(res.output, 'pong:r1');
    } finally {
      watcher.stop();
    }
  }).timeout(20000);

  it('시한을 넘기면 실패로 끝내고 무엇을 시켰는지 남긴다', async () => {
    const res = await sendHostRequest(
      sessionDir,
      { id: 'r-timeout', kind: 'ping', at: 0 },
      { timeoutMs: 120 },
    );
    assert.equal(res.ok, false);
    assert.match(res.output, /ping/);
    // 안 집힌 요청은 CLI가 치운다 — 다음 요청이 자리를 잡을 수 있어야 한다.
    await assert.rejects(fsp.access(hostRequestPath(sessionDir)));
  });

  it('요청이 도는 중이면 두 번째는 자리를 못 잡는다', async () => {
    await fsp.writeFile(hostRequestPath(sessionDir), JSON.stringify({ id: 'first', kind: 'ping', at: 0 }));
    const res = await sendHostRequest(sessionDir, { id: 'second', kind: 'ping', at: 0 }, { timeoutMs: 80 });
    assert.equal(res.ok, false);
    assert.match(res.output, /처리 중/);
  });

  it('창이 둘이면 먼저 집는 쪽만 이긴다', async () => {
    await fsp.writeFile(hostRequestPath(sessionDir), JSON.stringify({ id: 'r2', kind: 'ping', at: 0 }));
    const [a, b] = await Promise.all([claimHostRequest(sessionDir), claimHostRequest(sessionDir)]);
    const won = [a, b].filter(Boolean);
    assert.equal(won.length, 1, '하나만 집어야 한다');
    assert.equal(won[0]!.id, 'r2');
  });

  it('결과를 쓰면 요청 자리가 비고 결과가 남는다', async () => {
    await fsp.writeFile(hostRequestPath(sessionDir), JSON.stringify({ id: 'r3', kind: 'ping', at: 0 }));
    const req = (await claimHostRequest(sessionDir))!;
    await completeHostRequest(sessionDir, { id: req.id, ok: true, output: 'pong', at: 0 });
    const raw = JSON.parse(await fsp.readFile(hostResultPath(sessionDir), 'utf8'));
    assert.equal(raw.output, 'pong');
    await assert.rejects(fsp.access(hostRequestPath(sessionDir)));
  });

  it('처리기는 남의 세션 요청을 집지 않는다', async () => {
    const watcher = startHostRequestHandler({
      storageRoot,
      handlers: { ping: () => 'pong' },
      ownsSession: async () => false,
    });
    try {
      const res = await sendHostRequest(sessionDir, { id: 'r4', kind: 'ping', at: 0 }, { timeoutMs: 300 });
      assert.equal(res.ok, false);
    } finally {
      watcher.stop();
    }
  }).timeout(10000);

  it('처리기가 소유한 세션의 요청에 답한다', async () => {
    const watcher = startHostRequestHandler({
      storageRoot,
      handlers: { ping: (req) => `pong:${req.id}` },
      ownsSession: async () => true,
    });
    try {
      const res = await sendHostRequest(sessionDir, { id: 'r5', kind: 'ping', at: 0 }, { timeoutMs: 5000 });
      assert.equal(res.ok, true);
      assert.equal(res.output, 'pong:r5');
    } finally {
      watcher.stop();
    }
  }).timeout(10000);

  it('알 수 없는 종류는 실패로 답한다', async () => {
    const watcher = startHostRequestHandler({
      storageRoot,
      handlers: {},
      ownsSession: async () => true,
    });
    try {
      const res = await sendHostRequest(sessionDir, { id: 'r6', kind: 'nope', at: 0 }, { timeoutMs: 5000 });
      assert.equal(res.ok, false);
      assert.match(res.output, /알 수 없는/);
    } finally {
      watcher.stop();
    }
  }).timeout(10000);
});
