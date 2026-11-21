// 서브에이전트 명령 중 혼자 끝내는 넷 — list·read·check (4단계 W4)와 diff (5단계 W1).
// 호스트를 부르는 것들(start·send·stop·close·merge)은 통로 왕복이라 hostRequest 테스트가 덮는다.
//
// 근거: docs/0.5.0/spec/01_orca_adoption.md B-6·B-9, docs/0.5.0/plan/04_stage4_subagents.md W4,
// docs/0.5.0/plan/05_stage5_review_merge.md W1.
import { strict as assert } from 'assert';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync, spawnSync } from 'child_process';
import {
  listSubs,
  agentList,
  agentRead,
  agentCheck,
  agentDiff,
  addWorktree,
  resolveReportReadFile,
  resolveTurnSignalFile,
  HOST_AGENT_START,
  type HarnessRunner,
  type SpawnExtras,
  type SpawnOptions,
} from '@agentbridge/core';
import { initSubagents, createStartHandler } from '../src/core/subagents';
import { getWorkspaceStore } from '../src/core/coreInstances';
import * as workspaceStore from '../src/core/workspaceStore';
import { initCoreForTest } from './helpers';

const PARENT = 'parent-1';

async function makeWorkspace(): Promise<string> {
  const ws = await fsp.mkdtemp(join(tmpdir(), 'ab-sub-'));
  await fsp.mkdir(join(ws, 'sessions'), { recursive: true });
  return ws;
}

interface SessionSeed {
  sessionId: string;
  model?: string;
  parentSessionId?: string;
  agentName?: string;
  title?: string;
  closedAt?: string | null;
  subModel?: string;
  subEffort?: string;
}

async function writeSessions(
  ws: string,
  sessions: SessionSeed[],
  workspacePath?: string,
): Promise<void> {
  const full = sessions.map((s) => ({
    model: 'codex',
    modelSessionId: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    closedAt: null,
    ...s,
  }));
  await fsp.writeFile(
    join(ws, 'workspace.json'),
    JSON.stringify({ workspaceId: 'ws', workspacePath, sessions: full }),
    'utf8',
  );
  for (const s of sessions) {
    await fsp.mkdir(join(ws, 'sessions', s.sessionId), { recursive: true });
  }
}

async function writeSignal(ws: string, sessionId: string, complete: boolean, at: number): Promise<void> {
  await fsp.writeFile(
    resolveTurnSignalFile(ws, sessionId),
    JSON.stringify({
      agent: 'codex',
      event: 'Stop',
      sessionId,
      transcriptPath: '/tmp/t.jsonl',
      complete,
      at,
    }),
    'utf8',
  );
}

async function writeTurns(ws: string, sessionId: string, count: number): Promise<void> {
  const lines = [];
  for (let i = 0; i < count; i++) {
    lines.push(
      JSON.stringify({
        id: `t${i}`,
        sessionId,
        model: 'codex',
        user: `질문 ${i}`,
        assistantBody: `답 ${i}`,
        completedAt: `2026-09-01T00:0${i}:00.000Z`,
      }),
    );
  }
  await fsp.writeFile(join(ws, 'sessions', sessionId, 'turns.jsonl'), lines.join('\n') + '\n', 'utf8');
}

