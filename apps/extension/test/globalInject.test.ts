import { strict as assert } from 'assert';
import {
  extractSessionIdFromStdin,
  extractPromptFromStdin,
  extractInvocationNum,
  extractLastUserInput,
} from '@agentbridge/core';

// 쿼리 추출은 0.5.0 B-4에서 폐기했다가 0.6.0 spec/03 §1-1에서 되살렸다. 훅이 매 턴 프롬프트를
// 쿼리로 삼아 장기 기억을 매칭하기 때문이다. 소비자는 헬퍼(bin/agentbridge-memory.js) 하나다.
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

describe('globalInject — extractPromptFromStdin', () => {
  it('claude/codex는 stdin의 prompt가 쿼리다', () => {
    assert.equal(extractPromptFromStdin(JSON.stringify({ prompt: '배포 어떻게 해' }), 'claude'), '배포 어떻게 해');
    assert.equal(extractPromptFromStdin(JSON.stringify({ prompt: 'deploy?' }), 'codex'), 'deploy?');
  });
  it('agy는 stdin에 사용자 발화가 없다 → 빈 문자열', () => {
    assert.equal(extractPromptFromStdin(JSON.stringify({ prompt: 'x' }), 'agy'), '');
  });
  it('JSON이 아니거나 prompt가 없으면 빈 문자열', () => {
    assert.equal(extractPromptFromStdin('not json', 'claude'), '');
    assert.equal(extractPromptFromStdin(JSON.stringify({ other: 1 }), 'claude'), '');
    assert.equal(extractPromptFromStdin('', 'claude'), '');
  });
});

describe('globalInject — extractInvocationNum', () => {
  it('agy PreInvocation의 invocationNum을 뽑는다', () => {
    assert.equal(extractInvocationNum(JSON.stringify({ invocationNum: 0 })), 0);
    assert.equal(extractInvocationNum(JSON.stringify({ invocationNum: 3 })), 3);
  });
  it('필드가 없거나 숫자가 아니면 null — 게이트를 못 걸면 막지 않는다', () => {
    assert.equal(extractInvocationNum(JSON.stringify({ other: 1 })), null);
    assert.equal(extractInvocationNum(JSON.stringify({ invocationNum: 'x' })), null);
    assert.equal(extractInvocationNum('not json'), null);
  });
});

describe('globalInject — extractLastUserInput', () => {
  const rec = (o: Record<string, unknown>) => JSON.stringify(o);
  const user = (content: string) =>
    rec({ type: 'USER_INPUT', source: 'USER_EXPLICIT', content });

  it('마지막 사용자 발화를 낸다 — <USER_REQUEST> 안만', () => {
    const jsonl = [
      user('<USER_REQUEST> 첫 턴 </USER_REQUEST>'),
      rec({ type: 'PLANNER_RESPONSE', source: 'MODEL', content: '답' }),
      user('<USER_REQUEST> 두 번째 턴 </USER_REQUEST>'),
    ].join('\n');
    assert.equal(extractLastUserInput(jsonl), '두 번째 턴');
  });
  it('주입 스텝(SYSTEM_SDK)은 사용자 발화가 아니다', () => {
    const jsonl = [
      user('<USER_REQUEST> 진짜 발화 </USER_REQUEST>'),
      rec({ type: 'EPHEMERAL_MESSAGE', source: 'SYSTEM_SDK', content: '<agentbridge-context> …' }),
    ].join('\n');
    assert.equal(extractLastUserInput(jsonl), '진짜 발화');
  });
  it('태그가 없으면 content 원문을 쓴다', () => {
    assert.equal(extractLastUserInput(user('맨몸 발화')), '맨몸 발화');
  });
  it('꼬리만 읽어 첫 줄이 잘려도 나머지로 답한다', () => {
    const jsonl = ['pe": "USER_INPUT"}', user('<USER_REQUEST> 온전한 줄 </USER_REQUEST>')].join('\n');
    assert.equal(extractLastUserInput(jsonl), '온전한 줄');
  });
  it('사용자 발화가 없으면 빈 문자열', () => {
    assert.equal(extractLastUserInput(rec({ type: 'PLANNER_RESPONSE', source: 'MODEL' })), '');
    assert.equal(extractLastUserInput(''), '');
  });
});
