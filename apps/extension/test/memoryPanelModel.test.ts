// 0.5.0 6단계 — 기억 패널의 명령 접기.
//
// 웹뷰 스크립트는 템플릿 문자열 안이라 tsc도 mocha도 안 본다. 그래서 검증할 값은 호스트에서
// 만들어 넘기고, 웹뷰는 받은 것을 그리기만 한다.
import { strict as assert } from 'assert';
import {
  collapseCommand,
  toProfileDocRow,
  orderPinnedFirst,
  isProfileDocPath,
  shouldRefreshOnProfileFileChange,
} from '../src/views/memoryPanelModel';

describe('orderPinnedFirst', () => {
  const row = (slug: string, category: string, pinned: boolean) =>
    ({ category, slug, title: slug, summary: '', path: `/p/${category}/${slug}.md`, pinned });

  it('고정된 문서를 카테고리와 상관없이 앞으로 모으고, 양쪽 다 들어온 순서를 지킨다', () => {
    const out = orderPinnedFirst([
      row('a', 'conventions', false),
      row('b', 'conventions', true),
      row('c', 'workflows', false),
      row('d', 'workflows', true),
    ]);
    assert.deepEqual(out.map((r) => r.slug), ['b', 'd', 'a', 'c']);
  });

  it('고정된 문서가 없으면 순서를 바꾸지 않는다', () => {
    const rows = [row('a', 'x', false), row('b', 'y', false)];
    assert.deepEqual(orderPinnedFirst(rows), rows);
  });
});

describe('collapseCommand', () => {
  it('앞 두 낱말만 남긴다', () => {
    assert.equal(collapseCommand('git status --short'), 'git status');
  });

  it('같은 도구의 다른 서브커맨드가 갈린다 — 이 규칙의 목적', () => {
    assert.equal(collapseCommand('git diff HEAD~1'), 'git diff');
    assert.notEqual(collapseCommand('git diff HEAD~1'), collapseCommand('git status --short'));
  });

  it('플래그도 낱말로 센다 — 따옴표나 경로를 구분하려 들지 않는다', () => {
    assert.equal(collapseCommand('grep -rn "showWarningMessage" apps/extension/src'), 'grep -rn');
    assert.equal(collapseCommand("sed -n '440,660p' memoryPanel.ts"), 'sed -n');
  });

  it('낱말이 둘 이하면 그대로 둔다', () => {
    assert.equal(collapseCommand('npm test'), 'npm test');
    assert.equal(collapseCommand('npm'), 'npm');
  });

  it('여러 칸 띄어쓰기와 줄바꿈에서도 낱말로 센다', () => {
    assert.equal(collapseCommand('  sed   -n   x  '), 'sed -n');
    assert.equal(collapseCommand('cd apps/extension &&\nnpm test'), 'cd apps/extension');
  });

  it('빈 문자열은 빈 문자열이다 — 없는 명령을 만들어내지 않는다', () => {
    assert.equal(collapseCommand(''), '');
    assert.equal(collapseCommand('   '), '');
  });
});

describe('toProfileDocRow', () => {
  const base = {
    category: 'conventions',
    slug: 'no-emoji',
    title: '이모지를 쓰지 않는다',
    summary: '아이콘은 인라인 SVG만 쓴다',
    path: '/tmp/global/profiles/default/docs/conventions/no-emoji.md',
  };

  it('tags에 pinned가 있으면 pinned=true와 path를 싣는다', () => {
    assert.deepEqual(toProfileDocRow({ ...base, tags: ['pinned', 'ui'] }), {
      ...base,
      pinned: true,
    });
  });

  it('tags에 pinned가 없거나 tags가 비어 있으면 pinned=false다', () => {
    assert.equal(toProfileDocRow({ ...base, tags: ['ui'] }).pinned, false);
    assert.equal(toProfileDocRow({ ...base, tags: [] }).pinned, false);
    assert.equal(toProfileDocRow(base).pinned, false);
  });
});

describe('isProfileDocPath', () => {
  const docsDir = '/tmp/agentbridge/global/profiles/default/docs';

  it('프로필 docs 아래 .md 파일만 허용한다', () => {
    assert.equal(isProfileDocPath(docsDir, `${docsDir}/conventions/no-emoji.md`), true);
    assert.equal(isProfileDocPath(docsDir, `${docsDir}/flat.md`), true);
  });

  it('프로필 폴더 바깥, 상위 탈출(..), index.md, 비-md 파일은 거른다', () => {
    assert.equal(isProfileDocPath(docsDir, '/tmp/agentbridge/global/profiles/default/index.md'), false);
    assert.equal(isProfileDocPath(docsDir, `${docsDir}/index.md`), false);
    assert.equal(isProfileDocPath(docsDir, `${docsDir}/../index.md`), false);
    assert.equal(isProfileDocPath(docsDir, `${docsDir}/../../other.md`), false);
    assert.equal(isProfileDocPath(docsDir, `${docsDir}/conventions/note.txt`), false);
    assert.equal(isProfileDocPath(docsDir, docsDir), false);
    assert.equal(isProfileDocPath(docsDir, ''), false);
  });
});

describe('shouldRefreshOnProfileFileChange', () => {
  it('프로필 폴더 아래 일반 .md 변경은 참이다', () => {
    assert.equal(shouldRefreshOnProfileFileChange('profiles/default/docs/conventions/no-emoji.md'), true);
    assert.equal(shouldRefreshOnProfileFileChange('projects/repo/docs/infra/build.md'), true);
    assert.equal(shouldRefreshOnProfileFileChange('projects\\repo\\docs\\infra\\build.md'), true);
  });

  it('index.md와 .md가 아닌 파일, 빈 경로는 거른다', () => {
    assert.equal(shouldRefreshOnProfileFileChange('profiles/default/index.md'), false);
    assert.equal(shouldRefreshOnProfileFileChange('index.md'), false);
    assert.equal(shouldRefreshOnProfileFileChange('profiles\\default\\index.md'), false);
    assert.equal(shouldRefreshOnProfileFileChange('profiles/default/docs/conventions/no-emoji.md.123.tmp'), false);
    assert.equal(shouldRefreshOnProfileFileChange('profiles/default/proposals/p1.json'), false);
    assert.equal(shouldRefreshOnProfileFileChange('profiles/default/profile.json'), false);
    assert.equal(shouldRefreshOnProfileFileChange(''), false);
    assert.equal(shouldRefreshOnProfileFileChange(null), false);
  });
});
