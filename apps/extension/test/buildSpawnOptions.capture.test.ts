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

  it('codex: captureToken이 env와 캡처 경로에 반영된다', async () => {
    const opts = await makeAdapters().codex.buildSpawnOptions('/cwd', 'ws-1', undefined, undefined, 'tok-1');
    assert.equal((opts.env as Record<string, string>).AGENTBRIDGE_WS_SESSION, 'tok-1');
    assert.equal(opts.hookCaptureFilePath, '/tmp/cap/ws-1/sessions/tok-1/captured.json');
  });

  it('agy: captureToken이 env와 캡처 경로에 반영된다', async () => {
    const opts = await makeAdapters().agy.buildSpawnOptions('/cwd', 'ws-2', undefined, undefined, 'tok-2');
    assert.equal((opts.env as Record<string, string>).AGENTBRIDGE_WS_SESSION, 'tok-2');
    assert.equal(opts.hookCaptureFilePath, '/tmp/cap/ws-2/sessions/tok-2/captured.json');
  });

  it('captureToken 미지정이면 내부 sessionId를 토큰으로 쓴다 (extension 경로)', async () => {
    const opts = await makeAdapters().codex.buildSpawnOptions('/cwd', 'ws-3');
    // sessionId는 내부 생성(randomUUID) → 값은 예측 불가하나 env·경로가 그 값으로 일관돼야 한다.
    assert.equal((opts.env as Record<string, string>).AGENTBRIDGE_WS_SESSION, opts.sessionId);
    assert.equal(opts.hookCaptureFilePath, `/tmp/cap/ws-3/sessions/${opts.sessionId}/captured.json`);
  });
});
