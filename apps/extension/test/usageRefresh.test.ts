// 0.6.0 사용량 조회 3단계 — 토큰 갱신 명령과 동시 실행 차단.
//
// 갱신은 CLI를 실제로 띄운다. 문이 없으면 폴링 주기마다 프로세스가 쌓인다.
// 그리고 이 명령들은 모델 턴을 소비하면 안 된다 — 사용량을 보려다 사용량을 쓰는 꼴이 된다.
import { strict as assert } from 'assert';
import type { CliKind } from '@agentbridge/core';
import { refreshCommand, createTokenRefresher, type RefreshCommand } from '../src/core/usage/refreshToken';

describe('usage/refreshToken', () => {
  describe('명령 형태', () => {
    it('claude는 세션을 남기지 않고 도구 없이 /usage를 부른다', () => {
      const c = refreshCommand('claude');
      assert.equal(c.file, 'claude');
      assert.deepEqual(c.args.slice(0, 2), ['-p', '/usage']);
      for (const flag of ['--no-session-persistence', '--strict-mcp-config', '--tools', '--mcp-config']) {
        assert.ok(c.args.includes(flag), `${flag}가 빠졌다`);
      }
    });

    it('claude의 mcp 설정은 서버가 없는 빈 설정이다', () => {
      const c = refreshCommand('claude');
      const config = c.args[c.args.indexOf('--mcp-config') + 1];
      assert.deepEqual(JSON.parse(config), { mcpServers: {} });
    });

    it('codex는 app-server를 띄우고 initialize만 보낸다', () => {
      const c = refreshCommand('codex');
      assert.equal(c.file, 'codex');
      assert.deepEqual(c.args, ['app-server']);
      assert.match(String(c.stdin), /"method"\s*:\s*"initialize"/);
    });

    it('agy는 print 모드로 /usage를 부른다', () => {
      const c = refreshCommand('agy');
      assert.equal(c.file, 'agy');
      assert.deepEqual(c.args, ['--print', '/usage', '--print-timeout', '25s']);
    });
  });

  describe('동시 실행 차단', () => {
    function runner() {
      const started: CliKind[] = [];
      const pending: Array<() => void> = [];
      const run = async (cmd: RefreshCommand) => {
        started.push(cmd.file as CliKind);
        await new Promise<void>((resolve) => pending.push(resolve));
      };
      return { started, pending, run, flush: () => { for (const r of pending.splice(0)) r(); } };
    }

    it('같은 CLI가 이미 돌고 있으면 띄우지 않는다', async () => {
      const r = runner();
      const refresher = createTokenRefresher(r.run);
      const first = refresher.refresh('claude');
      await refresher.refresh('claude');
      assert.deepEqual(r.started, ['claude'], '두 번째는 건너뛴다');
      r.flush();
      await first;
    });

    it('끝난 뒤에는 다시 띄운다', async () => {
      const r = runner();
      const refresher = createTokenRefresher(r.run);
      const first = refresher.refresh('claude');
      r.flush();
      await first;
      const second = refresher.refresh('claude');
      assert.deepEqual(r.started, ['claude', 'claude']);
      r.flush();
      await second;
    });

    it('다른 CLI는 서로 막지 않는다', async () => {
      const r = runner();
      const refresher = createTokenRefresher(r.run);
      const a = refresher.refresh('claude');
      const b = refresher.refresh('codex');
      assert.deepEqual(r.started, ['claude', 'codex']);
      r.flush();
      await Promise.all([a, b]);
    });

    it('명령이 실패해도 던지지 않고 문을 연다', async () => {
      const refresher = createTokenRefresher(async () => { throw new Error('spawn failed'); });
      await refresher.refresh('claude');
      let ran = false;
      await createTokenRefresher(async () => { ran = true; }).refresh('claude');
      assert.equal(ran, true);
      await refresher.refresh('claude');
    });
  });
});
