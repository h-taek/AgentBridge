import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { fork } from 'child_process';
import { createWorkspaceStore } from '@agentbridge/core';

const WORKER = resolve(__dirname, 'fixtures', 'addSessionWorker.ts');

function runWorker(rootPath: string, folderPath: string, sessionId: string): Promise<number> {
  return new Promise((res, rej) => {
    const child = fork(WORKER, [rootPath, folderPath, sessionId], {
      execArgv: ['-r', 'ts-node/register'],
      cwd: resolve(__dirname, '..'),
      stdio: 'pipe',
    });
    // 워커 stderr 수집 — 실패 시 원인 파악용
    const stderrBuf: Buffer[] = [];
    (child.stderr as NodeJS.ReadableStream).on('data', (chunk: Buffer) => stderrBuf.push(chunk));
    child.on('exit', (code) => {
      const exitCode = code ?? 1;
      if (exitCode !== 0 && stderrBuf.length > 0) {
        console.error(`[워커 stderr] sessionId=${sessionId}\n${Buffer.concat(stderrBuf).toString()}`);
      }
      res(exitCode);
    });
    child.on('error', rej);
  });
}

describe('프로세스 간 동시성 (V-12 lost update 검증)', function () {
  // 실제 프로세스 fork + ts-node 부팅이라 여유 있게
  this.timeout(60_000);

  let rootPath: string;

  beforeEach(async () => {
    rootPath = await fs.mkdtemp(join(tmpdir(), 'agentbridge-xproc-'));
  });

  afterEach(async () => {
    await fs.rm(rootPath, { recursive: true, force: true });
  });

  it('두 프로세스가 동시에 세션을 추가해도 둘 다 살아남는다', async () => {
    const folderPath = '/tmp/agentbridge-xproc-project';
    const sidA = '11111111-1111-4111-8111-111111111111';
    const sidB = '22222222-2222-4222-8222-222222222222';

    const [codeA, codeB] = await Promise.all([
      runWorker(rootPath, folderPath, sidA),
      runWorker(rootPath, folderPath, sidB),
    ]);
    assert.equal(codeA, 0, '워커 A 비정상 종료');
    assert.equal(codeB, 0, '워커 B 비정상 종료');

    const store = createWorkspaceStore({ rootPathForTesting: rootPath });
    const wid = store.getOrCreateWorkspaceId(folderPath);
    const meta = await store.loadWorkspace(wid);
    const ids = meta.sessions.map((s) => s.sessionId).sort();
    assert.deepEqual(ids, [sidA, sidB], 'lost update 발생 — 한쪽 세션이 사라짐');
  });
});
