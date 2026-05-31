// 워크스페이스별 sessions.json — 활성 세션 목록과 메타.
//
// 호스트 차이 흡수: workspace path 계산은 호스트가 책임지고 인자로 전달한다.
// attachment 청소는 원본에서 deleteSession 내부에서 fire-and-forget로 import했으나, 코어는
// 부수 효과를 호출자에게 위임 — onAfterDelete 콜백 또는 호출자가 직접 호출.

import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { CLI_DISPLAY_NAME, type CliKind } from './shared/cli';
import type { Logger } from './interfaces';
import { noopLogger } from './interfaces';

export interface SessionMeta {
  sessionId: string;
  workspaceId: string;
  model: CliKind;
  name: string;
  createdAt: string;
  lastActiveAt: string;
  turnCount: number;
  active: boolean;
  // codex thread_id / agy conversation UUID. claude는 sessionId === modelSessionId.
  modelSessionId?: string;
}

export type SessionRegistryOptions = {
  logger?: Logger;
  // delete 후 호출됨 (attachment 청소 등). throw하지 않도록 caller가 책임.
  onAfterDelete?: (workspaceId: string, sessionId: string) => void | Promise<void>;
};

// CLI별 native 세션 파일 삭제 — sessionRegistry.delete 외에 호스트가 별도 호출 가능하도록 export.
//   - claude: ~/.claude/projects/<*>/<sessionId>.jsonl
//   - codex:  ~/.codex/sessions/<Y>/<M>/<D>/rollout-*-<sessionId>.jsonl
//   - agy:    ~/.gemini/antigravity-cli/conversations/<sessionId>.pb

export async function deleteClaudeNativeSession(sessionId: string, logger: Logger = noopLogger): Promise<void> {
  const root = join(homedir(), '.claude', 'projects');
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return;
  }
  for (const p of entries) {
    const subDir = join(root, p);
    try {
      const stat = await fs.stat(subDir);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }
    const file = join(subDir, `${sessionId}.jsonl`);
    try {
      await fs.unlink(file);
      logger.log(`sessionRegistry: claude native session deleted — ${file}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn(`sessionRegistry: claude native delete failed — ${file}`);
      }
    }
  }
}

export async function deleteCodexNativeSession(sessionId: string, logger: Logger = noopLogger): Promise<void> {
  const root = join(homedir(), '.codex', 'sessions');
  const target = `-${sessionId.toLowerCase()}.jsonl`;
  let years: string[];
  try {
    years = await fs.readdir(root);
  } catch {
    return;
  }
  for (const y of years) {
    const yDir = join(root, y);
    let months: string[];
    try {
      months = await fs.readdir(yDir);
    } catch {
      continue;
    }
    for (const m of months) {
      const mDir = join(yDir, m);
      let days: string[];
      try {
        days = await fs.readdir(mDir);
      } catch {
        continue;
      }
      for (const d of days) {
        const dDir = join(mDir, d);
        let files: string[];
        try {
          files = await fs.readdir(dDir);
        } catch {
          continue;
        }
        for (const f of files) {
          if (!f.toLowerCase().endsWith(target)) continue;
          const file = join(dDir, f);
          try {
            await fs.unlink(file);
            logger.log(`sessionRegistry: codex native session deleted — ${file}`);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
              logger.warn(`sessionRegistry: codex native delete failed — ${file}`);
            }
          }
        }
      }
    }
  }
}

export async function deleteAgyNativeSession(sessionId: string, logger: Logger = noopLogger): Promise<void> {
  const file = join(
    homedir(),
    '.gemini',
    'antigravity-cli',
    'conversations',
    `${sessionId}.pb`,
  );
  try {
    await fs.unlink(file);
    logger.log(`sessionRegistry: agy native conversation deleted — ${file}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(`sessionRegistry: agy native delete failed — ${file}`);
    }
  }
}

export async function deleteNativeSession(model: CliKind, sessionId: string, logger?: Logger): Promise<void> {
  switch (model) {
    case 'claude':
      return deleteClaudeNativeSession(sessionId, logger);
    case 'codex':
      return deleteCodexNativeSession(sessionId, logger);
    case 'agy':
      return deleteAgyNativeSession(sessionId, logger);
  }
}

export interface SessionRegistry {
  register(workspaceId: string, workspaceRoot: string, sessionId: string, model: CliKind): Promise<SessionMeta>;
  updateActivity(workspaceId: string, workspaceRoot: string, sessionId: string): Promise<void>;
  setModelSessionId(workspaceId: string, workspaceRoot: string, sessionId: string, modelSessionId: string): Promise<void>;
  markClosed(workspaceId: string, workspaceRoot: string, sessionId: string): Promise<void>;
  resetAllActive(workspaceId: string, workspaceRoot: string): Promise<void>;
  markActive(workspaceId: string, workspaceRoot: string, sessionId: string): Promise<void>;
  rename(workspaceId: string, workspaceRoot: string, sessionId: string, name: string): Promise<void>;
  delete(workspaceId: string, workspaceRoot: string, sessionId: string): Promise<void>;
  list(workspaceRoot: string): Promise<SessionMeta[]>;
}

