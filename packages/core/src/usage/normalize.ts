// 벤더 응답 → UsageSnapshot. 순수 함수라 네트워크도 파일도 건드리지 않는다.
//
// 벤더가 응답을 바꾸면 창을 하나도 못 읽는다. 그때 던지지 않고 unsupported로 끝내는 것이
// 이 파일의 계약이다 — 폴링이 CLI 하나 때문에 멈추면 안 된다.

import type { CliKind } from '../shared/cli';
import type { UsageSnapshot, UsageWindow, UsageWindowId } from '../shared/usage';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null;

const finiteNum = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

const percent = (n: number): number => Math.min(100, Math.max(0, Math.round(n * 10) / 10));

const isoMs = (v: unknown): number | null => {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

// claude — five_hour / seven_day의 utilization은 퍼센트, resets_at은 ISO8601.
function readClaude(raw: Obj): UsageWindow[] {
  const out: UsageWindow[] = [];
  const put = (id: UsageWindowId, src: unknown): void => {
    if (!isObj(src)) return;
    const used = finiteNum(src.utilization);
    if (used === undefined) return;
    out.push({ id, usedPercent: percent(used), resetsAt: isoMs(src.resets_at) });
  };
  put('session', raw.five_hour);
  put('weekly', raw.seven_day);
  return out;
}

// codex — rate_limit의 primary/secondary. reset_at은 epoch 초라 1000을 곱한다.
//
// 어느 칸이 5시간이고 어느 칸이 주간인지는 칸 순서가 아니라 limit_window_seconds로 가른다.
// 5시간 한도가 없는 Pro는 첫째 칸에 주간 창이 올 수 있다. codex CLI도 길이로 이름을 붙이고
// 5% 오차를 같은 창으로 본다(codex-rs tui `get_limits_duration`). 길이가 없으면 칸 순서를 따르고,
// 5시간도 주간도 아닌 길이의 창은 뺀다.
const SESSION_SECONDS = 5 * 60 * 60;
const WEEKLY_SECONDS = 7 * 24 * 60 * 60;

const near = (seconds: number, expected: number): boolean =>
  seconds >= expected * 0.95 && seconds <= expected * 1.05;

function codexWindowId(src: Obj, byPosition: UsageWindowId): UsageWindowId | null {
  const seconds = finiteNum(src.limit_window_seconds);
  if (seconds === undefined || seconds <= 0) return byPosition;
  if (near(seconds, SESSION_SECONDS)) return 'session';
  if (near(seconds, WEEKLY_SECONDS)) return 'weekly';
  return null;
}

function readCodex(raw: Obj): UsageWindow[] {
  const limit = raw.rate_limit;
  if (!isObj(limit)) return [];
  const out: UsageWindow[] = [];
  const put = (byPosition: UsageWindowId, src: unknown): void => {
    if (!isObj(src)) return;
    const used = finiteNum(src.used_percent);
    if (used === undefined) return;
    const id = codexWindowId(src, byPosition);
    if (id === null || out.some((w) => w.id === id)) return;
    const seconds = finiteNum(src.reset_at);
    out.push({
      id,
      usedPercent: percent(used),
      resetsAt: seconds === undefined ? null : seconds * 1000,
    });
  };
  put('session', limit.primary_window);
  put('weekly', limit.secondary_window);
  return out;
}

// agy — groups[].buckets[]에서 bucketId로 찾는다. 값이 잔여율이라 뒤집는다.
// 3p-* 버킷(Claude·GPT 계열)은 이번 범위가 아니다.
function readAgy(raw: Obj): UsageWindow[] {
  if (!Array.isArray(raw.groups)) return [];
  const buckets = new Map<string, Obj>();
  for (const group of raw.groups) {
    if (!isObj(group) || !Array.isArray(group.buckets)) continue;
    for (const bucket of group.buckets) {
      if (!isObj(bucket) || typeof bucket.bucketId !== 'string') continue;
      if (!buckets.has(bucket.bucketId)) buckets.set(bucket.bucketId, bucket);
    }
  }
  const out: UsageWindow[] = [];
  const put = (id: UsageWindowId, bucketId: string): void => {
    const bucket = buckets.get(bucketId);
    if (!bucket) return;
    const remaining = finiteNum(bucket.remainingFraction);
    if (remaining === undefined) return;
    out.push({
      id,
      usedPercent: percent((1 - remaining) * 100),
      resetsAt: isoMs(bucket.resetTime),
    });
  };
  put('session', 'gemini-5h');
  put('weekly', 'gemini-weekly');
  return out;
}

const READERS: Record<CliKind, (raw: Obj) => UsageWindow[]> = {
  claude: readClaude,
  codex: readCodex,
  agy: readAgy,
};

export function normalizeUsage(cli: CliKind, raw: unknown, fetchedAt: number): UsageSnapshot {
  const windows = isObj(raw) ? READERS[cli](raw) : [];
  const planName =
    cli === 'codex' && isObj(raw) && typeof raw.plan_type === 'string' ? raw.plan_type : null;
  return {
    cli,
    planName,
    windows,
    fetchedAt,
    status: windows.length > 0 ? 'ok' : 'unsupported',
  };
}
