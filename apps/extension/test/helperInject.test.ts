import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeProfileDocs, getGlobalDir } from '@agentbridge/core';

describe('helper inject — 글로벌 메모리 검색 종단(§G3)', () => {
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

  it('stdin 프롬프트와 매치되는 글로벌 문서를 주입한다', () => {
    const res = run(JSON.stringify({ prompt: 'how do I handle deployment to production?' }));
    const ctx = res.hookSpecificOutput.additionalContext as string;
    assert.match(ctx, /Global memory/);
    assert.match(ctx, /Deployment workflow/);
    assert.equal(res.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  });

  it('매치가 없으면 글로벌 섹션을 생략한다(IR/turns 주입은 불변)', () => {
    const res = run(JSON.stringify({ prompt: 'zzzzz totally unrelated quokka' }));
    const ctx = res.hookSpecificOutput.additionalContext as string;
    assert.doesNotMatch(ctx, /Global memory/);
  });

  // 회귀 방지: esbuild가 주석을 제거해 `@agentbridge-helper-version` 마커가 사라지면
  // hookInstaller 버전비교가 번들을 0.0.0으로 읽어 기존 설치본을 영영 갱신하지 않는다(주입 미동작).
  // bundleHelper가 번들 출력에 마커를 다시 주입해야 한다.
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
