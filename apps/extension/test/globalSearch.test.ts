import { strict as assert } from 'assert';
import { tmpdir } from 'os';
import { join } from 'path';
import { tokenizeQuery } from '@agentbridge/core';
import { countTokenMatches } from '@agentbridge/core';
import { scoreDoc, minimumUsefulScore } from '@agentbridge/core';
import { getGlobalDir, writeProfileDocs, resolveContext } from '@agentbridge/core';
import {
  injectionFloor,
  gateInjectionMatches,
  resolveInjection,
  tokenizeQueryGroups,
  scoreDocGroups,
} from '@agentbridge/core';

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

// ─── 훅 주입 게이트 (0.6.0 spec/03 §1-3) ─────────────────────────────────
//
// `memory search`와 다른 임계를 쓴다. 모델이 스스로 부른 검색은 관대해도 되지만, 훅 주입은
// 안 물었는데 매 턴 들어가는 것이라 좁게 잡는다.

describe('globalSearch.injectionFloor', () => {
  it('토큰이 늘면 임계가 오른다 — 4 × √(토큰 수)', () => {
    assert.equal(injectionFloor(1), 4);
    assert.equal(injectionFloor(4), 8);
    assert.equal(injectionFloor(9), 12);
  });
  it('토큰이 없으면 0', () => {
    assert.equal(injectionFloor(0), 0);
  });
});

describe('globalSearch.gateInjectionMatches', () => {
  const m = (slug: string, score: number) => ({
    scope: 'user' as const, category: 'workflows', slug, title: slug, score,
  });

  it('절대 임계 미달을 버린다', () => {
    // 토큰 4개 → 임계 8
    const out = gateInjectionMatches([m('a', 20), m('b', 7)], 4);
    assert.deepEqual(out.map((x) => x.slug), ['a']);
  });
  it('최고점의 60% 미만을 버린다', () => {
    // 임계 4(1토큰) 위이지만 20의 60%=12에 못 미치는 것은 나간다
    const out = gateInjectionMatches([m('a', 20), m('b', 12), m('c', 11)], 1);
    assert.deepEqual(out.map((x) => x.slug), ['a', 'b']);
  });
  it('상위 3건에서 끊는다', () => {
    const out = gateInjectionMatches([m('a', 20), m('b', 19), m('c', 18), m('d', 17)], 1);
    assert.deepEqual(out.map((x) => x.slug), ['a', 'b', 'c']);
  });
  it('점수 내림차순으로 낸다 — 입력 순서와 무관하게', () => {
    const out = gateInjectionMatches([m('b', 20), m('a', 30), m('c', 25)], 1);
    assert.deepEqual(out.map((x) => x.slug), ['a', 'c', 'b']);
  });
  it('후보가 없으면 빈 배열', () => {
    assert.deepEqual(gateInjectionMatches([], 3), []);
  });
});

describe('globalSearch.tokenizeQueryGroups', () => {
  it('원형과 조사 변이형이 한 그룹이다', () => {
    assert.deepEqual(tokenizeQueryGroups('배포를'), [['배포를', '배포']]);
  });
  it('변이형이 없으면 혼자 선다', () => {
    assert.deepEqual(tokenizeQueryGroups('deploy'), [['deploy']]);
  });
  it('그룹 수가 곧 단어 수다 — 임계가 부풀지 않는다', () => {
    // '그대로'는 조사가 아닌 꼬리('로')까지 떼여 '그대'를 만든다. 그래도 단어는 하나다.
    assert.equal(tokenizeQueryGroups('그대로 보여줘').length, 2);
    assert.equal(tokenizeQuery('그대로 보여줘').length, 3); // 평평한 목록은 셋
  });
  it('평평한 목록은 그룹을 펼친 것과 같다 — 기존 소비자가 안 바뀐다', () => {
    const flat = tokenizeQueryGroups('배포를 알려줘').flat();
    assert.deepEqual(new Set(tokenizeQuery('배포를 알려줘')), new Set(flat));
  });
});

