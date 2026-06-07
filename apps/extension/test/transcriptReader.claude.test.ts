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

  it('stop_reason=end_turn이면 다음 user 없이도 즉시 마감한다 (실시간 flush)', () => {
    const records = [
      { type: 'user', promptSource: 'typed', uuid: 'u1', timestamp: '2026-06-07T00:00:00.000Z', message: { role: 'user', content: '유일 질문' } },
      { type: 'assistant', uuid: 'a1', timestamp: '2026-06-07T00:00:01.000Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '유일 답변' }] } },
    ];
    const { turns, carry } = claudeConsume(records, EMPTY_CARRY, CTX);
    assert.equal(turns.length, 1); // 다음 user 없이도 end_turn에서 닫힘
    assert.equal(turns[0].user, '유일 질문');
    assert.equal(turns[0].assistantBody, '유일 답변');
    assert.equal(carry.open, null); // carry 비어 finalize 재flush 안 함
  });

  it('thinking 레코드가 end_turn을 먼저 달고 와도 뒤따르는 답변 text를 잃지 않는다 (빈-body 버그 재현)', () => {
    // 실데이터 구조: claude는 한 메시지를 블록별 레코드(thinking/text)로 쪼개 쓰고 stop_reason을 복제.
    // thinking 레코드가 end_turn을 달고 text보다 먼저 온다 → 옛 로직은 여기서 빈 채로 마감해 답변 유실.
    const records = [
      { type: 'user', promptSource: 'typed', uuid: 'u1', timestamp: '2026-06-07T00:00:00.000Z', message: { role: 'user', content: '질문' } },
      { type: 'assistant', uuid: 'a1', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '생각...' }] } },
      { type: 'assistant', uuid: 'a2', timestamp: '2026-06-07T00:00:02.000Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '진짜 답변' }] } },
    ];
    const { turns, carry } = claudeConsume(records, EMPTY_CARRY, CTX);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].assistantBody, '진짜 답변'); // 빈 채로 마감되지 않음
    assert.equal(carry.open, null);
  });

  it('답변 없이 끊긴 턴(생각만)은 다음 user 경계에서 skip한다 (빈-턴 규칙)', () => {
    const records = [
      { type: 'user', promptSource: 'typed', uuid: 'u1', message: { role: 'user', content: '첫 질문' } },
      { type: 'assistant', uuid: 'a1', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: '생각만 하다 끊김' }] } },
      { type: 'user', promptSource: 'typed', uuid: 'u2', message: { role: 'user', content: '둘째 질문' } },
    ];
    const { turns } = claudeConsume(records, EMPTY_CARRY, CTX);
    assert.equal(turns.length, 0); // 내용 없는 첫 턴은 안 박힘
  });

  it('end_turn 전 tool_use 단계(stop=tool_use)는 마감하지 않는다', () => {
    const records = [
      { type: 'user', promptSource: 'typed', uuid: 'u1', message: { role: 'user', content: 'q' } },
      { type: 'assistant', uuid: 'a1', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { p: 1 } }] } },
    ];
    const { turns, carry } = claudeConsume(records, EMPTY_CARRY, CTX);
    assert.equal(turns.length, 0); // tool_use는 중간 단계 — 안 닫힘
    assert.ok(carry.open);
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
