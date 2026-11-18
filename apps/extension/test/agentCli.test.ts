import { strict as assert } from 'assert';
import { promisify } from 'util';
import { execFile, execFileSync, spawnSync } from 'child_process';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  getCanonicalBinPath,
  installBinToCanonicalPath,
  getGlobalDir,
  writeProfileDocs,
  readProfileDocs,
  profileIdForPath,
  readProposals,
  approveProposal,
  startHostRequestHandler,
  applyMemoryWrite,
  parseMemoryWriteRequest,
  HOST_MEMORY_WRITE,
  HOST_AGENT_MODELS,
  HOST_AGENT_START,
  type HostRequestHandlers,
} from '@agentbridge/core';
import { createModelsHandler } from '../src/core/modelLookup';

// 에이전트용 CLI (0.5.0 3단계 W1) — 골격, 신원 해소, 설치 배관.
// 헬퍼와 같은 모양으로 실제 번들을 만들어 자식 프로세스로 돌린다. 신원은 인자가 아니라
// AGENTBRIDGE_WS_DIR이고, 그 변수가 없는 자리(앱 밖 터미널)에서는 아무것도 내지 않아야 한다.
describe('agent CLI — 골격과 신원 해소 (0.5.0 W1)', () => {
  let tmp: string;
  let root: string;
  let cliPath: string;
  let wsDir: string;

  before(async function () {
    this.timeout(30000); // esbuild 번들 빌드 여유
    tmp = await fsp.mkdtemp(join(tmpdir(), 'ab-agentcli-'));
    root = join(tmp, 'storage');
    await fsp.mkdir(join(root, 'bin'), { recursive: true });
    cliPath = join(root, 'bin', 'agentbridge.js');
    const bundler = join(process.cwd(), '..', '..', 'scripts', 'bundle-helper.mjs');
    execFileSync('node', [bundler, cliPath, 'cli'], { encoding: 'utf8' });
    wsDir = join(root, 'workspaces', 'ws-1');
    await fsp.mkdir(wsDir, { recursive: true });
  });

  after(async () => {
    if (tmp) await fsp.rm(tmp, { recursive: true, force: true });
  });

  // 지식 쓰기는 호스트를 거친다(0.5.0 6단계 후속). 그래서 쓰기 계열은 호스트를 띄운 채 부른다.
  // spawnSync로는 같은 프로세스의 처리기가 돌 틈이 없어 비동기로 띄운다.
  const HOST_SESSION = 'sess-host';
  async function runWithHost(args: string[], extraHandlers: HostRequestHandlers = {}) {
    const watcher = startHostRequestHandler({
      storageRoot: root,
      handlers: {
        [HOST_MEMORY_WRITE]: (req) => applyMemoryWrite(root, parseMemoryWriteRequest(req.payload)),
        ...extraHandlers,
      },
      ownsSession: async () => true,
    });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AGENTBRIDGE_WS_DIR: wsDir,
      AGENTBRIDGE_WS_SESSION: HOST_SESSION,
    };
    try {
      const { stdout, stderr } = await promisify(execFile)('node', [cliPath, ...args], { env });
      return { status: 0, stdout, stderr };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      return { status: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    } finally {
      watcher.stop();
    }
  }

  function run(args: string[], wsDirOverride?: string | null) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.AGENTBRIDGE_WS_DIR;
    const ws = wsDirOverride === undefined ? wsDir : wsDirOverride;
    if (ws) env.AGENTBRIDGE_WS_DIR = ws;
    const r = spawnSync('node', [cliPath, ...args], { encoding: 'utf8', env });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  it('신원 변수가 없으면 아무것도 내지 않고 끝난다', () => {
    const r = run(['context'], null);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /AgentBridge/);
    assert.equal(r.stderr, '');
  });

  it('신원 변수가 저장소 루트 밖을 가리키면 거절한다', () => {
    const r = run(['context'], tmp);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /저장소 루트/);
  });

  it('알 수 없는 명령은 사용법을 내고 exit 2', () => {
    const r = run(['nope']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /context/);
  });

  it('명령이 없으면 사용법을 내고 exit 2', () => {
    const r = run([]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /context/);
  });

  it('context — IR이 없으면 그 사실을 말한다', () => {
    const r = run(['context']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /없/);
  });

  it('context — IR의 여섯 절을 낸다', async () => {
    await fsp.writeFile(
      join(wsDir, 'ir.json'),
      JSON.stringify({
        contextId: 'ctx-1',
        // meta가 없으면 손상된 ir.json으로 본다(clearIR이 '{}'를 쓰는 계약) — 실제 모양과 맞춘다.
        meta: { createdAt: '2026-08-31T00:00:00.000Z', updatedAt: '2026-08-31T00:10:00.000Z' },
        intent: { goal: '3단계 CLI를 세운다', constraints: ['주입은 마지막에 걷는다'] },
        decisions: [{ topic: '신원', choice: '환경변수로 받는다', rationale: '모델이 틀릴 여지가 없다' }],
        files: [{ status: 'read', path: 'packages/core/bin/agentbridge.js', summary: '엔트리' }],
        commands: [{ cmd: 'npm test', exitCode: 0, summary: '411 passing' }],
        tests: [{ status: 'pass', name: 'agentCli' }],
        pending: [{ task: '읽기 넷', nextStep: 'W2' }],
      }),
    );
    const r = run(['context']);
    assert.equal(r.status, 0);
    for (const section of ['Intent', 'Decisions', 'Files', 'Commands', 'Tests', 'Pending']) {
      assert.match(r.stdout, new RegExp(section));
    }
    assert.match(r.stdout, /3단계 CLI를 세운다/);
    assert.match(r.stdout, /환경변수로 받는다/);
  });

  it('turns — 기록이 없으면 그 사실을 말한다', () => {
    const r = run(['turns']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /턴이 없다/);
  });

  it('turns — 기본은 최근 세 턴, --last로 자른다', async () => {
    const turn = (n: number) => JSON.stringify({
      id: `t${n}`,
      workspaceId: 'ws-1',
      sessionId: 's1',
      model: 'claude',
      startedAt: `2026-08-31T00:0${n}:00.000Z`,
      completedAt: `2026-08-31T00:0${n}:30.000Z`,
      user: `질문 ${n}`,
      userBytes: 5,
      assistantBody: `답 ${n}`,
      assistantBodyBytes: 3,
      toolCalls: [],
    });
    await fsp.writeFile(join(wsDir, 'turns.jsonl'), [1, 2, 3, 4, 5].map(turn).join('\n') + '\n');

    const def = run(['turns']);
    assert.equal(def.status, 0);
    assert.match(def.stdout, /질문 5/);
    assert.match(def.stdout, /질문 3/);
    assert.doesNotMatch(def.stdout, /질문 2/);

    const one = run(['turns', '--last', '1']);
    assert.match(one.stdout, /질문 5/);
    assert.doesNotMatch(one.stdout, /질문 4/);
  });

  it('turns — --last에 숫자가 아닌 값이 오면 거절한다', () => {
    const r = run(['turns', '--last', '많이']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /정수/);
  });

  it('memory user — 기본은 식별자와 요약, --full이 전문을 붙인다', async () => {
    await writeProfileDocs(getGlobalDir(root), 'default', {
      docs: [{
        category: 'workflows',
        slug: 'isolated-debug',
        title: '격리 환경 디버깅',
        summary: '문제를 최소 환경으로 좁혀 확인한다.',
        body: '주변 요소를 배제하고 재현 경로만 남긴다.',
        indexEntries: ['격리 디버깅'],
      }],
    });

    const brief = run(['memory', 'user']);
    assert.equal(brief.status, 0);
    assert.match(brief.stdout, /workflows\/isolated-debug/);
    assert.match(brief.stdout, /격리 환경 디버깅/);
    assert.doesNotMatch(brief.stdout, /주변 요소를 배제/);

    const full = run(['memory', 'user', '--full']);
    assert.match(full.stdout, /주변 요소를 배제/);
  });

  it('memory project — 워크스페이스 폴더 키로 읽는다', async () => {
    const projectFolder = join(tmp, 'project');
    await fsp.mkdir(projectFolder, { recursive: true });
    await fsp.writeFile(
      join(wsDir, 'workspace.json'),
      JSON.stringify({ workspaceId: 'ws-1', workspacePath: projectFolder, sessions: [] }),
    );
    await writeProfileDocs(
      getGlobalDir(root),
      profileIdForPath(projectFolder),
      {
        docs: [{
          category: 'conventions',
          slug: 'release-flow',
          title: '발행 절차',
          summary: 'develop을 main에 병합하고 태그를 단다.',
          body: '',
          indexEntries: ['발행'],
        }],
      },
      'project',
    );

    const r = run(['memory', 'project']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /conventions\/release-flow/);
    assert.match(r.stdout, /발행 절차/);
  });

  it('memory search — 두 지식을 함께 훑는다', () => {
    const r = run(['memory', 'search', '발행 절차']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /발행 절차/);
  });

  it('memory search — 걸리는 것이 없으면 그 사실을 말한다', () => {
    const r = run(['memory', 'search', 'zzzqqq']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /없다/);
  });

  // ── memory read (0.6.0 spec/03 §3) ────────────────────────────────────
  //
  // 훅이 싣는 것은 식별자와 제목뿐이라 본문을 낼 명령이 필요하다. 식별자에 scope가 없어서
  // 양쪽을 다 찾는다 — 같은 <카테고리>/<슬러그>가 사용자 지식과 프로젝트 지식에 동시에 있을 수 있다.

  it('memory read — 식별자 하나의 전문을 낸다', () => {
    const r = run(['memory', 'read', 'workflows/isolated-debug']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /격리 환경 디버깅/);
    assert.match(r.stdout, /주변 요소를 배제/); // 본문까지
  });

  it('memory read — 양쪽에 같은 식별자가 있으면 둘 다 낸다', async () => {
    // 프로젝트 쪽 conventions/release-flow는 위에서 심었다. 같은 식별자를 사용자 쪽에도 둔다.
    await writeProfileDocs(getGlobalDir(root), 'default', {
      docs: [{
        category: 'conventions',
        slug: 'release-flow',
        title: '내 발행 습관',
        summary: '어느 저장소에서든 태그를 먼저 단다.',
        body: '사용자 지식 쪽 본문.',
        indexEntries: ['발행'],
      }],
    });

    const r = run(['memory', 'read', 'conventions/release-flow']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /내 발행 습관/);  // user
    assert.match(r.stdout, /발행 절차/);     // project
  });

  it('memory read — --scope로 한쪽만 낸다', () => {
    const r = run(['memory', 'read', 'conventions/release-flow', '--scope', 'project']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /발행 절차/);
    assert.doesNotMatch(r.stdout, /내 발행 습관/);
  });

  it('memory read — 없는 식별자는 그 사실을 말한다', () => {
    const r = run(['memory', 'read', 'conventions/nope']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /없다/);
  });

  it('memory read — 식별자가 없으면 사용법을 내고 exit 2', () => {
    const r = run(['memory', 'read']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /식별자/);
  });

  it('memory read — 읽은 것을 로그에 남긴다 (식별자와 시각만)', async () => {
    run(['memory', 'read', 'workflows/isolated-debug']);
    const raw = await fsp.readFile(join(getGlobalDir(root), 'memory-reads.jsonl'), 'utf8');
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l));
    const hit = lines.filter((l) => l.id === 'workflows/isolated-debug');
    assert.ok(hit.length >= 1);
    assert.equal(hit[0].scope, 'user');
    assert.equal(typeof hit[0].at, 'string');
    // 대화 내용은 남기지 않는다 — 필드가 셋뿐이다.
    assert.deepEqual(Object.keys(hit[0]).sort(), ['at', 'id', 'scope']);
  });

  it('memory에 알 수 없는 하위 명령이 오면 사용법을 낸다', () => {
    const r = run(['memory', 'nope']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /memory/);
  });

  // ── 쓰기 (W3) ─────────────────────────────────────────────────────────

  it('memory add — 호스트를 거쳐 제안 큐로 가고 문서는 안 바뀐다', async () => {
    const r = await runWithHost([
      'memory', 'add',
      '--scope', 'user',
      '--category', 'conventions',
      '--title', '커밋 트레일러 금지',
      '--summary', '커밋 메시지에 세션 식별자를 남기지 않는다.',
      '--body', '공개 이력에 대화 식별자가 영구히 남는다.',
    ]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /제안 큐/);

    const pending = await readProposals(getGlobalDir(root), 'default');
    assert.equal(pending.filter((p) => p.title === '커밋 트레일러 금지').length, 1);

    // 승인 전에는 읽기에 안 섞인다.
    assert.doesNotMatch(run(['memory', 'user']).stdout, /커밋 트레일러 금지/);
  });

  it('memory add — --scope가 없으면 거절하고 고르는 기준을 낸다', () => {
    const r = run([
      'memory', 'add',
      '--category', 'infra',
      '--title', '범위 누락',
      '--summary', 's',
      '--body', 'b',
    ]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--scope가 없다/);
    assert.match(r.stderr, /모든 프로젝트에 적용된다고 직접 말한 것만 user/);
  });

  it('memory add — 호스트 자리를 모르면 쓰지 않는다 (앱 밖)', async () => {
    // 쓰기는 호스트가 한다. 신원이 없으면 넘길 자리가 없고, 몰래 직접 쓰면 화면과 어긋난다.
    const before = await readProposals(getGlobalDir(root), 'default');
    const r = run([
      'memory', 'add',
      '--scope', 'user',
      '--category', 'infra',
      '--title', '앱 밖에서 쓴 것',
      '--summary', 's',
      '--body', 'b',
    ]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /세션의 자리/);
    const after = await readProposals(getGlobalDir(root), 'default');
    assert.equal(after.length, before.length);
  });

  it('memory add — 카테고리가 목록 밖이면 거절하고 목록을 낸다', () => {
    const r = run(['memory', 'add', '--scope', 'user', '--category', 'nope', '--title', 'a', '--summary', 'b', '--body', 'c']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /conventions/);
  });

  it('memory add — 빈 필드는 거절한다', () => {
    const r = run(['memory', 'add', '--scope', 'user', '--category', 'infra', '--title', 'a', '--summary', 'b']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--body/);
  });

  it('memory add — 이미 있는 제목이면 update로 안내한다', async () => {
    const r = await runWithHost([
      'memory', 'add',
      '--scope', 'user',
      '--category', 'workflows',
      '--title', '격리 환경 디버깅',
      '--summary', '다시 쓴 요약',
      '--body', '다시 쓴 본문',
    ]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /update/);
  });

  it('memory add — 대기 제안과 제목이 겹치면 withdraw로 안내한다', async () => {
    const [existing] = await readProposals(getGlobalDir(root), 'default');
    assert.ok(existing);
    const r = await runWithHost([
      'memory', 'add',
      '--scope', 'user',
      '--category', 'conventions',
      '--title', '커밋 트레일러 금지',
      '--summary', '다시 쓴 요약',
      '--body', '다시 쓴 본문',
    ]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /대기열에 같은 제목의 제안이 있다/);
    assert.ok(r.stdout.includes(`memory withdraw ${existing.id}`));
  });

  it('memory update — 없는 식별자는 거절한다', async () => {
    const r = await runWithHost(['memory', 'update', 'workflows/없는-것', '--body', 'x']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /없다/);
  });

  it('memory update — 식별자 형식이 아니면 거절한다', () => {
    const r = run(['memory', 'update', '그냥이름', '--body', 'x']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /형식/);
  });

  it('memory update — 안 준 필드는 원래 값을 잇고, 승인이 같은 자리를 덮는다', async () => {
    const globalDir = getGlobalDir(root);
    const before = (await readProfileDocs(globalDir, 'default')).find(
      (d) => d.slug === 'isolated-debug',
    )!;

    const r = await runWithHost([
      'memory', 'update', 'workflows/isolated-debug',
      '--body', '재현 경로만 남기고 나머지는 끈다.',
    ]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /고침 제안/);

    const proposal = (await readProposals(globalDir, 'default')).find(
      (p) => p.targetSlug === 'isolated-debug',
    )!;
    assert.ok(proposal, '대상을 지목한 제안이 있어야 한다');
    assert.equal(proposal.title, before.title); // 안 준 필드는 그대로
    assert.equal(proposal.body, '재현 경로만 남기고 나머지는 끈다.');

    await approveProposal(globalDir, 'default', proposal.id);
    const after = await readProfileDocs(globalDir, 'default');
    const hits = after.filter((d) => d.slug === 'isolated-debug');
    assert.equal(hits.length, 1, '같은 항목이 둘로 갈리지 않는다');
    assert.match(hits[0]!.body, /재현 경로만 남기고/);
  });

  it('memory update — 프로젝트 쪽에만 있으면 --scope 없이 그쪽을 고친다', async () => {
    const globalDir = getGlobalDir(root);
    const projectId = profileIdForPath(join(tmp, 'project'));
    await writeProfileDocs(
      globalDir,
      projectId,
      {
        docs: [{
          category: 'repos',
          slug: 'project-only',
          title: '프로젝트 전용 문서',
          summary: '원래 요약',
          body: '원래 본문',
          indexEntries: ['프로젝트 전용'],
        }],
      },
      'project',
    );

    const r = await runWithHost(['memory', 'update', 'repos/project-only', '--body', '프로젝트만 고침']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /고침 제안/);

    const projectProposals = await readProposals(globalDir, projectId, 'project');
    assert.ok(projectProposals.some((p) => p.targetSlug === 'project-only' && p.body === '프로젝트만 고침'));
    const userProposals = await readProposals(globalDir, 'default', 'user');
    assert.ok(!userProposals.some((p) => p.targetSlug === 'project-only'));
  });

  it('memory update — 양쪽에 같은 식별자가 있으면 --scope 없이 거절한다', async () => {
    const r = await runWithHost(['memory', 'update', 'conventions/release-flow', '--body', '둘 다']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /양쪽에 같은 식별자가 있다\. --scope로 고른다/);
  });

  it('memory update — 양쪽에 있어도 --scope로 고르면 그쪽을 고친다', async () => {
    const globalDir = getGlobalDir(root);
    const projectId = profileIdForPath(join(tmp, 'project'));
    const r = await runWithHost([
      'memory', 'update', 'conventions/release-flow',
      '--scope', 'project',
      '--body', '프로젝트 쪽만 고침',
    ]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /고침 제안/);

    const projectProposals = await readProposals(globalDir, projectId, 'project');
    assert.ok(projectProposals.some((p) => p.targetSlug === 'release-flow' && p.body === '프로젝트 쪽만 고침'));
  });

  // ── 대기 제안 보기와 내리기 (0.8.0 spec §3) ────────────────────────────

  it('memory pending — 양쪽 대기 제안을 쪽별로 내고 --scope로 좁힌다', () => {
    const both = run(['memory', 'pending']);
    assert.equal(both.status, 0);
    assert.match(both.stdout, /### 사용자 지식/);
    assert.match(both.stdout, /### 프로젝트 지식/);
    assert.match(both.stdout, /새 항목 {2}커밋 트레일러 금지/);
    assert.match(both.stdout, /고침 repos\/project-only {2}프로젝트 전용 문서/);

    const userOnly = run(['memory', 'pending', '--scope', 'user']);
    assert.equal(userOnly.status, 0);
    assert.match(userOnly.stdout, /### 사용자 지식/);
    assert.doesNotMatch(userOnly.stdout, /### 프로젝트 지식/);
  });

  it('memory withdraw — 한쪽에만 있으면 --scope 없이 내린다', async () => {
    const globalDir = getGlobalDir(root);
    const [target] = await readProposals(globalDir, 'default', 'user');
    assert.ok(target);

    const r = await runWithHost(['memory', 'withdraw', target.id]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /대기 제안을 내렸다/);

    const after = await readProposals(globalDir, 'default', 'user');
    assert.ok(!after.some((p) => p.id === target.id));
  });

  it('memory withdraw — 없는 제안이면 거절한다', async () => {
    const r = await runWithHost(['memory', 'withdraw', 'workflows__missing__0000000']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /없다/);
  });

  it('memory withdraw — 양쪽에 같은 식별자가 있으면 --scope 없이 거절하고, 지정하면 그쪽만 내린다', async () => {
    const globalDir = getGlobalDir(root);
    const projectId = profileIdForPath(join(tmp, 'project'));
    for (const s of ['user', 'project'] as const) {
      const addRes = await runWithHost([
        'memory', 'add',
        '--scope', s,
        '--category', 'infra',
        '--title', '양쪽 대기 제안',
        '--summary', 's',
        '--body', 'b',
      ]);
      assert.equal(addRes.status, 0);
    }

    const userList = await readProposals(globalDir, 'default', 'user');
    const same = userList.find((p) => p.title === '양쪽 대기 제안');
    assert.ok(same);

    const ambiguous = await runWithHost(['memory', 'withdraw', same.id]);
    assert.equal(ambiguous.status, 2);
    assert.match(ambiguous.stderr, /--scope로 고른다/);

    const scoped = await runWithHost(['memory', 'withdraw', same.id, '--scope', 'project']);
    assert.equal(scoped.status, 0);
    assert.match(scoped.stdout, /대기 제안을 내렸다/);

    assert.ok(!(await readProposals(globalDir, projectId, 'project')).some((p) => p.id === same.id));
    assert.ok((await readProposals(globalDir, 'default', 'user')).some((p) => p.id === same.id));
  });

  it('memory pending — 대기 제안이 없으면 그 사실을 말한다', async () => {
    const globalDir = getGlobalDir(root);
    const projectId = profileIdForPath(join(tmp, 'project'));
    for (const p of await readProposals(globalDir, 'default', 'user')) {
      assert.equal((await runWithHost(['memory', 'withdraw', p.id, '--scope', 'user'])).status, 0);
    }
    for (const p of await readProposals(globalDir, projectId, 'project')) {
      assert.equal((await runWithHost(['memory', 'withdraw', p.id, '--scope', 'project'])).status, 0);
    }

    const empty = run(['memory', 'pending']);
    assert.equal(empty.status, 0);
    assert.equal(empty.stdout.trim(), '대기 중인 제안이 없다');
  });

  // ── agent models (0.8.0 spec/06 §2) ────────────────────────────────────

  it('agent models — 기본은 세 하니스를 호스트에 요청하고 표 모양으로 낸다', async () => {
    let seenKind = '';
    let seenHarnesses: unknown;
    const fakeHandler = createModelsHandler({
      run: async (h) => {
        if (h === 'claude') {
          return {
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: 'r1',
              response: {
                models: [
                  { value: 'opus', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
                  { value: 'claude-haiku-4-5-20251001', supportsEffort: false },
                ],
              },
            },
          };
        }
        if (h === 'codex') {
          return [
            {
              result: {
                data: [
                  {
                    model: 'gpt-6.1-sol',
                    supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'ultra' }],
                  },
                ],
                nextCursor: null,
              },
            },
          ];
        }
        return 'gemini-4-hydrogen-low\tGemini 4\ngemini-pro-orchestrator-g1-pro\tOrchestrator\n';
      },
    });

    const r = await runWithHost(['agent', 'models'], {
      [HOST_AGENT_MODELS]: (req, dir) => {
        seenKind = req.kind;
        seenHarnesses = (req.payload as { harnesses?: unknown })?.harnesses;
        return fakeHandler(req, dir);
      },
    });
    assert.equal(r.status, 0);
    assert.equal(seenKind, HOST_AGENT_MODELS);
    assert.deepEqual(seenHarnesses, ['claude', 'codex', 'agy']);
    assert.match(r.stdout, /## claude\n\n {2}opus\s+low medium high\n {2}claude-haiku-4-5-20251001\s+\(effort 없음\)/);
    assert.match(r.stdout, /## codex\n\n {2}gpt-6\.1-sol\s+low ultra/);
    assert.match(r.stdout, /## agy\n\n {2}gemini-4-hydrogen\s+low\n {2}gemini-pro-orchestrator-g1-pro\s+\(effort 없음\)/);
  });

  it('agent models — --harness로 대상을 좁히고 실패한 하니스는 조회 실패로 낸다', async () => {
    let seenHarnesses: unknown;
    const fakeHandler = createModelsHandler({
      run: async (h) => {
        if (h === 'agy') throw new Error('15초 시간 초과');
        return {
          models: [{ value: 'opus', supportsEffort: true, supportedEffortLevels: ['high'] }],
        };
      },
    });

    const r = await runWithHost(['agent', 'models', '--harness', 'claude,agy'], {
      [HOST_AGENT_MODELS]: (req, dir) => {
        seenHarnesses = (req.payload as { harnesses?: unknown })?.harnesses;
        return fakeHandler(req, dir);
      },
    });
    assert.equal(r.status, 0);
    assert.deepEqual(seenHarnesses, ['claude', 'agy']);
    assert.match(r.stdout, /## claude/);
    assert.doesNotMatch(r.stdout, /## codex/);
    assert.match(r.stdout, /## agy\n\n {2}조회 실패 \(15초 시간 초과\)/);
  });

  it('agent models — --harness에 값이 없으면 exit 2로 거절한다', () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AGENTBRIDGE_WS_DIR: wsDir,
      AGENTBRIDGE_WS_SESSION: HOST_SESSION,
    };
    const r = spawnSync('node', [cliPath, 'agent', 'models', '--harness'], { encoding: 'utf8', env });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--harness에 값이 없다/);
  });

  // ── agent start --model · --effort (0.8.0 spec/06 §3-1) ─────────────────

  it('agent start — 단일 하니스에 단일 값과 짝 형식을 모두 받아 호스트 payload에 짝지어 보낸다', async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const handlers: HostRequestHandlers = {
      [HOST_AGENT_START]: (req) => {
        payloads.push(req.payload as Record<string, unknown>);
        return 'ok';
      },
    };

    const single = await runWithHost(
      ['agent', 'start', '--prompt', '작업', '--model', 'opus', '--effort', 'high'],
      handlers,
    );
    assert.equal(single.status, 0);
    assert.deepEqual(payloads[0], {
      prompt: '작업',
      harnesses: ['claude'],
      isolate: false,
      models: { claude: 'opus' },
      efforts: { claude: 'high' },
    });

    const pairedSingle = await runWithHost(
      [
        'agent',
        'start',
        '--prompt',
        '작업',
        '--harness',
        'codex',
        '--model',
        'codex=gpt-6-luna',
        '--effort',
        'codex=xhigh',
      ],
      handlers,
    );
    assert.equal(pairedSingle.status, 0);
    assert.deepEqual(payloads[1], {
      prompt: '작업',
      harnesses: ['codex'],
      isolate: false,
      models: { codex: 'gpt-6-luna' },
      efforts: { codex: 'xhigh' },
    });

    const multiSame = await runWithHost(
      [
        'agent',
        'start',
        '--prompt',
        '작업',
        '--harness',
        'claude,claude',
        '--model',
        'claude=opus',
        '--effort',
        'claude=high',
      ],
      handlers,
    );
    assert.equal(multiSame.status, 0);
    assert.deepEqual(payloads[2], {
      prompt: '작업',
      harnesses: ['claude', 'claude'],
      isolate: false,
      models: { claude: 'opus' },
      efforts: { claude: 'high' },
    });

    // 같은 하니스 둘은 하니스가 하나인 것이다 — 짝 없이 단일 값을 받는다.
    const sameSingle = await runWithHost(
      ['agent', 'start', '--prompt', '작업', '--harness', 'claude,claude', '--model', 'opus', '--effort', 'high'],
      handlers,
    );
    assert.equal(sameSingle.status, 0);
    assert.deepEqual(payloads[3], payloads[2]);
  });

  it('agent start — CLI 형식 거절 세 경우를 exit 2로 거절한다', () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AGENTBRIDGE_WS_DIR: wsDir,
      AGENTBRIDGE_WS_SESSION: HOST_SESSION,
    };
    const runStart = (args: string[]) =>
      spawnSync('node', [cliPath, 'agent', 'start', '--prompt', '작업', ...args], {
        encoding: 'utf8',
        env,
      });

    // 1) 하니스가 여럿인데 짝 없이 값 하나
    const multiNoPair = runStart(['--harness', 'claude,codex', '--model', 'opus', '--effort', 'high']);
    assert.equal(multiNoPair.status, 2);
    assert.match(
      multiNoPair.stderr,
      /하니스가 여럿이면 --model과 --effort는 claude=opus처럼 하니스별로 쓴다/,
    );

    // 2) 짝에 --harness에 없는 하니스 (--model · --effort 둘 다)
    const missingModelHarness = runStart(['--harness', 'claude', '--model', 'codex=gpt-6-luna']);
    assert.equal(missingModelHarness.status, 2);
    assert.match(missingModelHarness.stderr, /--model의 codex는 --harness에 없다/);

    const missingEffortHarness = runStart([
      '--harness',
      'claude',
      '--model',
      'opus',
      '--effort',
      'codex=high',
    ]);
    assert.equal(missingEffortHarness.status, 2);
    assert.match(missingEffortHarness.stderr, /--effort의 codex는 --harness에 없다/);

    // 3) effort는 있는데 모델이 없다
    const effortOnlySingle = runStart(['--effort', 'high']);
    assert.equal(effortOnlySingle.status, 2);
    assert.match(effortOnlySingle.stderr, /claude에 --effort만 있다\. --model과 함께 쓴다/);

    const effortOnlyMulti = runStart([
      '--harness',
      'claude,codex',
      '--model',
      'claude=opus',
      '--effort',
      'claude=high,codex=xhigh',
    ]);
    assert.equal(effortOnlyMulti.status, 2);
    assert.match(effortOnlyMulti.stderr, /codex에 --effort만 있다\. --model과 함께 쓴다/);
  });
});

