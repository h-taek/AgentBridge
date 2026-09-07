// apps/extension/test/transcriptReader.agy.test.ts
// agy transcript.jsonl 기반 reader. (구 sqlite/protobuf 리더는 M2-8에서 제거됨.)
//
// 0.5.0 A-2: 턴을 닫는 근거가 추론에서 종료 훅 신호로 바뀌었다. transcript에는 턴 끝 표시가 없어
// 예전엔 "content 있고 tool_calls 없는 PLANNER_RESPONSE = 최종 답변"으로 추론했는데, 한 턴에
// 답변 텍스트가 여러 번 나오면 첫 번째에서 잘렸다. 이제 ctx.turnClosed가 유일한 근거다.
import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { join } from 'path';
import { agyConsume, EMPTY_CARRY, type ReaderCtx } from '@agentbridge/core';

const CTX: ReaderCtx = { workspaceId: 'w1', sessionId: 's1', detail: 'full' };
const CLOSED: ReaderCtx = { ...CTX, turnClosed: true };

async function loadRecords(name: string): Promise<unknown[]> {
  const raw = await fs.readFile(join(__dirname, 'fixtures/transcript', name), 'utf8');
  return raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

describe('agyReader (transcript.jsonl)', () => {
  it('USER_EXPLICIT 턴 분리 + <USER_REQUEST> 추출 + 도구·요약 + thinking 제외', async () => {
    const records = await loadRecords('agy-transcript.jsonl');
    const { turns, carry } = agyConsume(records, EMPTY_CARRY, CLOSED);
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

    assert.equal(carry.open, null); // 종료 신호가 왔으므로 마지막 턴까지 닫힘
  });

  it('종료 신호가 없으면 마지막 턴을 열어 둔다', async () => {
    const records = await loadRecords('agy-transcript.jsonl');
    const { turns, carry } = agyConsume(records, EMPTY_CARRY, CTX);
    // 다음 USER_INPUT이 앞 턴을 강제 마감하므로 첫 턴만 닫힌다.
    assert.equal(turns.length, 1);
    assert.equal(turns[0].user, '이 폴더 파일 목록 보여줘');
    assert.ok(carry.open, '마지막 턴은 신호 전까지 열려 있어야 한다');
    assert.equal(carry.open!.user, '고마워');
  });

  it('한 턴에 답변 텍스트가 여러 번 나와도 잘리지 않는다', () => {
    const records = [
      { step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '<USER_REQUEST>질문</USER_REQUEST>' },
      { step_index: 1, type: 'PLANNER_RESPONSE', source: 'MODEL', content: '먼저 이렇게 하고' },
      { step_index: 2, type: 'PLANNER_RESPONSE', source: 'MODEL', tool_calls: [{ name: 'run', args: {} }] },
      { step_index: 3, type: 'PLANNER_RESPONSE', source: 'MODEL', content: '끝났습니다' },
    ];
    const { turns } = agyConsume(records, EMPTY_CARRY, CLOSED);
    assert.equal(turns.length, 1);
    assert.ok(turns[0].assistantBody.includes('먼저 이렇게 하고'), '중간 답변이 빠졌다');
    assert.ok(turns[0].assistantBody.includes('끝났습니다'), '마지막 답변이 빠졌다');
    assert.equal(turns[0].toolCalls.length, 1);
  });

  it('신호가 와도 내용이 없으면 닫지 않는다 — 레코드가 아직 안 닿았을 수 있다', () => {
    const records = [
      { step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '<USER_REQUEST>질문</USER_REQUEST>' },
    ];
    const { turns, carry } = agyConsume(records, EMPTY_CARRY, CLOSED);
    assert.equal(turns.length, 0);
    assert.ok(carry.open);
  });

  it('주입(source=SYSTEM)은 user로도 본문으로도 안 들어간다', () => {
    const records = [
      { step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '<USER_REQUEST>질문</USER_REQUEST>' },
      { step_index: 1, type: 'CONVERSATION_HISTORY', source: 'SYSTEM', content: '<agentbridge-context>주입</agentbridge-context>' },
      { step_index: 2, type: 'PLANNER_RESPONSE', source: 'MODEL', content: '답' },
    ];
    const { turns } = agyConsume(records, EMPTY_CARRY, CLOSED);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].user, '질문');
    assert.equal(turns[0].assistantBody, '답');
    assert.ok(!turns[0].assistantBody.includes('주입'));
  });

  it('carry로 턴이 이어진다(증분 호출): 도구 호출까지 본 뒤 다음 호출에서 신호로 마감', async () => {
    const records = await loadRecords('agy-transcript.jsonl');
    const r1 = agyConsume(records.slice(0, 4), EMPTY_CARRY, CTX); // user~LIST_DIRECTORY까지
    assert.equal(r1.turns.length, 0);
    assert.ok(r1.carry.open);
    assert.equal(r1.carry.open!.toolCalls.length, 1);
    const r2 = agyConsume(records.slice(4), r1.carry, CLOSED); // 최종답변 + 둘째 턴
    assert.equal(r2.turns.length, 2);
    assert.equal(r2.turns[0].assistantBody, '이 폴더에는 a.txt, b.txt, README.md 가 있습니다.');
  });
});
