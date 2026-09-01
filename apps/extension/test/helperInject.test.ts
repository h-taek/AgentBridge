import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeProfileDocs, getGlobalDir } from '@agentbridge/core';

describe('helper inject — 지시문만 나른다 (0.5.0 B-4)', () => {
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

    // 프로필에 검색 대상 문서 시드(globalDir = userData/global).
    const globalDir = getGlobalDir(userData);
    await writeProfileDocs(globalDir, 'default', {
      docs: [{
        category: 'conventions',
        slug: 'deploy-flow',
        title: 'Deployment workflow',
        summary: 'Use the release branch and tag before publishing to production.',
        body: 'Run the release script then tag.',
        indexEntries: ['deployment workflow'],
      }],
    });

    // workspace 디렉토리(IR/turns 없음 — 글로벌 주입만 격리 검증).
    await fsp.mkdir(join(userData, 'workspaces', 'ws-1'), { recursive: true });
  });

  after(async () => {
    if (tmp) await fsp.rm(tmp, { recursive: true, force: true });
  });

  function run(stdin: string): any {
    const out = execFileSync(
      'node',
      [bundlePath, 'inject', '--agent', 'claude', '--event', 'UserPromptSubmit'],
      {
        input: stdin,
        encoding: 'utf8',
        env: { ...process.env, AGENTBRIDGE_WS_DIR: join(userData, 'workspaces', 'ws-1') },
      },
    );
    return JSON.parse(out);
  }

  // 미리 밀어넣는 내용이 없다. 프롬프트가 무엇이든 나가는 것은 같은 지시문이다.
  it('지식·IR·최근 턴을 밀지 않는다', () => {
    const res = run(JSON.stringify({ prompt: 'how do I handle deployment to production?' }));
    const ctx = res.hookSpecificOutput.additionalContext as string;
    assert.doesNotMatch(ctx, /Global memory/);
    assert.doesNotMatch(ctx, /Deployment workflow/);
    assert.doesNotMatch(ctx, /Memory \(compacted/);
    assert.doesNotMatch(ctx, /Recent conversation/);
    assert.equal(res.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  });

  it('부를 명령과 조건을 싣는다', () => {
    const ctx = run(JSON.stringify({ prompt: 'x' })).hookSpecificOutput.additionalContext as string;
    for (const cmd of ['context', 'turns --last 5', 'memory search', 'memory add', 'status']) {
      assert.ok(ctx.includes(cmd), `지시문에 ${cmd}가 있어야 한다`);
    }
    // 사용자 명령은 싣지 않는다.
    assert.doesNotMatch(ctx, /uninstall/);
  });

  it('실행 경로가 박히고 프롬프트가 무엇이든 크기가 같다', () => {
    const a = run(JSON.stringify({ prompt: '짧은 질문' })).hookSpecificOutput.additionalContext as string;
    const b = run(JSON.stringify({ prompt: 'a'.repeat(4000) })).hookSpecificOutput.additionalContext as string;
    assert.equal(a, b, '프롬프트에 따라 달라지는 내용이 없다');
    assert.ok(a.includes(join(userData, 'bin', 'agentbridge.js')), 'CLI 절대경로가 박혀야 한다');
    // 지시문 하나뿐이라 어느 하니스 한도(약 9KB)에도 안 걸린다.
    assert.ok(Buffer.byteLength(a, 'utf8') < 3000, `주입이 너무 크다: ${Buffer.byteLength(a, 'utf8')}`);
  });

  // 회귀 방지: esbuild가 주석을 제거해 `@agentbridge-helper-version` 마커가 사라지면
  // hookInstaller 버전비교가 번들을 0.0.0으로 읽어 기존 설치본을 영영 갱신하지 않는다(주입 미동작).
  // bundleBin이 번들 출력에 마커를 다시 주입해야 한다.
  it('번들 출력에 헬퍼 버전 마커가 남아 install 버전비교가 동작한다', async () => {
    const src = await fsp.readFile(bundlePath, 'utf8');
    assert.match(src, /@agentbridge-helper-version \d+\.\d+\.\d+/);
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

  it('토큰 env가 없으면 무동작 — 세션 폴더 자체가 안 생긴다', async () => {
    run('claude', 'UserPromptSubmit', JSON.stringify({ prompt: 'hi' }), undefined, 'ws-notoken');
    const sessionsDir = join(userData, 'workspaces', 'ws-notoken', 'sessions');
    await assert.rejects(() => fsp.stat(sessionsDir));
  });
});
