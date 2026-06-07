// agy step source — node:sqlite로 실제 db에서 step 행 읽기 (검증된 db 사용, 없으면 skip).
import { strict as assert } from 'assert';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { readAgySteps } from '@agentbridge/core';

const DB = join(homedir(), '.gemini/antigravity-cli/conversations/41b76a53-62bd-42f4-9a22-31b2f5c7c2f2.db');

describe('readAgySteps', function () {
  it('reads step rows as {idx, stepType, payload:Buffer} ordered by idx', function () {
    if (!existsSync(DB)) this.skip();
    const rows = readAgySteps(DB, -1);
    assert.ok(rows.length >= 8);
    assert.ok(Buffer.isBuffer(rows[0].payload));
    assert.ok(rows.every((r, i) => i === 0 || r.idx > rows[i - 1].idx));
    assert.ok(rows.some((r) => r.stepType === 14)); // user step 존재
  });

  it('afterIdx filters already-consumed steps', function () {
    if (!existsSync(DB)) this.skip();
    const all = readAgySteps(DB, -1);
    const tail = readAgySteps(DB, all[0].idx);
    assert.equal(tail.length, all.length - 1);
  });
});
