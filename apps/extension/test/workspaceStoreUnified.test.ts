import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorkspaceStore, deterministicWorkspaceId } from '@agentbridge/core';

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

  // ─── 닫기 확인 끄기 (0.5.0 6단계) ────────────────────────────────────
  //
  // 도는 중인 탭을 닫을 때 뜨는 확인을 사용자가 끌 수 있다. 그 선택은 레포 하나에만 걸린다 —
  // 저장 자리가 그 레포의 workspace.json이라서 다른 저장소에는 안 따라간다.

  it('처음에는 닫기 확인 끄기 값이 없다 — 기본은 묻는다', async () => {
    const store = createWorkspaceStore({ rootPathForTesting: storagePath });
    const ws = await store.createWorkspace({ workspacePath: '/tmp/agentbridge-unified-project' });
    assert.equal(ws.closeConfirmDisabled, undefined);
  });

  it('끄면 다시 읽어도 꺼진 채로 남는다', async () => {
    const store = createWorkspaceStore({ rootPathForTesting: storagePath });
    const wid = store.getOrCreateWorkspaceId('/tmp/agentbridge-unified-project');
    await store.createWorkspace({ workspacePath: '/tmp/agentbridge-unified-project' });
    await store.updateWorkspaceMeta(wid, { closeConfirmDisabled: true });

    const reopened = createWorkspaceStore({ rootPathForTesting: storagePath });
    assert.equal((await reopened.loadWorkspace(wid)).closeConfirmDisabled, true);
  });

  it('되돌리면 다시 묻는 상태가 된다', async () => {
    const store = createWorkspaceStore({ rootPathForTesting: storagePath });
    const wid = store.getOrCreateWorkspaceId('/tmp/agentbridge-unified-project');
    await store.createWorkspace({ workspacePath: '/tmp/agentbridge-unified-project' });
    await store.updateWorkspaceMeta(wid, { closeConfirmDisabled: true });
    await store.updateWorkspaceMeta(wid, { closeConfirmDisabled: false });
    assert.equal((await store.loadWorkspace(wid)).closeConfirmDisabled, false);
  });

  it('레포가 다르면 따라가지 않는다', async () => {
    const store = createWorkspaceStore({ rootPathForTesting: storagePath });
    const a = store.getOrCreateWorkspaceId('/tmp/agentbridge-repo-a');
    const b = store.getOrCreateWorkspaceId('/tmp/agentbridge-repo-b');
    await store.createWorkspace({ workspacePath: '/tmp/agentbridge-repo-a' });
    await store.createWorkspace({ workspacePath: '/tmp/agentbridge-repo-b' });
    await store.updateWorkspaceMeta(a, { closeConfirmDisabled: true });

    assert.equal((await store.loadWorkspace(a)).closeConfirmDisabled, true);
    assert.equal((await store.loadWorkspace(b)).closeConfirmDisabled, undefined);
  });
});