// 설치 배관 — 헬퍼와 CLI가 같은 함수를 타되 파일명과 버전 마커만 다르다.
describe('agent CLI — canonical 설치 (0.5.0 W1)', () => {
  let tmp: string;
  let root: string;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(join(tmpdir(), 'ab-bininstall-'));
    root = join(tmp, 'storage');
  });

  afterEach(async () => {
    if (tmp) await fsp.rm(tmp, { recursive: true, force: true });
  });

  async function bundled(version: string): Promise<string> {
    const p = join(tmp, `cli-${version}.js`);
    await fsp.writeFile(p, `#!/usr/bin/env node\n// @agentbridge-cli-version ${version}\n`);
    return p;
  }

  it('CLI의 canonical 경로는 <루트>/bin/agentbridge.js다', () => {
    assert.equal(getCanonicalBinPath(root, 'cli'), join(root, 'bin', 'agentbridge.js'));
    assert.equal(getCanonicalBinPath(root, 'helper'), join(root, 'bin', 'agentbridge-memory.js'));
  });

  it('미설치면 설치한다', async () => {
    const canonical = await installBinToCanonicalPath(await bundled('0.5.0'), root, 'cli');
    assert.equal(canonical, join(root, 'bin', 'agentbridge.js'));
    assert.match(await fsp.readFile(canonical, 'utf8'), /@agentbridge-cli-version 0\.5\.0/);
  });

  it('설치본이 더 새것이면 건드리지 않는다', async () => {
    await installBinToCanonicalPath(await bundled('0.6.0'), root, 'cli');
    const canonical = await installBinToCanonicalPath(await bundled('0.5.0'), root, 'cli');
    assert.match(await fsp.readFile(canonical, 'utf8'), /@agentbridge-cli-version 0\.6\.0/);
  });

  it('같은 버전인데 내용이 다르면 갱신한다', async () => {
    await installBinToCanonicalPath(await bundled('0.5.0'), root, 'cli');
    const changed = join(tmp, 'changed.js');
    await fsp.writeFile(changed, `#!/usr/bin/env node\n// @agentbridge-cli-version 0.5.0\n// 다름\n`);
    const canonical = await installBinToCanonicalPath(changed, root, 'cli');
    assert.match(await fsp.readFile(canonical, 'utf8'), /다름/);
  });
});
