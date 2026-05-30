// Agy(Antigravity) resume.
//
// 저장 위치:
//   - conversations: `~/.gemini/antigravity-cli/conversations/<UUID>.pb` (protobuf)
//   - cwd→UUID 매핑: `~/.gemini/antigravity-cli/cache/last_conversations.json` (사용 안 함 — stale 가능)
//
// resume: `--conversation <UUID>`. 새 세션은 agy가 UUID 자체 생성 → spawn 후 conversations/ snapshot diff로 캡처.

import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Logger } from '../interfaces';
import { noopLogger } from '../interfaces';

const AGY_BASE_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli');

function getConversationsDir(): string {
  return path.join(AGY_BASE_DIR, 'conversations');
}

function getConversationFilePath(uuid: string): string {
  return path.join(getConversationsDir(), `${uuid}.pb`);
}

async function hasAgyConversationFile(modelSessionId: string): Promise<boolean> {
  try {
    const stat = await fs.stat(getConversationFilePath(modelSessionId));
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
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

const UUID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.pb$/i;

export async function snapshotAgyConversations(): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const entries = await fs.readdir(getConversationsDir());
    for (const e of entries) {
      const m = UUID_RE.exec(e);
      if (m) out.add(m[1].toLowerCase());
    }
  } catch {
    /* dir 없으면 빈 set */
  }
  return out;
}

export async function watchForNewConversationUuid(opts: {
  cwd: string;
  excludeUuids: Set<string>;
  timeoutMs?: number;
  onCaptured: (uuid: string) => void;
  abortSignal?: AbortSignal;
  logger?: Logger;
}): Promise<void> {
  const log = opts.logger ?? noopLogger;
  const start = Date.now();
  const limit = opts.timeoutMs ?? 5 * 60_000;
  const interval = 1_000;
  while (!opts.abortSignal?.aborted) {
    const elapsed = Date.now() - start;
    if (elapsed > limit) {
      log.warn(`agyResume: modelSessionId 캡처 timeout cwd=${opts.cwd} elapsed=${elapsed}`);
      return;
    }
    try {
      const entries = await fs.readdir(getConversationsDir());
      let newest: { uuid: string; mtimeMs: number } | null = null;
      for (const e of entries) {
        const m = UUID_RE.exec(e);
        if (!m) continue;
        const uuid = m[1].toLowerCase();
        if (opts.excludeUuids.has(uuid)) continue;
        try {
          const stat = await fs.stat(path.join(getConversationsDir(), e));
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
        return;
      }
    } catch (err) {
      log.warn(`agyResume: scan failed — ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleepWithAbort(interval, opts.abortSignal);
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
