// 0.6.0 사용량 조회 4단계 — 캐시와 폴링.
//
// 스냅샷은 확장 호스트 메모리에만 둔다. 디스크에 쓰지 않는다.
import { strict as assert } from 'assert';
import type { CliKind, UsageSnapshot } from '@agentbridge/core';
import { createUsageStore, POLL_MS, TTL_MS } from '../src/core/usage/usageStore';

const snap = (cli: CliKind, used: number, at: number): UsageSnapshot => ({
  cli,
  planName: null,
  windows: [{ id: 'session', usedPercent: used, resetsAt: null }],
  fetchedAt: at,
  status: 'ok',
});

function harness(opts: {
  results?: Partial<Record<CliKind, UsageSnapshot | null | Error>>;
} = {}) {
  let clock = 1_788_000_000_000;
  const asked: CliKind[] = [];
  const scheduled: Array<{ fn: () => void; ms: number }> = [];
  let cleared = 0;

  const store = createUsageStore({
    now: () => clock,
    fetchOne: async (cli) => {
      asked.push(cli);
      const r = opts.results?.[cli];
      if (r instanceof Error) throw r;
      if (r === null) return null;
      return r ?? snap(cli, 10, clock);
    },
    schedule: (fn, ms) => {
      scheduled.push({ fn, ms });
      return () => { cleared += 1; };
    },
  });

  return {
    store,
    asked,
    scheduled,
    advance: (ms: number) => { clock += ms; },
    at: () => clock,
    clearedCount: () => cleared,
  };
}

describe('usage/usageStore', () => {
  it('처음 새로고침하면 세 CLI를 모두 조회한다', async () => {
    const h = harness();
    await h.store.refresh();
    assert.deepEqual([...h.asked].sort(), ['agy', 'claude', 'codex']);
  });

  it('TTL 안에서는 다시 조회하지 않는다', async () => {
    const h = harness();
    await h.store.refresh();
    h.advance(TTL_MS - 1);
    await h.store.refresh();
    assert.equal(h.asked.length, 3);
  });

  it('TTL이 지나면 다시 조회한다', async () => {
    const h = harness();
    await h.store.refresh();
    h.advance(TTL_MS);
    await h.store.refresh();
    assert.equal(h.asked.length, 6);
  });

  it('강제 새로고침은 TTL을 무시한다', async () => {
    const h = harness();
    await h.store.refresh();
    await h.store.refresh({ force: true });
    assert.equal(h.asked.length, 6);
  });

  it('자격증명이 없는 CLI는 결과에 담지 않는다', async () => {
    const h = harness({ results: { agy: null } });
    await h.store.refresh();
    assert.deepEqual(Object.keys(h.store.getAll()).sort(), ['claude', 'codex']);
  });

  it('하나가 던져도 나머지 결과를 쓴다', async () => {
    const h = harness({ results: { codex: new Error('boom') } });
    await h.store.refresh();
    assert.deepEqual(Object.keys(h.store.getAll()).sort(), ['agy', 'claude']);
  });

  it('던진 CLI도 TTL을 소모한다 — 곧장 다시 때리지 않는다', async () => {
    const h = harness({ results: { codex: new Error('boom') } });
    await h.store.refresh();
    await h.store.refresh();
    assert.equal(h.asked.length, 3);
  });

  it('조회가 끝나면 구독자에게 알린다', async () => {
    const h = harness();
    let calls = 0;
    h.store.onChange(() => { calls += 1; });
    await h.store.refresh();
    assert.equal(calls, 1);
  });

  it('TTL에 막혀 아무것도 안 했으면 알리지 않는다', async () => {
    const h = harness();
    await h.store.refresh();
    let calls = 0;
    h.store.onChange(() => { calls += 1; });
    await h.store.refresh();
    assert.equal(calls, 0);
  });

  it('구독을 끊으면 더는 안 온다', async () => {
    const h = harness();
    let calls = 0;
    const off = h.store.onChange(() => { calls += 1; });
    off();
    await h.store.refresh();
    assert.equal(calls, 0);
  });

  it('폴링은 5분 간격으로 건다', () => {
    const h = harness();
    h.store.start();
    assert.equal(h.scheduled.length, 1);
    assert.equal(h.scheduled[0].ms, POLL_MS);
  });

  it('dispose하면 폴링을 걷는다', () => {
    const h = harness();
    h.store.start();
    h.store.dispose();
    assert.equal(h.clearedCount(), 1);
  });

  it('세 CLI를 동시에 보낸다 — 순차가 아니다', async () => {
    let inFlight = 0;
    let peak = 0;
    const store = createUsageStore({
      now: () => 0,
      fetchOne: async (cli) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setImmediate(r));
        inFlight -= 1;
        return snap(cli, 1, 0);
      },
      schedule: () => () => {},
    });
    await store.refresh();
    assert.equal(peak, 3);
  });
});
