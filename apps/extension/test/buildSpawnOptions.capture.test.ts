import { strict as assert } from 'assert';
import { createCliAdapters } from '@agentbridge/core';

// envProbe 최소 스텁 — getShellEnv/probe만 사용.
const fakeEnvProbe = {
  getShellEnv: () => ({ PATH: '/usr/bin' }),
  probe: () => ({ available: true, resolvedPath: '/bin/cli' }),
} as unknown as Parameters<typeof createCliAdapters>[0]['envProbe'];

function makeAdapters() {
  return createCliAdapters({
    envProbe: fakeEnvProbe,
    workspaceDir: (id: string) => `/tmp/cap/${id}`,
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