describe('agent list·read·check (0.5.0 W4)', () => {
  let ws: string;

  beforeEach(async () => {
    ws = await makeWorkspace();
  });

  afterEach(async () => {
    await fsp.rm(ws, { recursive: true, force: true });
  });

  it('부르는 세션의 자식만 목록에 나온다', async () => {
    await writeSessions(ws, [
      { sessionId: PARENT },
      { sessionId: 'mine', parentSessionId: PARENT, agentName: 'golden-gate' },
      { sessionId: 'theirs', parentSessionId: 'other-parent', agentName: 'hangang' },
      { sessionId: 'nameless', parentSessionId: PARENT },
    ]);
    const subs = await listSubs(ws, PARENT);
    assert.deepEqual(
      subs.map((s) => s.name),
      ['golden-gate'],
    );
  });

  it('서브가 없으면 목록이 그 사실을 말한다', async () => {
    await writeSessions(ws, [{ sessionId: PARENT }]);
    assert.match(await agentList(ws, PARENT), /띄운 서브가 없다/);
  });

  it('check가 기다리기 전에 이미 끝나 있는 것을 먼저 낸다', async () => {
    await writeSessions(ws, [
      { sessionId: PARENT },
      { sessionId: 'sub', parentSessionId: PARENT, agentName: 'golden-gate' },
    ]);
    await writeSignal(ws, 'sub', true, Date.now());
    // wait를 안 줬는데도 나와야 한다 — 부르기 전에 끝난 것을 놓치지 않는다.
    assert.match(await agentCheck(ws, PARENT), /golden-gate/);
  });

  it('미완 표시가 달린 신호는 check를 깨우지 않는다', async () => {
    await writeSessions(ws, [
      { sessionId: PARENT },
      { sessionId: 'sub', parentSessionId: PARENT, agentName: 'golden-gate' },
    ]);
    await writeSignal(ws, 'sub', false, Date.now());
    assert.match(await agentCheck(ws, PARENT), /안 읽은 서브가 없다/);
  });

  it('--wait이 켜지는 순간 즉시 반환한다', async () => {
    await writeSessions(ws, [
      { sessionId: PARENT },
      { sessionId: 'sub', parentSessionId: PARENT, agentName: 'golden-gate' },
    ]);
    // 세 번째 폴링에서 신호가 온다. 상한(60초)까지 안 기다리고 그때 바로 돌아와야 한다.
    let ticks = 0;
    const out = await agentCheck(ws, PARENT, {
      wait: true,
      sleep: async () => {
        ticks += 1;
        if (ticks === 3) await writeSignal(ws, 'sub', true, Date.now());
      },
    });
    assert.match(out, /golden-gate/);
    assert.equal(ticks, 3);
  });

  it('아무도 안 끝나면 상한에서 빈손으로 돌아온다', async () => {
    await writeSessions(ws, [
      { sessionId: PARENT },
      { sessionId: 'sub', parentSessionId: PARENT, agentName: 'golden-gate' },
    ]);
    let clock = 0;
    const out = await agentCheck(ws, PARENT, {
      wait: true,
      forSec: 3,
      now: () => clock,
      sleep: async () => {
        clock += 1000;
      },
    });
    assert.match(out, /기다리는 동안 끝난 서브가 없다/);
  });

  it('신호 없이 닫힌 서브는 재생한 지금 화면과 함께 나온다', async () => {
    await writeSessions(ws, [
      { sessionId: PARENT },
      {
        sessionId: 'sub',
        parentSessionId: PARENT,
        agentName: 'golden-gate',
        closedAt: '2026-09-01T00:10:00.000Z',
      },
      {
        sessionId: 'sub-empty',
        parentSessionId: PARENT,
        agentName: 'hangang',
        closedAt: '2026-09-01T00:11:00.000Z',
      },
    ]);
    await fsp.writeFile(
      join(ws, 'sessions', 'sub', 'replay.log'),
      '\x1b[2J\x1b[H첫 줄\r\n둘째 줄\x1b[1;1H덮어쓴 줄\x1b[K',
      'utf8',
    );
    const out = await agentCheck(ws, PARENT);
    assert.match(out, /완료 신호 없이 끝났다\. 지금 화면 \(120×30\):/);
    assert.match(out, / {6}덮어쓴 줄/);
    assert.match(out, / {6}둘째 줄/);
    assert.doesNotMatch(out, /\x1b/);
    assert.doesNotMatch(out, /첫 줄/);
    assert.match(out, /hangang[\s\S]*완료 신호 없이 끝났다\. 화면 기록이 없다\./);
  });

  it('완료 신호 없이 출력이 멈춘 서브를 check가 따로 낸다', async () => {
    await writeSessions(ws, [
      { sessionId: PARENT },
      { sessionId: 'sub', parentSessionId: PARENT, agentName: 'tower-bridge' },
    ]);
    // 2분 전에 턴이 시작됐고 종료 신호가 없다. 사용자가 끊었을 때의 모양이다.
    const old = Date.now() - 120_000;
    await fsp.writeFile(
      join(ws, 'sessions', 'sub', 'turn-start.json'),
      JSON.stringify({ agent: 'codex', event: 'UserPromptSubmit', sessionId: 'sub', at: old }),
      'utf8',
    );
    const out = await agentCheck(ws, PARENT);
    assert.match(out, /상태를 알 수 없는 서브/);
    assert.match(out, /tower-bridge/);
  });

  it('멈춘 서브가 생기면 --wait이 상한을 안 채우고 돌아온다', async () => {
    await writeSessions(ws, [
      { sessionId: PARENT },
      { sessionId: 'sub', parentSessionId: PARENT, agentName: 'tower-bridge' },
    ]);
    let ticks = 0;
    const out = await agentCheck(ws, PARENT, {
      wait: true,
      sleep: async () => {
        ticks += 1;
        if (ticks === 2) {
          await fsp.writeFile(
            join(ws, 'sessions', 'sub', 'turn-start.json'),
            JSON.stringify({
              agent: 'codex',
              event: 'UserPromptSubmit',
              sessionId: 'sub',
              at: Date.now() - 120_000,
            }),
            'utf8',
          );
        }
      },
    });
    assert.match(out, /상태를 알 수 없는 서브/);
    assert.equal(ticks, 2);
  });

  it('read가 읽음 표시를 쓰고 그 뒤 check가 조용해진다. check는 아무것도 안 쓴다', async () => {
    await writeSessions(ws, [
      { sessionId: PARENT },
      { sessionId: 'sub', parentSessionId: PARENT, agentName: 'golden-gate' },
    ]);
    await writeSignal(ws, 'sub', true, Date.now());
    await writeTurns(ws, 'sub', 2);

    // check는 순수 조회다 — 읽음 표시를 만들지 않는다.
    await agentCheck(ws, PARENT);
    await assert.rejects(fsp.access(resolveReportReadFile(ws, 'sub')));

    const read = await agentRead(ws, PARENT, 'golden-gate');
    assert.match(read, /질문 0/);
    await fsp.access(resolveReportReadFile(ws, 'sub')); // 이제 있다
    assert.match(await agentCheck(ws, PARENT), /안 읽은 서브가 없다/);
  });

  it('read --last N은 뒤에서 N턴만 낸다', async () => {
    await writeSessions(ws, [
      { sessionId: PARENT },
      { sessionId: 'sub', parentSessionId: PARENT, agentName: 'golden-gate' },
    ]);
    await writeTurns(ws, 'sub', 3);
    const out = await agentRead(ws, PARENT, 'golden-gate', 1);
    assert.match(out, /질문 2/);
    assert.doesNotMatch(out, /질문 0/);
  });

  it('없는 이름은 있는 것들을 알려주며 거절한다', async () => {
    await writeSessions(ws, [
      { sessionId: PARENT },
      { sessionId: 'sub', parentSessionId: PARENT, agentName: 'golden-gate' },
    ]);
    await assert.rejects(agentRead(ws, PARENT, 'hangang'), /golden-gate/);
  });
});

