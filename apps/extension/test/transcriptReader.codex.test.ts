// apps/extension/test/transcriptReader.codex.test.ts
import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { join } from 'path';
import { codexConsume, EMPTY_CARRY, type ReaderCtx } from '@agentbridge/core';

const CTX: ReaderCtx = { workspaceId: 'w1', sessionId: 's1', detail: 'full' };

async function loadRecords(name: string): Promise<unknown[]> {
  const raw = await fs.readFile(join(__dirname, 'fixtures/transcript', name), 'utf8');
  return raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

describe('codexReader', () => {
  it('주입분(developer/environment_context)을 거르고 실사용자만 턴으로', async () => {
    const records = await loadRecords('codex-basic.jsonl');
    const { turns } = codexConsume(records, EMPTY_CARRY, CTX);
    assert.equal(turns.length, 1); // 첫 실사용자 턴 닫힘, 둘째는 carry
    const t = turns[0];
    assert.equal(t.user, '실제 질문');
    assert.equal(t.assistantBody, '답변');
    assert.equal(t.toolCalls.length, 1);
    assert.equal(t.toolCalls[0].tool, 'exec_command');
    assert.equal(t.toolCalls[0].arg, '{"cmd":"ls"}');
    assert.equal(t.toolCalls[0].summary, '파일 목록');
    assert.equal(t.id, 'codex:s1#0');
  });
});
