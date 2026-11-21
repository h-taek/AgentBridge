// 화면 기록 보관 기간 정리 (0.8.0) — 최종 수정 시각이 7일을 넘은 replay.log를 지운다.
// 소유 표지(owner.json)를 쓰는 acquireOwnership과 같은 파일 락(withFileLock)을 써서,
// '소유자 없음'을 본 직후 다른 창이 소유권을 잡고 기록을 여는 경합을 막는다.

import { promises as fsp } from 'fs';
import { join } from 'path';
import { withFileLock } from './fileLock';
import { replayLogPath } from './replayPaths';
import { isSessionOwned } from './sessionOwner';

export const REPLAY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null | undefined)?.code;
}

async function readDirNames(dir: string): Promise<{ names: string[]; errorPath?: string }> {
  try {
    return { names: await fsp.readdir(dir) };
  } catch (err) {
    const code = errorCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { names: [] };
    }
    return { names: [], errorPath: dir };
  }
}

// workspaces/*/sessions/*/replay.log를 훑어 7일 넘은 무소유 기록을 지운다.
export async function sweepOldReplayLogs(
  storageRoot: string,
  now: number,
): Promise<{ removed: number; bytes: number; failed: string[] }> {
  const result = { removed: 0, bytes: 0, failed: [] as string[] };
  const workspacesRoot = join(storageRoot, 'workspaces');
  const wsList = await readDirNames(workspacesRoot);
  if (wsList.errorPath) {
    result.failed.push(wsList.errorPath);
    return result;
  }

  for (const ws of wsList.names) {
    const sessionsRoot = join(workspacesRoot, ws, 'sessions');
    const sessionList = await readDirNames(sessionsRoot);
    if (sessionList.errorPath) {
      result.failed.push(sessionList.errorPath);
      continue;
    }

    for (const sid of sessionList.names) {
      const sessionDir = join(sessionsRoot, sid);
      const logPath = replayLogPath(sessionDir);

      // 락을 잡기 전에 먼저 훑어 미존재·최근 기록은 건너뛴다.
      let preStat;
      try {
        preStat = await fsp.stat(logPath);
      } catch (err) {
        const code = errorCode(err);
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
          result.failed.push(logPath);
        }
        continue;
      }
      if (now - preStat.mtimeMs <= REPLAY_RETENTION_MS) {
        continue;
      }

      try {
        await withFileLock(sessionDir, async () => {
          let st;
          try {
            st = await fsp.stat(logPath);
          } catch (err) {
            if (errorCode(err) !== 'ENOENT') {
              result.failed.push(logPath);
            }
            return;
          }
          if (now - st.mtimeMs <= REPLAY_RETENTION_MS) {
            return;
          }
          if (await isSessionOwned(sessionDir)) {
            return;
          }
          try {
            await fsp.unlink(logPath);
          } catch (err) {
            if (errorCode(err) !== 'ENOENT') {
              result.failed.push(logPath);
            }
            return;
          }
          result.removed += 1;
          result.bytes += st.size;
        });
      } catch {
        result.failed.push(logPath);
      }
    }
  }

  return result;
}
