// apps/extension/test/transcriptReader.agy.test.ts
// agy transcript.jsonl 기반 reader. (구 sqlite/protobuf 리더는 M2-8에서 제거됨.)
import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { join } from 'path';
import { agyConsume, EMPTY_CARRY, type ReaderCtx } from '@agentbridge/core';

const CTX: ReaderCtx = { workspaceId: 'w1', sessionId: 's1', detail: 'full' };

async function loadRecords(name: string): Promise<unknown[]> {
  const raw = await fs.readFile(join(__dirname, 'fixtures/transcript', name), 'utf8');
  return raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

describe('agyReader (transcript.jsonl)', () => {
  it('USER_EXPLICIT 턴 분리 + <USER_REQUEST> 추출 + 도구·요약 + thinking 제외 + 즉시 flush', async () => {
    const records = await loadRecords('agy-transcript.jsonl');
    const { turns, carry } = agyConsume(records, EMPTY_CARRY, CTX);
    // 두 턴 모두 최종 답변(content+도구없음)에서 즉시 flush → 2개
    assert.equal(turns.length, 2);

    const t1 = turns[0];
    assert.equal(t1.user, '이 폴더 파일 목록 보여줘'); // <USER_REQUEST>만, 메타데이터 제외
    assert.equal(t1.assistantBody, '이 폴더에는 a.txt, b.txt, README.md 가 있습니다.'); // thinking 제외
    assert.equal(t1.id, 'agy:s1#0'); // 결정적 id = sessionId#step_index
    assert.equal(t1.toolCalls.length, 1);
    assert.equal(t1.toolCalls[0].tool, 'list_dir');
    assert.equal(t1.toolCalls[0].arg, '{"DirectoryPath":"/proj"}');
    assert.equal(t1.toolCalls[0].summary, 'a.txt\nb.txt\nREADME.md');

    const t2 = turns[1];
    assert.equal(t2.user, '고마워');
    assert.equal(t2.assistantBody, '천만에요!');
    assert.equal(t2.toolCalls.length, 0);

    assert.equal(carry.open, null); // 마지막 턴까지 즉시 flush → carry 비어 finalize 재flush 없음
  });

  it('주입(source=SYSTEM)은 user로도 본문으로도 안 들어간다', () => {
    const records = [
      { step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '<USER_REQUEST>질문</USER_REQUEST>' },
      { step_index: 1, type: 'CONVERSATION_HISTORY', source: 'SYSTEM', content: '<agentbridge-context>주입</agentbridge-context>' },
      { step_index: 2, type: 'PLANNER_RESPONSE', source: 'MODEL', content: '답' },
    ];
    const { turns } = agyConsume(records, EMPTY_CARRY, CTX);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].user, '질문');
    assert.equal(turns[0].assistantBody, '답');
    assert.ok(!turns[0].assistantBody.includes('주입'));
  });

  it('carry로 턴이 이어진다(증분 호출): 도구 호출까지 본 뒤 다음 호출에서 최종답변→flush', async () => {
    const records = await loadRecords('agy-transcript.jsonl');
    const r1 = agyConsume(records.slice(0, 4), EMPTY_CARRY, CTX); // user~LIST_DIRECTORY까지
    assert.equal(r1.turns.length, 0); // 아직 최종답변 안 옴
    assert.ok(r1.carry.open);
    assert.equal(r1.carry.open!.toolCalls.length, 1);
    const r2 = agyConsume(records.slice(4), r1.carry, CTX); // 최종답변 + 둘째 턴
    assert.equal(r2.turns.length, 2);
    assert.equal(r2.turns[0].assistantBody, '이 폴더에는 a.txt, b.txt, README.md 가 있습니다.');
  });
});
