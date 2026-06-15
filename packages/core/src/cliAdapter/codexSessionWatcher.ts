// Codex `thread_id` 캡처. spawn 직전 ~/.codex/sessions 스냅샷 → 백그라운드 polling으로
// 새로 생긴 rollout jsonl 감지 → 파일명에서 thread_id 추출.
//
// codex 인터랙티브 PTY 모드가 stream-json을 출력하지 않으므로 파일 시스템 우회.

import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Logger } from '../interfaces';
import { noopLogger } from '../interfaces';
import { createSessionFileWatcher, type SessionFileWatcher } from '../sessionFileWatcher';

const CODEX_SESSIONS_ROOT = path.join(os.homedir(), '.codex', 'sessions');

const ROLLOUT_FILE_RE =
  /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

export type CodexSessionSnapshot = {
  files: Set<string>;
};

// snapshot 이후 새로 생기는 파일만 감지하면 되므로 today + yesterday만 스캔(자정 경계).
// 전체 DFS는 누적 세션이 많은 사용자에서 polling 시 I/O 스파이크 유발.
async function walkRolloutFiles(root: string, daysBack = 1): Promise<Set<string>> {
  const out = new Set<string>();
  const now = new Date();
  for (let back = 0; back <= daysBack; back++) {
    const d = new Date(now.getTime() - back * 24 * 60 * 60 * 1000);
    const y = String(d.getFullYear());
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const dp = path.join(root, y, m, day);
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

export async function snapshotCodexSessions(
  root: string = CODEX_SESSIONS_ROOT,
): Promise<CodexSessionSnapshot> {
  const files = await walkRolloutFiles(root);
  return { files };
}

export type CaptureOptions = {
  // watch 누락/미지원 시 안전망 폴링 주기. 기본 3초.
  intervalMs?: number;
  // 감시 루트 override(테스트용). 기본 ~/.codex/sessions.
  sessionsRoot?: string;
  // 데드라인이 없으므로 수명은 전적으로 이 시그널에 매인다 → **필수**. 호스트가 PTY exit/패널
  // dispose에 묶어 넘기지 않으면 워처가 영원히 살아남는다(누수). 옵셔널이면 호출부 누락을
  // 타입체커가 못 잡으므로 의도적으로 필수로 둔다.
  signal: AbortSignal;
  logger?: Logger;
};

// 새 codex 세션이 **첫 입력 시점에** 만드는 rollout jsonl을 잡아 thread_id를 돌려준다.
// OS watch(즉시성) + 저빈도 폴링(안전망)으로 감시하며 **데드라인은 없다** — 첫 입력이 언제
// 들어오든(채팅이 열려 있는 한) 잡는다. 수명은 opts.signal에 매여 있고(PTY exit/패널 dispose),
// abort되면 캡처 없이 null을 돌려준다.
export async function captureNewThreadId(
  before: CodexSessionSnapshot,
  opts: CaptureOptions,
): Promise<string | null> {
  const log = opts.logger ?? noopLogger;
  const pollMs = opts.intervalMs ?? 3000;
  const root = opts.sessionsRoot ?? CODEX_SESSIONS_ROOT;
  if (opts.signal.aborted) return null;

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

    // 트리거마다 폴더를 재스캔해 snapshot에 없던 새 rollout 파일을 찾는다(이벤트 자체는 믿지 않음).
    const check = async (): Promise<void> => {
      if (settled) return;
      let now: Set<string>;
      try {
        now = await walkRolloutFiles(root);
      } catch {
        return;
      }
      for (const f of now) {
        if (before.files.has(f)) continue;
        const m = ROLLOUT_FILE_RE.exec(path.basename(f));
        if (m) {
          log.log(`codexSessionWatcher: thread_id captured ${m[1]} (${f})`);
          finish(m[1]);
          return;
        }
      }
    };

    opts.signal.addEventListener('abort', onAbort, { once: true });
    // 주: OS watch(즉시성). 보조: 저빈도 폴링(루트 미존재·watch 미지원 안전망).
    watcher = createSessionFileWatcher({
      root,
      filenames: ['.jsonl'],
      onChange: () => void check(),
      logger: { warn: (m) => log.warn(m) },
    });
    timer = setInterval(() => void check(), pollMs);
    void check();
  });
}