// ─── diff (5단계 W1) ─────────────────────────────────────────────────────

describe('agent diff', () => {
  let ws = '';
  let repo = '';

  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' });
  }

  beforeEach(async () => {
    ws = await makeWorkspace();
    repo = join(ws, 'repo');
    await fsp.mkdir(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@agentbridge.local');
    git(repo, 'config', 'user.name', 'AgentBridge Test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    await fsp.writeFile(join(repo, 'a.txt'), 'hello\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'init');
    await writeSessions(
      ws,
      [
        { sessionId: PARENT },
        { sessionId: 'sub', parentSessionId: PARENT, agentName: 'golden-gate' },
      ],
      repo,
    );
  });

  afterEach(async () => {
    if (ws) await fsp.rm(ws, { recursive: true, force: true });
    ws = '';
  });

  it('격리 서브는 분기점 이후 전체를 낸다', async () => {
    await addWorktree(repo, join(ws, 'trees', 'golden-gate'), 'golden-gate');
    await fsp.writeFile(join(ws, 'trees', 'golden-gate', 'sub.txt'), 'sub work\n');

    const out = await agentDiff(ws, PARENT, 'golden-gate');

    assert.match(out, /격리 worktree, 분기점/);
    assert.match(out, /sub\.txt/);
    assert.match(out, /\+sub work/);
  });

  it('--stat은 패치 없이 요약만 낸다', async () => {
    await addWorktree(repo, join(ws, 'trees', 'golden-gate'), 'golden-gate');
    await fsp.writeFile(join(ws, 'trees', 'golden-gate', 'sub.txt'), 'sub work\n');

    const out = await agentDiff(ws, PARENT, 'golden-gate', { statOnly: true });

    assert.match(out, /sub\.txt/);
    assert.doesNotMatch(out, /\+sub work/);
  });

  it('비격리 서브는 원본 폴더의 변경을 내고 섞여 있음을 알린다', async () => {
    await fsp.writeFile(join(repo, 'a.txt'), 'hello\nedited\n');

    const out = await agentDiff(ws, PARENT, 'golden-gate');

    assert.match(out, /원본 폴더의 지금 상태/);
    assert.match(out, /\+edited/);
  });

  it('변경이 없으면 그렇게 말한다', async () => {
    await addWorktree(repo, join(ws, 'trees', 'golden-gate'), 'golden-gate');
    assert.match(await agentDiff(ws, PARENT, 'golden-gate'), /바뀐 파일이 없다/);
  });

  it('남의 서브는 거절한다', async () => {
    await assert.rejects(agentDiff(ws, 'other-parent', 'golden-gate'), /그런 서브가 없다/);
  });
});

// ─── 서브 모델·effort 검사 및 출력 (0.8.0 spec/06 §3·§6) ──────────────────────

