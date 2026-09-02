// 0.5.0 B-9 / W1 — 서브의 변경을 뜨는 표면.
// 임시 폴더에 실물 git 저장소를 만들어서 검증한다. 패치가 원본에 얹힐 재료이므로 무엇이
// 담기고 무엇이 안 담기는지가 여기서 정해진다.
import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  addWorktree,
  forkPoint,
  snapshotAgainst,
  subagentDiff,
  truncatePatch,
  mergeSubagent,
  renderMerge,
} from '@agentbridge/core';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

let root = '';
let repo = '';
let tree = '';

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'ab-diff-'));
  repo = join(root, 'repo');
  await fs.mkdir(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@agentbridge.local');
  git(repo, 'config', 'user.name', 'AgentBridge Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(join(repo, 'a.txt'), 'hello\n');
  await fs.writeFile(join(repo, '.gitignore'), 'ignored.txt\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  tree = join(root, 'trees', 'golden-gate');
});

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = '';
});

describe('snapshotAgainst', () => {
  it('커밋된 변경·미커밋 변경·미추적 파일이 한 패치에 담긴다', async () => {
    await addWorktree(repo, tree, 'golden-gate');
    const base = git(tree, 'rev-parse', 'HEAD').trim();

    await fs.writeFile(join(tree, 'committed.txt'), 'committed\n');
    git(tree, 'add', '-A');
    git(tree, 'commit', '-qm', 'sub commit');
    await fs.writeFile(join(tree, 'a.txt'), 'hello\nchanged\n');
    await fs.writeFile(join(tree, 'untracked.txt'), 'new\n');

    const snap = await snapshotAgainst(tree, base);

    assert.deepEqual(snap.files.sort(), ['a.txt', 'committed.txt', 'untracked.txt']);
    assert.match(snap.patch, /\+changed/);
    assert.match(snap.patch, /diff --git a\/untracked.txt/);
  });

  it('삭제된 파일이 패치에 담긴다', async () => {
    await addWorktree(repo, tree, 'golden-gate');
    const base = git(tree, 'rev-parse', 'HEAD').trim();
    await fs.rm(join(tree, 'a.txt'));

    const snap = await snapshotAgainst(tree, base);

    assert.deepEqual(snap.files, ['a.txt']);
    assert.match(snap.patch, /deleted file mode/);
  });

  it('무시되는 파일은 안 담긴다', async () => {
    await addWorktree(repo, tree, 'golden-gate');
    const base = git(tree, 'rev-parse', 'HEAD').trim();
    await fs.writeFile(join(tree, 'ignored.txt'), 'noise\n');

    const snap = await snapshotAgainst(tree, base);

    assert.deepEqual(snap.files, []);
    assert.equal(snap.patch, '');
  });

  it('바이너리와 파일 모드 변경이 담긴다', async () => {
    await addWorktree(repo, tree, 'golden-gate');
    const base = git(tree, 'rev-parse', 'HEAD').trim();
    await fs.writeFile(join(tree, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, 7]));
    await fs.chmod(join(tree, 'a.txt'), 0o755);

    const snap = await snapshotAgainst(tree, base);

    assert.match(snap.patch, /GIT binary patch/);
    assert.match(snap.patch, /old mode 100644[\s\S]*new mode 100755/);
  });

  it('서브의 인덱스를 안 건드린다', async () => {
    await addWorktree(repo, tree, 'golden-gate');
    const base = git(tree, 'rev-parse', 'HEAD').trim();
    await fs.writeFile(join(tree, 'staged.txt'), 'staged\n');
    git(tree, 'add', 'staged.txt');
    await fs.writeFile(join(tree, 'a.txt'), 'hello\nunstaged\n');
    const before = git(tree, 'status', '--porcelain');

    await snapshotAgainst(tree, base);

    assert.equal(git(tree, 'status', '--porcelain'), before);
  });
});

