import { strict as assert } from 'assert';
import {
  extractPromptFromStdin,
  resolveQuery,
  renderGlobalMatches,
  extractSessionIdFromStdin,
} from '@agentbridge/core';

describe('globalInject — extractPromptFromStdin', () => {
  it('claude UserPromptSubmit 입력의 prompt 필드를 뽑는다', () => {
    assert.equal(extractPromptFromStdin(JSON.stringify({ prompt: '배포 절차' })), '배포 절차');
  });
  it('대체 필드명(user_prompt/input/message)도 시도한다', () => {
    assert.equal(extractPromptFromStdin(JSON.stringify({ user_prompt: 'x' })), 'x');
    assert.equal(extractPromptFromStdin(JSON.stringify({ input: 'y' })), 'y');
    assert.equal(extractPromptFromStdin(JSON.stringify({ message: 'z' })), 'z');
  });
  it('JSON이 아니거나 후보 필드가 없으면 빈 문자열', () => {
    assert.equal(extractPromptFromStdin('not json'), '');
    assert.equal(extractPromptFromStdin(JSON.stringify({ other: 'q' })), '');
    assert.equal(extractPromptFromStdin(''), '');
    assert.equal(extractPromptFromStdin('   '), '');
  });
  it('빈/공백 값 필드는 건너뛴다', () => {
    assert.equal(extractPromptFromStdin(JSON.stringify({ prompt: '   ', input: 'real' })), 'real');
  });
});

describe('globalInject — resolveQuery', () => {
  it('stdin 프롬프트가 있으면 그것을 쓴다', () => {
    assert.equal(resolveQuery(JSON.stringify({ prompt: 'from-stdin' }), 'last-turn'), 'from-stdin');
  });
  it('stdin이 비면 마지막 사용자 턴으로 폴백', () => {
    assert.equal(resolveQuery('', 'last-turn'), 'last-turn');
    assert.equal(resolveQuery('not json', 'last-turn'), 'last-turn');
  });
  it('둘 다 없으면 빈 문자열', () => {
    assert.equal(resolveQuery('', ''), '');
  });
});

describe('globalInject — renderGlobalMatches', () => {
  it('매치가 없으면 빈 문자열(섹션 생략)', () => {
    assert.equal(renderGlobalMatches([]), '');
  });
  it('매치가 있으면 제목·카테고리·요약을 담은 섹션을 만든다', () => {
    const out = renderGlobalMatches([
      { category: 'conventions', slug: 'deploy', title: 'Deploy flow', summary: 'release then tag', score: 12 },
    ]);
    assert.match(out, /## Global memory/);
    assert.match(out, /Deploy flow/);
    assert.match(out, /conventions/);
    assert.match(out, /release then tag/);
  });
  it('긴 요약은 잘린다(… 부착)', () => {
    const long = 'x'.repeat(300);
    const out = renderGlobalMatches([{ category: 'c', slug: 's', title: 't', summary: long, score: 5 }]);
    assert.match(out, /…/);
    assert.ok(!out.includes(long));
  });
});

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
