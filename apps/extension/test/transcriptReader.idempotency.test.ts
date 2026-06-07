// 결정적 turn id → 같은 레코드를 두 번 consume해도 id가 동일(M2 dedup의 근거).
import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { join } from 'path';
import { claudeConsume, EMPTY_CARRY, type ReaderCtx } from '@agentbridge/core';

const CTX: ReaderCtx = { workspaceId: 'w1', sessionId: 's1', detail: 'full' };

describe('reader idempotency', () => {
  it('같은 레코드를 두 번 consume하면 turn id가 동일하다 (dedup 근거)', async () => {
    const raw = await fs.readFile(
      join(__dirname, 'fixtures/transcript/claude-basic.jsonl'),
      'utf8',
    );
    const records = raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    const a = claudeConsume(records, EMPTY_CARRY, CTX).turns.map((t) => t.id);
    const b = claudeConsume(records, EMPTY_CARRY, CTX).turns.map((t) => t.id);
    assert.deepEqual(a, b);
    assert.ok(a.length > 0);
  });
});
