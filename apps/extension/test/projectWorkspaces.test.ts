import { strict as assert } from 'assert';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { adoptPathKeyedProject, getGlobalDir, profileIdForPath, projectsRoot, recordProjectWorkspace } from '@agentbridge/core';

const PROJECT_ID = 'github.com-acme-repo';

async function setup(): Promise<{ root: string; globalDir: string; file: string; mkRepo: (name: string) => Promise<string> }> {
  const root = await fsp.mkdtemp(join(tmpdir(), 'ab-workspaces-'));
  const globalDir = getGlobalDir(join(root, 'ab'));
  const file = join(projectsRoot(globalDir), PROJECT_ID, 'workspaces.json');
  const mkRepo = async (name: string): Promise<string> => {
    const p = join(root, 'repos', name);
    await fsp.mkdir(p, { recursive: true });
    return p;
  };
  return { root, globalDir, file, mkRepo };
}

const format = (paths: string[]): string => JSON.stringify({ workspaces: paths }, null, 2) + '\n';

describe('recordProjectWorkspace', () => {
  it('처음이면 지금 경로 하나로 만든다', async () => {
    const { globalDir, file, mkRepo } = await setup();
    const repo = await mkRepo('a');
    await recordProjectWorkspace(globalDir, PROJECT_ID, repo);
    assert.equal(await fsp.readFile(file, 'utf8'), format([repo]));
  });

  it('같은 경로는 다시 더하지 않는다', async () => {
    const { globalDir, file, mkRepo } = await setup();
    const repo = await mkRepo('a');
    await recordProjectWorkspace(globalDir, PROJECT_ID, repo);
    const old = new Date(Date.now() - 60_000);
    await fsp.utimes(file, old, old);
    await recordProjectWorkspace(globalDir, PROJECT_ID, repo);
    assert.equal(await fsp.readFile(file, 'utf8'), format([repo]));
    assert.equal((await fsp.stat(file)).mtimeMs, old.getTime());
  });

  it('디스크에 없는 경로는 뺀다', async () => {
    const { globalDir, file, mkRepo } = await setup();
    const repo = await mkRepo('a');
    const gone = join(repo, '..', 'gone');
    await fsp.mkdir(join(file, '..'), { recursive: true });
    await fsp.writeFile(file, format([gone, repo]), 'utf8');
    await recordProjectWorkspace(globalDir, PROJECT_ID, repo);
    assert.equal(await fsp.readFile(file, 'utf8'), format([repo]));
  });

  it('다른 클론 경로는 함께 둔다', async () => {
    const { globalDir, file, mkRepo } = await setup();
    const a = await mkRepo('a');
    const b = await mkRepo('b');
    await recordProjectWorkspace(globalDir, PROJECT_ID, a);
    await recordProjectWorkspace(globalDir, PROJECT_ID, b);
    assert.equal(await fsp.readFile(file, 'utf8'), format([a, b]));
  });

  it('깨진 파일은 새로 쓴다', async () => {
    const { globalDir, file, mkRepo } = await setup();
    const repo = await mkRepo('a');
    await fsp.mkdir(join(file, '..'), { recursive: true });
    await fsp.writeFile(file, 'not json', 'utf8');
    await recordProjectWorkspace(globalDir, PROJECT_ID, repo);
    assert.equal(await fsp.readFile(file, 'utf8'), format([repo]));
  });

  it('프로젝트 폴더 이름이 경로 조각이 아니면 거절한다', async () => {
    const { globalDir, mkRepo } = await setup();
    const repo = await mkRepo('a');
    await assert.rejects(() => recordProjectWorkspace(globalDir, '../escape', repo), /single path segment/);
  });

  it('경로 키 폴더 이전 뒤에 기록하면 이전된 지식과 같은 폴더에 남는다', async () => {
    const { globalDir, file, mkRepo } = await setup();
    const repo = await mkRepo('a');
    const oldDir = join(projectsRoot(globalDir), profileIdForPath(repo));
    await fsp.mkdir(join(oldDir, 'docs'), { recursive: true });
    await fsp.writeFile(join(oldDir, 'docs', 'keep.md'), 'memo\n', 'utf8');
    adoptPathKeyedProject(projectsRoot(globalDir), repo, PROJECT_ID);
    await recordProjectWorkspace(globalDir, PROJECT_ID, repo);
    assert.equal(await fsp.readFile(join(file, '..', 'docs', 'keep.md'), 'utf8'), 'memo\n');
    assert.equal(await fsp.readFile(file, 'utf8'), format([repo]));
  });
});
