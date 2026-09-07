// 0.5.0 B-9 / W3 — 서브 worktree를 소스 제어 뷰에 붙이고 떼는 자리.
// 확장 자체는 라이브로만 볼 수 있으므로, 여기서 보는 것은 우리가 무엇을 넘기고 무엇을 안
// 넘기는가다. 특히 사용자의 원본 저장소를 실수로 닫지 않는 것.
import { strict as assert } from 'assert';
import { registerRepo, unregisterRepo } from '../src/core/scmView';
import * as vscode from 'vscode';

const TREE = '/tmp/ws/trees/golden-gate';

let opened: string[] = [];
let closed: unknown[] = [];
let repositories: Array<{ rootUri: { fsPath: string } }> = [];
let openThrows = false;

const api = {
  state: 'initialized',
  get repositories() {
    return repositories;
  },
  openRepository: async (uri: { fsPath: string }) => {
    if (openThrows) throw new Error('열 수 없다');
    opened.push(uri.fsPath);
    const repo = { rootUri: { fsPath: uri.fsPath } };
    repositories.push(repo);
    return repo;
  },
  getRepository: (uri: { fsPath: string }) =>
    repositories.find((r) => r.rootUri.fsPath === uri.fsPath) ?? null,
};

beforeEach(() => {
  opened = [];
  closed = [];
  repositories = [];
  openThrows = false;
  (vscode.extensions as { getExtension: (id: string) => unknown }).getExtension = () => ({
    isActive: true,
    exports: { getAPI: () => api },
    activate: async () => ({ getAPI: () => api }),
  });
  (
    vscode.commands as unknown as { executeCommand: (...a: unknown[]) => Promise<unknown> }
  ).executeCommand = async (...args: unknown[]) => {
    if (args[0] === 'git.close') closed.push(args[1]);
    return undefined;
  };
});

describe('scmView', () => {
  it('worktree 경로를 저장소로 연다', async () => {
    await registerRepo(TREE);
    assert.deepEqual(opened, [TREE]);
  });

  it('열기가 실패해도 던지지 않는다 — 스폰을 막지 않는다', async () => {
    openThrows = true;
    await registerRepo(TREE); // rejects하면 여기서 실패한다
    assert.deepEqual(opened, []);
  });

  it('등록한 것을 git.close로 뗀다', async () => {
    await registerRepo(TREE);
    await unregisterRepo(TREE);
    assert.equal(closed.length, 1);
    assert.equal((closed[0] as { rootUri: { fsPath: string } }).rootUri.fsPath, TREE);
  });

  it('경로를 품은 다른 저장소는 안 닫는다 — 사용자의 원본이 걸리는 자리다', async () => {
    repositories = [{ rootUri: { fsPath: '/tmp/ws' } }];
    // 등록 안 된 경로로 물으면 확장이 그것을 품은 저장소를 줄 수 있다.
    api.getRepository = () => repositories[0];

    await unregisterRepo(TREE);

    assert.deepEqual(closed, []);
    api.getRepository = (uri: { fsPath: string }) =>
      repositories.find((r) => r.rootUri.fsPath === uri.fsPath) ?? null;
  });
});
