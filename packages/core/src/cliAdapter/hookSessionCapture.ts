// 세션 id 결정적 캡처 — 훅이 쓰는 단일 파일(<wsDir>/captured-<token>.json)만 감시한다.
// 전역 디렉토리 와치(mislink 위험)와 달리 파일이 세션별 토큰으로 키잉돼 같은 워크스페이스
// 동종 N세션도 안 섞인다. 시작 시 stale 파일을 제거해, 첫 턴 훅의 fresh write에만 반응한다.

import { promises as fs } from 'fs';
import { dirname, basename, join } from 'path';
import type { Logger } from '../interfaces';
import { noopLogger } from '../interfaces';
import { createSessionFileWatcher, type SessionFileWatcher } from '../sessionFileWatcher';

// 훅이 캡처를 쓰는 자리. 세션 토큰으로 키잉해 같은 워크스페이스의 동종 N세션이 안 섞인다.
export function resolveHookCaptureFile(workspaceDir: string, captureToken: string): string {
  return join(workspaceDir, 'sessions', captureToken, 'captured.json');
}

// 캡처 파일에서 세션 id만 읽는다. 없거나 아직 쓰는 중이면 null.
export async function readCapturedSessionId(captureFilePath: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await fs.readFile(captureFilePath, 'utf8');
  } catch {
    return null;
  }
  try {
    const obj = JSON.parse(raw) as { modelSessionId?: unknown };
    if (typeof obj.modelSessionId === 'string' && obj.modelSessionId.trim()) {
      return obj.modelSessionId;
    }
  } catch {
    /* 부분 write 중 */
  }
  return null;
}

export async function captureSessionIdFromHook(opts: {
  captureFilePath: string;
  // 수명은 전적으로 이 시그널에 매인다(PTY exit/패널 dispose) → 필수.
  signal: AbortSignal;
  // watch 미지원/누락 시 안전망 폴링 주기. 기본 3초.
  intervalMs?: number;
  logger?: Logger;
}): Promise<string | null> {
  const log = opts.logger ?? noopLogger;
  const pollMs = opts.intervalMs ?? 3000;
  const file = opts.captureFilePath;
  const base = basename(file);
  if (opts.signal.aborted) return null;
  await fs.rm(file, { force: true }).catch(() => {}); // stale 제거

  return new Promise<string | null>((resolve) => {
    let settled = false;
    let watcher: SessionFileWatcher | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      watcher?.stop();
      opts.signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = (): void => finish(null);

    const check = async (): Promise<void> => {
      if (settled) return;
      const id = await readCapturedSessionId(file);
      if (id) {
        log.log(`captureSessionIdFromHook: ${id} (${file})`);
        finish(id);
      }
    };

    opts.signal.addEventListener('abort', onAbort, { once: true });
    // 주: OS watch(즉시성, dirname을 recursive watch하며 basename 매칭). 보조: 저빈도 폴링.
    watcher = createSessionFileWatcher({
      root: dirname(file),
      filenames: [base],
      onChange: () => void check(),
      logger: { warn: (m) => log.warn(m) },
    });
    timer = setInterval(() => void check(), pollMs);
    void check();
  });
}

// 훅 우선 + 폴백 유예. 훅이 오면 즉시 채택. 폴백이 먼저 오면 graceMs 동안 훅을 더 기다려,
// 훅이 살아있으면 항상 훅이 이기게 한다(전역 와치 mislink 방지). 훅이 끝내 안 오면 폴백 채택.
export async function coordinateCapture(opts: {
  hookCapture: Promise<string | null>;
  fallbackCapture: Promise<string | null>;
  graceMs?: number;
  signal: AbortSignal;
}): Promise<{ id: string; source: 'hook' | 'fallback' } | null> {
  if (opts.signal.aborted) return null;
  const grace = opts.graceMs ?? 2000;
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: { id: string; source: 'hook' | 'fallback' } | null): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    opts.signal.addEventListener('abort', () => done(null), { once: true });

    void opts.hookCapture
      .then((id) => {
        if (id) done({ id, source: 'hook' });
      })
      .catch(() => {});

    void opts.fallbackCapture
      .then(async (id) => {
        if (!id || settled) return;
        const hookWins = await Promise.race([
          opts.hookCapture.then((h) => !!h).catch(() => false),
          new Promise<boolean>((r) => setTimeout(() => r(false), grace)),
        ]);
        if (!hookWins) done({ id, source: 'fallback' });
      })
      .catch(() => {});
  });
}
