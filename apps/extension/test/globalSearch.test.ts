import { strict as assert } from 'assert';
import { tokenizeQuery } from '@agentbridge/core';

describe('globalSearch.tokenize', () => {
  it('영문: 소문자화 + 불용어/1글자 제거', () => {
    assert.deepEqual(tokenizeQuery('Deploy the App'), ['deploy', 'app']); // 'the' 불용어
  });
  it('한글: 원형 보존 + 조사 변이형 추가 (비파괴)', () => {
    const t = tokenizeQuery('배포를 알려줘');
    assert.ok(t.includes('배포를'));  // 원형 보존
    assert.ok(t.includes('배포'));    // '를' 떼낸 변이형 추가
  });
  it('조사 음절로 끝나는 단어는 변이형을 안 만든다 (잔여 <2음절)', () => {
    const t = tokenizeQuery('경로'); // '로' 떼면 '경'(1음절) → 변이형 X
    assert.deepEqual(t, ['경로']);    // 원형만, 깨짐 없음
  });
  it('ASCII↔한글 경계 분리', () => {
    assert.ok(tokenizeQuery('git배포').includes('git'));
    assert.ok(tokenizeQuery('git배포').includes('배포'));
  });
});
