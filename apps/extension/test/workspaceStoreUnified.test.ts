import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createWorkspaceStore,
  deterministicWorkspaceId,
  readFolderMark,
  backfillFolderMarks,
  syncFolderMark,
} from '@agentbridge/core';

describe('workspaceStore (V-12 통일 동작)', () => {
  let storagePath: string;

  beforeEach(async () => {
    storagePath = await fs.mkdtemp(join(tmpdir(), 'agentbridge-unified-'));
  });

  afterEach(async () => {
    await fs.rm(storagePath, { recursive: true, force: true });
  });

  it('getOrCreateWorkspaceId가 결정적 ID를 반환한다', () => {
    const store = createWorkspaceStore({ rootPathForTesting: storagePath });
    const id = store.getOrCreateWorkspaceId('/tmp/agentbridge-unified-project');
    assert.equal(id, deterministicWorkspaceId('/tmp/agentbridge-unified-project'));
  });

  it('서로 다른 스토어 인스턴스(다른 앱 시뮬레이션)가 같은 폴더에 같은 ID를 반환한다', () => {
    const storeA = createWorkspaceStore({ rootPathForTesting: storagePath }); // 데스크탑 역할
    const storeB = createWorkspaceStore({ rootPathForTesting: storagePath }); // 익스텐션 역할
    const idA = storeA.getOrCreateWorkspaceId('/tmp/agentbridge-unified-project');
    const idB = storeB.getOrCreateWorkspaceId('/tmp/agentbridge-unified-project');
    assert.equal(idA, idB);
  });

  it('workspaces.json 장부 파일을 더 이상 만들지 않는다', () => {
    const store = createWorkspaceStore({ rootPathForTesting: storagePath });
    store.getOrCreateWorkspaceId('/tmp/agentbridge-unified-project');
    assert.equal(existsSync(join(storagePath, 'workspaces.json')), false);
  });

  it('createWorkspace가 같은 폴더에 대해 결정적 ID를 사용한다', async () => {
    const store = createWorkspaceStore({ rootPathForTesting: storagePath });
    const ws = await store.createWorkspace({ workspacePath: '/tmp/agentbridge-unified-project' });
    assert.equal(ws.workspaceId, deterministicWorkspaceId('/tmp/agentbridge-unified-project'));
  });

  it('createWorkspace를 같은 폴더로 두 번 불러도 워크스페이스가 하나다 (idempotent)', async () => {
    const store = createWorkspaceStore({ rootPathForTesting: storagePath });
    const first = await store.createWorkspace({
      workspacePath: '/tmp/agentbridge-unified-project',
      initialModel: 'claude',
    });
    const second = await store.createWorkspace({
      workspacePath: '/tmp/agentbridge-unified-project',
      initialModel: 'codex',
    });
    assert.equal(first.workspaceId, second.workspaceId);
    // 두 번째 호출의 세션은 기존 워크스페이스에 추가됨
    const meta = await store.loadWorkspace(first.workspaceId);
    assert.equal(meta.sessions.length, 2);
  });

  it('두 스토어 인스턴스가 동시에 세션을 추가해도 둘 다 살아남는다 (파일 락)', async () => {
    const storeA = createWorkspaceStore({ rootPathForTesting: storagePath });
    const storeB = createWorkspaceStore({ rootPathForTesting: storagePath });
    const wid = storeA.getOrCreateWorkspaceId('/tmp/agentbridge-unified-project');
    storeB.getOrCreateWorkspaceId('/tmp/agentbridge-unified-project');

    const sidA = '11111111-1111-4111-8111-111111111111';
    const sidB = '22222222-2222-4222-8222-222222222222';
    await Promise.all([
      storeA.addSession(wid, 'claude', 'cli', sidA),
      storeB.addSession(wid, 'codex', 'cli', sidB),
    ]);

    const meta = await storeA.loadWorkspace(wid);
    const ids = meta.sessions.map((s) => s.sessionId).sort();
    assert.deepEqual(ids, [sidA, sidB]);
  });

  it('deleteSession이 자식·손자 레코드까지 함께 지운다 (0.5.0 B-2)', async () => {
    const store = createWorkspaceStore({ rootPathForTesting: storagePath });
    const wid = store.getOrCreateWorkspaceId('/tmp/agentbridge-unified-project');
    const parent = await store.addSession(wid, 'claude', 'cli', '11111111-1111-4111-8111-111111111111');
    const child = await store.addSession(wid, 'claude', 'cli', '22222222-2222-4222-8222-222222222222');
    const grandchild = await store.addSession(wid, 'claude', 'cli', '33333333-3333-4333-8333-333333333333');
    await store.updateSessionMeta(wid, child.sessionId, { parentSessionId: parent.sessionId });
    await store.updateSessionMeta(wid, grandchild.sessionId, { parentSessionId: child.sessionId });

    await store.deleteSession(wid, parent.sessionId);

    const meta = await store.loadWorkspace(wid);
    assert.deepEqual(meta.sessions, []);
  });

  it('없는 부모를 가리키는 고아 레코드는 저장 층이 걸러내지 않는다', async () => {
    const store = createWorkspaceStore({ rootPathForTesting: storagePath });
    const wid = store.getOrCreateWorkspaceId('/tmp/agentbridge-unified-project');
    const orphan = await store.addSession(wid, 'claude', 'cli', '44444444-4444-4444-8444-444444444444');
    await store.updateSessionMeta(wid, orphan.sessionId, { parentSessionId: 'no-such-session' });

    const meta = await store.loadWorkspace(wid);
    assert.equal(meta.sessions.length, 1);
    assert.equal(meta.sessions[0].parentSessionId, 'no-such-session');
  });

  it('두 필드가 없는 기존 workspace.json을 읽어도 깨지지 않는다', async () => {
    const store = createWorkspaceStore({ rootPathForTesting: storagePath });
    const wid = store.getOrCreateWorkspaceId('/tmp/agentbridge-unified-project');
    await store.addSession(wid, 'claude', 'cli', '55555555-5555-4555-8555-555555555555');
    const metaPath = join(storagePath, 'workspaces', wid, 'workspace.json');
    const raw = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    assert.equal(raw.sessions[0].parentSessionId, undefined);
    assert.equal(raw.sessions[0].lastOpenedAt, undefined);

    const meta = await store.loadWorkspace(wid);
    assert.equal(meta.sessions.length, 1);
  });

  it('readFolderMark는 폴더의 dev·ino·birthtimeNs를 10진 문자열로 읽고 없으면 null이다', async () => {
    const dir = join(storagePath, 'sample-dir');
    await fs.mkdir(dir);
    const mark = readFolderMark(dir);
    assert.ok(mark);
    assert.match(mark!.dev, /^\d+$/);
    assert.match(mark!.ino, /^\d+$/);
    assert.match(mark!.birthtimeNs, /^\d+$/);
    assert.equal(readFolderMark(join(storagePath, 'missing-dir')), null);
  });

  it('시작 때 folderMark가 없고 경로가 살아 있는 것만 채우고, 이미 있는 표지는 덮지 않는다', async () => {
    const store = createWorkspaceStore({ rootPathForTesting: storagePath });
    const dirMissingMark = join(storagePath, 'proj-a');
    const dirHasMark = join(storagePath, 'proj-b');
    const dirDeleted = join(storagePath, 'proj-deleted');
    await fs.mkdir(dirMissingMark);
    await fs.mkdir(dirHasMark);
    await fs.mkdir(dirDeleted);

    const idA = store.getOrCreateWorkspaceId(dirMissingMark);
    const idB = store.getOrCreateWorkspaceId(dirHasMark);
    const idC = store.getOrCreateWorkspaceId(dirDeleted);
    const sentinel = { dev: '1', ino: '2', birthtimeNs: '3' };
    await store.updateWorkspaceMeta(idB, { folderMark: sentinel });
    await fs.rm(dirDeleted, { recursive: true, force: true });

    await backfillFolderMarks(store);

    const metaA = await store.loadWorkspace(idA);
    const metaB = await store.loadWorkspace(idB);
    const metaC = await store.loadWorkspace(idC);
    assert.deepEqual(metaA.folderMark, readFolderMark(dirMissingMark));
    assert.deepEqual(metaB.folderMark, sentinel);
    assert.equal(metaC.folderMark, undefined);

    const listed = await store.listWorkspaces();
    const entryA = listed.find((e) => e.workspaceId === idA);
    assert.deepEqual(entryA?.folderMark, readFolderMark(dirMissingMark));
  });

  it('열 때 folderMark가 다르면 덮어쓰고 같으면 updatedAt이 바뀌지 않는다', async () => {
    const store = createWorkspaceStore({ rootPathForTesting: storagePath });
    const dir = join(storagePath, 'proj-sync');
    await fs.mkdir(dir);
    const wid = store.getOrCreateWorkspaceId(dir);
    await store.updateWorkspaceMeta(wid, { folderMark: { dev: '9', ino: '9', birthtimeNs: '9' } });

    const changed = await syncFolderMark(store, wid, dir);
    assert.equal(changed, true);
    const afterOverwrite = await store.loadWorkspace(wid);
    assert.deepEqual(afterOverwrite.folderMark, readFolderMark(dir));

    await new Promise((r) => setTimeout(r, 15));
    const unchanged = await syncFolderMark(store, wid, dir);
    assert.equal(unchanged, false);
    const afterNoop = await store.loadWorkspace(wid);
    assert.equal(afterNoop.updatedAt, afterOverwrite.updatedAt);
  });

});
