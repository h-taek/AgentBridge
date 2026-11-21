// `session new`(0.9.0 spec/02)와 서브 세션의 기동 거절(0.9.0 spec/03 §1).
//
// 근거: docs/0.9.0/spec/02_session_new.md, docs/0.9.0/spec/03_no_nested_subagents.md,
// docs/0.9.0/plan/02_session_new_no_nested.md 과제 1·2.
import { strict as assert } from 'assert';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import {
  HOST_AGENT_START,
  HOST_SESSION_NEW,
  type HarnessRunner,
  type HostRequest,
  type SpawnOptions,
} from '@agentbridge/core';
import { initSubagents, createStartHandler, createSessionNewHandler } from '../src/core/subagents';
import { getWorkspaceStore } from '../src/core/coreInstances';
import * as workspaceStore from '../src/core/workspaceStore';
import { initCoreForTest } from './helpers';

// 세션 id는 UUID 형식만 받는다(workspaceStore 가드).
const MAIN = '11111111-1111-4111-8111-111111111111';
const SUB = '22222222-2222-4222-8222-222222222222';
const GHOST = '33333333-3333-4333-8333-333333333333';

const REFUSAL =
  '서브 세션에서는 새 세션을 띄우지 않는다. 다른 에이전트가 필요한 일은 보고에 적어 메인에게 넘긴다.';

// 모델 조회는 이 테스트의 관심이 아니다. 모델 지정 없이 부르므로 호출되지 않는다.
const unusedRunner: HarnessRunner = async () => {
  throw new Error('모델 조회가 불리면 안 된다');
};

