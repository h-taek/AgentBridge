// 0.5.0 A-2 — 헬퍼가 종료 훅 페이로드를 한 모양의 신호로 정규화한다.
// 페이로드 형태는 research 04(설치본 바이너리에서 읽은 스키마·실측)를 그대로 따른다.
import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import { parseTurnSignal, parseHookError } from '@agentbridge/core';

const BUNDLED_HELPER = join(__dirname, '..', 'resources', 'bin', 'agentbridge-memory.js');

describe('종료 훅 신호 — 헬퍼 방출', () => {
  const WS = 'ws-sig';
  const TOKEN = 'sess-sig';
  let userData: string;
  let helper: string;

  beforeEach(async () => {
    userData = await fs.mkdtemp(join(tmpdir(), 'ab-signal-'));
    await fs.mkdir(join(userData, 'workspaces', WS), { recursive: true });
    await fs.mkdir(join(userData, 'bin'), { recursive: true });
    helper = join(userData, 'bin', 'agentbridge-memory.js');
    await fs.copyFile(BUNDLED_HELPER, helper);
  });
  afterEach(async () => {
    await fs.rm(userData, { recursive: true, force: true });
  });

  function run(agent: string, event: string, payload: unknown): Promise<string> {
    return new Promise((resolve) => {
      const p = spawn('node', [helper, 'inject', '--agent', agent, '--event', event], {
        env: {
          ...process.env,
          AGENTBRIDGE_WS_SESSION: TOKEN,
          AGENTBRIDGE_WS_DIR: join(userData, 'workspaces', WS),
        },
      });
      let out = '';
      p.stdout.on('data', (c) => { out += String(c); });
      p.stderr.on('data', () => {});
      p.stdin.write(JSON.stringify(payload));
      p.stdin.end();
      p.on('close', () => resolve(out));
    });
  }

  async function readSignal(): Promise<any> {
    const raw = await fs.readFile(
      join(userData, 'workspaces', WS, 'sessions', TOKEN, 'turn-signal.json'),
      'utf8',
    );
    return JSON.parse(raw);
  }

  it('claude Stop — session_id·transcript_path를 싣고 완료로 표시한다', async () => {
    await run('claude', 'Stop', {
      hook_event_name: 'Stop',
      session_id: 'cd82c4dd-1111-2222-3333-444455556666',
      transcript_path: '/tmp/claude/projects/x/cd82c4dd.jsonl',
      cwd: '/proj',
      stop_hook_active: false,
      last_assistant_message: '답변',
    });
    const s = await readSignal();
    assert.equal(s.agent, 'claude');
    assert.equal(s.event, 'Stop');
    assert.equal(s.sessionId, 'cd82c4dd-1111-2222-3333-444455556666');
    assert.equal(s.transcriptPath, '/tmp/claude/projects/x/cd82c4dd.jsonl');
    assert.equal(s.complete, true);
  });

  it('claude StopFailure — 오류로 끊긴 턴은 미완으로 표시한다', async () => {
    await run('claude', 'StopFailure', {
      hook_event_name: 'StopFailure',
      session_id: 's-1',
      transcript_path: '/tmp/t.jsonl',
      error: 'server_error',
    });
    const s = await readSignal();
    assert.equal(s.event, 'StopFailure');
    assert.equal(s.complete, false);
    assert.equal(s.error, 'server_error');
  });

  it('codex Stop — turn_id가 있어도 세션은 session_id로 잡는다', async () => {
    await run('codex', 'Stop', {
      hook_event_name: 'Stop',
      session_id: '019e-codex-session',
      turn_id: 'turn-abc',
      transcript_path: '/tmp/codex/rollout-019e.jsonl',
      cwd: '/proj',
      model: 'gpt-5',
      permission_mode: 'default',
      stop_hook_active: false,
      last_assistant_message: '답',
    });
    const s = await readSignal();
    assert.equal(s.agent, 'codex');
    assert.equal(s.sessionId, '019e-codex-session');
    assert.equal(s.transcriptPath, '/tmp/codex/rollout-019e.jsonl');
    assert.equal(s.complete, true);
  });

  it('agy Stop — conversationId·transcriptPath, fullyIdle이 완료 판단이다', async () => {
    await run('agy', 'Stop', {
      executionNum: 1,
      terminationReason: 'model_stop',
      error: '',
      fullyIdle: true,
      conversationId: 'a247c86e-e5fb-420c-b4ff-1596b7bf367e',
      transcriptPath: '/tmp/agy/transcript.jsonl',
      modelName: 'gemini',
    });
    const s = await readSignal();
    assert.equal(s.agent, 'agy');
    assert.equal(s.sessionId, 'a247c86e-e5fb-420c-b4ff-1596b7bf367e');
    assert.equal(s.transcriptPath, '/tmp/agy/transcript.jsonl');
    assert.equal(s.complete, true);
    assert.equal(s.terminationReason, 'model_stop');
  });

  it('agy — 배경 작업이 남아 있으면 미완이다', async () => {
    await run('agy', 'Stop', {
      terminationReason: 'max_steps_exceeded',
      fullyIdle: false,
      conversationId: 'c-1',
      transcriptPath: '/tmp/t.jsonl',
    });
    const s = await readSignal();
    assert.equal(s.complete, false);
    assert.equal(s.terminationReason, 'max_steps_exceeded');
  });

  it('종료 훅은 컨텍스트를 싣지 않고 종료를 막지 않는 응답만 낸다', async () => {
    const claudeOut = JSON.parse(await run('claude', 'Stop', { session_id: 's', transcript_path: '/t' }));
    assert.equal(claudeOut.hookSpecificOutput, undefined, '종료 훅에 컨텍스트를 실으면 안 된다');
    assert.equal(claudeOut.decision, undefined, 'decision의 유일한 허용값이 block이라 싣지 않는다');

    // agy는 decision이 required이고 "continue"만 종료를 막는다.
    const agyOut = JSON.parse(await run('agy', 'Stop', { conversationId: 'c', transcriptPath: '/t' }));
    assert.ok(agyOut.decision, 'agy는 decision이 필수다');
    assert.notEqual(agyOut.decision, 'continue', '종료를 막으면 안 된다');
  });

  it('세션 토큰이 없으면 신호를 쓰지 않는다', async () => {
    await new Promise<void>((resolve) => {
      const p = spawn('node', [helper, 'inject', '--agent', 'claude', '--event', 'Stop'], {
        env: { ...process.env, AGENTBRIDGE_WS_DIR: join(userData, 'workspaces', WS) },
      });
      p.stdout.on('data', () => {});
      p.stdin.write('{}');
      p.stdin.end();
      p.on('close', () => resolve());
    });
    await assert.rejects(() => readSignal());
  });
});