describe('forkPoint', () => {
  it('원본이 앞으로 나가도 갈라진 커밋을 낸다', async () => {
    await addWorktree(repo, tree, 'golden-gate');
    const forked = git(tree, 'rev-parse', 'HEAD').trim();

    await fs.writeFile(join(repo, 'b.txt'), 'main moved\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'main moves on');

    assert.equal(await forkPoint(tree, repo), forked);
  });

  it('분기점 이후만 담기고 원본이 앞서 만든 커밋은 안 담긴다', async () => {
    await addWorktree(repo, tree, 'golden-gate');
    await fs.writeFile(join(repo, 'b.txt'), 'main moved\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'main moves on');
    await fs.writeFile(join(tree, 'sub.txt'), 'sub work\n');

    const diff = await subagentDiff(repo, tree);

    assert.equal(diff.isolated, true);
    assert.deepEqual(diff.files, ['sub.txt']);
  });
});

describe('subagentDiff', () => {
  it('worktree가 없으면 원본 폴더의 HEAD 대비 변경을 낸다', async () => {
    await fs.writeFile(join(repo, 'a.txt'), 'hello\nmain edit\n');
    await fs.writeFile(join(repo, 'fresh.txt'), 'fresh\n');

    const diff = await subagentDiff(repo, join(root, 'trees', 'nonexistent'));

    assert.equal(diff.isolated, false);
    assert.equal(diff.base, undefined);
    assert.deepEqual(diff.files.sort(), ['a.txt', 'fresh.txt']);
  });

  it('변경이 없으면 빈 패치를 낸다', async () => {
    await addWorktree(repo, tree, 'golden-gate');

    const diff = await subagentDiff(repo, tree);

    assert.equal(diff.patch, '');
    assert.deepEqual(diff.files, []);
    assert.equal(diff.stat, '');
  });
});

describe('truncatePatch', () => {
  const filePatch = (name: string, body: string): string =>
    [
      `diff --git a/${name} b/${name}`,
      'index 0000000..1111111 100644',
      `--- a/${name}`,
      `+++ b/${name}`,
      '@@ -0,0 +1 @@',
      `+${body}`,
    ].join('\n');

  it('상한 아래면 그대로 낸다', () => {
    const patch = filePatch('a.txt', 'x');
    assert.deepEqual(truncatePatch(patch, 10_000), { patch, omitted: [] });
  });

  it('파일 경계에서 자르고 빠진 파일 이름을 낸다', () => {
    const first = filePatch('a.txt', 'x'.repeat(200));
    const patch = [first, filePatch('b.txt', 'y'), filePatch('c.txt', 'z')].join('\n');

    const cut = truncatePatch(patch, first.length + 1);

    assert.equal(cut.patch, first);
    assert.deepEqual(cut.omitted, ['b.txt', 'c.txt']);
  });

  it('첫 파일부터 상한을 넘으면 아무것도 안 남기고 전부 빠진 것으로 낸다', () => {
    const patch = [filePatch('a.txt', 'x'.repeat(500)), filePatch('b.txt', 'y')].join('\n');

    const cut = truncatePatch(patch, 10);

    assert.equal(cut.patch, '');
    assert.deepEqual(cut.omitted, ['a.txt', 'b.txt']);
  });
});

// ─── 머지 (5단계 W2) ─────────────────────────────────────────────────────

describe('mergeSubagent', () => {
  async function snapshotFiles(dir: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const name of await fs.readdir(dir)) {
      if (name === '.git') continue;
      const stat = await fs.stat(join(dir, name));
      if (stat.isFile()) out[name] = await fs.readFile(join(dir, name), 'base64');
    }
    return out;
  }

  it('커밋된 것·미커밋·미추적·바이너리·모드 변경이 전부 얹힌다', async () => {
    await addWorktree(repo, tree, 'golden-gate');
    await fs.writeFile(join(tree, 'committed.txt'), 'committed\n');
    git(tree, 'add', '-A');
    git(tree, 'commit', '-qm', 'sub commit');
    await fs.writeFile(join(tree, 'a.txt'), 'hello\nchanged\n');
    await fs.writeFile(join(tree, 'untracked.txt'), 'new\n');
    await fs.writeFile(join(tree, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, 7]));
    await fs.chmod(join(tree, '.gitignore'), 0o755);

    const r = await mergeSubagent(repo, tree);

    assert.equal(r.applied, true);
    assert.equal(await fs.readFile(join(repo, 'a.txt'), 'utf8'), 'hello\nchanged\n');
    assert.equal(await fs.readFile(join(repo, 'committed.txt'), 'utf8'), 'committed\n');
    assert.equal(await fs.readFile(join(repo, 'untracked.txt'), 'utf8'), 'new\n');
    assert.deepEqual([...(await fs.readFile(join(repo, 'blob.bin')))], [0, 1, 2, 0, 255, 7]);
    assert.equal((await fs.stat(join(repo, '.gitignore'))).mode & 0o111, 0o111);
  });

  it('충돌하면 원본이 한 바이트도 안 바뀌고 걸린 파일을 낸다', async () => {
    await addWorktree(repo, tree, 'golden-gate');
    await fs.writeFile(join(tree, 'a.txt'), 'hello\nfrom sub\n');
    await fs.writeFile(join(tree, 'clean.txt'), 'sub only\n');
    // 원본에서 같은 줄을 다르게 고쳐 둔다 — 패치가 안 붙는 상태.
    await fs.writeFile(join(repo, 'a.txt'), 'hello\nfrom main\n');
    const before = await snapshotFiles(repo);

    const r = await mergeSubagent(repo, tree);

    assert.equal(r.applied, false);
    assert.equal(r.reason, 'conflict');
    assert.deepEqual(r.conflicts, ['a.txt']);
    assert.deepEqual(await snapshotFiles(repo), before);
  });

  it('원본이 더러워도 성공하면 그 변경이 그대로 남는다', async () => {
    await addWorktree(repo, tree, 'golden-gate');
    await fs.writeFile(join(tree, 'sub.txt'), 'sub work\n');
    await fs.writeFile(join(repo, 'a.txt'), 'hello\nmain wip\n'); // 미커밋
    await fs.writeFile(join(repo, 'scratch.txt'), 'main scratch\n'); // 미추적

    const r = await mergeSubagent(repo, tree);

    assert.equal(r.applied, true);
    assert.equal(await fs.readFile(join(repo, 'a.txt'), 'utf8'), 'hello\nmain wip\n');
    assert.equal(await fs.readFile(join(repo, 'scratch.txt'), 'utf8'), 'main scratch\n');
    assert.equal(await fs.readFile(join(repo, 'sub.txt'), 'utf8'), 'sub work\n');
  });

  it('같은 서브를 두 번 얹으면 두 번째는 걸리고 원본은 그대로다', async () => {
    await addWorktree(repo, tree, 'golden-gate');
    await fs.writeFile(join(tree, 'sub.txt'), 'sub work\n');
    assert.equal((await mergeSubagent(repo, tree)).applied, true);
    const before = await snapshotFiles(repo);

    const second = await mergeSubagent(repo, tree);

    assert.equal(second.applied, false);
    assert.deepEqual(await snapshotFiles(repo), before);
  });

  it('머지 뒤에도 worktree와 브랜치와 서브의 변경이 살아 있다', async () => {
    await addWorktree(repo, tree, 'golden-gate');
    await fs.writeFile(join(tree, 'sub.txt'), 'sub work\n');

    await mergeSubagent(repo, tree);

    assert.equal(await fs.readFile(join(tree, 'sub.txt'), 'utf8'), 'sub work\n');
    assert.match(git(repo, 'branch', '--list', 'agentbridge/golden-gate'), /agentbridge\/golden-gate/);
  });

  it('격리가 아니면 얹지 않고 그 사실을 낸다', async () => {
    const r = await mergeSubagent(repo, join(root, 'trees', 'nonexistent'));
    assert.equal(r.reason, 'not-isolated');
    assert.match(renderMerge('golden-gate', r), /이미 원본에 있으므로/);
  });

  it('변경이 없으면 얹지 않는다', async () => {
    await addWorktree(repo, tree, 'golden-gate');
    const r = await mergeSubagent(repo, tree);
    assert.equal(r.reason, 'no-changes');
  });
});