export function createSessionRegistry(opts: SessionRegistryOptions = {}): SessionRegistry {
  const log = opts.logger ?? noopLogger;
  const onAfterDelete = opts.onAfterDelete;

  // Per-workspace mutex — prevents read-modify-write race on sessions.json.
  const writeMutex = new Map<string, Promise<void>>();
  async function withWriteLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
    const prev = writeMutex.get(workspaceId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    writeMutex.set(workspaceId, prev.then(() => next));
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (writeMutex.get(workspaceId) === next) writeMutex.delete(workspaceId);
    }
  }

  function registryPath(workspaceRoot: string): string {
    return join(workspaceRoot, 'sessions.json');
  }

  async function loadRegistry(workspaceRoot: string): Promise<SessionMeta[]> {
    const p = registryPath(workspaceRoot);
    let raw: string;
    try {
      raw = await fs.readFile(p, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new Error('sessions.json is not an array');
      }
      return parsed as SessionMeta[];
    } catch (err) {
      const backup = `${p}.broken.${Date.now()}.bak`;
      try {
        await fs.writeFile(backup, raw, 'utf8');
        log.warn(
          `sessionRegistry: corrupt sessions.json — backed up to ${backup} (${err instanceof Error ? err.message : String(err)})`,
        );
      } catch {
        /* noop */
      }
      return [];
    }
  }

  async function saveRegistry(workspaceRoot: string, sessions: SessionMeta[]): Promise<void> {
    const p = registryPath(workspaceRoot);
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(sessions, null, 2), 'utf8');
    await fs.rename(tmp, p);
  }

  // Module-level deleteNativeSession을 logger 주입해 호출.
  const deleteNativeSessionInternal = (model: CliKind, sessionId: string): Promise<void> =>
    deleteNativeSession(model, sessionId, log);

  return {
    async register(workspaceId, workspaceRoot, sessionId, model) {
      return withWriteLock(workspaceId, async () => {
        const sessions = await loadRegistry(workspaceRoot);
        const now = new Date().toISOString();
        const meta: SessionMeta = {
          sessionId,
          workspaceId,
          model,
          name: CLI_DISPLAY_NAME[model],
          createdAt: now,
          lastActiveAt: now,
          turnCount: 0,
          active: true,
        };
        sessions.unshift(meta);
        await saveRegistry(workspaceRoot, sessions);
        log.log(`sessionRegistry: registered ${model} session ${sessionId.slice(0, 8)}`);
        return meta;
      });
    },

    async updateActivity(workspaceId, workspaceRoot, sessionId) {
      return withWriteLock(workspaceId, async () => {
        const sessions = await loadRegistry(workspaceRoot);
        const s = sessions.find((x) => x.sessionId === sessionId);
        if (!s) return;
        s.lastActiveAt = new Date().toISOString();
        s.turnCount++;
        await saveRegistry(workspaceRoot, sessions);
      });
    },

    async setModelSessionId(workspaceId, workspaceRoot, sessionId, modelSessionId) {
      return withWriteLock(workspaceId, async () => {
        const sessions = await loadRegistry(workspaceRoot);
        const s = sessions.find((x) => x.sessionId === sessionId);
        if (!s) return;
        s.modelSessionId = modelSessionId;
        await saveRegistry(workspaceRoot, sessions);
        log.log(
          `sessionRegistry: modelSessionId set sessionId=${sessionId.slice(0, 8)} → ${modelSessionId.slice(0, 8)}`,
        );
      });
    },

    async markClosed(workspaceId, workspaceRoot, sessionId) {
      return withWriteLock(workspaceId, async () => {
        const sessions = await loadRegistry(workspaceRoot);
        const s = sessions.find((x) => x.sessionId === sessionId);
        if (!s) return;
        s.active = false;
        await saveRegistry(workspaceRoot, sessions);
      });
    },

    async resetAllActive(workspaceId, workspaceRoot) {
      return withWriteLock(workspaceId, async () => {
        const sessions = await loadRegistry(workspaceRoot);
        let changed = false;
        for (const s of sessions) {
          if (s.active) {
            s.active = false;
            changed = true;
          }
        }
        if (changed) await saveRegistry(workspaceRoot, sessions);
      });
    },

    async markActive(workspaceId, workspaceRoot, sessionId) {
      return withWriteLock(workspaceId, async () => {
        const sessions = await loadRegistry(workspaceRoot);
        const s = sessions.find((x) => x.sessionId === sessionId);
        if (!s) return;
        if (s.active) return;
        s.active = true;
        s.lastActiveAt = new Date().toISOString();
        await saveRegistry(workspaceRoot, sessions);
      });
    },

    async rename(workspaceId, workspaceRoot, sessionId, name) {
      return withWriteLock(workspaceId, async () => {
        const sessions = await loadRegistry(workspaceRoot);
        const s = sessions.find((x) => x.sessionId === sessionId);
        if (!s) return;
        s.name = name;
        await saveRegistry(workspaceRoot, sessions);
      });
    },

    async delete(workspaceId, workspaceRoot, sessionId) {
      return withWriteLock(workspaceId, async () => {
        const sessions = await loadRegistry(workspaceRoot);
        const target = sessions.find((x) => x.sessionId === sessionId);
        if (target) {
          // claude는 sessionId === modelSessionId. codex/agy는 캡처된 modelSessionId가 있어야 native 정리.
          const nativeId = target.modelSessionId ?? (target.model === 'claude' ? sessionId : null);
          if (nativeId) {
            await deleteNativeSessionInternal(target.model, nativeId);
          }
        }
        const filtered = sessions.filter((x) => x.sessionId !== sessionId);
        await saveRegistry(workspaceRoot, filtered);
        // 부수 효과는 호출자에게 위임. attachment 청소 등.
        if (onAfterDelete) {
          try {
            await onAfterDelete(workspaceId, sessionId);
          } catch (err) {
            log.warn(
              `sessionRegistry: onAfterDelete failed (sessionId=${sessionId}) — ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      });
    },

    async list(workspaceRoot) {
      const sessions = await loadRegistry(workspaceRoot);
      return sessions.slice().sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        return new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime();
      });
    },
  };
}
