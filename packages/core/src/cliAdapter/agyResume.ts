// Agy(Antigravity) resume.
//
// 저장 위치:
//   - conversations: `~/.gemini/antigravity-cli/conversations/<UUID>.db` (SQLite)
//     ※ agy CLI 2026-06-02 업데이트 전에는 `<UUID>.pb` (protobuf) — 구버전 호환 위해 둘 다 인식.
//   - cwd→UUID 매핑: `~/.gemini/antigravity-cli/cache/last_conversations.json` (사용 안 함 — stale 가능)
//
// resume: `--conversation <UUID>`. 새 세션은 agy가 UUID 자체 생성 → spawn 후 conversations/ snapshot diff로 캡처.

import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Logger } from '../interfaces';
import { noopLogger } from '../interfaces';
import { createSessionFileWatcher, type SessionFileWatcher } from '../sessionFileWatcher';

const AGY_BASE_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli');

function getConversationsDir(): string {
  return path.join(AGY_BASE_DIR, 'conversations');
}

// agy CLI 2026-06-02 업데이트로 conversation 저장 포맷이 .pb(protobuf) → .db(SQLite)로 변경됨.
// 신포맷 우선, 구버전 사용자 호환을 위해 .pb도 함께 처리한다. (V-17 실기 검증에서 발견)
const CONVERSATION_EXTENSIONS = ['.db', '.pb'] as const;

function getConversationFilePathCandidates(uuid: string): string[] {
  return CONVERSATION_EXTENSIONS.map((ext) => path.join(getConversationsDir(), `${uuid}${ext}`));
}

async function hasAgyConversationFile(modelSessionId: string): Promise<boolean> {
  for (const file of getConversationFilePathCandidates(modelSessionId)) {
    try {
      const stat = await fs.stat(file);
      if (stat.isFile() && stat.size > 0) return true;
    } catch {
      /* 다음 확장자 후보 시도 */
    }
  }
  return false;
}

export type ResumeResolveOptions = {
  sessionId: string | null;
  logger?: Logger;
};

export async function resolveResumeArgs(opts: ResumeResolveOptions): Promise<string[]> {
  const log = opts.logger ?? noopLogger;
  if (!opts.sessionId) {
    throw new Error(
      'agy resume — modelSessionId가 비어있습니다. 이 thread를 삭제하고 새 워크스페이스를 만드세요.',
    );
  }
  const exists = await hasAgyConversationFile(opts.sessionId);
  if (!exists) {
    throw new Error(
      `agy conversation ${opts.sessionId}을(를) ${getConversationsDir()}에서 찾을 수 없습니다 — 메시지 교환 전 닫힌 빈 세션은 agy가 영속화하지 않습니다.`,
    );
  }
  log.log(`agyResume: UUID 직접 전달 — ${opts.sessionId}`);
  return ['--conversation', opts.sessionId];
}

const UUID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(?:pb|db)$/i;

// conversation 파일명 → UUID. 매칭 안 되면 null. (.pb/.db 모두 인식 — 회귀 테스트 대상)
export function parseConversationFilename(filename: string): string | null {
  const m = UUID_RE.exec(filename);
  return m ? m[1].toLowerCase() : null;
}

export async function snapshotAgyConversations(): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const entries = await fs.readdir(getConversationsDir());
    for (const e of entries) {
      const uuid = parseConversationFilename(e);
      if (uuid) out.add(uuid);
    }
  } catch {
    /* dir 없으면 빈 set */
  }
  return out;
}

// 새 agy 세션이 **첫 메시지 교환 시점에** 만드는 conversation 파일(<uuid>.db/.pb)을 잡아
// onCaptured로 넘긴다. OS watch(즉시성) + 저빈도 폴링(안전망)으로 감시하며 **데드라인은 없다**
// — 첫 입력이 언제 들어오든(채팅이 열려 있는 한) 잡는다. 수명은 abortSignal에 매여 있고
// (PTY exit/패널 dispose), abort되면 캡처 없이 종료한다.
export async function watchForNewConversationUuid(opts: {
  cwd: string;
  excludeUuids: Set<string>;
  // watch 누락/미지원 시 안전망 폴링 주기. 기본 3초.
  intervalMs?: number;
  // 감시 디렉터리 override(테스트용). 기본 ~/.gemini/antigravity-cli/conversations.
  conversationsDir?: string;
  onCaptured: (uuid: string) => void;
  abortSignal?: AbortSignal;
  logger?: Logger;
}): Promise<void> {
  const log = opts.logger ?? noopLogger;
  const pollMs = opts.intervalMs ?? 3000;
  const dir = opts.conversationsDir ?? getConversationsDir();
  if (opts.abortSignal?.aborted) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    let watcher: SessionFileWatcher | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      watcher?.stop();
      opts.abortSignal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = (): void => finish();

    // 트리거마다 conversations/를 재스캔해 excludeUuids에 없는 **최신** conversation 파일을 잡는다.
    const check = async (): Promise<void> => {
      if (settled) return;
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch {
        return;
      }
      let newest: { uuid: string; mtimeMs: number } | null = null;
      for (const e of entries) {
        const uuid = parseConversationFilename(e);
        if (!uuid || opts.excludeUuids.has(uuid)) continue;
        try {
          const stat = await fs.stat(path.join(dir, e));
          if (!stat.isFile() || stat.size === 0) continue;
          if (!newest || stat.mtimeMs > newest.mtimeMs) {
            newest = { uuid, mtimeMs: stat.mtimeMs };
          }
        } catch {
          /* skip */
        }
      }
      if (newest) {
        log.log(`agyResume: modelSessionId 캡처 완료 cwd=${opts.cwd} uuid=${newest.uuid}`);
        opts.onCaptured(newest.uuid);
        finish();
      }
    };

    opts.abortSignal?.addEventListener('abort', onAbort, { once: true });
    // 주: OS watch(즉시성). 보조: 저빈도 폴링(디렉터리 미존재·watch 미지원 안전망).
    watcher = createSessionFileWatcher({
      root: dir,
      filenames: [...CONVERSATION_EXTENSIONS],
      onChange: () => void check(),
      logger: { warn: (m) => log.warn(m) },
    });
    timer = setInterval(() => void check(), pollMs);
    void check();
  });
}