describe('agent list·check 괄호 출력 (0.8.0 §6)', () => {
  let ws: string;

  beforeEach(async () => {
    ws = await makeWorkspace();
  });

  afterEach(async () => {
    await fsp.rm(ws, { recursive: true, force: true });
  });

  it('listSubs와 agentList가 저장된 subModel·subEffort를 상태 앞 괄호로 낸다', async () => {
    await writeSessions(ws, [
      { sessionId: PARENT },
      {
        sessionId: 's-both',
        model: 'claude',
        parentSessionId: PARENT,
        agentName: 'golden-gate',
        title: '작업-claude',
        subModel: 'opus',
        subEffort: 'high',
      },
      {
        sessionId: 's-model-only',
        model: 'claude',
        parentSessionId: PARENT,
        agentName: 'hangang',
        title: '간단-claude',
        subModel: 'claude-haiku-4-5-20251001',
      },
      {
        sessionId: 's-none',
        model: 'codex',
        parentSessionId: PARENT,
        agentName: 'tower-bridge',
        title: '기본-codex',
      },
    ]);

    const subs = await listSubs(ws, PARENT);
    assert.deepEqual(
      subs.map((s) => ({ name: s.name, subModel: s.subModel, subEffort: s.subEffort })),
      [
        { name: 'golden-gate', subModel: 'opus', subEffort: 'high' },
        { name: 'hangang', subModel: 'claude-haiku-4-5-20251001', subEffort: undefined },
        { name: 'tower-bridge', subModel: undefined, subEffort: undefined },
      ],
    );

    const out = await agentList(ws, PARENT);
    assert.match(out, /golden-gate {2}\(claude, opus, high, 노는 중\) {2}작업-claude/);
    assert.match(out, /hangang {2}\(claude, claude-haiku-4-5-20251001, 노는 중\) {2}간단-claude/);
    assert.match(out, /tower-bridge {2}\(codex, 노는 중\) {2}기본-codex/);
  });

  it('agentCheck가 끝난·알 수 없는·빈손 행 모두에 모델·effort 괄호를 붙인다', async () => {
    await writeSessions(ws, [
      { sessionId: PARENT },
      {
        sessionId: 's-done',
        model: 'claude',
        parentSessionId: PARENT,
        agentName: 'golden-gate',
        title: '완료-claude',
        subModel: 'opus',
        subEffort: 'high',
      },
      {
        sessionId: 's-stuck',
        model: 'agy',
        parentSessionId: PARENT,
        agentName: 'ponte-vecchio',
        title: '멈춤-agy',
        subModel: 'gemini-4-hydrogen',
        subEffort: 'low',
      },
      {
        sessionId: 's-noeffort',
        model: 'claude',
        parentSessionId: PARENT,
        agentName: 'hangang',
        title: '하쿠-claude',
        subModel: 'haiku',
        closedAt: '2026-09-01T00:10:00.000Z',
      },
    ]);

    // 모두 빈손 상태(아직 완료 신호 없음, s-noeffort만 닫힘)
    const emptyOut = await agentCheck(ws, PARENT);
    assert.match(emptyOut, /golden-gate {2}\(claude, opus, high, 노는 중\)/);
    assert.match(emptyOut, /ponte-vecchio {2}\(agy, gemini-4-hydrogen, low, 노는 중\)/);
    assert.match(emptyOut, /hangang {2}\(claude, haiku, 끝남\)/);

    // s-done 완료, s-stuck 멈춤(unknown)
    await writeSignal(ws, 's-done', true, Date.now());
    await fsp.writeFile(
      join(ws, 'sessions', 's-stuck', 'turn-start.json'),
      JSON.stringify({
        agent: 'agy',
        event: 'UserPromptSubmit',
        sessionId: 's-stuck',
        at: Date.now() - 120_000,
      }),
      'utf8',
    );
    const wokeOut = await agentCheck(ws, PARENT);
    assert.match(wokeOut, /golden-gate {2}\(claude, opus, high\) {2}완료-claude/);
    assert.match(wokeOut, /ponte-vecchio {2}\(agy, gemini-4-hydrogen, low\) {2}멈춤-agy/);
  });
});

