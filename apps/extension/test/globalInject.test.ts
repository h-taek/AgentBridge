import { strict as assert } from 'assert';
import { extractSessionIdFromStdin } from '@agentbridge/core';

// 쿼리 추출과 검색결과 렌더의 케이스는 0.5.0 B-4에서 폐기했다. 훅이 나르는 것이 지시문
// 하나가 되면서 그 경로에 소비자가 없다 — 검색은 `memory search`가 한다.
describe('globalInject — extractSessionIdFromStdin', () => {
  it('agy conversationId를 뽑는다 (폴백 conversation_id)', () => {
    assert.equal(extractSessionIdFromStdin(JSON.stringify({ conversationId: 'a1' }), 'agy'), 'a1');
    assert.equal(extractSessionIdFromStdin(JSON.stringify({ conversation_id: 'a2' }), 'agy'), 'a2');
  });
  it('codex session_id를 뽑는다', () => {
    assert.equal(extractSessionIdFromStdin(JSON.stringify({ session_id: 'c1' }), 'codex'), 'c1');
  });
  it('claude/알 수 없는 agent는 대상 아님 → 빈 문자열', () => {
    assert.equal(extractSessionIdFromStdin(JSON.stringify({ session_id: 'x' }), 'claude'), '');
  });
  it('JSON이 아니거나 필드가 없으면 빈 문자열', () => {
    assert.equal(extractSessionIdFromStdin('not json', 'codex'), '');
    assert.equal(extractSessionIdFromStdin(JSON.stringify({ other: 'q' }), 'agy'), '');
    assert.equal(extractSessionIdFromStdin('', 'codex'), '');
  });
});
