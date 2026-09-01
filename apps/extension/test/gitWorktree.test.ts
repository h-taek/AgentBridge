// 0.5.0 B-7 / W1·W6·W7 — 격리 worktree의 git 표면.
// 임시 폴더에 실물 git 저장소를 만들어서 검증한다. 삭제가 강제인 경로라 사용자의 저장소를
// 대상으로 돌리지 않는다.
import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import { promises as fs, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  AGENT_BRANCH_PREFIX,
  listAgentBranches,
  addWorktree,
  summarizeWorktree,
  commitAll,
  removeWorktree,
  deleteBranch,
} from '@agentbridge/core/dist/agent/gitWorktree';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

let root = '';
let repo = '';

// 저장소마다 새 임시 폴더를 쓴다. 브랜치 삭제가 강제라 상태가 새는 것을 아예 막는다.
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'ab-worktree-'));
  repo = join(root, 'repo');
  await fs.mkdir(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@agentbridge.local');
  git(repo, 'config', 'user.name', 'AgentBridge Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(join(repo, 'a.txt'), 'hello\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
});

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = '';
});

describe('worktree 생성', () => {
  it('폴더가 생기고 브랜치 이름에 접두사가 붙는다', async () => {
    const tree = join(root, 'trees', 'golden-gate');
    await addWorktree(repo, tree, 'golden-gate');

    assert.ok(existsSync(join(tree, 'a.txt')), 'worktree에 추적 파일이 풀려 있어야 한다');
    assert.equal(git(tree, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'agentbridge/golden-gate');
    assert.equal(AGENT_BRANCH_PREFIX, 'agentbridge/');
  });
});

describe('listAgentBranches', () => {
  it('접두사를 벗겨 내고, 접두사 없는 사용자 브랜치는 안 낸다', async () => {
    await addWorktree(repo, join(root, 'trees', 'hangang'), 'hangang');
    await addWorktree(repo, join(root, 'trees', 'ponte-vecchio'), 'ponte-vecchio');
    git(repo, 'branch', 'feature/login'); // 사용자 브랜치

    const names = (await listAgentBranches(repo)).sort();
    assert.deepEqual(names, ['hangang', 'ponte-vecchio']);
  });

  it('접두사 브랜치가 없으면 빈 목록', async () => {
    assert.deepEqual(await listAgentBranches(repo), []);
  });
});

describe('summarizeWorktree', () => {
  it('깨끗한 트리는 dirty가 아니고 head가 HEAD SHA다', async () => {
    const tree = join(root, 'trees', 'clean');
    await addWorktree(repo, tree, 'clean');

    const s = await summarizeWorktree(tree);
    assert.equal(s.dirty, false);
    assert.equal(s.changedFiles, 0);
    assert.equal(s.insertions, 0);
    assert.equal(s.deletions, 0);
    assert.equal(s.untracked, 0);
    assert.equal(s.head, git(tree, 'rev-parse', 'HEAD').trim());
    assert.match(s.head, /^[0-9a-f]{40}$/);
  });

  it('수정만 있는 트리는 변경 줄 수를 센다', async () => {
    const tree = join(root, 'trees', 'dirty');
    await addWorktree(repo, tree, 'dirty');
    await fs.writeFile(join(tree, 'a.txt'), 'hello\nworld\n');

    const s = await summarizeWorktree(tree);
    assert.equal(s.dirty, true);
    assert.equal(s.changedFiles, 1);
    assert.equal(s.insertions, 1);
    assert.equal(s.deletions, 0);
    assert.equal(s.untracked, 0);
  });

  it('미추적 파일만 있어도 dirty이고 untracked로 따로 센다', async () => {
    const tree = join(root, 'trees', 'new-files');
    await addWorktree(repo, tree, 'new-files');
    await fs.writeFile(join(tree, 'b.txt'), 'b\n');
    await fs.writeFile(join(tree, 'c.txt'), 'c\n');

    const s = await summarizeWorktree(tree);
    assert.equal(s.dirty, true);
    assert.equal(s.untracked, 2);
    assert.equal(s.changedFiles, 0, '미추적은 changedFiles가 아니라 untracked가 센다');
  });
});

describe('commitAll', () => {
  it('깨끗하면 null이고 새 커밋이 안 생긴다', async () => {
    const tree = join(root, 'trees', 'clean');
    await addWorktree(repo, tree, 'clean');
    const before = git(tree, 'rev-parse', 'HEAD').trim();

    assert.equal(await commitAll(tree, '마감'), null);
    assert.equal(git(tree, 'rev-parse', 'HEAD').trim(), before);
  });

  it('더러우면 SHA를 내고 그 뒤 트리가 깨끗해진다', async () => {
    const tree = join(root, 'trees', 'dirty');
    await addWorktree(repo, tree, 'dirty');
    await fs.writeFile(join(tree, 'a.txt'), 'changed\n');

    const sha = await commitAll(tree, '마감 커밋');
    assert.ok(sha, 'SHA가 나와야 한다');
    assert.match(sha as string, /^[0-9a-f]{40}$/);
    assert.equal(git(tree, 'rev-parse', 'HEAD').trim(), sha);
    assert.equal((await summarizeWorktree(tree)).dirty, false);
  });

  it('미추적 파일과 파일 모드 변경이 커밋에 들어간다', async () => {
    const tree = join(root, 'trees', 'mixed');
    await addWorktree(repo, tree, 'mixed');
    await fs.writeFile(join(tree, 'new.txt'), 'new\n');
    await fs.chmod(join(tree, 'a.txt'), 0o755);

    const sha = await commitAll(tree, '마감 커밋');
    assert.ok(sha);
    const files = git(tree, 'show', '--name-only', '--format=', sha as string);
    assert.ok(files.includes('new.txt'), '미추적 파일이 커밋에 들어가야 한다');
    assert.ok(files.includes('a.txt'), '모드 변경이 커밋에 들어가야 한다');
    assert.match(git(tree, 'ls-tree', 'HEAD', 'a.txt'), /^100755 /);
    assert.equal((await summarizeWorktree(tree)).dirty, false);
  });
});

describe('삭제', () => {
  it('폴더와 브랜치가 함께 사라진다', async () => {
    const tree = join(root, 'trees', 'gone');
    await addWorktree(repo, tree, 'gone');

    await removeWorktree(repo, tree);
    await deleteBranch(repo, 'gone');

    assert.equal(existsSync(tree), false);
    assert.deepEqual(await listAgentBranches(repo), []);
  });

  it('커밋이 있고 머지 안 된 브랜치도 지워진다', async () => {
    const tree = join(root, 'trees', 'unmerged');
    await addWorktree(repo, tree, 'unmerged');
    await fs.writeFile(join(tree, 'work.txt'), 'work\n');
    const sha = await commitAll(tree, '마감 커밋');
    assert.ok(sha);
    // main에 안 얹은 상태 — 평범한 삭제(-d)라면 git이 거절하는 자리다.
    assert.equal(git(repo, 'branch', '--merged', 'main').includes('unmerged'), false);

    await removeWorktree(repo, tree);
    await deleteBranch(repo, 'unmerged');

    assert.equal(existsSync(tree), false);
    assert.deepEqual(await listAgentBranches(repo), []);
  });

  it('강제 삭제 뒤에도 head SHA로 내용을 되살릴 수 있다', async () => {
    const tree = join(root, 'trees', 'recover');
    await addWorktree(repo, tree, 'recover');
    await fs.writeFile(join(tree, 'work.txt'), '되살릴 내용\n');
    await commitAll(tree, '마감 커밋');

    // 영수증 재료는 지우기 전에 한 번 모은다(W7).
    const receipt = await summarizeWorktree(tree);

    await removeWorktree(repo, tree);
    await deleteBranch(repo, 'recover');

    assert.deepEqual(await listAgentBranches(repo), []);
    assert.equal(git(repo, 'show', `${receipt.head}:work.txt`), '되살릴 내용\n');
  });

  it('브랜치가 다른 worktree에 체크아웃돼 있으면 이유를 낸다', async () => {
    const tree = join(root, 'trees', 'busy');
    await addWorktree(repo, tree, 'busy');

    // worktree를 안 뗀 채 브랜치부터 지우려는 순서 — git이 막는 유일한 경우다.
    await assert.rejects(
      () => deleteBranch(repo, 'busy'),
      (err: Error) => {
        assert.ok(err.message.includes('agentbridge/busy'), `브랜치 이름이 있어야 한다: ${err.message}`);
        assert.ok(err.message.includes('worktree'), `이유가 있어야 한다: ${err.message}`);
        return true;
      },
    );
    // 막힌 뒤에도 브랜치는 그대로다.
    assert.deepEqual(await listAgentBranches(repo), ['busy']);
  });
});
