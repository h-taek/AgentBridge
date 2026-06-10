import { strict as assert } from 'assert';
import { buildRefineSpawnRequest } from '@agentbridge/core';

describe('refineCliArgs isolatedCwd platform gate', () => {
  it('agy refine: darwin이면 isolatedCwd 미생성', () => {
    const req = buildRefineSpawnRequest('agy', 'p', { platform: 'darwin' });
    assert.equal(req.isolatedCwd, undefined);
  });
  it('agy refine: 비-darwin이면 isolatedCwd 생성(현행 9종 청소 경로)', () => {
    const req = buildRefineSpawnRequest('agy', 'p', { platform: 'win32' });
    assert.ok(req.isolatedCwd);
  });
});
