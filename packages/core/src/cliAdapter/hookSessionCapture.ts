// 세션 id 결정적 캡처 — 훅이 쓰는 단일 파일(<wsDir>/captured-<token>.json)만 감시한다.
// 전역 디렉토리 와치(mislink 위험)와 달리 파일이 세션별 토큰으로 키잉돼 같은 워크스페이스
// 동종 N세션도 안 섞인다. 시작 시 stale 파일을 제거해, 첫 턴 훅의 fresh write에만 반응한다.

import { promises as fs } from 'fs';
import { dirname, basename } from 'path';
import type { Logger } from '../interfaces';
import { noopLogger } from '../interfaces';
import { createSessionFileWatcher, type SessionFileWatcher } from '../sessionFileWatcher';

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
      let raw: string;
      try {
        raw = await fs.readFile(file, 'utf8');
      } catch {
        return; // 아직 없음
      }
      try {
        const obj = JSON.parse(raw) as { modelSessionId?: unknown };
        if (typeof obj.modelSessionId === 'string' && obj.modelSessionId.trim()) {
          log.log(`captureSessionIdFromHook: ${obj.modelSessionId} (${file})`);
          finish(obj.modelSessionId);
        }
      } catch {
        /* 부분 write 중 — 다음 트리거에 재시도 */
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