describe('globalSearch.scoreDocGroups', () => {
  const rec = {
    category: 'workflows', slug: 'evidence', title: '근거',
    summary: '그대로 두지 말고 근거를 댄다', indexEntries: ['evidence'], body: '그대로',
  };

  it('한 단어가 두 번 세이지 않는다', () => {
    // 평평한 목록은 '그대로'와 '그대'가 따로 걸려 summary·body에서 두 배가 된다.
    const flat = scoreDoc(rec, tokenizeQuery('그대로'));
    const grouped = scoreDocGroups(rec, tokenizeQueryGroups('그대로'));
    assert.equal(flat, 12);    // summary 5 + body 1, 두 번
    assert.equal(grouped, 6);  // summary 5 + body 1, 한 번
  });

  it('변이형만 걸려도 점수는 난다 — recall이 안 줄어든다', () => {
    const doc = { ...rec, summary: '배포 절차', body: '' };
    assert.ok(scoreDocGroups(doc, tokenizeQueryGroups('배포를')) > 0);
  });

  it('영문은 그룹이 홑이라 scoreDoc과 같다', () => {
    const doc = { category: 'infra', slug: 'deploy', title: 'Deployment', summary: 'ship it', indexEntries: ['deploy'], body: '' };
    assert.equal(
      scoreDocGroups(doc, tokenizeQueryGroups('deployment')),
      scoreDoc(doc, tokenizeQuery('deployment')),
    );
  });
});

describe('globalSearch.resolveInjection', () => {
  it('사용자 지식과 프로젝트 지식을 함께 돌리고 scope를 달아 낸다', async () => {
    const g = await tmpGlobal();
    await writeProfileDocs(g, 'default', {
      docs: [{ category: 'workflows', slug: 'git-flow', title: 'git-flow 배포', summary: 'main 릴리스 전용', body: '', indexEntries: ['배포', 'release'] }],
    });
    await writeProfileDocs(g, 'proj-1', {
      docs: [{ category: 'conventions', slug: 'release', title: '릴리스 절차', summary: '태그 후 배포', body: '', indexEntries: ['배포', 'release'] }],
    }, 'project');

    const out = await resolveInjection(g, { user: 'default', project: 'proj-1' }, '배포');
    assert.equal(out.length, 2);
    assert.deepEqual([...new Set(out.map((x) => x.scope))].sort(), ['project', 'user']);
    assert.ok(out.every((x) => x.title.length > 0), '제목이 실린다');
  });

  it('프로젝트 지식 자리가 없으면 사용자 지식만 돌린다', async () => {
    const g = await tmpGlobal();
    await writeProfileDocs(g, 'default', {
      docs: [{ category: 'workflows', slug: 'git-flow', title: 'git-flow 배포', summary: 'main 릴리스 전용', body: '', indexEntries: ['배포'] }],
    });
    const out = await resolveInjection(g, { user: 'default', project: null }, '배포');
    assert.equal(out.length, 1);
    assert.equal(out[0].scope, 'user');
  });

  it('무관한 프롬프트에는 아무것도 안 낸다', async () => {
    const g = await tmpGlobal();
    await writeProfileDocs(g, 'default', {
      docs: [{ category: 'workflows', slug: 'git-flow', title: 'git-flow', summary: 'main 릴리스 전용', body: '', indexEntries: ['배포'] }],
    });
    assert.deepEqual(await resolveInjection(g, { user: 'default', project: null }, '오늘 몇 시야'), []);
  });

  it('빈 쿼리는 빈 배열 — 토큰이 없으면 임계가 0이라 전부 통과할 수 있다', async () => {
    const g = await tmpGlobal();
    await writeProfileDocs(g, 'default', {
      docs: [{ category: 'workflows', slug: 'git-flow', title: 'git-flow', summary: 'main 릴리스 전용', body: '', indexEntries: ['배포'] }],
    });
    assert.deepEqual(await resolveInjection(g, { user: 'default', project: null }, '   '), []);
  });

  it('한 단어를 두 번 세어 임계를 넘던 오탐이 안 걸린다 (2026-09-09 라이브)', async () => {
    const g = await tmpGlobal();
    await writeProfileDocs(g, 'default', {
      docs: [{
        category: 'workflows',
        slug: '모르는-건-모른다고-주장엔-외부-근거를',
        title: '모르는 건 모른다고, 주장엔 외부 근거를',
        summary: '추측을 사실처럼 말하지 말고 근거를 그대로 댄다.',
        body: '모르면 모른다고 한다.',
        indexEntries: ['근거', '추측'],
      }],
    });
    const q = '훅으로 들어온 <agentbridge-context> 블록의 1절만 그대로 보여줘. 요약하지 말고.';
    assert.deepEqual(await resolveInjection(g, { user: 'default', project: null }, q), []);
  });
});
