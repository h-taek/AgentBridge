// 0.8.0 — 프로젝트 폴더 이름 변경·이동 뒤 워크스페이스 이어받기 테스트.
// 임시 폴더와 실제 git 저장소로 검증한다(~/agentbridge를 건드리지 않는다).
import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import { existsSync, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  addWorktree,
  createWorkspaceStore,
  deterministicWorkspaceId,
  getGlobalDir,
  profileIdForPath,
  projectsRoot,
  readFolderMark,
  repairWorktrees,
  resolveProjectProfileKey,
  takeOverRenamedWorkspace,
  type TakeoverDeps,
  type WorkspaceMeta,
} from '@agentbridge/core';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

describe('workspaceTakeover', () => {
  let root = '';
  let storageRoot = '';
  let logs: string[] = [];

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'ab-takeover-'));
    storageRoot = join(root, 'storage');
    await fs.mkdir(storageRoot, { recursive: true });
    logs = [];
  });

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = '';
  });

  function makeDeps(
    store: ReturnType<typeof createWorkspaceStore>,
    overrides: Partial<TakeoverDeps> = {},
  ): TakeoverDeps {
    return {
      listWorkspaces: () => store.listWorkspaces(),
      readFolderMark,
      repairWorktrees,
      resolveProjectProfileId: (cwd) => resolveProjectProfileKey(cwd),
      log: (line) => logs.push(line),
      ...overrides,
    };
  }

  async function initGitRepo(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'test@agentbridge.local');
    git(dir, 'config', 'user.name', 'AgentBridge Test');
    git(dir, 'config', 'commit.gpgsign', 'false');
    await fs.writeFile(join(dir, 'README.md'), 'init\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'init');
  }

  it('후보가 없으면 none을 돌려준다', async () => {
    const store = createWorkspaceStore({ rootPathForTesting: storageRoot });
    const proj = join(root, 'brand-new');
    await fs.mkdir(proj);

    const res = await takeOverRenamedWorkspace(storageRoot, proj, makeDeps(store));
    assert.deepEqual(res, { kind: 'none' });
  });

  it('표지를 읽을 수 없는 폴더면 none을 돌려준다', async () => {
    const store = createWorkspaceStore({ rootPathForTesting: storageRoot });
    const res = await takeOverRenamedWorkspace(storageRoot, join(root, 'no-such-folder'), makeDeps(store));
    assert.deepEqual(res, { kind: 'none' });
  });

  it('기록된 경로가 현재 폴더와 같으면 none을 돌려준다', async () => {
    const store = createWorkspaceStore({ rootPathForTesting: storageRoot });
    const proj = join(root, 'same-proj');
    await fs.mkdir(proj);
    const id = store.getOrCreateWorkspaceId(proj);
    await store.updateWorkspaceMeta(id, { folderMark: readFolderMark(proj)! });

    const res = await takeOverRenamedWorkspace(storageRoot, proj, makeDeps(store));
    assert.deepEqual(res, { kind: 'none' });
  });

  it('후보가 둘 이상이면 ambiguous를 돌려주고 로그에 후보 id를 남긴다', async () => {
    const store = createWorkspaceStore({ rootPathForTesting: storageRoot });
    const proj = join(root, 'renamed-proj');
    await fs.mkdir(proj);
    const mark = readFolderMark(proj)!;

    const id1 = store.getOrCreateWorkspaceId(join(root, 'ghost-1'));
    const id2 = store.getOrCreateWorkspaceId(join(root, 'ghost-2'));
    await store.updateWorkspaceMeta(id1, { folderMark: mark });
    await store.updateWorkspaceMeta(id2, { folderMark: mark });

    const res = await takeOverRenamedWorkspace(storageRoot, proj, makeDeps(store));
    assert.equal(res.kind, 'ambiguous');
    if (res.kind === 'ambiguous') {
      assert.deepEqual([...res.candidates].sort(), [id1, id2].sort());
    }
    assert.ok(logs.some((l) => l.includes(id1) && l.includes(id2)));
  });

  it('이름이 같은 다른 프로젝트(표지 다름)는 none이고 getOrCreateWorkspaceId가 충돌로 거절한다', async () => {
    const store = createWorkspaceStore({ rootPathForTesting: storageRoot });
    const proj = join(root, 'same-name');
    await fs.mkdir(proj);
    const id = deterministicWorkspaceId(proj);
    // 같은 id 자리에 다른 경로와 다른 표지를 심어 충돌 상태를 만든다.
    const wsDir = join(storageRoot, 'workspaces', id);
    await fs.mkdir(wsDir, { recursive: true });
    const foreignMeta: WorkspaceMeta = {
      workspaceId: id,
      title: 'same-name',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workspacePath: join(root, 'other-place', 'same-name'),
      sessions: [],
      primarySessionId: null,
      compactionInProgress: null,
      folderMark: { dev: '1', ino: '2', birthtimeNs: '3' },
    };
    await fs.writeFile(join(wsDir, 'workspace.json'), JSON.stringify(foreignMeta, null, 2));

    const res = await takeOverRenamedWorkspace(storageRoot, proj, makeDeps(store));
    assert.deepEqual(res, { kind: 'none' });
    assert.throws(() => store.getOrCreateWorkspaceId(proj), /already belongs to/);
  });

  it('정상 이어받기: 세션·worktree·프로젝트 기억을 옮기고 대화 기록 파일은 바이트 그대로 유지한다', async () => {
    const store = createWorkspaceStore({ rootPathForTesting: storageRoot });
    const oldRepo = join(root, 'proj-old');
    const newRepo = join(root, 'proj-new');
    await initGitRepo(oldRepo);

    const oldId = store.getOrCreateWorkspaceId(oldRepo);
    const sid = '11111111-1111-4111-8111-111111111111';
    await store.addSession(oldId, 'claude', 'cli', sid);
    await store.updateWorkspaceMeta(oldId, { folderMark: readFolderMark(oldRepo)! });

    // 격리 worktree와 커밋 안 한 파일 준비
    const oldWsDir = join(storageRoot, 'workspaces', oldId);
    const oldTree = join(oldWsDir, 'trees', 'sub1');
    await addWorktree(oldRepo, oldTree, 'sub1');
    await fs.writeFile(join(oldTree, 'draft.txt'), 'wip\n');

    // 대화 기록·IR·보관본·화면 기록 준비 (옛 경로·옛 id 문자열 포함)
    const turnsBytes = Buffer.from(JSON.stringify({ cwd: oldRepo, workspaceId: oldId }) + '\n');
    const sessionTurnsBytes = Buffer.from(`{"path":"${oldRepo}"}\n`);
    const irBytes = Buffer.from(JSON.stringify({ summary: `repo ${oldRepo} id ${oldId}` }));
    const archiveBytes = Buffer.from(`{"ir":{"summary":"${oldId}"}}\n`);
    const replayBytes = Buffer.from(`\x1b[32m${oldRepo} ${oldId}\x1b[0m\n`);

    await fs.writeFile(join(oldWsDir, 'turns.jsonl'), turnsBytes);
    await fs.writeFile(join(oldWsDir, 'sessions', sid, 'turns.jsonl'), sessionTurnsBytes);
    await fs.writeFile(join(oldWsDir, 'ir.json'), irBytes);
    await fs.mkdir(join(oldWsDir, 'archive'), { recursive: true });
    await fs.writeFile(join(oldWsDir, 'archive', 'compressed_1.jsonl'), archiveBytes);
    await fs.writeFile(join(oldWsDir, 'sessions', sid, 'replay.log'), replayBytes);

    // 경로 키 프로젝트 기억 준비
    const projectsDir = projectsRoot(getGlobalDir(storageRoot));
    const oldKey = profileIdForPath(oldRepo);
    await fs.mkdir(join(projectsDir, oldKey, 'docs'), { recursive: true });
    await fs.writeFile(join(projectsDir, oldKey, 'docs', 'note.md'), 'project memory\n');

    // 폴더 이름 변경
    await fs.rename(oldRepo, newRepo);
    const newId = deterministicWorkspaceId(newRepo);
    const newKey = profileIdForPath(newRepo);

    const res = await takeOverRenamedWorkspace(storageRoot, newRepo, makeDeps(store));
    assert.deepEqual(res, { kind: 'took-over', fromId: oldId, toId: newId });

    // 옛 폴더는 없고 다시 생기지도 않았다
    assert.equal(existsSync(oldWsDir), false);
    const newWsDir = join(storageRoot, 'workspaces', newId);
    assert.equal(existsSync(newWsDir), true);

    // workspace.json이 새 값으로 바뀌고 세션은 그대로다
    const meta = await store.loadWorkspace(newId);
    assert.equal(meta.workspaceId, newId);
    assert.equal(meta.workspacePath, newRepo);
    assert.equal(meta.title, 'proj-new');
    assert.deepEqual(meta.folderMark, readFolderMark(newRepo));
    assert.equal(meta.sessions.length, 1);
    assert.equal(meta.sessions[0].sessionId, sid);

    // worktree가 새 경로로 복구됐다
    const newTree = join(newWsDir, 'trees', 'sub1');
    const wtList = git(newRepo, 'worktree', 'list', '--porcelain');
    assert.ok(wtList.includes(await fs.realpath(newTree)));
    assert.ok(git(newTree, 'status', '--porcelain').includes('draft.txt'));

    // 프로젝트 기억이 새 키로 옮겨졌다
    assert.equal(existsSync(join(projectsDir, oldKey)), false);
    assert.equal(await fs.readFile(join(projectsDir, newKey, 'docs', 'note.md'), 'utf8'), 'project memory\n');

    // 대화 기록·IR·보관본·화면 기록은 바이트 그대로다
    assert.deepEqual(await fs.readFile(join(newWsDir, 'turns.jsonl')), turnsBytes);
    assert.deepEqual(await fs.readFile(join(newWsDir, 'sessions', sid, 'turns.jsonl')), sessionTurnsBytes);
    assert.deepEqual(await fs.readFile(join(newWsDir, 'ir.json')), irBytes);
    assert.deepEqual(await fs.readFile(join(newWsDir, 'archive', 'compressed_1.jsonl')), archiveBytes);
    assert.deepEqual(await fs.readFile(join(newWsDir, 'sessions', sid, 'replay.log')), replayBytes);

    // 로그에 <oldId> → <newId>
    assert.ok(logs.some((l) => l.includes(`${oldId} → ${newId}`)));
  });

  it('1단계 뒤 멈춘 상태(폴더만 옮김)에서 다시 부르면 resumed로 2~4단계를 끝까지 마친다', async () => {
    const store = createWorkspaceStore({ rootPathForTesting: storageRoot });
    const oldRepo = join(root, 'resume-old');
    const newRepo = join(root, 'resume-new');
    await initGitRepo(oldRepo);

    const oldId = store.getOrCreateWorkspaceId(oldRepo);
    await store.updateWorkspaceMeta(oldId, { folderMark: readFolderMark(oldRepo)! });
    const oldTree = join(storageRoot, 'workspaces', oldId, 'trees', 'sub1');
    await addWorktree(oldRepo, oldTree, 'sub1');

    const projectsDir = projectsRoot(getGlobalDir(storageRoot));
    const oldKey = profileIdForPath(oldRepo);
    await fs.mkdir(join(projectsDir, oldKey), { recursive: true });
    await fs.writeFile(join(projectsDir, oldKey, 'index.md'), 'memo\n');

    await fs.rename(oldRepo, newRepo);
    const newId = deterministicWorkspaceId(newRepo);
    const newKey = profileIdForPath(newRepo);

    // 2단계(repairWorktrees)에서 실패하도록 유도해 1단계 뒤 중단 상태 시뮬레이션
    const failed = await takeOverRenamedWorkspace(
      storageRoot,
      newRepo,
      makeDeps(store, {
        repairWorktrees: async () => {
          throw new Error('simulated crash at step 2');
        },
      }),
    );
    assert.equal(failed.kind, 'failed');
    // 1단계는 이미 지나갔지만 4단계 전이라 workspace.json은 여전히 oldId/oldRepo다
    const midMeta = JSON.parse(
      await fs.readFile(join(storageRoot, 'workspaces', newId, 'workspace.json'), 'utf8'),
    ) as WorkspaceMeta;
    assert.equal(midMeta.workspaceId, oldId);
    assert.equal(midMeta.workspacePath, oldRepo);

    // 다음 열기에서 정상 deps로 재시도 → resumed
    const resumed = await takeOverRenamedWorkspace(storageRoot, newRepo, makeDeps(store));
    assert.deepEqual(resumed, { kind: 'resumed', toId: newId });

    const finalMeta = await store.loadWorkspace(newId);
    assert.equal(finalMeta.workspaceId, newId);
    assert.equal(finalMeta.workspacePath, newRepo);
    assert.equal(finalMeta.title, 'resume-new');
    assert.equal(existsSync(join(projectsDir, newKey, 'index.md')), true);
    const wtList = git(newRepo, 'worktree', 'list', '--porcelain');
    assert.ok(wtList.includes(await fs.realpath(join(storageRoot, 'workspaces', newId, 'trees', 'sub1'))));

    // 끝난 뒤 한 번 더 부르면 none
    const again = await takeOverRenamedWorkspace(storageRoot, newRepo, makeDeps(store));
    assert.deepEqual(again, { kind: 'none' });
  });

  it('3단계에서 새 키 자리에 이미 폴더가 있으면 옮기지 않고 로그만 남긴다', async () => {
    const store = createWorkspaceStore({ rootPathForTesting: storageRoot });
    const oldRepo = join(root, 'mem-old');
    const newRepo = join(root, 'mem-new');
    await fs.mkdir(oldRepo);
    const oldId = store.getOrCreateWorkspaceId(oldRepo);
    await store.updateWorkspaceMeta(oldId, { folderMark: readFolderMark(oldRepo)! });

    const projectsDir = projectsRoot(getGlobalDir(storageRoot));
    const oldKey = profileIdForPath(oldRepo);
    await fs.mkdir(join(projectsDir, oldKey), { recursive: true });
    await fs.writeFile(join(projectsDir, oldKey, 'index.md'), 'old-data\n');

    await fs.rename(oldRepo, newRepo);
    const newId = deterministicWorkspaceId(newRepo);
    const newKey = profileIdForPath(newRepo);
    await fs.mkdir(join(projectsDir, newKey), { recursive: true });
    await fs.writeFile(join(projectsDir, newKey, 'index.md'), 'existing-new-data\n');

    const res = await takeOverRenamedWorkspace(storageRoot, newRepo, makeDeps(store));
    assert.deepEqual(res, { kind: 'took-over', fromId: oldId, toId: newId });

    assert.equal(await fs.readFile(join(projectsDir, oldKey, 'index.md'), 'utf8'), 'old-data\n');
    assert.equal(await fs.readFile(join(projectsDir, newKey, 'index.md'), 'utf8'), 'existing-new-data\n');
    assert.ok(logs.some((l) => l.includes(newKey) && l.includes(oldKey)));
  });

  it('3단계에서 remote 키를 쓰는 저장소는 경로 키 폴더를 옮기지 않는다', async () => {
    const store = createWorkspaceStore({ rootPathForTesting: storageRoot });
    const oldRepo = join(root, 'remote-old');
    const newRepo = join(root, 'remote-new');
    await fs.mkdir(oldRepo);
    const oldId = store.getOrCreateWorkspaceId(oldRepo);
    await store.updateWorkspaceMeta(oldId, { folderMark: readFolderMark(oldRepo)! });

    const projectsDir = projectsRoot(getGlobalDir(storageRoot));
    const oldKey = profileIdForPath(oldRepo);
    await fs.mkdir(join(projectsDir, oldKey), { recursive: true });
    await fs.writeFile(join(projectsDir, oldKey, 'index.md'), 'keep-me\n');

    await fs.rename(oldRepo, newRepo);
    const newId = deterministicWorkspaceId(newRepo);

    const res = await takeOverRenamedWorkspace(
      storageRoot,
      newRepo,
      makeDeps(store, {
        resolveProjectProfileId: async () => ({ id: 'github-repo-12345678', keyedBy: 'remote' }),
      }),
    );
    assert.deepEqual(res, { kind: 'took-over', fromId: oldId, toId: newId });
    assert.equal(existsSync(join(projectsDir, oldKey, 'index.md')), true);
  });
});