describe('handleStart — 모델·effort 검사와 스폰 연결 (0.8.0 §3·§6)', () => {
  let storagePath: string;
  let home: string;
  let repoDir: string;
  let wid: string;
  let parentSessionDir: string;
  let cliPath: string;
  let buildOptsCalls: Array<{ model: string; extras?: SpawnExtras }>;
  let openedPanels: SpawnOptions[];

  const fakeRunner: HarnessRunner = async (harness) => {
    if (harness === 'claude') {
      return {
        models: [
          { value: 'opus', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
          { value: 'claude-haiku-4-5-20251001', supportsEffort: false },
        ],
      };
    }
    if (harness === 'codex') {
      return [
        {
          result: {
            data: [
              {
                model: 'gpt-6-luna',
                supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'xhigh' }],
              },
              { model: 'gpt-5-nano', supportedReasoningEfforts: [] },
            ],
            nextCursor: null,
          },
        },
      ];
    }
    return [
      'gemini-4-hydrogen-low\tGemini 4 (Low)',
      'gemini-4-hydrogen-medium\tGemini 4 (Medium)',
      'gemini-4-hydrogen-high\tGemini 4 (High)',
      'gemini-4-hydrogen-xhigh\tGemini 4 (XHigh)',
      'gemini-pro-orchestrator-g1-pro\tOrchestrator',
    ].join('\n');
  };

  before(async function () {
    this.timeout(30000);
    const cliTmp = await fsp.mkdtemp(join(tmpdir(), 'ab-subcmd-cli-'));
    cliPath = join(cliTmp, 'agentbridge.js');
    const bundler = join(process.cwd(), '..', '..', 'scripts', 'bundle-helper.mjs');
    execFileSync('node', [bundler, cliPath, 'cli'], { encoding: 'utf8' });
  });

  after(async () => {
    if (cliPath) await fsp.rm(join(cliPath, '..'), { recursive: true, force: true });
  });

  beforeEach(async () => {
    storagePath = await fsp.mkdtemp(join(tmpdir(), 'ab-substart-'));
    home = await fsp.mkdtemp(join(tmpdir(), 'ab-substart-home-'));
    repoDir = await fsp.mkdtemp(join(tmpdir(), 'ab-substart-repo-'));
    initCoreForTest(storagePath, home);
    wid = workspaceStore.getOrCreateWorkspaceId(repoDir);
    const parentSid = '11111111-1111-4111-8111-111111111111';
    await getWorkspaceStore().addSession(wid, 'claude', 'cli', parentSid);
    parentSessionDir = workspaceStore.getSessionDir(wid, parentSid);

    buildOptsCalls = [];
    openedPanels = [];
    initSubagents({
      buildOpts: async (model, cwd, workspaceId, sessionId, _resumeModelSid, extras) => {
        buildOptsCalls.push({ model, extras });
        return {
          command: model,
          args: [],
          cwd,
          env: {},
          terminalName: model,
          workspaceId,
          sessionId,
          model,
          parentSessionId: extras?.parentSessionId,
        };
      },
      openPanel: (opts) => {
        openedPanels.push(opts);
      },
      refreshTree: () => {},
    });
  });

  afterEach(async () => {
    for (const d of [storagePath, home, repoDir]) {
      await fsp.rm(d, { recursive: true, force: true });
    }
  });

  it('거절 표의 다섯 경우와 표 불일치·조회 실패를 거절하고 아무것도 띄우지 않는다', async () => {
    const handleStart = createStartHandler({ run: fakeRunner });

    // 1) 하니스가 여럿인데 짝 없이 값 하나 (CLI)
    const cliRes = spawnSync(
      'node',
      [cliPath, 'agent', 'start', '--prompt', '작업', '--harness', 'claude,codex', '--model', 'opus'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          AGENTBRIDGE_WS_DIR: workspaceStore.getWorkspacePath(wid),
          AGENTBRIDGE_WS_SESSION: '11111111-1111-4111-8111-111111111111',
        },
      },
    );
    assert.equal(cliRes.status, 2);
    assert.match(
      cliRes.stderr,
      /하니스가 여럿이면 --model과 --effort는 claude=opus처럼 하니스별로 쓴다/,
    );

    // 2) 짝에 --harness에 없는 하니스
    await assert.rejects(
      () =>
        handleStart(
          {
            id: 'r2',
            kind: HOST_AGENT_START,
            at: 0,
            payload: { prompt: '작업', harnesses: ['claude'], models: { codex: 'gpt-6-luna' } },
          },
          parentSessionDir,
        ),
      /--model의 codex는 --harness에 없다/,
    );

    // 3) 모델은 있는데 effort가 없다
    await assert.rejects(
      () =>
        handleStart(
          {
            id: 'r3',
            kind: HOST_AGENT_START,
            at: 0,
            payload: { prompt: '작업', harnesses: ['claude'], models: { claude: 'opus' } },
          },
          parentSessionDir,
        ),
      /claude의 opus에 --effort가 없다\. 받는 값: low medium high/,
    );

    // 4) effort는 있는데 모델이 없다
    await assert.rejects(
      () =>
        handleStart(
          {
            id: 'r4',
            kind: HOST_AGENT_START,
            at: 0,
            payload: { prompt: '작업', harnesses: ['claude'], efforts: { claude: 'high' } },
          },
          parentSessionDir,
        ),
      /claude에 --effort만 있다\. --model과 함께 쓴다/,
    );

    // 5) effort가 없는 모델에 effort가 왔다
    await assert.rejects(
      () =>
        handleStart(
          {
            id: 'r5',
            kind: HOST_AGENT_START,
            at: 0,
            payload: {
              prompt: '작업',
              harnesses: ['claude'],
              models: { claude: 'claude-haiku-4-5-20251001' },
              efforts: { claude: 'low' },
            },
          },
          parentSessionDir,
        ),
      /claude의 claude-haiku-4-5-20251001은 effort를 받지 않는다/,
    );

    // 표에 없는 모델 이름 (agy effort 꼬리가 붙은 id 포함)
    await assert.rejects(
      () =>
        handleStart(
          {
            id: 'r6',
            kind: HOST_AGENT_START,
            at: 0,
            payload: {
              prompt: '작업',
              harnesses: ['agy'],
              models: { agy: 'gemini-4-hydrogen-high' },
              efforts: { agy: 'high' },
            },
          },
          parentSessionDir,
        ),
      /agy에 gemini-4-hydrogen-high 모델이 없다\..*agent models/,
    );

    // 알 수 없는 하니스 키와 빈 문자열 값 거절
    await assert.rejects(
      () =>
        handleStart(
          {
            id: 'r7',
            kind: HOST_AGENT_START,
            at: 0,
            payload: { prompt: '작업', harnesses: ['claude'], models: { nope: 'opus' } },
          },
          parentSessionDir,
        ),
      /모르는 하니스다: nope/,
    );
    await assert.rejects(
      () =>
        handleStart(
          {
            id: 'r8',
            kind: HOST_AGENT_START,
            at: 0,
            payload: { prompt: '작업', harnesses: ['claude'], models: { claude: '   ' } },
          },
          parentSessionDir,
        ),
      /--model의 claude 값이 비어 있다/,
    );

    // 표를 못 받음
    const failHandler = createStartHandler({
      run: async () => {
        throw new Error('15초 시간 초과');
      },
    });
    await assert.rejects(
      () =>
        failHandler(
          {
            id: 'r9',
            kind: HOST_AGENT_START,
            at: 0,
            payload: {
              prompt: '작업',
              harnesses: ['codex'],
              models: { codex: 'gpt-6-luna' },
              efforts: { codex: 'xhigh' },
            },
          },
          parentSessionDir,
        ),
      /codex의 모델 목록을 받지 못해 검사할 수 없다 \(15초 시간 초과\)/,
    );

    assert.equal(buildOptsCalls.length, 0);
    assert.equal(openedPanels.length, 0);
    const meta = await getWorkspaceStore().loadWorkspace(wid);
    assert.equal(meta.sessions.length, 1);
  });

  it('여럿 중 하나만 걸려도 아무것도 띄우지 않고 거절 문구 묶음을 돌려준다', async () => {
    const handleStart = createStartHandler({ run: fakeRunner });

    await assert.rejects(
      () =>
        handleStart(
          {
            id: 'r-partial',
            kind: HOST_AGENT_START,
            at: 0,
            payload: {
              prompt: '작업',
              harnesses: ['claude', 'agy'],
              models: { claude: 'opus', agy: 'gemini-4-hydrogen' },
              efforts: { claude: 'high', agy: 'max' },
            },
          },
          parentSessionDir,
        ),
      /agy의 gemini-4-hydrogen은 --effort max를 받지 않는다\. 받는 값: low medium high xhigh\. 전체는 agent models로 본다/,
    );

    assert.equal(buildOptsCalls.length, 0);
    assert.equal(openedPanels.length, 0);
    const meta = await getWorkspaceStore().loadWorkspace(wid);
    assert.equal(meta.sessions.length, 1);
  });

  it('통과한 모델·effort가 buildOpts extras, workspace.json, start 응답 괄호까지 이어진다', async () => {
    const queried: string[] = [];
    const handleStart = createStartHandler({
      run: async (h, sig) => {
        queried.push(h);
        return fakeRunner(h, sig);
      },
    });

    // 1) 모델+effort 있는 claude와 지정 없는 codex 함께 스폰 -> claude 표만 조회
    const out1 = await handleStart(
      {
        id: 'ok-1',
        kind: HOST_AGENT_START,
        at: 0,
        payload: {
          prompt: '작업',
          harnesses: ['claude', 'codex'],
          models: { claude: 'opus' },
          efforts: { claude: 'high' },
        },
      },
      parentSessionDir,
    );

    assert.deepEqual(queried, ['claude']);
    assert.equal(buildOptsCalls.length, 2);
    assert.equal(buildOptsCalls[0]!.model, 'claude');
    assert.equal(buildOptsCalls[0]!.extras?.subModel, 'opus');
    assert.equal(buildOptsCalls[0]!.extras?.subEffort, 'high');
    assert.equal(buildOptsCalls[1]!.model, 'codex');
    assert.equal(buildOptsCalls[1]!.extras?.subModel, undefined);
    assert.equal(buildOptsCalls[1]!.extras?.subEffort, undefined);
    assert.match(out1, /\(claude, opus, high\)/);
    assert.match(out1, /\(codex\)$|  \(codex\)\n/m);

    // 2) effort 없는 모델 -> subModel만 기록, 응답은 (claude, claude-haiku-4-5-20251001)
    const out2 = await handleStart(
      {
        id: 'ok-2',
        kind: HOST_AGENT_START,
        at: 0,
        payload: {
          prompt: '가벼운 작업',
          harnesses: ['claude'],
          models: { claude: 'claude-haiku-4-5-20251001' },
        },
      },
      parentSessionDir,
    );
    assert.equal(buildOptsCalls[2]!.extras?.subModel, 'claude-haiku-4-5-20251001');
    assert.equal(buildOptsCalls[2]!.extras?.subEffort, undefined);
    assert.match(out2, /\(claude, claude-haiku-4-5-20251001\)/);

    const meta = await getWorkspaceStore().loadWorkspace(wid);
    const children = meta.sessions.filter((s) => s.parentSessionId);
    assert.equal(children.length, 3);
    assert.equal(children[0]!.subModel, 'opus');
    assert.equal(children[0]!.subEffort, 'high');
    assert.equal(children[1]!.subModel, undefined);
    assert.equal(children[1]!.subEffort, undefined);
    assert.equal(children[2]!.subModel, 'claude-haiku-4-5-20251001');
    assert.equal(children[2]!.subEffort, undefined);
  });
});

