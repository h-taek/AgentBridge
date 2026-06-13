import { strict as assert } from 'assert';
import { slugify, renderDocMarkdown } from '@agentbridge/core';

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
