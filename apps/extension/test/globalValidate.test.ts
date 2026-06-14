import { strict as assert } from 'assert';
import { validateGlobalUpdateInput } from '@agentbridge/core';

const ok = { docs: [{ category: 'workflows', slug: 'git-flow', title: 'git-flow', summary: 's', body: 'b', indexEntries: ['git-flow'] }] };

describe('globalValidate', () => {
  it('정상 입력은 통과', () => { assert.doesNotThrow(() => validateGlobalUpdateInput(structuredClone(ok))); });
  it('docs 빈 배열 reject', () => {
    assert.throws(() => validateGlobalUpdateInput({ docs: [] }), /docs must be a non-empty array/);
  });
  it('알 수 없는 카테고리 reject', () => {
    const bad = structuredClone(ok); bad.docs[0].category = 'misc';
    assert.throws(() => validateGlobalUpdateInput(bad), /category must be one of/);
  });
  it('slug에 경로탈출/\\.md reject', () => {
    for (const slug of ['../escape', 'a/b', 'x.md', '/abs']) {
      const bad = structuredClone(ok); bad.docs[0].slug = slug;
      assert.throws(() => validateGlobalUpdateInput(bad), /slug/);
    }
  });
  it('body에 # 제목 / ## Summary 포함 시 reject', () => {
    const b1 = structuredClone(ok); b1.docs[0].body = '# 제목\n내용';
    assert.throws(() => validateGlobalUpdateInput(b1), /must not include the top-level/);
    const b2 = structuredClone(ok); b2.docs[0].body = '## Summary\nx';
    assert.throws(() => validateGlobalUpdateInput(b2), /## Summary/);
  });
  it('indexEntries 비면 reject', () => {
    const bad = structuredClone(ok); bad.docs[0].indexEntries = [];
    assert.throws(() => validateGlobalUpdateInput(bad), /indexEntries/);
  });
  it('길이캡 초과 reject (body 20000자 초과)', () => {
    const bad = structuredClone(ok); bad.docs[0].body = 'x'.repeat(20_001);
    assert.throws(() => validateGlobalUpdateInput(bad), /body.*exceeds/);
  });
  it('알 수 없는 필드 reject', () => {
    const bad = structuredClone(ok); (bad.docs[0] as Record<string, unknown>).content = 'x';
    assert.throws(() => validateGlobalUpdateInput(bad), /unsupported field/);
  });
});
