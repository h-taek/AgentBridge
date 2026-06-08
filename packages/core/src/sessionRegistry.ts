// CLI native 세션 파일 삭제 헬퍼.
//
// 2026-06-01 Phase 6.B: SessionRegistry 인터페이스 + createSessionRegistry + LegacySessionMeta
// 폐기. 세션 메타는 workspace.json sessions[]에 통합 저장 (workspaceStore 참조).
// 이 파일에는 호스트가 직접 호출하는 native 파일 삭제 함수들만 남김.
//   - claude: ~/.claude/projects/<*>/<sessionId>.jsonl
//   - codex:  ~/.codex/sessions/<Y>/<M>/<D>/rollout-*-<sessionId>.jsonl
//   - agy:    ~/.gemini/antigravity-cli/conversations/<sessionId>.db (구버전: .pb)

import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { CliKind } from './shared/cli';
import type { Logger } from './interfaces';
import { noopLogger } from './interfaces';

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
  // agy CLI 2026-06-02 업데이트로 conversation 포맷이 .pb(protobuf) → .db(SQLite)로 변경됨.
  // 구버전 호환을 위해 두 확장자 모두 삭제 시도.
  const conversationsDir = join(homedir(), '.gemini', 'antigravity-cli', 'conversations');
  for (const ext of ['.db', '.pb']) {
    const file = join(conversationsDir, `${sessionId}${ext}`);
    try {
      await fs.unlink(file);
      logger.log(`sessionRegistry: agy native conversation deleted — ${file}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn(`sessionRegistry: agy native delete failed — ${file}`);
      }
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
