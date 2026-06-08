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
import { initCoreForTest } from './helpers';

const wid = '11111111-2222-3333-4444-555555555555';

// 코어 WorkspaceStore.loadWorkspace는 정상 schema를 기대. raw 시드 시 필수 필드 채워둠.
function baseMeta(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    workspaceId: wid,
    title: 'test',
    createdAt: now,
    updatedAt: now,
    workspacePath: '/tmp/test',
    sessions: [],
    primarySessionId: null,
    compactionInProgress: null,
    ...extra,
  };
}

describe('compactionScheduler locks', () => {
  let storagePath: string;

  beforeEach(async () => {
    storagePath = await fs.mkdtemp(join(tmpdir(), 'agentbridge-test-'));
    initCoreForTest(storagePath);
    await fs.mkdir(join(storagePath, 'workspaces', wid), { recursive: true });
    // workspace.json 정상 시드 — acquireDiskLock이 loadWorkspace 호출하므로 필수.
    const metaPath = join(workspaceStore.getWorkspacePath(wid), 'workspace.json');
    await fs.writeFile(metaPath, JSON.stringify(baseMeta()), 'utf8');
  });

  afterEach(async () => {
    await fs.rm(storagePath, { recursive: true, force: true });
  });

  it('acquires and releases disk lock', async () => {
    const ok = await acquireDiskLock(wid);
    assert.equal(ok, true);
    await releaseDiskLock(wid);
  });

  it('returns false when a live holder pid holds a fresh lock', async () => {
    const lockPath = join(workspaceStore.getWorkspacePath(wid), 'workspace.json');
    // process.pid는 isPidAlive가 alive로 판정하는 유일한 pid(자기 자신).
    await fs.writeFile(
      lockPath,
      JSON.stringify(
        baseMeta({ compactionInProgress: { pid: process.pid, startedAt: Date.now() } }),
      ),
      'utf8',
    );
    const ok = await acquireDiskLock(wid);
    assert.equal(ok, false);
  });

  it('overrides a fresh lock whose holder pid is dead', async () => {
    const lockPath = join(workspaceStore.getWorkspacePath(wid), 'workspace.json');
    // 999999 = 존재하지 않는 pid. startedAt은 방금(=시간상 stale 아님)이지만 holder가
    // 죽었으므로 즉시 takeover해야 한다 (stale-lock 버그 회귀 방지).
    await fs.writeFile(
      lockPath,
      JSON.stringify(baseMeta({ compactionInProgress: { pid: 999999, startedAt: Date.now() } })),
      'utf8',
    );
    const ok = await acquireDiskLock(wid);
    assert.equal(ok, true);
    await releaseDiskLock(wid);
  });

  it('overrides stale lock (>5 min old)', async () => {
    const lockPath = join(workspaceStore.getWorkspacePath(wid), 'workspace.json');
    const sixMinutesAgo = Date.now() - 6 * 60 * 1000;
    await fs.writeFile(
      lockPath,
      JSON.stringify(
        baseMeta({ compactionInProgress: { pid: 999999, startedAt: sixMinutesAgo } }),
      ),
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
