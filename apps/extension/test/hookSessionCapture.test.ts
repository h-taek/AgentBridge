import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { captureSessionIdFromHook } from '@agentbridge/core';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('captureSessionIdFromHook', () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'agentbridge-hookcap-'));
    file = join(dir, 'captured-sess-1.json');
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('캡처 파일이 생기면 modelSessionId를 반환', async () => {
    const p = captureSessionIdFromHook({
      captureFilePath: file,
      intervalMs: 50,
      signal: new AbortController().signal,
    });
    await wait(150);
    await fs.writeFile(file, JSON.stringify({ modelSessionId: 'cap-1' }), 'utf8');
    assert.equal(await p, 'cap-1');
  });

  it('시작 시 stale 파일을 제거하고, 새 write 없으면 abort 시 null', async () => {
    await fs.writeFile(file, JSON.stringify({ modelSessionId: 'stale' }), 'utf8');
    const ctrl = new AbortController();
    const p = captureSessionIdFromHook({ captureFilePath: file, intervalMs: 50, signal: ctrl.signal });
    await wait(150);
    ctrl.abort();
    assert.equal(await p, null);
  });

  it('abort되면 null', async () => {
    const ctrl = new AbortController();
    const p = captureSessionIdFromHook({ captureFilePath: file, intervalMs: 50, signal: ctrl.signal });
    await wait(60);
    ctrl.abort();
    assert.equal(await p, null);
  });
});
