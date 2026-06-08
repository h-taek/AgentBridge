import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createOwnerWatcher } from '@agentbridge/core';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('createOwnerWatcher', () => {
  let root: string;
  let sessionDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'agentbridge-ownerwatch-'));
    sessionDir = join(root, 'ws', 'sessions', 's1');
    await fs.mkdir(sessionDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('owner.json 변화 시 onChange를 호출한다', async () => {
    let calls = 0;
    const w = createOwnerWatcher({ root, onChange: () => calls++, debounceMs: 30 });
    await wait(60);
    await fs.writeFile(join(sessionDir, 'owner.json'), '{}', 'utf8');
    await wait(200);
    assert.ok(calls >= 1, `onChange가 호출되지 않음 (calls=${calls})`);
    w.stop();
  });

  it('owner.json이 아닌 파일(replay.log) 변화는 무시한다', async () => {
    let calls = 0;
    const w = createOwnerWatcher({ root, onChange: () => calls++, debounceMs: 30 });
    await wait(60);
    await fs.writeFile(join(sessionDir, 'replay.log'), 'data', 'utf8');
    await wait(200);
    assert.equal(calls, 0);
    w.stop();
  });

  it('연속 변화를 debounce로 1회로 합친다', async () => {
    let calls = 0;
    const w = createOwnerWatcher({ root, onChange: () => calls++, debounceMs: 80 });
    await wait(60);
    const f = join(sessionDir, 'owner.json');
    await fs.writeFile(f, '{"a":1}', 'utf8');
    await fs.writeFile(f, '{"a":2}', 'utf8');
    await fs.writeFile(f, '{"a":3}', 'utf8');
    await wait(250);
    assert.equal(calls, 1);
    w.stop();
  });

  it('stop 후에는 onChange를 호출하지 않는다', async () => {
    let calls = 0;
    const w = createOwnerWatcher({ root, onChange: () => calls++, debounceMs: 30 });
    await wait(60);
    w.stop();
    await fs.writeFile(join(sessionDir, 'owner.json'), '{}', 'utf8');
    await wait(200);
    assert.equal(calls, 0);
  });
});
