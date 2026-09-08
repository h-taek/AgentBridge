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
function readCodex(raw: Obj): UsageWindow[] {
  const limit = raw.rate_limit;
  if (!isObj(limit)) return [];
  const out: UsageWindow[] = [];
  const put = (id: UsageWindowId, src: unknown): void => {
    if (!isObj(src)) return;
    const used = finiteNum(src.used_percent);
    if (used === undefined) return;
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