describe('session new와 서브의 서브 막기 (0.9.0)', () => {
  let storagePath: string;
  let home: string;
  let repoDir: string;
  let wid: string;
  let cliPath: string;
  let opened: Array<{ opts: SpawnOptions; workspaceId: string; preserveFocus: boolean }>;
  let buildOptsCalls: Array<{ model: string; cwd: string }>;
  let available: Record<string, boolean>;

  before(async function () {
    this.timeout(30000);
    const cliTmp = await fsp.mkdtemp(join(tmpdir(), 'ab-sessnew-cli-'));
    cliPath = join(cliTmp, 'agentbridge.js');
    const bundler = join(process.cwd(), '..', '..', 'scripts', 'bundle-helper.mjs');
    execFileSync('node', [bundler, cliPath, 'cli'], { encoding: 'utf8' });
  });

  after(async () => {
    if (cliPath) await fsp.rm(join(cliPath, '..'), { recursive: true, force: true });
  });

  beforeEach(async () => {
    storagePath = await fsp.mkdtemp(join(tmpdir(), 'ab-sessnew-'));
    home = await fsp.mkdtemp(join(tmpdir(), 'ab-sessnew-home-'));
    repoDir = await fsp.mkdtemp(join(tmpdir(), 'ab-sessnew-repo-'));
    initCoreForTest(storagePath, home);
    wid = workspaceStore.getOrCreateWorkspaceId(repoDir);

    opened = [];
    buildOptsCalls = [];
    available = { claude: true, codex: true, agy: true };
    initSubagents({
      buildOpts: async (model, cwd, workspaceId, sessionId) => {
        buildOptsCalls.push({ model, cwd });
        return {
          command: model,
          args: [],
          cwd,
          env: {},
          terminalName: 'X',
          workspaceId,
          // 메인 세션 경로처럼 id를 안 주면 새로 발급한다.
          sessionId: sessionId ?? randomUUID(),
          model,
        };
      },
      openPanel: (opts, workspaceId, preserveFocus) => {
        opened.push({ opts, workspaceId, preserveFocus });
      },
      refreshTree: () => {},
      isAvailable: (model) => available[model] !== false,
    });
  });

  afterEach(async () => {
    for (const d of [storagePath, home, repoDir]) {
      await fsp.rm(d, { recursive: true, force: true });
    }
  });

  async function addMain(sessionId: string, model: 'claude' | 'codex' | 'agy'): Promise<string> {
    await getWorkspaceStore().addSession(wid, model, 'cli', sessionId);
    return workspaceStore.getSessionDir(wid, sessionId);
  }

  async function addSub(sessionId: string, parentSessionId: string): Promise<string> {
    await getWorkspaceStore().addSession(wid, 'claude', 'cli', sessionId, {
      parentSessionId,
      agentName: 'a',
    });
    return workspaceStore.getSessionDir(wid, sessionId);
  }

  const newReq = (payload: unknown): HostRequest => ({
    id: 'r1',
    kind: HOST_SESSION_NEW,
    at: 0,
    payload,
  });

  describe('session new', () => {
    it('부른 세션의 하니스로 부모 없는 세션을 연다', async () => {
      const dir = await addMain(MAIN, 'codex');
      const out = await createSessionNewHandler()(newReq({}), dir);

      assert.equal(out, '새 메인 세션을 열었다 (codex).');
      assert.equal(opened.length, 1);
      assert.equal(opened[0]!.preserveFocus, true);
      assert.equal(opened[0]!.workspaceId, wid);
      const meta = await getWorkspaceStore().loadWorkspace(wid);
      assert.equal(buildOptsCalls[0]!.model, 'codex');
      assert.equal(buildOptsCalls[0]!.cwd, meta.workspacePath);
      const fresh = meta.sessions.find((s) => s.sessionId === opened[0]!.opts.sessionId);
      assert.ok(fresh, '새 세션 기록이 있어야 한다');
      assert.equal(fresh!.model, 'codex');
      assert.equal(fresh!.parentSessionId, undefined);
      assert.equal(fresh!.agentName, undefined);
    });

    it('--harness로 고른 하니스로 연다', async () => {
      const dir = await addMain(MAIN, 'claude');
      const out = await createSessionNewHandler()(newReq({ harness: 'agy' }), dir);
      assert.match(out, /\(agy\)/);
      assert.equal(buildOptsCalls[0]!.model, 'agy');
    });

    it('모르는 하니스는 거절한다', async () => {
      const dir = await addMain(MAIN, 'claude');
      await assert.rejects(
        () => createSessionNewHandler()(newReq({ harness: 'gpt' }), dir),
        /모르는 하니스다: gpt/,
      );
      assert.equal(opened.length, 0);
    });

    it('설치되지 않은 하니스는 거절한다', async () => {
      const dir = await addMain(MAIN, 'codex');
      available.claude = false;
      await assert.rejects(
        () => createSessionNewHandler()(newReq({ harness: 'claude' }), dir),
        /claude CLI를 찾을 수 없다/,
      );
      assert.equal(opened.length, 0);
      const meta = await getWorkspaceStore().loadWorkspace(wid);
      assert.equal(meta.sessions.length, 1);
    });

    it('CLI — 쉼표가 있으면 거절한다', () => {
      const res = spawnSync('node', [cliPath, 'session', 'new', '--harness', 'claude,codex'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          AGENTBRIDGE_WS_DIR: workspaceStore.getWorkspacePath(wid),
          AGENTBRIDGE_WS_SESSION: MAIN,
        },
      });
      assert.equal(res.status, 2);
      assert.match(res.stderr, /session new는 하니스를 하나만 받는다/);
    });
  });

  describe('서브 세션의 기동 거절', () => {
    const startReq = (): HostRequest => ({
      id: 'r2',
      kind: HOST_AGENT_START,
      at: 0,
      payload: { prompt: 'x' },
    });

    it('서브가 부른 agent start를 거절한다', async () => {
      await addMain(MAIN, 'claude');
      const subDir = await addSub(SUB, MAIN);
      const before = (await getWorkspaceStore().loadWorkspace(wid)).sessions.length;

      await assert.rejects(
        () => createStartHandler({ run: unusedRunner })(startReq(), subDir),
        (err: Error) => err.message === REFUSAL,
      );
      assert.equal(opened.length, 0);
      assert.equal((await getWorkspaceStore().loadWorkspace(wid)).sessions.length, before);
    });

    it('서브가 부른 session new를 거절한다', async () => {
      await addMain(MAIN, 'claude');
      const subDir = await addSub(SUB, MAIN);
      await assert.rejects(
        () => createSessionNewHandler()(newReq({}), subDir),
        (err: Error) => err.message === REFUSAL,
      );
      assert.equal(opened.length, 0);
    });

    it('격리 서브도 거절한다 — 작업 폴더가 아니라 세션 기록으로 가른다', async () => {
      await addMain(MAIN, 'claude');
      const subDir = await addSub(SUB, MAIN);
      // 격리 서브는 trees/<이름> 아래 worktree에서 돈다. 세션 폴더(요청이 놓이는 곳)는 그대로
      // 워크스페이스 저장소 쪽이고, 판정에 쓰이는 것은 기록뿐이다.
      await fsp.mkdir(join(workspaceStore.getWorkspacePath(wid), 'trees', 'a'), { recursive: true });
      await assert.rejects(
        () => createStartHandler({ run: unusedRunner })(startReq(), subDir),
        (err: Error) => err.message === REFUSAL,
      );
      await assert.rejects(
        () => createSessionNewHandler()(newReq({}), subDir),
        (err: Error) => err.message === REFUSAL,
      );
      assert.equal(opened.length, 0);
    });

    it('메인이 부르면 지금처럼 띄운다', async () => {
      const mainDir = await addMain(MAIN, 'claude');
      const out = await createStartHandler({ run: unusedRunner })(startReq(), mainDir);
      assert.match(out, /서브 1개를 띄웠다/);
      assert.equal(opened.length, 1);
      const meta = await getWorkspaceStore().loadWorkspace(wid);
      const subs = meta.sessions.filter((s) => s.parentSessionId === MAIN);
      assert.equal(subs.length, 1);
    });

    it('기록을 못 찾는 세션은 메인으로 본다', async () => {
      // 세션 폴더만 있고 workspace.json에 기록이 없는 세션.
      const dir = workspaceStore.getSessionDir(wid, GHOST);
      await fsp.mkdir(dir, { recursive: true });
      const out = await createSessionNewHandler()(newReq({}), dir);
      assert.equal(out, '새 메인 세션을 열었다 (claude).');
    });
  });
});
