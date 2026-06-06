// apps/extension/test/transcriptReader.claude.test.ts
import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { join } from 'path';
import { claudeConsume, EMPTY_CARRY, type ReaderCtx } from '@agentbridge/core';

const CTX: ReaderCtx = { workspaceId: 'w1', sessionId: 's1', detail: 'full' };

async function loadRecords(name: string): Promise<unknown[]> {
  const raw = await fs.readFile(join(__dirname, 'fixtures/transcript', name), 'utf8');
  return raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

describe('claudeReader', () => {
  it('두 개의 typed 턴을 분리하고 본문·도구를 채운다', async () => {
    const records = await loadRecords('claude-basic.jsonl');
    const { turns } = claudeConsume(records, EMPTY_CARRY, CTX);
    // 첫 턴은 닫힘(둘째 user 등장), 둘째 턴은 carry로 열린 채 → turns엔 1개
    assert.equal(turns.length, 1);
    const t = turns[0];
    assert.equal(t.user, '첫 질문');
    assert.equal(t.assistantBody, '답변 앞부분\n답변 마무리'); // thinking 제외, text 누적
    assert.equal(t.toolCalls.length, 1);
    assert.equal(t.toolCalls[0].tool, 'Read');
    assert.equal(t.toolCalls[0].arg, '{"file_path":"/x.md"}');
    assert.equal(t.toolCalls[0].summary, '파일 내용');
    assert.equal(t.id, 'claude:u1'); // 결정적 id = user uuid
    assert.equal(t.startedAt, '2026-06-07T00:00:00.000Z');
  });

  it('string content이지만 promptSource≠typed면 user 턴이 아니다 (슬래시 커맨드)', () => {
    const records = [
      { type: 'user', uuid: 'c1', message: { role: 'user', content: '/foo 명령' } }, // promptSource 없음
    ];
    const { turns, carry } = claudeConsume(records, EMPTY_CARRY, CTX);
    assert.equal(turns.length, 0);
    assert.equal(carry.open, null);
  });

  it('carry로 턴이 이어진다(증분 호출)', async () => {
    const records = await loadRecords('claude-basic.jsonl');
    // 첫 호출: 앞 3줄만
    const r1 = claudeConsume(records.slice(0, 3), EMPTY_CARRY, CTX);
    assert.equal(r1.turns.length, 0); // 아직 안 닫힘
    assert.ok(r1.carry.open);
    // 둘째 호출: 나머지
    const r2 = claudeConsume(records.slice(3), r1.carry, CTX);
    assert.equal(r2.turns.length, 1);
    assert.equal(r2.turns[0].assistantBody, '답변 앞부분\n답변 마무리');
  });
});
