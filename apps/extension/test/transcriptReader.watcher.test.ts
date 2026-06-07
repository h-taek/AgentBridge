// readJsonlIncrement — jsonl 증분 파싱: 완전한 라인만 파싱, 부분 라인 보류(offset 미전진), 깨진 라인 skip.
import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readJsonlIncrement } from '@agentbridge/core';

async function tmpFile(content: string): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'wtest-'));
  const f = join(dir, 't.jsonl');
  await fs.writeFile(f, content);
  return f;
}

describe('readJsonlIncrement', () => {
  it('완전한 새 라인만 파싱하고, 부분 라인은 보류, offset은 마지막 개행까지', async () => {
    const f = await tmpFile('{"a":1}\n{"a":2}\n{"partial":');
    const r1 = await readJsonlIncrement(f, 0);
    assert.deepEqual(r1.records, [{ a: 1 }, { a: 2 }]);
    await fs.appendFile(f, '3}\n');
    const r2 = await readJsonlIncrement(f, r1.offset);
    assert.deepEqual(r2.records, [{ partial: 3 }]);
  });

  it('깨진 라인은 그것만 skip하고 나머지는 통과', async () => {
    const f = await tmpFile('{"ok":1}\nNOT JSON\n{"ok":2}\n');
    const r = await readJsonlIncrement(f, 0);
    assert.deepEqual(r.records, [{ ok: 1 }, { ok: 2 }]);
  });

  it('완전한 라인이 아직 없으면 빈 결과 + offset 미전진', async () => {
    const f = await tmpFile('{"incomplete":');
    const r = await readJsonlIncrement(f, 0);
    assert.deepEqual(r.records, []);
    assert.equal(r.offset, 0);
  });

  it('새 바이트 없으면 빈 결과 + 같은 offset', async () => {
    const f = await tmpFile('{"a":1}\n');
    const first = await readJsonlIncrement(f, 0);
    const second = await readJsonlIncrement(f, first.offset);
    assert.deepEqual(second.records, []);
    assert.equal(second.offset, first.offset);
  });
});