describe('종료 훅 신호 — 호스트 파싱', () => {
  const base = {
    agent: 'claude',
    event: 'Stop',
    sessionId: 's-1',
    transcriptPath: '/tmp/t.jsonl',
    complete: true,
    at: 5,
  };

  it('자식 식별자가 있으면 버린다 — 부모 턴이 아니다', () => {
    assert.equal(parseTurnSignal(JSON.stringify({ ...base, agentId: 'child-1' })), null);
  });

  it('빈 자식 식별자는 부모 신호로 통과시킨다', () => {
    assert.ok(parseTurnSignal(JSON.stringify({ ...base, agentId: '' })));
  });

  it('모르는 하니스나 부분 write는 null', () => {
    assert.equal(parseTurnSignal(JSON.stringify({ ...base, agent: 'gemini' })), null);
    assert.equal(parseTurnSignal('{"agent":"claude","ev'), null);
    assert.equal(parseTurnSignal(JSON.stringify({ ...base, event: '' })), null);
  });
});

describe('훅 실행 실패 통로', () => {
  const WS = 'ws-err';
  const TOKEN = 'sess-err';
  let userData: string;
  let helper: string;

  beforeEach(async () => {
    userData = await fs.mkdtemp(join(tmpdir(), 'ab-hookerr-'));
    await fs.mkdir(join(userData, 'workspaces', WS), { recursive: true });
    await fs.mkdir(join(userData, 'bin'), { recursive: true });
    helper = join(userData, 'bin', 'agentbridge-memory.js');
    await fs.copyFile(BUNDLED_HELPER, helper);
  });
  afterEach(async () => {
    await fs.rm(userData, { recursive: true, force: true });
  });

  it('저장소 루트 밖을 가리키면 파일로 남긴다 — stderr는 CLI가 삼킨다', async () => {
    const outside = await fs.mkdtemp(join(tmpdir(), 'ab-outside-'));
    await fs.mkdir(join(outside, 'sessions', TOKEN), { recursive: true });
    await new Promise<void>((resolve) => {
      const p = spawn('node', [helper, 'inject', '--agent', 'codex', '--event', 'UserPromptSubmit'], {
        env: { ...process.env, AGENTBRIDGE_WS_SESSION: TOKEN, AGENTBRIDGE_WS_DIR: outside },
      });
      p.stdout.on('data', () => {});
      p.stderr.on('data', () => {});
      p.stdin.write('{}');
      p.stdin.end();
      p.on('close', () => resolve());
    });
    const raw = await fs.readFile(join(outside, 'sessions', TOKEN, 'hook-error.json'), 'utf8');
    const err = parseHookError(raw);
    assert.ok(err, '파싱 가능한 오류 기록이어야 한다');
    assert.equal(err!.agent, 'codex');
    assert.match(err!.message, /저장소 루트/);
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('형식이 어긋난 기록은 무시한다', () => {
    assert.equal(parseHookError('{"agent":"claude"}'), null, '메시지 없는 기록은 무시');
    assert.equal(parseHookError('not json'), null);
    assert.equal(parseHookError('{"agent":"gemini","message":"x"}'), null);
  });
});
