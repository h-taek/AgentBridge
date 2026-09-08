// 0.6.0 사용량 조회 3단계 — 조회와 401 재시도.
//
// 재시도는 주기당 한 번이다. 이게 무너지면 만료된 토큰으로 헤드리스 CLI를 무한히 띄우게 된다.
import { strict as assert } from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { CliKind } from '@agentbridge/core';
import { fetchUsage, type FetchInitLike, type FetchLike, type UsageFetchDeps } from '../src/core/usage/fetchUsage';
import type { CredentialIO } from '../src/core/usage/credentials';

const HOME = '/Users/tester';
const fixture = (name: string) =>
  readFileSync(join(__dirname, 'fixtures', 'usage', `${name}.json`), 'utf8');

const claudeBlob = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-secret' } });
const agyBlob = (expiry: string | null) =>
  'go-keyring-base64:' +
  Buffer.from(
    JSON.stringify({ token: { access_token: 'ya29.secret', ...(expiry ? { expiry } : {}) } }),
    'utf8',
  ).toString('base64');

function credIO(store: Record<string, string>): CredentialIO {
  return {
    readKeychain: (service, account) => store[account ? `${service}/${account}` : service] ?? null,
    readTextFile: () => null,
    env: {},
    home: HOME,
  };
}

const ok = (body: string) => ({
  ok: true,
  status: 200,
  headers: { get: (n: string) => (n.toLowerCase() === 'content-length' ? String(body.length) : null) },
  text: async () => body,
});
const fail = (status: number) => ({
  ok: false,
  status,
  headers: { get: () => null },
  text: async () => '{"error":"nope"}',
});

interface Harness {
  deps: UsageFetchDeps;
  calls: FetchInitLike[];
  refreshed: CliKind[];
}

function harness(opts: {
  store?: Record<string, string>;
  responses?: Array<ReturnType<typeof ok> | ReturnType<typeof fail> | Error>;
  now?: number;
  onRefresh?: (store: Record<string, string>) => void;
}): Harness {
  const store = opts.store ?? { 'Claude Code-credentials': claudeBlob };
  const queue = [...(opts.responses ?? [ok(fixture('claude'))])];
  const calls: FetchInitLike[] = [];
  const refreshed: CliKind[] = [];
  const fetchFn: FetchLike = async (_url, init) => {
    calls.push(init);
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (next instanceof Error) throw next;
    return next;
  };
  return {
    calls,
    refreshed,
    deps: {
      io: credIO(store),
      fetchFn,
      refresh: async (cli) => {
        refreshed.push(cli);
        opts.onRefresh?.(store);
      },
      now: () => opts.now ?? 1_788_000_000_000,
    },
  };
}

describe('usage/fetchUsage', () => {
  it('자격증명이 없으면 요청하지 않고 null을 준다', async () => {
    const h = harness({ store: {} });
    assert.equal(await fetchUsage('claude', h.deps), null);
    assert.equal(h.calls.length, 0);
  });

  it('200이면 정규화한 스냅샷을 준다', async () => {
    const h = harness({});
    const s = await fetchUsage('claude', h.deps);
    assert.equal(s?.status, 'ok');
    assert.equal(s?.windows.length, 2);
  });

  it('리다이렉트를 따르지 않고 중단 신호를 싣는다', async () => {
    const h = harness({});
    await fetchUsage('claude', h.deps);
    assert.equal(h.calls[0].redirect, 'error');
    assert.equal(typeof h.calls[0].signal, 'object');
  });

  it('401이면 한 번 갱신하고 다시 보낸다', async () => {
    const h = harness({ responses: [fail(401), ok(fixture('claude'))] });
    const s = await fetchUsage('claude', h.deps);
    assert.equal(s?.status, 'ok');
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.refreshed, ['claude']);
  });

  it('갱신 뒤에도 401이면 unauthenticated로 끝낸다', async () => {
    const h = harness({ responses: [fail(401)] });
    const s = await fetchUsage('claude', h.deps);
    assert.equal(s?.status, 'unauthenticated');
    assert.equal(h.calls.length, 2, '재시도는 한 번뿐이다');
    assert.equal(h.refreshed.length, 1);
  });

  it('403도 같은 경로를 탄다', async () => {
    const h = harness({ responses: [fail(403), ok(fixture('claude'))] });
    assert.equal((await fetchUsage('claude', h.deps))?.status, 'ok');
    assert.deepEqual(h.refreshed, ['claude']);
  });

  it('갱신 뒤 자격증명이 사라지면 unauthenticated다', async () => {
    const h = harness({
      responses: [fail(401)],
      onRefresh: (store) => { delete store['Claude Code-credentials']; },
    });
    const s = await fetchUsage('claude', h.deps);
    assert.equal(s?.status, 'unauthenticated');
    assert.equal(h.calls.length, 1);
  });

  it('500은 갱신 없이 unavailable이다', async () => {
    const h = harness({ responses: [fail(500)] });
    assert.equal((await fetchUsage('claude', h.deps))?.status, 'unavailable');
    assert.deepEqual(h.refreshed, []);
  });

  it('요청이 던지면 unavailable이다', async () => {
    const h = harness({ responses: [new Error('ECONNRESET')] });
    assert.equal((await fetchUsage('claude', h.deps))?.status, 'unavailable');
  });

  it('본문이 JSON이 아니면 unsupported다', async () => {
    const h = harness({ responses: [ok('<html>maintenance</html>')] });
    assert.equal((await fetchUsage('claude', h.deps))?.status, 'unsupported');
  });

  it('본문이 1MB를 넘으면 unsupported다', async () => {
    const h = harness({ responses: [ok('"' + 'x'.repeat(1024 * 1024) + '"')] });
    assert.equal((await fetchUsage('claude', h.deps))?.status, 'unsupported');
  });

  it('오류 결과에 토큰이 실리지 않는다', async () => {
    const h = harness({ responses: [fail(401)] });
    const s = await fetchUsage('claude', h.deps);
    assert.equal(JSON.stringify(s).includes('sk-ant-secret'), false);
  });

  describe('agy 만료 선판정', () => {
    const expired = { 'gemini/antigravity': agyBlob('2020-01-01T00:00:00Z') };
    const fresh = { 'gemini/antigravity': agyBlob('2999-01-01T00:00:00Z') };

    it('만료가 지났으면 요청 전에 먼저 갱신한다', async () => {
      const h = harness({ store: expired, responses: [ok(fixture('agy'))] });
      const s = await fetchUsage('agy', h.deps);
      assert.deepEqual(h.refreshed, ['agy']);
      assert.equal(h.calls.length, 1, '만료된 토큰으로는 보내지 않는다');
      assert.equal(s?.status, 'ok');
    });

    it('만료 전이면 갱신 없이 바로 보낸다', async () => {
      const h = harness({ store: fresh, responses: [ok(fixture('agy'))] });
      assert.equal((await fetchUsage('agy', h.deps))?.status, 'ok');
      assert.deepEqual(h.refreshed, []);
    });

    it('만료 갱신 뒤 401이 나도 재시도는 한 번뿐이다', async () => {
      const h = harness({ store: expired, responses: [fail(401)] });
      const s = await fetchUsage('agy', h.deps);
      assert.equal(s?.status, 'unauthenticated');
      assert.equal(h.refreshed.length, 1);
      assert.equal(h.calls.length, 1);
    });
  });
});
