// Codex `thread_id` 캡처. spawn 직전 ~/.codex/sessions 스냅샷 → 백그라운드 polling으로
// 새로 생긴 rollout jsonl 감지 → 파일명에서 thread_id 추출.
//
// codex 인터랙티브 PTY 모드가 stream-json을 출력하지 않으므로 파일 시스템 우회.

import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Logger } from '../interfaces';
import { noopLogger } from '../interfaces';

const CODEX_SESSIONS_ROOT = path.join(os.homedir(), '.codex', 'sessions');

const ROLLOUT_FILE_RE =
  /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

export type CodexSessionSnapshot = {
  files: Set<string>;
};

// snapshot 이후 새로 생기는 파일만 감지하면 되므로 today + yesterday만 스캔(자정 경계).
// 전체 DFS는 누적 세션이 많은 사용자에서 polling 시 I/O 스파이크 유발.
async function walkRolloutFiles(daysBack = 1): Promise<Set<string>> {
  const out = new Set<string>();
  const now = new Date();
  for (let back = 0; back <= daysBack; back++) {
    const d = new Date(now.getTime() - back * 24 * 60 * 60 * 1000);
    const y = String(d.getFullYear());
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const dp = path.join(CODEX_SESSIONS_ROOT, y, m, day);
    let entries: string[];
    try {
      entries = await fs.readdir(dp);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.endsWith('.jsonl') && ROLLOUT_FILE_RE.test(e)) {
        out.add(path.join(dp, e));
      }
    }
  }
  return out;
}

export async function snapshotCodexSessions(): Promise<CodexSessionSnapshot> {
  const files = await walkRolloutFiles();
  return { files };
}

export type CaptureOptions = {
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  logger?: Logger;
};

export async function captureNewThreadId(
  before: CodexSessionSnapshot,
  opts: CaptureOptions = {},
): Promise<string> {
  const log = opts.logger ?? noopLogger;
  const intervalMs = opts.intervalMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const start = Date.now();
  while (true) {
    if (opts.signal?.aborted) {
      throw new Error('codex thread_id capture aborted');
    }
    const now = await walkRolloutFiles();
    for (const f of now) {
      if (!before.files.has(f)) {
        const base = path.basename(f);
        const m = ROLLOUT_FILE_RE.exec(base);
        if (m) {
          log.log(`codexSessionWatcher: thread_id captured ${m[1]} (${f})`);
          return m[1];
        }
      }
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `codex thread_id capture timeout (${timeoutMs}ms) — ~/.codex/sessions에 새 jsonl 미감지.`,
      );
    }
    await sleepWithAbort(intervalMs, opts.signal);
  }
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
