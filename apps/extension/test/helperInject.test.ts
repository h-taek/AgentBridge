import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeProfileDocs, getGlobalDir } from '@agentbridge/core';

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

  it('무관한 문서는 안 걸린다 — 게이트가 최고점의 60%로 자른다', () => {
    const ctx = ctxFor('how do I handle deployment to production?');
    assert.doesNotMatch(ctx, /role\/solo/);
  });

  it('프롬프트에 따라 주입이 달라진다', () => {
    assert.notEqual(ctxFor('deployment workflow'), ctxFor('what time is it right now'));
  });

  it('부를 명령과 조건을 싣는다', () => {
    const ctx = ctxFor('x');
    for (const cmd of ['context', 'turns --last', 'memory search', 'memory read', 'memory add', 'status']) {
      assert.ok(ctx.includes(cmd), `지시문에 ${cmd}가 있어야 한다`);
    }
    // 사용자 명령은 싣지 않는다.
    assert.doesNotMatch(ctx, /uninstall/);
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
