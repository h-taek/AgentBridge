import { strict as assert } from 'assert';
import { tokenizeQuery } from '@agentbridge/core';
import { countTokenMatches } from '@agentbridge/core';

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

describe('globalSearch.match', () => {
  it('한글: 문서 텍스트가 쿼리 토큰을 부분문자열로 포함하면 매칭', () => {
    // 쿼리 "배포를"→토큰 {배포를,배포}; 문서에 "배포"만 있어도 매칭(안 깨짐)
    assert.equal(countTokenMatches('git-flow 배포 release', tokenizeQuery('배포를')), 1);
  });
  it('한글: 조사 음절로 끝나는 단어를 깨지 않는다', () => {
    // 문서 "경로 설정", 쿼리 "경로의"→{경로의,경로}; "경로" 부분문자열 매칭, "경"으로 안 쪼갬
    assert.equal(countTokenMatches('경로 설정', tokenizeQuery('경로의')), 1);
    // 무관 단어 "워크플로"는 "로" 쿼리에 안 걸림(1음절 토큰은 매칭 제외)
    assert.equal(countTokenMatches('워크플로', tokenizeQuery('로')), 0);
  });
  it('ASCII: 단어 경계 매칭', () => {
    assert.equal(countTokenMatches('deploy now', tokenizeQuery('deploy')), 1);
    assert.equal(countTokenMatches('redeployment', tokenizeQuery('dep')), 0); // 부분단어 비매칭
  });
});
