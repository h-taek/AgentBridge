// finalizeCarry — 세션 종료/완료 신호 시 carry에 열린 채 남은 마지막 턴을 emit.
// reader는 "다음 user"로만 턴을 닫으므로, 단일 턴 세션의 유일한 턴은 carry에 갇힘.
// M2 watcher가 세션 종료 시 이 헬퍼로 마지막 턴을 flush한다.
import { strict as assert } from 'assert';
import { codexConsume, finalizeCarry, EMPTY_CARRY, type ReaderCtx } from '@agentbridge/core';

const CTX: ReaderCtx = { workspaceId: 'w1', sessionId: 's1', detail: 'full' };

describe('finalizeCarry', () => {
  it('단일 턴 세션: consume은 0턴이지만 finalizeCarry가 마지막 턴을 emit', () => {
    const records = [
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '질문' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '답변' }] } },
      { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls"}', call_id: 'c1' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: '결과' } },
    ];
    const { turns, carry } = codexConsume(records, EMPTY_CARRY, CTX);
    assert.equal(turns.length, 0); // 다음 user가 없어 안 닫힘

    const last = finalizeCarry(carry, 'codex', CTX);
    assert.ok(last, 'finalizeCarry는 열린 턴을 반환해야 한다');
    assert.equal(last.user, '질문');
    assert.equal(last.assistantBody, '답변');
    assert.equal(last.toolCalls.length, 1);
    assert.equal(last.toolCalls[0].tool, 'exec_command');
    assert.equal(last.toolCalls[0].summary, '결과');
    assert.equal(last.id, 'codex:s1#0'); // consume이 닫은 턴과 동일 규칙의 결정적 id
  });

  it('열린 턴이 없으면 null (이중 flush·빈 세션 안전)', () => {
    assert.equal(finalizeCarry(EMPTY_CARRY, 'codex', CTX), null);
  });
});
