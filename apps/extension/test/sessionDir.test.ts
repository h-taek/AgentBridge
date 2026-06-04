import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorkspaceStore } from '@agentbridge/core';

const WID = '11111111-1111-4111-8111-111111111111';
const SID = '22222222-2222-4222-8222-222222222222';

describe('getSessionDir', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'agentbridge-sessiondir-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('<root>/workspaces/<wid>/sessions/<sid> 경로를 반환한다', () => {
    const store = createWorkspaceStore({ rootPathForTesting: root });
    assert.equal(
      store.getSessionDir(WID, SID),
      join(root, 'workspaces', WID, 'sessions', SID),
    );
  });

  it('비-UUID sessionId는 거부한다 (traversal 방어)', () => {
    const store = createWorkspaceStore({ rootPathForTesting: root });
    assert.throws(() => store.getSessionDir(WID, '../escape'), /invalid sessionId/);
  });
});
