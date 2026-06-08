import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as workspaceStore from '../src/core/workspaceStore';
import { getSessions, registerSession } from '../src/core/sessionRegistry';
import { initCoreForTest } from './helpers';

describe('sessionRegistry', () => {
  let storagePath: string;
  let wid: string;

  beforeEach(async () => {
    storagePath = await fs.mkdtemp(join(tmpdir(), 'agentbridge-test-'));
    initCoreForTest(storagePath);
    // 실제 익스텐션 흐름과 동일 — getOrCreateWorkspaceId가 mapping + 정상 schema workspace.json 생성.
    wid = workspaceStore.getOrCreateWorkspaceId('/tmp/agentbridge-test-project');
  });

  afterEach(async () => {
    await fs.rm(storagePath, { recursive: true, force: true });
  });

  it('returns an empty list for a fresh workspace', async () => {
    const sessions = await getSessions(wid);
    assert.deepEqual(sessions, []);
  });

  it('repairs an old-schema (empty) workspace.json and returns empty list', async () => {
    // 옛 schema 흔적 시뮬레이션 — 빈 객체 workspace.json. readWorkspaceMeta의 repair fallback이
    // 정상 schema로 복구해야 한다. (과거 sessions.json + .broken 백업 방식은 core 통합 때 repair로 대체)
    const metaPath = join(workspaceStore.getWorkspacePath(wid), 'workspace.json');
    await fs.writeFile(metaPath, '{}', 'utf8');

    const sessions = await getSessions(wid);
    assert.deepEqual(sessions, []);

    // repair 후 workspace.json이 정상 schema로 복구되었는지 확인.
    const repaired = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    assert.equal(repaired.workspaceId, wid);
    assert.ok(Array.isArray(repaired.sessions));
  });

  it('registers a session and reads it back', async () => {
    // 실제 익스텐션 흐름과 동일하게 UUID 형식 sessionId 사용 (addSession이 UUID 형식을 강제 — V-04).
    const sid = '12345678-1234-1234-1234-123456789abc';
    await registerSession(wid, sid, 'claude');
    const sessions = await getSessions(wid);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sessionId, sid);
    assert.equal(sessions[0].model, 'claude');
  });

  it('rejects a non-UUID sessionId (V-04 path traversal guard)', async () => {
    await assert.rejects(() => registerSession(wid, '../escape', 'claude'), /invalid sessionId/);
  });
});
