import { strict as assert } from 'assert';
import { createCliAdapters } from '@agentbridge/core';

// envProbe 최소 스텁 — getShellEnv/probe만 사용.
const fakeEnvProbe = {
  getShellEnv: () => ({ PATH: '/usr/bin' }),
  probe: () => ({ available: true, resolvedPath: '/bin/cli' }),
} as unknown as Parameters<typeof createCliAdapters>[0]['envProbe'];

function makeAdapters(opts?: { storageRoot?: string; homeDir?: string }) {
  return createCliAdapters({
    envProbe: fakeEnvProbe,
    workspaceDir: (id: string) => `/tmp/cap/${id}`,
    storageRoot: opts?.storageRoot,
    homeDir: opts?.homeDir,
  });
}

describe('buildSpawnOptions — env 토큰 + hookCaptureFilePath', () => {
  it('세 하니스 모두 신원 변수로 워크스페이스 폴더를 심는다 (A-3)', async () => {
    const a = makeAdapters();
    for (const [kind, opts] of [
      ['claude', await a.claude.buildSpawnOptions('/cwd', 'ws-0')],
      ['codex', await a.codex.buildSpawnOptions('/cwd', 'ws-0')],
      ['agy', await a.agy.buildSpawnOptions('/cwd', 'ws-0')],
    ] as const) {
      assert.equal(
        (opts.env as Record<string, string>).AGENTBRIDGE_WS_DIR,
        '/tmp/cap/ws-0',
        `${kind}에 AGENTBRIDGE_WS_DIR이 없다`,
      );
    }
  });

  it('codex·agy는 세션 id를 토큰으로 env와 캡처 경로에 일관되게 심는다', async () => {
    const a = makeAdapters();
    for (const [kind, opts] of [
      ['codex', await a.codex.buildSpawnOptions('/cwd', 'ws-1')],
      ['agy', await a.agy.buildSpawnOptions('/cwd', 'ws-1')],
    ] as const) {
      assert.equal(
        (opts.env as Record<string, string>).AGENTBRIDGE_WS_SESSION,
        opts.sessionId,
        `${kind}의 토큰이 세션 id와 다르다`,
      );
      assert.equal(
        opts.hookCaptureFilePath,
        `/tmp/cap/ws-1/sessions/${opts.sessionId}/captured.json`,
      );
    }
  });

  it('claude는 캡처 대상이 아니다 — id를 우리가 발급한다', async () => {
    const opts = await makeAdapters().claude.buildSpawnOptions('/cwd', 'ws-2');
    assert.equal(opts.hookCaptureFilePath, undefined);
    assert.ok(opts.args.includes('--session-id'));
  });

  it('추측형 폴백 재료를 더 이상 싣지 않는다 (spec A-1)', async () => {
    const a = makeAdapters();
    const codex = (await a.codex.buildSpawnOptions('/cwd', 'ws-3')) as Record<string, unknown>;
    const agy = (await a.agy.buildSpawnOptions('/cwd', 'ws-3')) as Record<string, unknown>;
    assert.equal(codex.codexSessionSnapshot, undefined);
    assert.equal(agy.agyWatchUuid, undefined);
  });
});

