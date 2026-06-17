import { strict as assert } from 'assert';
import { GLOBAL_CATEGORIES, DOC_CAPS } from '@agentbridge/core';

describe('shared/global', () => {
  it('7 카테고리를 정확한 순서로 노출한다', () => {
    assert.deepEqual(GLOBAL_CATEGORIES, [
      'role', 'repos', 'domain', 'workflows', 'conventions', 'infra', 'verification',
    ]);
  });
  it('DOC_CAPS 길이 상한을 노출한다', () => {
    assert.equal(DOC_CAPS.title, 200);
    assert.equal(DOC_CAPS.summary, 2_000);
    assert.equal(DOC_CAPS.body, 20_000);
    assert.equal(DOC_CAPS.indexEntries, 50);
  });
});
