import { strict as assert } from 'assert';
import { homedir } from 'os';
import { join } from 'path';
import { getStorageRoot, getLegacyStorageRoot, createWorkspaceStore } from '@agentbridge/core';

describe('storageRoot', () => {
  it('~/agentbridge를 반환한다 (0.5.0에서 숨김 해제)', () => {
    assert.equal(getStorageRoot(), join(homedir(), 'agentbridge'));
  });

  it('옛 루트는 ~/.agentbridge로 남는다 (장기 메모리 이전용)', () => {
    assert.equal(getLegacyStorageRoot(), join(homedir(), '.agentbridge'));
  });

  it('createWorkspaceStore는 기본적으로 getStorageRoot()를 사용한다', () => {
    const store = createWorkspaceStore();
    assert.equal(store.getGlobalStoragePath(), getStorageRoot());
  });

  it('rootPathForTesting 옵션으로만 루트를 오버라이드할 수 있다', () => {
    const store = createWorkspaceStore({ rootPathForTesting: '/tmp/agentbridge-override' });
    assert.equal(store.getGlobalStoragePath(), '/tmp/agentbridge-override');
  });
});
