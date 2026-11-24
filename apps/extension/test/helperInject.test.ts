import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  writeProfileDocs,
  setDocPinned,
  resolveProjectProfileId,
  getGlobalDir,
  TURN_SIGNAL_FILENAME,
} from '@agentbridge/core';

// 훅 주입 (0.6.0 spec/03 §1·§2).
//
// 0.5.0 B-4에서 훅은 고정 지시문 하나였다. 이제 매 턴 프롬프트를 쿼리로 장기 기억을 매칭해
// 식별자와 제목을 싣고, 다섯 턴마다 기록을 명령한다. 본문은 여전히 안 민다 — `memory read` 몫이다.
describe('helper inject — 매칭 주입 (0.6.0 spec/03 §1)', () => {
  let tmp: string;
  let bundlePath: string;
  let userData: string;

  before(async function () {
    this.timeout(30000); // esbuild 번들 빌드 여유
    tmp = await fsp.mkdtemp(join(tmpdir(), 'ab-helper-'));
    userData = join(tmp, 'userdata');
    // 헬퍼는 <저장소 루트>/bin/에 산다. 자기 위치에서 루트를 계산하므로 배치를 실제와 맞춘다.
    await fsp.mkdir(join(userData, 'bin'), { recursive: true });
    bundlePath = join(userData, 'bin', 'agentbridge-memory.js');

    // 실제 번들 스크립트로 self-contained 헬퍼 생성(번들 정합성까지 검증).
    // ts-node(CommonJS)는 await import(file://)를 require로 다운레벨해 .mjs를 못 부른다 → 자식 프로세스로 spawn.
    // 테스트 cwd = apps/extension → ../../ = repo root → scripts/bundle-helper.mjs
    const bundlerScript = join(process.cwd(), '..', '..', 'scripts', 'bundle-helper.mjs');
    execFileSync('node', [bundlerScript, bundlePath], { encoding: 'utf8' });

    await writeProfileDocs(getGlobalDir(userData), 'default', {
      docs: [
        {
          category: 'conventions',
          slug: 'deploy-flow',
          title: 'Deployment workflow',
          summary: 'Use the release branch and tag before publishing to production.',
          body: 'Run the release script then tag.',
          indexEntries: ['deployment workflow', 'deploy'],
        },
        {
          category: 'role',
          slug: 'solo',
          title: 'Solo developer',
          summary: 'One person builds and ships everything.',
          body: 'No team review step.',
          indexEntries: ['solo'],
        },
      ],
    });

    // workspace 디렉토리(IR/turns 없음 — 주입만 격리 검증).
    await fsp.mkdir(join(userData, 'workspaces', 'ws-1'), { recursive: true });
  });

  after(async () => {
    if (tmp) await fsp.rm(tmp, { recursive: true, force: true });
  });

  function run(stdin: string, session?: string): any {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AGENTBRIDGE_WS_DIR: join(userData, 'workspaces', 'ws-1'),
    };
    if (session) env.AGENTBRIDGE_WS_SESSION = session;
    const out = execFileSync(
      'node',
      [bundlePath, 'inject', '--agent', 'claude', '--event', 'UserPromptSubmit'],
      { input: stdin, encoding: 'utf8', env },
    );
    return JSON.parse(out);
  }

  function ctxFor(prompt: string, session?: string): string {
    return run(JSON.stringify({ prompt }), session).hookSpecificOutput.additionalContext as string;
  }

  it('본문은 여전히 안 민다 — 식별자와 제목뿐이다', () => {
    const ctx = ctxFor('how do I handle deployment to production?');
    assert.match(ctx, /conventions\/deploy-flow/);
    assert.match(ctx, /Deployment workflow/);
    assert.doesNotMatch(ctx, /Run the release script/); // 본문
    assert.doesNotMatch(ctx, /Use the release branch and tag/); // 요약도 아니다
  });

  it('걸린 건수를 말하고 읽는 명령을 준다', () => {
    const ctx = ctxFor('how do I handle deployment to production?');
    assert.match(ctx, /memory read <id>/);
    assert.match(ctx, /1 piece of long-term memory overlaps/);
  });

  // 매칭은 단어가 겹친다는 것뿐이다. 게이트를 더 조여 정탐까지 버리는 대신 모델이 제목을 보고
  // 버리게 한다 — 어휘 매칭으로 의미를 가르는 데는 한계가 있다.
  it('무관하면 무시하라는 조건을 함께 싣는다', () => {
    const ctx = ctxFor('how do I handle deployment to production?');
    assert.match(ctx, /not by judgment/);
    assert.match(ctx, /ignore it and do not read it/);
  });

  // 슬러그가 제목을 slugify한 것이라(memory add 경로) 이어 붙이면 같은 말이 두 번 나온다.
  it('슬러그가 제목을 담고 있으면 제목을 덧붙이지 않는다', async () => {
    await writeProfileDocs(getGlobalDir(userData), 'default', {
      docs: [{
        category: 'infra',
        slug: 'keychain-토큰-보관-1abc23',
        title: 'Keychain 토큰 보관',
        summary: '자격증명은 키체인에서 읽는다.',
        body: '파일 폴백은 그다음이다.',
        indexEntries: ['keychain', '토큰'],
      }],
    });
    const ctx = ctxFor('keychain 토큰 어디서 읽지');
    assert.match(ctx, /- infra\/keychain-토큰-보관-1abc23$/m);
    assert.doesNotMatch(ctx, /keychain-토큰-보관-1abc23 — /);
  });

  it('슬러그와 제목이 갈리면 제목을 붙인다', () => {
    const ctx = ctxFor('how do I handle deployment to production?');
    assert.match(ctx, /- conventions\/deploy-flow — Deployment workflow/);
  });

  it('무관한 프롬프트에는 1-1 소절이 제목째 빠진다', () => {
    const ctx = ctxFor('what time is it right now');
    assert.doesNotMatch(ctx, /### 1-1/);
    assert.doesNotMatch(ctx, /conventions\/deploy-flow/);
    // 상시 안내는 그대로 나간다.
    assert.match(ctx, /### 1-2/);
  });

  it('프롬프트에 따라 주입이 달라진다', () => {
    assert.notEqual(ctxFor('deployment workflow'), ctxFor('what time is it right now'));
  });

  it('부를 명령과 조건을 싣는다', () => {
    const ctx = ctxFor('x');
    // 0.10.0 spec/02 §1 — 할지 말지를 정하는 조건마다 쓸 명령만 싣는다.
    for (const cmd of [
      'context',
      'turns --last',
      'memory search',
      'memory project',
      'memory add',
      'memory update',
      'agent start',
      'agent check --wait',
      'status',
    ]) {
      assert.ok(ctx.includes(cmd), `지시문에 ${cmd}가 있어야 한다`);
    }
    // 사용자 명령은 싣지 않는다.
    assert.doesNotMatch(ctx, /uninstall/);
  });

  // 0.10.0 spec/02 §2 — 명령 전체 목록과 제안 회수 절차는 스킬로 옮겼다. 훅은 스킬을 가리킨다.
  it('3. Commands는 전체 목록이 스킬에 있다고 가리키고, 옮긴 절은 싣지 않는다', () => {
    const ctx = ctxFor('x');
    assert.match(ctx, /When to run which is below\. Arguments and procedures are in the `agentbridge` skill\./);
    assert.match(ctx, /The full list, with arguments, is\nin the `agentbridge` skill\. If a command fails, run `status`/);
    assert.doesNotMatch(ctx, /memory withdraw/);
    assert.doesNotMatch(ctx, /What you are looking at/);
    assert.doesNotMatch(ctx, /### 2-3/);
    assert.doesNotMatch(ctx, /Reading and recording\./);
  });

  it('실행 경로가 박히고, 가장 빡빡한 한도(codex 10,000바이트) 아래다', () => {
    const ctx = ctxFor('deployment workflow and release tagging and production rollout');
    assert.ok(ctx.includes(join(userData, 'bin', 'agentbridge.js')), 'CLI 절대경로가 박혀야 한다');
    const bytes = Buffer.byteLength(ctx, 'utf8');
    assert.ok(bytes < 9000, `주입이 너무 크다: ${bytes}`);
  });

  // 회귀 방지: esbuild가 주석을 제거해 `@agentbridge-helper-version` 마커가 사라지면
  // hookInstaller 버전비교가 번들을 0.0.0으로 읽어 기존 설치본을 영영 갱신하지 않는다(주입 미동작).
  // bundleBin이 번들 출력에 마커를 다시 주입해야 한다.
  it('번들 출력에 헬퍼 버전 마커가 남아 install 버전비교가 동작한다', async () => {
    const src = await fsp.readFile(bundlePath, 'utf8');
    assert.match(src, /@agentbridge-helper-version \d+\.\d+\.\d+/);
  });
});

describe('helper inject — 다섯 턴 제안 (0.6.0 spec/03 §2)', () => {
  let tmp: string;
  let bundlePath: string;
  let userData: string;
  let wsDir: string;

  before(async function () {
    this.timeout(30000);
    tmp = await fsp.mkdtemp(join(tmpdir(), 'ab-proposal-'));
    userData = join(tmp, 'userdata');
    await fsp.mkdir(join(userData, 'bin'), { recursive: true });
    bundlePath = join(userData, 'bin', 'agentbridge-memory.js');
    const bundlerScript = join(process.cwd(), '..', '..', 'scripts', 'bundle-helper.mjs');
    execFileSync('node', [bundlerScript, bundlePath], { encoding: 'utf8' });
    wsDir = join(userData, 'workspaces', 'ws-1');
    await fsp.mkdir(wsDir, { recursive: true });
  });

  after(async () => {
    if (tmp) await fsp.rm(tmp, { recursive: true, force: true });
  });

  function fire(event: string, stdin: string, session: string, agent = 'claude'): string {
    const out = execFileSync('node', [bundlePath, 'inject', '--agent', agent, '--event', event], {
      input: stdin,
      encoding: 'utf8',
      env: { ...process.env, AGENTBRIDGE_WS_DIR: wsDir, AGENTBRIDGE_WS_SESSION: session },
    });
    return out;
  }

  function injectCtx(session: string): string {
    return JSON.parse(fire('UserPromptSubmit', JSON.stringify({ prompt: 'hi' }), session))
      .hookSpecificOutput.additionalContext as string;
  }

  async function count(session: string): Promise<number> {
    const raw = await fsp.readFile(join(wsDir, 'sessions', session, 'turn-count.json'), 'utf8');
    return JSON.parse(raw).count;
  }

  it('Stop이 턴을 센다', async () => {
    const s = 'sess-count';
    for (let i = 0; i < 3; i++) fire('Stop', JSON.stringify({ session_id: 'x' }), s);
    assert.equal(await count(s), 3);
  });

  it('StopFailure는 세지 않는다 — 끊긴 턴에는 돌아볼 것이 없다', async () => {
    const s = 'sess-failure';
    fire('Stop', JSON.stringify({ session_id: 'x' }), s);
    fire('StopFailure', JSON.stringify({ session_id: 'x' }), s);
    assert.equal(await count(s), 1);
  });

  it('네 턴에는 안 붙고 다섯 턴 뒤에 붙는다', async () => {
    const s = 'sess-five';
    for (let i = 0; i < 4; i++) fire('Stop', JSON.stringify({ session_id: 'x' }), s);
    assert.doesNotMatch(injectCtx(s), /last five turns/);

    fire('Stop', JSON.stringify({ session_id: 'x' }), s);
    const ctx = injectCtx(s);
    assert.match(ctx, /### 1-1/);
    assert.match(ctx, /last five turns/);
    assert.match(ctx, /memory search/);
  });

  it('여섯 턴째에는 다시 빠진다', async () => {
    const s = 'sess-six';
    for (let i = 0; i < 6; i++) fire('Stop', JSON.stringify({ session_id: 'x' }), s);
    assert.doesNotMatch(injectCtx(s), /last five turns/);
  });

  // 0.8.0 spec/03 §1 — 기록의 자리와 문턱은 다섯 턴 블록이 아니라 매 턴 붙는다.
  it('기록 문턱(1-3)은 다섯 턴과 상관없이 매 턴 붙는다', async () => {
    const s = 'sess-bar';
    const first = injectCtx(s);
    assert.match(first, /### 1-3\. Recording/);
    assert.match(first, /Do not write there/);
    assert.match(first, /Recording nothing is the default/);
    // 0.10.0 spec/02 §3 — 판단 순서의 두 질문만 싣고, 전문은 스킬을 읽게 한다.
    const set = first.indexOf('1. The user set it for the future');
    const general = first.indexOf('2. Otherwise: if this entry were deleted, would a capable model work');
    assert.ok(set > 0 && general > set);
    assert.match(first, /would they have said it even if you had done\n   the work right\? Pointing out your slip is not this, "from now on"\n   included\./);
    assert.match(first, /it is general knowledge — do not record it,\n   not even the second time\./);
    assert.match(first, /Before `memory add` or `memory update`, read the skill's\n`Recording something` — the rest of the bar is there\./);
    // 지적에 붙은 "앞으로"가 예외로 다시 읽히지 않게, 옛 문턱의 두 문장은 빠진다.
    assert.doesNotMatch(first, /or when the user says it applies from now on/);
    assert.doesNotMatch(first, /- what a capable model already does unprompted/);
    for (let i = 0; i < 5; i++) fire('Stop', JSON.stringify({ session_id: 'x' }), s);
    const fifth = injectCtx(s);
    assert.match(fifth, /### 1-3\. Recording/);
    assert.match(fifth, /against the bar in 1-3/);
    // 근거 판단과 search·add·update 절차는 스킬 몫이다.
    assert.doesNotMatch(fifth, /it has to come from the user/);
  });
});

describe('helper inject — agy 중복 주입 방지 (0.6.0 spec/03 §1-2)', () => {
  let tmp: string;
  let bundlePath: string;
  let userData: string;
  let wsDir: string;
  let transcript: string;

  before(async function () {
    this.timeout(30000);
    tmp = await fsp.mkdtemp(join(tmpdir(), 'ab-agyinject-'));
    userData = join(tmp, 'userdata');
    await fsp.mkdir(join(userData, 'bin'), { recursive: true });
    bundlePath = join(userData, 'bin', 'agentbridge-memory.js');
    const bundlerScript = join(process.cwd(), '..', '..', 'scripts', 'bundle-helper.mjs');
    execFileSync('node', [bundlerScript, bundlePath], { encoding: 'utf8' });
    wsDir = join(userData, 'workspaces', 'ws-1');
    await fsp.mkdir(wsDir, { recursive: true });

    await writeProfileDocs(getGlobalDir(userData), 'default', {
      docs: [{
        category: 'conventions',
        slug: 'deploy-flow',
        title: 'Deployment workflow',
        summary: 'Tag before publishing.',
        body: 'Run the release script then tag.',
        indexEntries: ['deployment workflow', 'deploy'],
      }],
    });

    transcript = join(tmp, 'transcript.jsonl');
    await fsp.writeFile(
      transcript,
      JSON.stringify({
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        content: '<USER_REQUEST> how do I handle deployment </USER_REQUEST>',
      }) + '\n',
      'utf8',
    );
  });

  after(async () => {
    if (tmp) await fsp.rm(tmp, { recursive: true, force: true });
  });

  function fire(payload: Record<string, unknown>): any {
    const out = execFileSync(
      'node',
      [bundlePath, 'inject', '--agent', 'agy', '--event', 'PreInvocation'],
      {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        env: { ...process.env, AGENTBRIDGE_WS_DIR: wsDir },
      },
    );
    return JSON.parse(out);
  }

  it('첫 모델 호출(invocationNum 0)에만 주입한다', () => {
    const res = fire({ conversationId: 'c1', invocationNum: 0, transcriptPath: transcript });
    assert.equal(res.injectSteps.length, 1);
    assert.match(res.injectSteps[0].ephemeralMessage, /AgentBridge does two things/);
  });

  it('같은 턴의 두 번째 호출부터는 아무것도 안 낸다', () => {
    for (const n of [1, 2, 7]) {
      const res = fire({ conversationId: 'c1', invocationNum: n, transcriptPath: transcript });
      assert.deepEqual(res, {}, `invocationNum ${n}에는 주입이 없어야 한다`);
    }
  });

  it('쿼리를 transcript의 마지막 사용자 발화에서 얻는다 — stdin에는 없다', () => {
    const res = fire({ conversationId: 'c1', invocationNum: 0, transcriptPath: transcript });
    assert.match(res.injectSteps[0].ephemeralMessage, /conventions\/deploy-flow/);
  });

  it('invocationNum을 못 읽으면 막지 않는다 — 판정 불가로 맥락을 버리지 않는다', () => {
    const res = fire({ conversationId: 'c1', transcriptPath: transcript });
    assert.equal(res.injectSteps.length, 1);
  });
});

describe('helper inject — 턴 시작 신호(0.5.0 W1)', () => {
  let tmp: string;
  let bundlePath: string;
  let userData: string;

  before(async function () {
    this.timeout(30000); // esbuild 번들 빌드 여유
    tmp = await fsp.mkdtemp(join(tmpdir(), 'ab-turnstart-'));
    userData = join(tmp, 'userdata');
    await fsp.mkdir(join(userData, 'bin'), { recursive: true });
    bundlePath = join(userData, 'bin', 'agentbridge-memory.js');
    const bundlerScript = join(process.cwd(), '..', '..', 'scripts', 'bundle-helper.mjs');
    execFileSync('node', [bundlerScript, bundlePath], { encoding: 'utf8' });
    await fsp.mkdir(join(userData, 'workspaces', 'ws-1'), { recursive: true });
    await fsp.mkdir(join(userData, 'workspaces', 'ws-notoken'), { recursive: true });
  });

  after(async () => {
    if (tmp) await fsp.rm(tmp, { recursive: true, force: true });
  });

  function run(agent: string, event: string, stdin: string, token?: string, ws = 'ws-1'): void {
    execFileSync('node', [bundlePath, 'inject', '--agent', agent, '--event', event], {
      input: stdin,
      encoding: 'utf8',
      env: {
        ...process.env,
        AGENTBRIDGE_WS_DIR: join(userData, 'workspaces', ws),
        ...(token ? { AGENTBRIDGE_WS_SESSION: token } : {}),
      },
    });
  }

  async function readTurnStart(token: string, ws = 'ws-1'): Promise<any> {
    const raw = await fsp.readFile(
      join(userData, 'workspaces', ws, 'sessions', token, 'turn-start.json'),
      'utf8',
    );
    return JSON.parse(raw);
  }

  it('claude UserPromptSubmit — turn-start.json을 쓴다', async () => {
    const token = 'sess-claude-start';
    run('claude', 'UserPromptSubmit', JSON.stringify({ prompt: 'hi', session_id: 's-claude' }), token);
    const s = await readTurnStart(token);
    assert.equal(s.agent, 'claude');
    assert.equal(s.event, 'UserPromptSubmit');
    assert.equal(typeof s.at, 'number');
  });

  it('codex UserPromptSubmit — turn-start.json을 쓴다', async () => {
    const token = 'sess-codex-start';
    run('codex', 'UserPromptSubmit', JSON.stringify({ prompt: 'hi', session_id: 's-codex' }), token);
    const s = await readTurnStart(token);
    assert.equal(s.agent, 'codex');
    assert.equal(s.event, 'UserPromptSubmit');
    assert.equal(s.sessionId, 's-codex');
    assert.equal(typeof s.at, 'number');
  });

  it('agy PreInvocation — turn-start.json을 쓴다', async () => {
    const token = 'sess-agy-start';
    run('agy', 'PreInvocation', JSON.stringify({ conversationId: 'c-agy' }), token);
    const s = await readTurnStart(token);
    assert.equal(s.agent, 'agy');
    assert.equal(s.event, 'PreInvocation');
    assert.equal(s.sessionId, 'c-agy');
    assert.equal(typeof s.at, 'number');
  });

  // 주입을 건너뛰는 호출에서도 신호는 남아야 한다. 호스트의 턴 판정이 이 파일을 보기 때문이다.
  it('agy 두 번째 호출도 turn-start.json은 갱신한다', async () => {
    const token = 'sess-agy-repeat';
    run('agy', 'PreInvocation', JSON.stringify({ conversationId: 'c-agy', invocationNum: 2 }), token);
    const s = await readTurnStart(token);
    assert.equal(s.agent, 'agy');
    assert.equal(typeof s.at, 'number');
  });

  it('토큰 env가 없으면 무동작 — 세션 폴더 자체가 안 생긴다', async () => {
    run('claude', 'UserPromptSubmit', JSON.stringify({ prompt: 'hi' }), undefined, 'ws-notoken');
    const sessionsDir = join(userData, 'workspaces', 'ws-notoken', 'sessions');
    await assert.rejects(() => fsp.stat(sessionsDir));
  });
});

describe('helper inject — 첫 턴 핀 주입 (0.8.0 spec/05 §2-2)', () => {
  let tmp: string;
  let bundlePath: string;
  let userData: string;
  let wsDir: string;
  let projDir: string;
  let projectProfileId: string;

  before(async function () {
    this.timeout(30000);
    tmp = await fsp.mkdtemp(join(tmpdir(), 'ab-pins-'));
    userData = join(tmp, 'userdata');
    await fsp.mkdir(join(userData, 'bin'), { recursive: true });
    bundlePath = join(userData, 'bin', 'agentbridge-memory.js');
    const bundlerScript = join(process.cwd(), '..', '..', 'scripts', 'bundle-helper.mjs');
    execFileSync('node', [bundlerScript, bundlePath], { encoding: 'utf8' });

    wsDir = join(userData, 'workspaces', 'ws-1');
    projDir = join(tmp, 'repo-plain');
    await fsp.mkdir(wsDir, { recursive: true });
    await fsp.mkdir(projDir, { recursive: true });
    await fsp.writeFile(
      join(wsDir, 'workspace.json'),
      JSON.stringify({ workspacePath: projDir }),
      'utf8',
    );
    projectProfileId = await resolveProjectProfileId(projDir);
  });

  after(async () => {
    if (tmp) await fsp.rm(tmp, { recursive: true, force: true });
  });

  function fire(
    event: string,
    payload: Record<string, unknown>,
    session: string,
    agent = 'claude',
  ): any {
    const out = execFileSync('node', [bundlePath, 'inject', '--agent', agent, '--event', event], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: { ...process.env, AGENTBRIDGE_WS_DIR: wsDir, AGENTBRIDGE_WS_SESSION: session },
    });
    return JSON.parse(out);
  }

  function injectCtx(prompt: string, session: string): string {
    return fire('UserPromptSubmit', { prompt }, session).hookSpecificOutput
      .additionalContext as string;
  }

  async function clearGlobal(): Promise<void> {
    await fsp.rm(getGlobalDir(userData), { recursive: true, force: true });
  }

  it('첫 주입에 사용자·프로젝트 핀 블록을 1-1 바로 앞에 싣고, 둘째 주입에는 안 싣는다', async () => {
    await clearGlobal();
    const globalDir = getGlobalDir(userData);
    await writeProfileDocs(globalDir, 'default', {
      docs: [
        {
          category: 'conventions',
          slug: 'pinned-style',
          title: 'Use concise replies',
          summary: 'Keep answers brief.',
          body: 'Detailed user rule body.',
          indexEntries: ['reply', 'concise'],
          tags: ['pinned'],
        },
        {
          category: 'workflows',
          slug: 'deploy-flow',
          title: 'Deployment workflow',
          summary: 'Tag before push.',
          body: 'Release body.',
          indexEntries: ['deployment', 'release'],
        },
      ],
    });
    await writeProfileDocs(
      globalDir,
      projectProfileId,
      {
        docs: [
          {
            category: 'infra',
            slug: 'never-force-push-abc12',
            title: 'Never force push',
            summary: 'Avoid force push.',
            body: 'Project rule body.',
            indexEntries: ['push'],
            tags: ['pinned'],
          },
        ],
      },
      'project',
    );

    const first = injectCtx('deployment release', 'sess-pin-1');
    assert.match(first, /The user pinned these\. They hold for every task in this session\./);
    assert.match(first, /- conventions\/pinned-style — Use concise replies/);
    // 슬러그가 제목을 담고 있으면 제목을 중복해서 붙이지 않는다.
    assert.match(first, /^- infra\/never-force-push-abc12$/m);
    assert.doesNotMatch(first, /Detailed user rule body/);
    assert.doesNotMatch(first, /Project rule body/);

    // 1-1. Do this turn 바로 앞에 놓인다.
    const pinPos = first.indexOf('The user pinned these.');
    const turnPos = first.indexOf('### 1-1. Do this turn');
    assert.ok(pinPos > first.indexOf('## 1. Context') && pinPos < turnPos);

    // 둘째 주입에는 핀 블록이 빠진다.
    const second = injectCtx('deployment release', 'sess-pin-1');
    assert.doesNotMatch(second, /The user pinned these\./);
    assert.doesNotMatch(second, /conventions\/pinned-style/);
  });

  it('첫 턴이 Stop 없이 끝난 뒤 다음 주입에도 핀 블록이 없다', async () => {
    await clearGlobal();
    await writeProfileDocs(getGlobalDir(userData), 'default', {
      docs: [
        {
          category: 'conventions',
          slug: 'pinned-rule',
          title: 'Pinned rule',
          summary: 'Summary.',
          body: 'Body.',
          indexEntries: ['pinned'],
          tags: ['pinned'],
        },
      ],
    });

    const first = injectCtx('hello', 'sess-no-stop');
    assert.match(first, /The user pinned these\./);

    // Stop 없이 바로 다음 입력 또는 StopFailure 뒤 다음 입력
    fire('StopFailure', { session_id: 'x' }, 'sess-no-stop');
    const second = injectCtx('next prompt', 'sess-no-stop');
    assert.doesNotMatch(second, /The user pinned these\./);
  });

  it('첫 주입 때 핀이 없었고 그 뒤 핀을 꽂아도 같은 세션에는 안 실린다', async () => {
    await clearGlobal();
    const globalDir = getGlobalDir(userData);
    const { written } = await writeProfileDocs(globalDir, 'default', {
      docs: [
        {
          category: 'conventions',
          slug: 'later-pin',
          title: 'Later pinned rule',
          summary: 'Summary.',
          body: 'Body.',
          indexEntries: ['later'],
        },
      ],
    });

    const first = injectCtx('hello', 'sess-late-pin');
    assert.doesNotMatch(first, /The user pinned these\./);

    await setDocPinned(globalDir, 'default', 'user', written[0]!, true);

    const sameSessionNext = injectCtx('hello again', 'sess-late-pin');
    assert.doesNotMatch(sameSessionNext, /The user pinned these\./);

    const freshSession = injectCtx('hello fresh', 'sess-fresh-after-pin');
    assert.match(freshSession, /The user pinned these\./);
    assert.match(freshSession, /- conventions\/later-pin — Later pinned rule/);
  });

  it('핀 문서는 단어 겹침 매칭 블록에 나오지 않는다', async () => {
    await clearGlobal();
    await writeProfileDocs(getGlobalDir(userData), 'default', {
      docs: [
        {
          category: 'conventions',
          slug: 'pinned-deploy',
          title: 'Pinned deployment rule',
          summary: 'Always check deployment checklist.',
          body: 'Deployment checklist details.',
          indexEntries: ['deployment', 'checklist'],
          tags: ['pinned'],
        },
        {
          category: 'workflows',
          slug: 'normal-deploy',
          title: 'Normal deployment guide',
          summary: 'Standard deployment steps.',
          body: 'Deployment guide details.',
          indexEntries: ['deployment', 'steps'],
        },
      ],
    });

    const first = injectCtx('deployment checklist steps', 'sess-no-overlap');
    // 핀 문서는 핀 블록에만 나오고 1-1 매칭 블록에는 나오지 않는다.
    const [beforeTurn, afterTurn] = first.split('### 1-1. Do this turn');
    assert.match(beforeTurn!, /conventions\/pinned-deploy/);
    assert.ok(afterTurn, '1-1 매칭 블록이 있어야 한다');
    assert.match(afterTurn, /workflows\/normal-deploy/);
    assert.doesNotMatch(afterTurn, /conventions\/pinned-deploy/);

    // 둘째 턴에도 매칭 블록에서 빠진다.
    const second = injectCtx('deployment checklist steps', 'sess-no-overlap');
    assert.doesNotMatch(second, /conventions\/pinned-deploy/);
    assert.match(second, /workflows\/normal-deploy/);
  });

  it('agy PreInvocation은 invocationNum 0에서 한 번만 핀을 싣고 이후 호출·다음 턴엔 안 싣는다', async () => {
    await clearGlobal();
    await writeProfileDocs(getGlobalDir(userData), 'default', {
      docs: [
        {
          category: 'conventions',
          slug: 'agy-pin',
          title: 'Agy pinned rule',
          summary: 'Summary.',
          body: 'Body.',
          indexEntries: ['agy'],
          tags: ['pinned'],
        },
      ],
    });

    const transcript = join(tmp, 'agy-pin-transcript.jsonl');
    await fsp.writeFile(
      transcript,
      JSON.stringify({
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        content: '<USER_REQUEST> hi </USER_REQUEST>',
      }) + '\n',
      'utf8',
    );

    const inv1Before0 = fire(
      'PreInvocation',
      { conversationId: 'c1', invocationNum: 1, transcriptPath: transcript },
      'sess-agy-pin',
      'agy',
    );
    assert.deepEqual(inv1Before0, {});

    const inv0 = fire(
      'PreInvocation',
      { conversationId: 'c1', invocationNum: 0, transcriptPath: transcript },
      'sess-agy-pin',
      'agy',
    );
    assert.match(inv0.injectSteps[0].ephemeralMessage, /The user pinned these\./);
    assert.match(inv0.injectSteps[0].ephemeralMessage, /conventions\/agy-pin/);

    const nextTurn = fire(
      'PreInvocation',
      { conversationId: 'c1', invocationNum: 0, transcriptPath: transcript },
      'sess-agy-pin',
      'agy',
    );
    assert.doesNotMatch(nextTurn.injectSteps[0].ephemeralMessage, /The user pinned these\./);
  });
});

// 서브 차례의 2절 (0.9.0 spec/03 §2). 서브는 서브를 못 띄우므로 서브 소절로 바꿔 싣고,
// 판정은 워크스페이스의 세션 기록에서 자기 세션의 parentSessionId를 보는 것으로 한다.
describe('helper inject — 서브 차례 (0.9.0 spec/03 §2)', () => {
  let tmp: string;
  let bundlePath: string;
  let userData: string;
  let wsDir: string;

  before(async function () {
    this.timeout(30000);
    tmp = await fsp.mkdtemp(join(tmpdir(), 'ab-helper-sub-'));
    userData = join(tmp, 'userdata');
    await fsp.mkdir(join(userData, 'bin'), { recursive: true });
    bundlePath = join(userData, 'bin', 'agentbridge-memory.js');
    const bundlerScript = join(process.cwd(), '..', '..', 'scripts', 'bundle-helper.mjs');
    execFileSync('node', [bundlerScript, bundlePath], { encoding: 'utf8' });

    wsDir = join(userData, 'workspaces', 'ws-1');
    await fsp.mkdir(wsDir, { recursive: true });
    await fsp.writeFile(
      join(wsDir, 'workspace.json'),
      JSON.stringify({
        workspaceId: 'ws-1',
        sessions: [
          { sessionId: 'sub-1', parentSessionId: 'main-1', agentName: 'a' },
          { sessionId: 'main-1' },
        ],
      }),
      'utf8',
    );
  });

  after(async () => {
    if (tmp) await fsp.rm(tmp, { recursive: true, force: true });
  });

  function ctxFor(session: string): string {
    const out = execFileSync(
      'node',
      [bundlePath, 'inject', '--agent', 'claude', '--event', 'UserPromptSubmit'],
      {
        input: JSON.stringify({ prompt: 'hello' }),
        encoding: 'utf8',
        env: { ...process.env, AGENTBRIDGE_WS_DIR: wsDir, AGENTBRIDGE_WS_SESSION: session },
      },
    );
    return JSON.parse(out).hookSpecificOutput.additionalContext as string;
  }

  it('서브 차례는 서브 소절을 싣는다', () => {
    const ctx = ctxFor('sub-1');
    assert.match(ctx, /### 2-2\. You are a subagent/);
    assert.match(ctx, /Do not use your own built-in subagent tool for that either\./);
    assert.doesNotMatch(ctx, /### 2-2\. What they are/);
    assert.doesNotMatch(ctx, /### 2-3\. After a report/);
    assert.doesNotMatch(ctx, /and for anything/);
    // 3절의 서브 명령 묶음이 통째로 빠진다. 소절 안의 `agent start`는 "거절된다"는 설명이라 남는다.
    assert.doesNotMatch(ctx, /Subagents\./);
    assert.doesNotMatch(ctx, /agent start --prompt/);
    assert.doesNotMatch(ctx, /agent check/);
    assert.doesNotMatch(ctx, /agent read/);
    assert.doesNotMatch(ctx, /agent close/);
    assert.equal(ctx.split('agent start').length - 1, 1);
    // 3절은 메인과 같은 스킬 안내다.
    assert.match(ctx, /The full list, with arguments, is\nin the `agentbridge` skill\./);
    // 나머지 절은 메인과 같다.
    assert.match(ctx, /## 1\. Context/);
    assert.match(ctx, /## 4\. When you answer/);
  });

  it('메인 차례는 지금과 같다', () => {
    const ctx = ctxFor('main-1');
    assert.match(ctx, /### 2-2\. What they are/);
    assert.match(ctx, /Open the `agentbridge` skill\nbefore `agent start`, and again to review a report/);
    assert.match(ctx, /run `agent check --wait` before you end the turn/);
    assert.doesNotMatch(ctx, /You are a subagent/);
  });

  it('기록이 없으면 메인 문구다', () => {
    const ctx = ctxFor('nobody');
    assert.match(ctx, /### 2-2\. What they are/);
    assert.doesNotMatch(ctx, /You are a subagent/);
  });

  it('workspace.json을 못 읽으면 메인 문구다', async () => {
    const other = join(userData, 'workspaces', 'ws-none');
    await fsp.mkdir(other, { recursive: true });
    const out = execFileSync(
      'node',
      [bundlePath, 'inject', '--agent', 'claude', '--event', 'UserPromptSubmit'],
      {
        input: JSON.stringify({ prompt: 'hello' }),
        encoding: 'utf8',
        env: { ...process.env, AGENTBRIDGE_WS_DIR: other, AGENTBRIDGE_WS_SESSION: 'sub-1' },
      },
    );
    assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /### 2-2\. What they are/);
  });

  it('서브 주입문도 9KB 안이다', () => {
    assert.ok(Buffer.byteLength(ctxFor('sub-1'), 'utf8') <= 9 * 1024);
  });
});

// 0.10.0 spec/02 §4 — 붙을 수 있는 블록이 한꺼번에 붙어도 가장 빡빡한 한도(codex 10,000바이트)
// 아래 9,000바이트 안에 든다. 고정 기억·걸린 기억 셋·다섯 턴 블록·안 읽은 서브 보고를 한 주입에 겹친다.
describe('helper inject — 가장 무거운 주입의 크기 (0.10.0 spec/02 §4)', () => {
  let tmp: string;
  let bundlePath: string;
  let userData: string;
  let wsDir: string;
  const longTitle = (lead: string) =>
    `${lead} — a deliberately long title that stands in for the longest real entry titles`;

  before(async function () {
    this.timeout(30000);
    tmp = await fsp.mkdtemp(join(tmpdir(), 'ab-helper-heavy-'));
    userData = join(tmp, 'userdata');
    await fsp.mkdir(join(userData, 'bin'), { recursive: true });
    bundlePath = join(userData, 'bin', 'agentbridge-memory.js');
    const bundlerScript = join(process.cwd(), '..', '..', 'scripts', 'bundle-helper.mjs');
    execFileSync('node', [bundlerScript, bundlePath], { encoding: 'utf8' });

    const docs = [];
    for (let i = 0; i < 3; i++) {
      docs.push({
        category: 'workflows',
        slug: `pin-${i}`,
        title: longTitle(`Pinned rule ${i}`),
        summary: 'Pinned.',
        body: 'Pinned body.',
        indexEntries: [`pinned-only-${i}`],
        tags: ['pinned'],
      });
      docs.push({
        category: 'conventions',
        slug: `match-${i}`,
        title: longTitle(`Deployment rule ${i}`),
        summary: 'Matched.',
        body: 'Matched body.',
        indexEntries: ['deployment workflow', 'release tagging', 'production rollout'],
      });
    }
    await writeProfileDocs(getGlobalDir(userData), 'default', { docs });

    wsDir = join(userData, 'workspaces', 'ws-1');
    const children = ['sub-alpha-reviewer', 'sub-beta-implementer', 'sub-gamma-measurer'];
    await fsp.mkdir(wsDir, { recursive: true });
    await fsp.writeFile(
      join(wsDir, 'workspace.json'),
      JSON.stringify({
        workspaceId: 'ws-1',
        sessions: [
          { sessionId: 'main-1' },
          ...children.map((name) => ({
            sessionId: name,
            parentSessionId: 'main-1',
            agentName: name,
            closedAt: null,
          })),
        ],
      }),
      'utf8',
    );
    for (const name of children) {
      const dir = join(wsDir, 'sessions', name);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(
        join(dir, TURN_SIGNAL_FILENAME),
        JSON.stringify({ agent: 'claude', event: 'Stop', complete: true, at: Date.now() }),
        'utf8',
      );
    }
  });

  after(async () => {
    if (tmp) await fsp.rm(tmp, { recursive: true, force: true });
  });

  function fire(event: string, stdin: string): string {
    return execFileSync('node', [bundlePath, 'inject', '--agent', 'codex', '--event', event], {
      input: stdin,
      encoding: 'utf8',
      env: { ...process.env, AGENTBRIDGE_WS_DIR: wsDir, AGENTBRIDGE_WS_SESSION: 'main-1' },
    });
  }

  it('모든 블록이 붙은 주입이 9,000바이트 아래다', () => {
    for (let i = 0; i < 5; i++) fire('Stop', JSON.stringify({ session_id: 'x' }));
    const out = JSON.parse(
      fire('UserPromptSubmit', JSON.stringify({ prompt: 'deployment workflow and release tagging and production rollout' })),
    );
    const ctx = out.hookSpecificOutput.additionalContext as string;
    assert.match(ctx, /The user pinned these\./);
    assert.match(ctx, /3 pieces of long-term memory overlap/);
    assert.match(ctx, /last five turns/);
    assert.match(ctx, /3 finished and are unread/);
    const bytes = Buffer.byteLength(ctx, 'utf8');
    assert.ok(bytes < 9000, `주입이 너무 크다: ${bytes}`);
  });
});
