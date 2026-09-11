import { strict as assert } from 'assert';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { watchServedFiles } from '@agentbridge/core';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('viewerWatch', () => {
  it('감시 중인 파일이 바뀌면 한 번 부른다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-watch-'));
    const f = join(dir, 'a.html');
    writeFileSync(f, '1');
    let n = 0;
    const w = watchServedFiles(() => {
      n += 1;
    }, 50);
    w.update([f]);
    await wait(50);
    writeFileSync(f, '2');
    await wait(300);
    w.close();
    assert.equal(n, 1);
  });

  it('연달아 바뀌어도 한 번으로 묶는다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-watch-'));
    const f = join(dir, 'a.html');
    writeFileSync(f, '1');
    let n = 0;
    const w = watchServedFiles(() => {
      n += 1;
    }, 80);
    w.update([f]);
    await wait(50);
    for (let i = 0; i < 5; i += 1) {
      writeFileSync(f, String(i));
      await wait(5);
    }
    await wait(400);
    w.close();
    assert.equal(n, 1);
  });

  it('감시 목록에 없는 이웃 파일은 무시한다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-watch-'));
    writeFileSync(join(dir, 'a.html'), '1');
    writeFileSync(join(dir, 'other.txt'), '1');
    let n = 0;
    const w = watchServedFiles(() => {
      n += 1;
    }, 50);
    w.update([join(dir, 'a.html')]);
    await wait(50);
    writeFileSync(join(dir, 'other.txt'), '2');
    await wait(300);
    w.close();
    assert.equal(n, 0);
  });

  it('같은 디렉터리의 파일 둘에 감시자를 하나만 단다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-watch-'));
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'a.html'), '1');
    writeFileSync(join(dir, 'b.css'), '1');
    const w = watchServedFiles(() => undefined, 50);
    w.update([join(dir, 'a.html'), join(dir, 'b.css')]);
    assert.equal((w as unknown as { size(): number }).size(), 1);
    w.close();
  });

  it('닫으면 더 부르지 않는다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-watch-'));
    const f = join(dir, 'a.html');
    writeFileSync(f, '1');
    let n = 0;
    const w = watchServedFiles(() => {
      n += 1;
    }, 50);
    w.update([f]);
    await wait(50);
    w.close();
    writeFileSync(f, '2');
    await wait(300);
    assert.equal(n, 0);
  });
});
