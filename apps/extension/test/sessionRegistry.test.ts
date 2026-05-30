import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as workspaceStore from '../src/core/workspaceStore';
import { getSessions, registerSession } from '../src/core/sessionRegistry';

const wid = '22222222-2222-2222-2222-222222222222';

describe('sessionRegistry', () => {
  let storagePath: string;

  beforeEach(async () => {
    storagePath = await fs.mkdtemp(join(tmpdir(), 'agentbridge-test-'));
    workspaceStore.init(storagePath);
    await fs.mkdir(join(storagePath, 'workspaces', wid), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(storagePath, { recursive: true, force: true });
  });

  it('returns an empty list for a fresh workspace', async () => {
    const sessions = await getSessions(wid);
    assert.deepEqual(sessions, []);
  });

  it('backs up a corrupt sessions.json to .broken.<ts>.bak and returns empty list', async () => {
    const sessionsPath = join(workspaceStore.getWorkspacePath(wid), 'sessions.json');
    await fs.writeFile(sessionsPath, '{not valid json', 'utf8');

    const sessions = await getSessions(wid);
    assert.deepEqual(sessions, []);

    const dir = workspaceStore.getWorkspacePath(wid);
    const entries = await fs.readdir(dir);
    const backup = entries.find(e => e.startsWith('sessions.json.broken.'));
    assert.ok(backup, `expected a .broken.<ts>.bak backup, got entries: ${entries.join(', ')}`);
  });

  it('registers a session and reads it back', async () => {
    await registerSession(wid, 'test-session-1', 'claude');
    const sessions = await getSessions(wid);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sessionId, 'test-session-1');
    assert.equal(sessions[0].model, 'claude');
  });
});
