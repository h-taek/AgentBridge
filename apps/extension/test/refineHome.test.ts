import { strict as assert } from 'assert';
import { join } from 'path';
import { ensureRefineHome } from '@agentbridge/core';

const rootDir = '/tmp/abtest-root';

describe('refineHome', () => {
  it('returns empty env on non-darwin (현행 경로 유지)', () => {
    const r = ensureRefineHome('agy', { platform: 'win32', rootDir: '/tmp/never' });
    assert.deepEqual(r.env, {});
  });

  it('darwin + agy → HOME set to box', () => {
    const r = ensureRefineHome('agy', { platform: 'darwin', rootDir });
    assert.deepEqual(r.env, { HOME: join(rootDir, 'agy') });
  });

  it('darwin + codex → CODEX_HOME set to box', () => {
    const r = ensureRefineHome('codex', { platform: 'darwin', rootDir });
    assert.deepEqual(r.env, { CODEX_HOME: join(rootDir, 'codex') });
  });

  it('darwin + claude → empty env (격리 미지원)', () => {
    const r = ensureRefineHome('claude', { platform: 'darwin', rootDir });
    assert.deepEqual(r.env, {});
  });
});
