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
} from '@agentbridge/core';

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
  async function runWithHost(args: string[]) {
    const watcher = startHostRequestHandler({
      storageRoot: root,
      handlers: {
        [HOST_MEMORY_WRITE]: (req) => applyMemoryWrite(root, parseMemoryWriteRequest(req.payload)),
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

  it('memory에 알 수 없는 하위 명령이 오면 사용법을 낸다', () => {
    const r = run(['memory', 'nope']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /memory/);
  });

  // ── 쓰기 (W3) ─────────────────────────────────────────────────────────

  it('memory add — 호스트를 거쳐 제안 큐로 가고 문서는 안 바뀐다', async () => {
    const r = await runWithHost([
      'memory', 'add',
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

  it('memory add — 호스트 자리를 모르면 쓰지 않는다 (앱 밖)', async () => {
    // 쓰기는 호스트가 한다. 신원이 없으면 넘길 자리가 없고, 몰래 직접 쓰면 화면과 어긋난다.
    const before = await readProposals(getGlobalDir(root), 'default');
    const r = run([
      'memory', 'add',
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
    const r = run(['memory', 'add', '--category', 'nope', '--title', 'a', '--summary', 'b', '--body', 'c']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /conventions/);
  });

  it('memory add — 빈 필드는 거절한다', () => {
    const r = run(['memory', 'add', '--category', 'infra', '--title', 'a', '--summary', 'b']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--body/);
  });

  it('memory add — 이미 있는 제목이면 update로 안내한다', async () => {
    const r = await runWithHost([
      'memory', 'add',
      '--category', 'workflows',
      '--title', '격리 환경 디버깅',
      '--summary', '다시 쓴 요약',
      '--body', '다시 쓴 본문',
    ]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /update/);
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
