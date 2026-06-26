import { strict as assert } from 'assert';
import { tmpdir } from 'os';
import { join } from 'path';
import { tokenizeQuery } from '@agentbridge/core';
import { countTokenMatches } from '@agentbridge/core';
import { scoreDoc, minimumUsefulScore } from '@agentbridge/core';
import { getGlobalDir, writeProfileDocs, resolveContext } from '@agentbridge/core';

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

describe('globalSearch.koreanStopwords', () => {
  it('한국어 의문사 불용어 제거 — 의미 단어만 남는다', () => {
    // '어떻게'는 불용어 → '배포'만 남음
    assert.deepEqual(tokenizeQuery('어떻게 배포'), ['배포']);
  });
  it('조사 변이형이 불용어면 원형까지 버린다 (방법을→방법 누수 방지)', () => {
    // '방법'은 불용어 → 조사 붙은 '방법을'도 통째로 제거
    assert.deepEqual(tokenizeQuery('방법을'), []);
    assert.equal(countTokenMatches('방법 설명서', tokenizeQuery('방법을')), 0);
  });
  it('불용어를 부분으로 포함한 단어는 보존한다 (방법론 ≠ 방법, recall 보호)', () => {
    assert.ok(tokenizeQuery('방법론').includes('방법론'));
  });
  it('불용어 한 단어로는 무관 문서가 매칭되지 않는다', () => {
    const noise = {
      category: 'role', slug: 'solo', title: '1인 개발', summary: '혼자',
      indexEntries: ['solo'], body: '어떻게 진행하든 확인한다',
    };
    // 쿼리의 의미 단어는 '배포'뿐(어떻게는 불용어), noise 문서엔 '배포' 없음 → 0점
    assert.equal(scoreDoc(noise, tokenizeQuery('배포 어떻게')), 0);
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

const rec = {
  category: 'workflows', slug: 'git-flow', title: 'git-flow', summary: 'main 릴리스 전용',
  indexEntries: ['배포', 'release', 'git-flow'], body: 'develop 통합',
};

describe('globalSearch.score', () => {
  it('index entries(label) 가중치가 가장 큼', () => {
    // '배포'는 indexEntries에만 → label 가중치 10
    assert.ok(scoreDoc(rec, tokenizeQuery('배포')) >= 10);
  });
  it('미매칭 문서는 0점', () => {
    assert.equal(scoreDoc(rec, tokenizeQuery('xyz레디스')), 0);
  });
  it('minimumUsefulScore: 1토큰=1, 다토큰=2', () => {
    assert.equal(minimumUsefulScore(tokenizeQuery('배포')), 1);
    assert.equal(minimumUsefulScore(tokenizeQuery('배포 절차')), 2);
  });
});

async function tmpGlobal(): Promise<string> {
  return getGlobalDir(join(tmpdir(), `gcs-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`));
}

describe('globalSearch.resolveContext', () => {
  it('쿼리에 맞는 문서를 점수순 top-N teaser로 반환', async () => {
    const g = await tmpGlobal();
    await writeProfileDocs(g, 'default', {
      docs: [
        { category: 'workflows', slug: 'git-flow', title: 'git-flow', summary: 'main 릴리스 전용', body: '', indexEntries: ['배포', 'release', 'git-flow'] },
        { category: 'role', slug: 'solo', title: '1인 개발', summary: '혼자 만든다', body: '', indexEntries: ['solo'] },
      ],
    });
    const matches = await resolveContext(g, 'default', '배포 절차', { topN: 5 });
    assert.ok(matches.length >= 1);
    assert.equal(matches[0].slug, 'git-flow');         // 배포 매칭 문서가 1위
    assert.ok(matches[0].summary.includes('릴리스'));   // teaser에 요약 포함
    assert.ok(matches.every((m) => m.slug !== 'solo')); // 무관 문서 제외(임계 미달)
  });
  it('매칭 없으면 빈 배열', async () => {
    const g = await tmpGlobal();
    await writeProfileDocs(g, 'default', { docs: [{ category: 'role', slug: 'solo', title: '1인', summary: 's', body: '', indexEntries: ['solo'] }] });
    assert.deepEqual(await resolveContext(g, 'default', 'xyz레디스큐브', { topN: 5 }), []);
  });
});
