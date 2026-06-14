import { strict as assert } from 'assert';
import { homedir } from 'os';
import { join } from 'path';
import {
  getGlobalDir, profilesRoot, profileDir, profileDocsDir,
  profileIndexPath, profileMetaPath, proposalsDir, DEFAULT_PROFILE_ID,
} from '@agentbridge/core';

describe('globalPaths', () => {
  it('getGlobalDir는 ~/.agentbridge/global (오버라이드 없을 때)', () => {
    assert.equal(getGlobalDir(), join(homedir(), '.agentbridge', 'global'));
  });
  it('rootOverride로 임시 루트를 주입할 수 있다', () => {
    assert.equal(getGlobalDir('/tmp/x'), join('/tmp/x', 'global'));
  });
  it('default 프로필 하위 경로를 조합한다', () => {
    const g = '/tmp/x/global';
    assert.equal(DEFAULT_PROFILE_ID, 'default');
    assert.equal(profilesRoot(g), '/tmp/x/global/profiles');
    assert.equal(profileDir(g, 'default'), '/tmp/x/global/profiles/default');
    assert.equal(profileDocsDir(g, 'default'), '/tmp/x/global/profiles/default/docs');
    assert.equal(profileIndexPath(g, 'default'), '/tmp/x/global/profiles/default/index.md');
    assert.equal(profileMetaPath(g, 'default'), '/tmp/x/global/profiles/default/profile.json');
    assert.equal(proposalsDir(g, 'default'), '/tmp/x/global/profiles/default/proposals');
  });
});
