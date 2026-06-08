import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readAppendedBytes } from '@agentbridge/core';

describe('readAppendedBytes', () => {
  let file: string;

  beforeEach(async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'agentbridge-tail-'));
    file = join(dir, 'replay.log');
  });

  afterEach(async () => {
    await fs.rm(file, { force: true });
  });

  it('오프셋 0부터 전체를 읽고 newOffset을 끝으로 보고한다', async () => {
    await fs.writeFile(file, 'hello', 'utf8');
    const r = await readAppendedBytes(file, 0);
    assert.equal(r.data, 'hello');
    assert.equal(r.newOffset, Buffer.byteLength('hello'));
  });

  it('오프셋 이후 append된 바이트만 읽는다', async () => {
    await fs.writeFile(file, 'hello', 'utf8');
    const first = await readAppendedBytes(file, 0);
    await fs.appendFile(file, ' world', 'utf8');
    const second = await readAppendedBytes(file, first.newOffset);
    assert.equal(second.data, ' world');
    assert.equal(second.newOffset, Buffer.byteLength('hello world'));
  });

  it('새 바이트가 없으면 빈 문자열 + 같은 offset', async () => {
    await fs.writeFile(file, 'abc', 'utf8');
    const r = await readAppendedBytes(file, 3);
    assert.equal(r.data, '');
    assert.equal(r.newOffset, 3);
  });

  it('파일이 없으면 빈 문자열 + offset 0', async () => {
    const r = await readAppendedBytes(file, 0);
    assert.equal(r.data, '');
    assert.equal(r.newOffset, 0);
  });

  it('파일이 잘렸으면(현재 크기 < offset) 처음부터 다시 읽는다', async () => {
    await fs.writeFile(file, 'hello world', 'utf8');
    await fs.writeFile(file, 'new', 'utf8'); // truncate + rewrite
    const r = await readAppendedBytes(file, 11);
    assert.equal(r.data, 'new');
    assert.equal(r.newOffset, 3);
  });
});
