// 사용량 한 번 조회. 자격증명을 읽어 요청하고, 401·403이면 CLI에 갱신을 한 번 맡긴 뒤 다시 보낸다.
//
// 재시도는 주기당 한 번이다. 이 한계가 무너지면 만료된 토큰으로 헤드리스 CLI를 무한히 띄우게 된다.
// 갱신은 우리가 하지 않는다 — 리프레시 토큰을 읽지 않고, OAuth 흐름을 구현하지 않는다.
//
// fetch·자격증명·시계·갱신을 전부 주입받는다. 네트워크 없이 테스트가 돌아야 하기 때문이다.

import { normalizeUsage, buildUsageRequest, type CliKind, type UsageSnapshot } from '@agentbridge/core';
import {
  readClaudeCredential,
  readCodexCredential,
  readAgyCredential,
  type CredentialIO,
} from './credentials';

const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 1024 * 1024;

export interface FetchInitLike {
  method: string;
  headers: Record<string, string>;
  body?: string;
  redirect: 'error';
  signal: AbortSignal;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchLike = (url: string, init: FetchInitLike) => Promise<FetchResponseLike>;

/** Node의 전역 fetch를 FetchLike로 맞춘다. lib.dom에 기대지 않으려고 구조적으로만 좁힌다. */
export const systemFetch: FetchLike = (url, init) =>
  (globalThis as unknown as { fetch(u: string, i: unknown): Promise<FetchResponseLike> }).fetch(url, init);

export interface UsageFetchDeps {
  io: CredentialIO;
  fetchFn: FetchLike;
  /** 해당 CLI를 헤드리스로 한 번 띄웠다 닫아 자기 토큰을 갱신하게 한다. */
  refresh(cli: CliKind): Promise<void>;
  now(): number;
}

interface Ticket {
  accessToken: string;
  accountId: string | null;
  /** epoch ms. agy만 준다. */
  expiresAt: number | null;
}

function readTicket(cli: CliKind, io: CredentialIO): Ticket | null {
  if (cli === 'claude') {
    const c = readClaudeCredential(io);
    return c && { accessToken: c.accessToken, accountId: null, expiresAt: null };
  }
  if (cli === 'codex') {
    const c = readCodexCredential(io);
    return c && { accessToken: c.accessToken, accountId: c.accountId, expiresAt: null };
  }
  const c = readAgyCredential(io);
  return c && { accessToken: c.accessToken, accountId: null, expiresAt: c.expiresAt };
}

const snapshot = (cli: CliKind, status: UsageSnapshot['status'], fetchedAt: number): UsageSnapshot => ({
  cli,
  planName: null,
  windows: [],
  fetchedAt,
  status,
});

type Attempt =
  | { kind: 'snapshot'; snapshot: UsageSnapshot }
  | { kind: 'unauthorized' }
  | { kind: 'unavailable' };

async function attempt(cli: CliKind, ticket: Ticket, deps: UsageFetchDeps): Promise<Attempt> {
  const request = buildUsageRequest(cli, ticket);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: FetchResponseLike;
  try {
    response = await deps.fetchFn(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      // 리다이렉트를 따라가면 토큰이 다른 호스트로 흘러간다.
      redirect: 'error',
      signal: controller.signal,
    });
  } catch {
    return { kind: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) return { kind: 'unauthorized' };
  if (!response.ok) return { kind: 'unavailable' };

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { kind: 'snapshot', snapshot: snapshot(cli, 'unsupported', deps.now()) };
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    return { kind: 'unavailable' };
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    return { kind: 'snapshot', snapshot: snapshot(cli, 'unsupported', deps.now()) };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: 'snapshot', snapshot: snapshot(cli, 'unsupported', deps.now()) };
  }
  return { kind: 'snapshot', snapshot: normalizeUsage(cli, raw, deps.now()) };
}

/**
 * 한 CLI의 사용량을 조회한다.
 * 자격증명이 아예 없으면 `null` — 조회 실패와 다르다. 화면에서 그 CLI를 아예 뺀다.
 */
export async function fetchUsage(cli: CliKind, deps: UsageFetchDeps): Promise<UsageSnapshot | null> {
  let ticket = readTicket(cli, deps.io);
  if (!ticket) return null;

  let refreshed = false;

  // agy는 만료 시각을 자격증명과 같은 블록에 준다. 이미 지났으면 보내볼 것도 없다.
  if (ticket.expiresAt !== null && ticket.expiresAt <= deps.now()) {
    await deps.refresh(cli);
    refreshed = true;
    ticket = readTicket(cli, deps.io);
    if (!ticket) return snapshot(cli, 'unauthenticated', deps.now());
  }

  for (;;) {
    const result = await attempt(cli, ticket, deps);
    if (result.kind === 'snapshot') return result.snapshot;
    if (result.kind === 'unavailable') return snapshot(cli, 'unavailable', deps.now());

    if (refreshed) return snapshot(cli, 'unauthenticated', deps.now());
    await deps.refresh(cli);
    refreshed = true;
    const renewed = readTicket(cli, deps.io);
    if (!renewed) return snapshot(cli, 'unauthenticated', deps.now());
    ticket = renewed;
  }
}
