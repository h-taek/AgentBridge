import { strict as assert } from 'assert';
import { slugify, renderDocMarkdown } from '@agentbridge/core';
import { extractTitle, extractSummary, extractIndexEntries, renderIndexMarkdown } from '@agentbridge/core';

describe('globalMarkdown.render', () => {
  it('slugify: 영문 소문자·하이픈, 한글 보존', () => {
    assert.equal(slugify('Git Flow'), 'git-flow');
    assert.equal(slugify('  배포 절차  '), '배포-절차');   // 한글 보존(gc-tree 원본은 ASCII만)
    assert.equal(slugify('!!!'), 'doc');                    // 빈 결과 fallback
  });
  it('renderDocMarkdown: # 제목 / ## Summary / ## Index Entries / ## Details 구조', () => {
    const md = renderDocMarkdown({
      title: 'git-flow', summary: 'main은 릴리스 전용', body: 'develop 통합',
      indexEntries: ['git-flow', 'release', '배포'],
    });
    assert.match(md, /^# git-flow\n/);
    assert.match(md, /## Summary\n\nmain은 릴리스 전용/);
    assert.match(md, /## Index Entries\n\n- git-flow\n- release\n- 배포/);
    assert.match(md, /## Details\n\ndevelop 통합/);
  });
  it('summary 비면 throw', () => {
    assert.throws(() => renderDocMarkdown({ title: 't', summary: '  ', body: 'b', indexEntries: ['x'] }), /summary is required/);
  });
});

describe('globalMarkdown.parse', () => {
  const md = renderDocMarkdown({
    title: 'git-flow', summary: 'main은 릴리스 전용', body: 'develop 통합', indexEntries: ['git-flow', '배포'],
  });
  it('extractTitle/Summary/IndexEntries 라운드트립', () => {
    assert.equal(extractTitle(md), 'git-flow');
    assert.equal(extractSummary(md), 'main은 릴리스 전용');
    assert.deepEqual(extractIndexEntries(md), ['git-flow', '배포']);
  });
  it('renderIndexMarkdown: 카테고리 순서대로 그룹 + path 아래 라벨 들여쓰기', () => {
    const idx = renderIndexMarkdown({
      profileId: 'default',
      docs: [
        { category: 'workflows', label: 'git-flow', path: 'docs/workflows/git-flow.md' },
        { category: 'role', label: '1인 개발', path: 'docs/role/solo.md' },
      ],
    });
    assert.ok(idx.indexOf('## Role') < idx.indexOf('## Workflows')); // 카테고리 순서
    assert.match(idx, /- docs\/workflows\/git-flow\.md\n {2}- git-flow/);
  });
  it('빈 docs: "No durable docs yet."', () => {
    assert.match(renderIndexMarkdown({ profileId: 'default', docs: [] }), /No durable docs yet\./);
  });
});