describe('buildSpawnOptions — subModel · subEffort 인자 (0.8.0)', () => {
  it('claude — 새 세션에서 --model과 --effort를 -- 프롬프트 앞에 넣는다', async () => {
    const opts = await makeAdapters().claude.buildSpawnOptions('/cwd', 'ws-m1', 'sid-1', {
      freshSession: true,
      initialPrompt: 'hello',
      subModel: 'opus',
      subEffort: 'high',
    });
    assert.deepEqual(opts.args, [
      '--session-id', 'sid-1',
      '--add-dir', '/tmp/cap/ws-m1',
      '--model', 'opus',
      '--effort', 'high',
      '--', 'hello',
    ]);
  });

  it('claude — effort가 없는 모델이면 --model만 넘기고 이어 열기에서도 유지한다', async () => {
    const a = makeAdapters();
    const fresh = await a.claude.buildSpawnOptions('/cwd', 'ws-m2', 'sid-2', {
      freshSession: true,
      initialPrompt: 'hello',
      subModel: 'claude-haiku-4-5-20251001',
    });
    assert.deepEqual(fresh.args, [
      '--session-id', 'sid-2',
      '--add-dir', '/tmp/cap/ws-m2',
      '--model', 'claude-haiku-4-5-20251001',
      '--', 'hello',
    ]);

    const resumed = await a.claude.buildSpawnOptions('/cwd', 'ws-m2', 'sid-2', {
      initialPrompt: 'ignored',
      subModel: 'opus',
      subEffort: 'max',
    });
    assert.equal(resumed.args.includes('--'), false);
    assert.deepEqual(resumed.args.slice(2), [
      '--add-dir', '/tmp/cap/ws-m2',
      '--model', 'opus',
      '--effort', 'max',
    ]);
  });

  it('codex — 새 세션과 resume 모두 sandboxArgs 뒤, 프롬프트·resume 앞에 -m과 -c를 넣는다', async () => {
    const storageRoot = '/tmp/cap-storage';
    const a = makeAdapters({ storageRoot, homeDir: '/tmp/nonexistent-codex-home' });
    const sandbox = ['-c', `sandbox_workspace_write.writable_roots=["${storageRoot}"]`];

    const fresh = await a.codex.buildSpawnOptions('/cwd', 'ws-m3', 'sid-3', undefined, {
      freshSession: true,
      initialPrompt: 'do work',
      subModel: 'gpt-6-luna',
      subEffort: 'xhigh',
    });
    assert.deepEqual(fresh.args, [
      ...sandbox,
      '-m', 'gpt-6-luna',
      '-c', 'model_reasoning_effort="xhigh"',
      'do work',
    ]);

    const noEffort = await a.codex.buildSpawnOptions('/cwd', 'ws-m3', 'sid-3', undefined, {
      freshSession: true,
      initialPrompt: 'do work',
      subModel: 'gpt-6-luna',
    });
    assert.deepEqual(noEffort.args, [...sandbox, '-m', 'gpt-6-luna', 'do work']);

    const resumed = await a.codex.buildSpawnOptions('/cwd', 'ws-m3', 'sid-3', 'thread-1', {
      initialPrompt: 'ignored',
      subModel: 'gpt-6-luna',
      subEffort: 'low',
    });
    assert.deepEqual(resumed.args, [
      ...sandbox,
      '-m', 'gpt-6-luna',
      '-c', 'model_reasoning_effort="low"',
      'resume', 'thread-1',
    ]);
  });

  it('agy — --model <이름>-<effort>를 cwdArgs 뒤에 넣고 --effort는 넘기지 않는다', async () => {
    const a = makeAdapters();
    const fresh = await a.agy.buildSpawnOptions('/cwd', 'ws-m4', 'sid-4', undefined, {
      freshSession: true,
      initialPrompt: 'do work',
      subModel: 'gemini-4-hydrogen',
      subEffort: 'high',
    });
    assert.deepEqual(fresh.args, [
      '--add-dir', '/cwd',
      '--model', 'gemini-4-hydrogen-high',
      '--dangerously-skip-permissions',
      '-i', 'do work',
    ]);
    assert.equal(fresh.args.includes('--effort'), false);

    const noEffort = await a.agy.buildSpawnOptions('/cwd', 'ws-m4', 'sid-4', undefined, {
      freshSession: true,
      initialPrompt: 'do work',
      subModel: 'gemini-pro-orchestrator-g1-pro',
    });
    assert.deepEqual(noEffort.args, [
      '--add-dir', '/cwd',
      '--model', 'gemini-pro-orchestrator-g1-pro',
      '--dangerously-skip-permissions',
      '-i', 'do work',
    ]);

    const resumed = await a.agy.buildSpawnOptions('/cwd', 'ws-m4', 'sid-4', undefined, {
      initialPrompt: 'ignored',
      subModel: 'gemini-4-hydrogen',
      subEffort: 'medium',
    });
    assert.deepEqual(resumed.args, [
      '--add-dir', '/cwd',
      '--model', 'gemini-4-hydrogen-medium',
      '--dangerously-skip-permissions',
    ]);
  });

  it('subModel을 넘기지 않으면 모델·effort 인자를 붙이지 않는다', async () => {
    const a = makeAdapters();
    for (const opts of [
      await a.claude.buildSpawnOptions('/cwd', 'ws-m5'),
      await a.codex.buildSpawnOptions('/cwd', 'ws-m5'),
      await a.agy.buildSpawnOptions('/cwd', 'ws-m5'),
    ]) {
      assert.equal(opts.args.includes('--model'), false);
      assert.equal(opts.args.includes('--effort'), false);
      assert.equal(opts.args.includes('-m'), false);
      assert.equal(opts.args.some((x) => x.includes('model_reasoning_effort')), false);
    }
  });
});
