import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as workspaceStore from '../src/core/workspaceStore';
import {
  acquireDiskLock,
  releaseDiskLock,
  markCompactionInFlight,
  unmarkCompactionInFlight,
} from '../src/core/compactionScheduler';

const wid = '11111111-2222-3333-4444-555555555555';

describe('compactionScheduler locks', () => {
  let storagePath: string;

  beforeEach(async () => {
    storagePath = await fs.mkdtemp(join(tmpdir(), 'agentbridge-test-'));
    workspaceStore.init(storagePath);
    await fs.mkdir(join(storagePath, 'workspaces', wid), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(storagePath, { recursive: true, force: true });
  });

  it('acquires and releases disk lock', async () => {
    const ok = await acquireDiskLock(wid);
    assert.equal(ok, true);
    await releaseDiskLock(wid);
  });

  it('returns false when lock is already held by another (simulated) pid', async () => {
    // Pre-seed workspace.json with an active lock owned by a different pid, not stale.
    const lockPath = join(workspaceStore.getWorkspacePath(wid), 'workspace.json');
    await fs.writeFile(
      lockPath,
      JSON.stringify({ compactionInProgress: { pid: 999999, startedAt: Date.now() } }),
      'utf8',
    );
    const ok = await acquireDiskLock(wid);
    assert.equal(ok, false);
  });

  it('overrides stale lock (>5 min old)', async () => {
    const lockPath = join(workspaceStore.getWorkspacePath(wid), 'workspace.json');
    const sixMinutesAgo = Date.now() - 6 * 60 * 1000;
    await fs.writeFile(
      lockPath,
      JSON.stringify({ compactionInProgress: { pid: 999999, startedAt: sixMinutesAgo } }),
      'utf8',
    );
    const ok = await acquireDiskLock(wid);
    assert.equal(ok, true);
    await releaseDiskLock(wid);
  });

  it('inFlight Set excludes a second mark for the same workspace', () => {
    assert.equal(markCompactionInFlight(wid), true);
    assert.equal(markCompactionInFlight(wid), false);
    unmarkCompactionInFlight(wid);
    assert.equal(markCompactionInFlight(wid), true);
    unmarkCompactionInFlight(wid);
  });
});