// ─── 지금 화면 붙이기 · --screen (0.8.0 spec/08 §2) ──────────────────────

describe('agent read 지금 화면 (0.8.0 spec/08)', () => {
  let ws: string;

  async function writeTurnBodies(sessionId: string, bodies: string[]): Promise<void> {
    const lines = bodies.map((assistantBody, i) =>
      JSON.stringify({
        id: `t${i}`,
        sessionId,
        model: 'codex',
        user: `질문 ${i}`,
        assistantBody,
        completedAt: `2026-09-01T00:0${i}:00.000Z`,
      }),
    );
    await fsp.writeFile(join(ws, 'sessions', sessionId, 'turns.jsonl'), lines.join('\n') + '\n', 'utf8');
  }

  beforeEach(async () => {
    ws = await makeWorkspace();
  });

  afterEach(async () => {
    await fsp.rm(ws, { recursive: true, force: true });
  });

  it('턴이 없으면 아직 기록된 턴이 없다 뒤에 지금 화면이나 빈 안내를 붙인다', async () => {
    await writeSessions(ws, [
      { sessionId: PARENT },
      { sessionId: 'sub-with-screen', parentSessionId: PARENT, agentName: 'golden-gate' },
      { sessionId: 'sub-no-screen', parentSessionId: PARENT, agentName: 'hangang' },
    ]);
    await fsp.writeFile(
      join(ws, 'sessions', 'sub-with-screen', 'owner.json'),
      JSON.stringify({ app: 'extension', pid: process.pid, acquiredAt: Date.now(), cols: 81, rows: 45 }),
      'utf8',
    );
    await fsp.writeFile(
      join(ws, 'sessions', 'sub-with-screen', 'replay.log'),
      'Waiting for its response...\r\nesc to cancel',
      'utf8',
    );

    const withScreen = await agentRead(ws, PARENT, 'golden-gate');
    assert.match(withScreen, /^golden-gate: 아직 기록된 턴이 없다\./);
    assert.match(withScreen, /### 지금 화면 \(81×45\)\n\nWaiting for its response\.\.\.\nesc to cancel$/);

    const noScreen = await agentRead(ws, PARENT, 'hangang');
    assert.equal(noScreen, 'hangang: 아직 기록된 턴이 없다.\n\n화면 기록이 없다');
  });

  it('마지막 턴의 답이 공백뿐이면 끝난 서브라도 화면을 붙인다', async () => {
    await writeSessions(ws, [
      { sessionId: PARENT },
      {
        sessionId: 'sub',
        parentSessionId: PARENT,
        agentName: 'golden-gate',
        closedAt: '2026-09-01T00:10:00.000Z',
      },
    ]);
    await writeTurnBodies('sub', ['첫 답', '  \n\t ']);
    await fsp.writeFile(join(ws, 'sessions', 'sub', 'replay.log'), '빈 답일 때의 화면', 'utf8');

    const out = await agentRead(ws, PARENT, 'golden-gate');
    assert.match(out, /질문 0/);
    assert.match(out, /### 지금 화면 \(120×30\)\n\n빈 답일 때의 화면$/);
  });

  it('답이 있어도 running·unknown 상태면 화면을 붙인다', async () => {
    await writeSessions(ws, [
      { sessionId: PARENT },
      { sessionId: 'sub-run', parentSessionId: PARENT, agentName: 'golden-gate' },
      { sessionId: 'sub-unk', parentSessionId: PARENT, agentName: 'tower-bridge' },
    ]);
    await writeTurnBodies('sub-run', ['지난 턴 답']);
    await writeTurnBodies('sub-unk', ['지난 턴 답']);
    await fsp.writeFile(join(ws, 'sessions', 'sub-run', 'replay.log'), '도는 중 화면', 'utf8');
    await fsp.writeFile(join(ws, 'sessions', 'sub-unk', 'replay.log'), '멈춘 화면', 'utf8');

    await fsp.writeFile(
      join(ws, 'sessions', 'sub-run', 'turn-start.json'),
      JSON.stringify({ agent: 'codex', event: 'UserPromptSubmit', sessionId: 'sub-run', at: Date.now() }),
      'utf8',
    );
    await fsp.writeFile(
      join(ws, 'sessions', 'sub-unk', 'turn-start.json'),
      JSON.stringify({
        agent: 'codex',
        event: 'UserPromptSubmit',
        sessionId: 'sub-unk',
        at: Date.now() - 120_000,
      }),
      'utf8',
    );

    const runningOut = await agentRead(ws, PARENT, 'golden-gate');
    assert.match(runningOut, /지난 턴 답/);
    assert.match(runningOut, /### 지금 화면 \(120×30\)\n\n도는 중 화면$/);

    const unknownOut = await agentRead(ws, PARENT, 'tower-bridge');
    assert.match(unknownOut, /지난 턴 답/);
    assert.match(unknownOut, /### 지금 화면 \(120×30\)\n\n멈춘 화면$/);
  });

  it('답이 있고 끝났거나 쉬는 서브는 화면을 붙이지 않는다', async () => {
    await writeSessions(ws, [
      { sessionId: PARENT },
      {
        sessionId: 'sub-closed',
        parentSessionId: PARENT,
        agentName: 'golden-gate',
        closedAt: '2026-09-01T00:10:00.000Z',
      },
      { sessionId: 'sub-done', parentSessionId: PARENT, agentName: 'hangang' },
    ]);
    await writeTurnBodies('sub-closed', ['완료 답']);
    await writeTurnBodies('sub-done', ['턴 끝 답']);
    await writeSignal(ws, 'sub-done', true, Date.now());
    await fsp.writeFile(join(ws, 'sessions', 'sub-closed', 'replay.log'), '안 나와야 할 화면', 'utf8');
    await fsp.writeFile(join(ws, 'sessions', 'sub-done', 'replay.log'), '안 나와야 할 화면', 'utf8');

    const closedOut = await agentRead(ws, PARENT, 'golden-gate');
    assert.match(closedOut, /완료 답/);
    assert.doesNotMatch(closedOut, /지금 화면/);
    assert.doesNotMatch(closedOut, /안 나와야 할 화면/);

    const doneOut = await agentRead(ws, PARENT, 'hangang');
    assert.match(doneOut, /턴 끝 답/);
    assert.doesNotMatch(doneOut, /지금 화면/);
  });

  it('--last 1로 일부만 보여도 판정은 기록 전체의 마지막 턴을 따른다', async () => {
    await writeSessions(ws, [
      { sessionId: PARENT },
      {
        sessionId: 'sub-filled-last',
        parentSessionId: PARENT,
        agentName: 'golden-gate',
        closedAt: '2026-09-01T00:10:00.000Z',
      },
      {
        sessionId: 'sub-empty-last',
        parentSessionId: PARENT,
        agentName: 'hangang',
        closedAt: '2026-09-01T00:10:00.000Z',
      },
    ]);
    // 앞 턴은 비었지만 마지막 턴에 답이 있는 경우: --last 1이어도 화면이 안 붙는다.
    await writeTurnBodies('sub-filled-last', ['', '마지막 답']);
    await fsp.writeFile(join(ws, 'sessions', 'sub-filled-last', 'replay.log'), '화면 X', 'utf8');

    const filledOut = await agentRead(ws, PARENT, 'golden-gate', 1);
    assert.match(filledOut, /마지막 답/);
    assert.doesNotMatch(filledOut, /지금 화면/);

    // 앞 턴에 답이 있고 마지막 턴이 빈 경우: --last 1에서 화면이 붙는다.
    await writeTurnBodies('sub-empty-last', ['앞 턴 답', '']);
    await fsp.writeFile(join(ws, 'sessions', 'sub-empty-last', 'replay.log'), '화면 O', 'utf8');

    const emptyOut = await agentRead(ws, PARENT, 'hangang', 1);
    assert.doesNotMatch(emptyOut, /앞 턴 답/);
    assert.match(emptyOut, /### 지금 화면 \(120×30\)\n\n화면 O$/);
  });

  it('--screen은 턴 기록 없이 화면만 내고 report-read.json을 쓴다', async () => {
    await writeSessions(ws, [
      { sessionId: PARENT },
      { sessionId: 'sub', parentSessionId: PARENT, agentName: 'golden-gate' },
      { sessionId: 'sub-empty', parentSessionId: PARENT, agentName: 'hangang' },
    ]);
    await writeSignal(ws, 'sub', true, Date.now());
    await writeTurnBodies('sub', ['답 0']);
    await fsp.writeFile(
      join(ws, 'sessions', 'sub', 'replay.log'),
      'Waiting for its response...\r\nesc to cancel',
      'utf8',
    );

    const out = await agentRead(ws, PARENT, 'golden-gate', { screen: true });
    assert.doesNotMatch(out, /의 기록/);
    assert.doesNotMatch(out, /질문 0/);
    assert.match(out, /^### 지금 화면 \(120×30\)\n\nWaiting for its response\.\.\.\nesc to cancel$/);

    await fsp.access(resolveReportReadFile(ws, 'sub'));
    assert.match(await agentCheck(ws, PARENT), /안 읽은 서브가 없다/);

    const emptyOut = await agentRead(ws, PARENT, 'hangang', { screen: true });
    assert.equal(emptyOut, '화면 기록이 없다');
  });

  it('--screen과 --last를 함께 주면 거절한다', async () => {
    await writeSessions(ws, [
      { sessionId: PARENT },
      { sessionId: 'sub', parentSessionId: PARENT, agentName: 'golden-gate' },
    ]);
    await assert.rejects(
      agentRead(ws, PARENT, 'golden-gate', { screen: true, lastN: 1 }),
      /--screen은 --last와 함께 쓰지 않는다/,
    );
  });
});
