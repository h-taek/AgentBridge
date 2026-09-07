// 0.5.0 3단계 B-8 — 격리 서브에게 조용한 결손을 알려주는 머리말.
// 임시 폴더에 실물 git 저장소를 만들어서 검증한다. gitWorktree.test.ts와 같은 구조를 쓴다.
import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  listMissingPaths,
  buildIsolationPreamble,
} from '@agentbridge/core';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

let root = '';
let repo = '';

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'ab-subenv-'));
  repo = join(root, 'repo');
  await fs.mkdir(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@agentbridge.local');
  git(repo, 'config', 'user.name', 'AgentBridge Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
});

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = '';
});

describe('listMissingPaths', () => {
  it('.gitignore에 든 폴더/파일이 결손 목록에 뜨고, 추적 중인 파일은 안 뜬다', async () => {
    await fs.writeFile(join(repo, '.gitignore'), 'node_modules/\nCLAUDE.md\n.env\n');
    await fs.writeFile(join(repo, 'a.txt'), 'hello\n');
    await fs.mkdir(join(repo, 'node_modules'));
    await fs.writeFile(join(repo, 'node_modules', 'x.js'), '');
    await fs.writeFile(join(repo, 'CLAUDE.md'), '지침\n');
    await fs.writeFile(join(repo, '.env'), 'SECRET=1\n');
    git(repo, 'add', 'a.txt', '.gitignore');
    git(repo, 'commit', '-qm', 'init');

    const missing = await listMissingPaths(repo);

    assert.ok(missing.some((p) => p.startsWith('node_modules')), `node_modules가 있어야 한다: ${missing}`);
    assert.ok(missing.includes('CLAUDE.md'), `CLAUDE.md가 있어야 한다: ${missing}`);
    assert.ok(missing.includes('.env'), `.env가 있어야 한다: ${missing}`);
    assert.ok(!missing.includes('a.txt'), `추적 파일은 없어야 한다: ${missing}`);
    assert.ok(!missing.includes('.gitignore'), `추적 파일은 없어야 한다: ${missing}`);
  });

  it('무시된 것이 없으면 빈 배열', async () => {
    await fs.writeFile(join(repo, 'a.txt'), 'hello\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'init');

    assert.deepEqual(await listMissingPaths(repo), []);
  });

  it('git 저장소가 아니면 빈 배열(던지지 않는다)', async () => {
    const notARepo = join(root, 'not-a-repo');
    await fs.mkdir(notARepo);

    assert.deepEqual(await listMissingPaths(notARepo), []);
  });
});

describe('buildIsolationPreamble', () => {
  it('부모 절대경로와 지침 파일을 읽으라는 문구가 들어간다', () => {
    const preamble = buildIsolationPreamble({
      parentPath: '/Users/x/project',
      worktreePath: '/Users/x/project-data/trees/golden-gate',
      missing: ['CLAUDE.md', 'node_modules/'],
    });

    assert.ok(preamble.includes('/Users/x/project'), '부모 경로가 있어야 한다');
    assert.match(preamble, /read/i);
    assert.ok(preamble.includes('CLAUDE.md') || preamble.includes('AGENTS.md'), '지침 파일 언급이 있어야 한다');
  });

  it('결손 목록이 상한보다 길면 잘리고, 전체 개수가 함께 나온다', () => {
    const missing = Array.from({ length: 20 }, (_, i) => `dir-${i}/`);
    const preamble = buildIsolationPreamble({
      parentPath: '/parent',
      worktreePath: '/tree',
      missing,
    });

    assert.ok(preamble.includes('20'), `전체 개수 20이 나와야 한다: ${preamble}`);
    assert.ok(!preamble.includes('dir-19/'), '상한을 넘는 항목은 안 나와야 한다');
  });

  it('결손이 비어 있어도 머리말이 성립한다', () => {
    const preamble = buildIsolationPreamble({
      parentPath: '/parent',
      worktreePath: '/tree',
      missing: [],
    });

    assert.ok(preamble.includes('/parent'));
    assert.ok(preamble.length > 0);
  });
});
