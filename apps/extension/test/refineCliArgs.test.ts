import { strict as assert } from 'assert';
import { buildRefineSpawnRequest } from '@agentbridge/core';

describe('refineCliArgs', () => {
  it('agy refine: 공유 tmpdir cwd + skip-permissions (per-run 격리 dir 없음)', () => {
    const req = buildRefineSpawnRequest('agy', 'p');
    assert.ok(req.cwd, 'cwd(tmpdir) 설정');
    assert.deepEqual(req.args, ['-p', 'p', '--dangerously-skip-permissions']);
  });
});
