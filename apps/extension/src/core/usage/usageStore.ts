// 사용량 스냅샷 보관과 폴링. 확장 호스트 메모리에만 둔다 — 디스크에 쓰지 않고 응답 원문을
// 보관하지 않는다.
//
// 시계와 타이머를 주입받는다. 5분 폴링과 60초 TTL을 실제로 기다리며 테스트할 수는 없다.

import { CLI_KINDS, type CliKind, type UsageSnapshot } from '@agentbridge/core';

export const TTL_MS = 60_000;
export const POLL_MS = 5 * 60_000;

export type UsageMap = Partial<Record<CliKind, UsageSnapshot>>;

export interface UsageStoreDeps {
  /** 자격증명이 없으면 null. 조회 실패와 다르다. */
  fetchOne(cli: CliKind): Promise<UsageSnapshot | null>;
  now(): number;
  schedule(fn: () => void, ms: number): () => void;
}

export interface UsageStore {
  getAll(): UsageMap;
  refresh(opts?: { force?: boolean }): Promise<void>;
  onChange(listener: () => void): () => void;
  start(): void;
  dispose(): void;
}

export function createUsageStore(deps: UsageStoreDeps): UsageStore {
  const snapshots = new Map<CliKind, UsageSnapshot>();
  const attemptedAt = new Map<CliKind, number>();
  const listeners = new Set<() => void>();
  let unschedule: (() => void) | undefined;

  const stale = (cli: CliKind): boolean => {
    const last = attemptedAt.get(cli);
    return last === undefined || deps.now() - last >= TTL_MS;
  };

  async function fetchInto(cli: CliKind): Promise<void> {
    // 성공이든 실패든 시도 시각을 남긴다. 실패한 CLI를 매 주기 다시 때리지 않기 위해서다.
    attemptedAt.set(cli, deps.now());
    try {
      const snapshot = await deps.fetchOne(cli);
      if (snapshot) snapshots.set(cli, snapshot);
      else snapshots.delete(cli);
    } catch {
      snapshots.delete(cli);
    }
  }

  return {
    getAll() {
      const out: UsageMap = {};
      for (const [cli, snapshot] of snapshots) out[cli] = snapshot;
      return out;
    },

    async refresh(opts) {
      const targets = opts?.force ? [...CLI_KINDS] : CLI_KINDS.filter(stale);
      if (targets.length === 0) return;
      // 하나가 실패해도 나머지 결과를 쓴다 — fetchInto가 스스로 삼킨다.
      await Promise.all(targets.map(fetchInto));
      for (const listener of listeners) listener();
    },

    onChange(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    start() {
      if (unschedule) return;
      unschedule = deps.schedule(() => { void this.refresh(); }, POLL_MS);
    },

    dispose() {
      unschedule?.();
      unschedule = undefined;
      listeners.clear();
    },
  };
}
