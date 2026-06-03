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
    const store = createWorkspaceStore(storagePath);
    const id = store.getOrCreateWorkspaceId('/tmp/agentbridge-unified-project');
    assert.equal(id, deterministicWorkspaceId('/tmp/agentbridge-unified-project'));
  });

  it('서로 다른 스토어 인스턴스(다른 앱 시뮬레이션)가 같은 폴더에 같은 ID를 반환한다', () => {
    const storeA = createWorkspaceStore(storagePath); // 데스크탑 역할
    const storeB = createWorkspaceStore(storagePath); // 익스텐션 역할
    const idA = storeA.getOrCreateWorkspaceId('/tmp/agentbridge-unified-project');
    const idB = storeB.getOrCreateWorkspaceId('/tmp/agentbridge-unified-project');
    assert.equal(idA, idB);
  });

  it('workspaces.json 장부 파일을 더 이상 만들지 않는다', () => {
    const store = createWorkspaceStore(storagePath);
    store.getOrCreateWorkspaceId('/tmp/agentbridge-unified-project');
    assert.equal(existsSync(join(storagePath, 'workspaces.json')), false);
  });

  it('createWorkspace가 같은 폴더에 대해 결정적 ID를 사용한다', async () => {
    const store = createWorkspaceStore(storagePath);
    const ws = await store.createWorkspace({ workspacePath: '/tmp/agentbridge-unified-project' });
    assert.equal(ws.workspaceId, deterministicWorkspaceId('/tmp/agentbridge-unified-project'));
  });

  it('createWorkspace를 같은 폴더로 두 번 불러도 워크스페이스가 하나다 (idempotent)', async () => {
    const store = createWorkspaceStore(storagePath);
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
    const storeA = createWorkspaceStore(storagePath);
    const storeB = createWorkspaceStore(storagePath);
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
});
