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

  it('deleteSession가 captured-<sessionId>.json도 함께 정리한다', async () => {
    const store = createWorkspaceStore({ rootPathForTesting: storagePath });
    const wid = await store.createWorkspace({
      workspacePath: '/tmp/agentbridge-test-captured',
      initialModel: 'claude',
    }).then((ws) => ws.workspaceId);

    const sessionId = '33333333-3333-4333-8333-333333333333';
    await store.addSession(wid, 'codex', 'cli', sessionId);

    // 훅이 작성하는 captured-<sessionId>.json 파일을 시뮬레이션
    const workspaceDirPath = store.getWorkspacePath(wid);
    const capturedFilePath = join(workspaceDirPath, `captured-${sessionId}.json`);
    await fs.writeFile(capturedFilePath, JSON.stringify({ turns: [] }), 'utf8');

    // 파일이 존재함을 확인
    assert.equal(existsSync(capturedFilePath), true);

    // deleteSession 호출
    await store.deleteSession(wid, sessionId);

    // captured 파일도 삭제되었는지 확인
    assert.equal(existsSync(capturedFilePath), false);

    // 세션도 삭제되었는지 확인
    const meta = await store.loadWorkspace(wid);
    const sessionFound = meta.sessions.find((s) => s.sessionId === sessionId);
    assert.equal(sessionFound, undefined);
  });
});
