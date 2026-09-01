// 서브 정리의 여섯 단계 (0.5.0 4단계 W7, B-7 "정리가 하는 일").
// 실물 git 저장소를 임시 폴더에 만들어 수명주기 전체를 돌린다 — 실패가 사용자 저장소를
// 건드리는 유일한 영역이라 이 스위트가 가장 두껍다.
import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  cleanupSubagent,
  renderReceipt,
  findOrphanTrees,
  resolveTreePath,
  addWorktree,
  listAgentBranches,
} from '@agentbridge/core';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

async function makeRepo(): Promise<{ repo: string; wsDir: string; root: string }> {
  const root = await fsp.mkdtemp(join(tmpdir(), 'ab-cleanup-'));
  const repo = join(root, 'repo');
  const wsDir = join(root, 'data');
  await fsp.mkdir(repo, { recursive: true });
  await fsp.mkdir(join(wsDir, 'trees'), { recursive: true });
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'test');
  await fsp.writeFile(join(repo, 'README.md'), '# test\n', 'utf8');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'init');
  return { repo, wsDir, root };
}

// 아무것도 안 하는 의존성. 정리는 PTY 종료와 레코드 갱신을 호출처에서 받는다.
function noopDeps(): { stopSession: () => void; markClosed: () => Promise<void>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    stopSession: () => {
      calls.push('stop');
    },
    markClosed: async () => {
      calls.push('closed');
    },
  };
}

describe('서브 정리 (0.5.0 W7)', () => {
  let repo: string;
  let wsDir: string;
  let root: string;

  beforeEach(async () => {
    ({ repo, wsDir, root } = await makeRepo());
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('격리를 안 쓴 서브는 PTY 종료와 레코드 갱신만 한다', async () => {
    const deps = noopDeps();
    const r = await cleanupSubagent({ name: 'golden-gate', repoPath: repo }, deps);
    assert.equal(r.ok, true);
    assert.equal(r.isolated, false);
    assert.deepEqual(deps.calls, ['stop', 'closed']);
    assert.match(renderReceipt(r), /격리를 안 쓴 서브/);
  });

  it('폴더와 브랜치를 함께 지운다', async () => {
    const tree = resolveTreePath(wsDir, 'tower-bridge');
    await addWorktree(repo, tree, 'tower-bridge');
    assert.equal((await listAgentBranches(repo)).includes('tower-bridge'), true);

    const r = await cleanupSubagent({ name: 'tower-bridge', repoPath: repo, treePath: tree }, noopDeps());
    assert.equal(r.ok, true);
    assert.equal(r.isolated, true);
    await assert.rejects(fsp.access(tree));
    assert.equal((await listAgentBranches(repo)).includes('tower-bridge'), false);
  });

  it('워킹트리가 더러우면 마감 커밋을 만들고 그 SHA로 되살아난다', async () => {
    const tree = resolveTreePath(wsDir, 'ponte-vecchio');
    await addWorktree(repo, tree, 'ponte-vecchio');
    await fsp.writeFile(join(tree, 'work.txt'), '서브가 만든 것\n', 'utf8'); // 미추적 파일

    const r = await cleanupSubagent({ name: 'ponte-vecchio', repoPath: repo, treePath: tree }, noopDeps());
    assert.equal(r.ok, true);
    assert.equal(r.sealed, true, '마감 커밋이 있어야 한다');
    assert.ok(r.recoverySha, '복구 식별자가 있어야 한다');

    // 강제로 지웠어도 커밋 객체는 남는다 — 식별자만 알면 그대로 되살아난다.
    const shown = git(repo, 'show', '--stat', '--name-only', r.recoverySha as string);
    assert.match(shown, /work\.txt/);
    assert.match(renderReceipt(r), /되살리려면/);
  });

  it('워킹트리가 깨끗하면 마감 커밋을 안 만든다', async () => {
    const tree = resolveTreePath(wsDir, 'millau-viaduct');
    await addWorktree(repo, tree, 'millau-viaduct');
    const r = await cleanupSubagent({ name: 'millau-viaduct', repoPath: repo, treePath: tree }, noopDeps());
    assert.equal(r.sealed, false);
    assert.equal(r.ok, true);
  });

  it('중간에 실패하면 남은 것을 영수증에 적고 되돌리지 않는다', async () => {
    const tree = resolveTreePath(wsDir, 'stari-most');
    await addWorktree(repo, tree, 'stari-most');
    const deps = noopDeps();
    const r = await cleanupSubagent(
      { name: 'stari-most', repoPath: repo, treePath: tree },
      {
        ...deps,
        markClosed: async () => {
          throw new Error('레코드를 못 썼다');
        },
      },
    );
    assert.equal(r.ok, false);
    assert.equal(r.failedAt, 'record');
    assert.deepEqual(r.remaining, ['record']);
    // 앞 단계는 이미 갔다 — 되돌리지 않는다.
    await assert.rejects(fsp.access(tree));
    assert.match(renderReceipt(r), /남은 것: record/);
  });

  it('영수증에 변경 요약이 지우기 전 값으로 들어간다', async () => {
    const tree = resolveTreePath(wsDir, 'london-bridge');
    await addWorktree(repo, tree, 'london-bridge');
    await fsp.appendFile(join(tree, 'README.md'), '한 줄 더\n', 'utf8');
    const r = await cleanupSubagent({ name: 'london-bridge', repoPath: repo, treePath: tree }, noopDeps());
    assert.equal(r.changedFiles, 1);
    assert.ok((r.insertions ?? 0) >= 1);
  });

  it('고아 스캔은 레코드 없는 폴더만 낸다', async () => {
    await addWorktree(repo, resolveTreePath(wsDir, 'golden-gate'), 'golden-gate');
    await addWorktree(repo, resolveTreePath(wsDir, 'brooklyn-bridge'), 'brooklyn-bridge');
    const orphans = await findOrphanTrees(wsDir, ['golden-gate']);
    assert.deepEqual(orphans, ['brooklyn-bridge']);
  });

  it('trees/가 없으면 고아 스캔이 빈 배열이다', async () => {
    const empty = await fsp.mkdtemp(join(tmpdir(), 'ab-empty-'));
    assert.deepEqual(await findOrphanTrees(empty, []), []);
    await fsp.rm(empty, { recursive: true, force: true });
  });
});
