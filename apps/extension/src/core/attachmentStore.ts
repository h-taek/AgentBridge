// 첨부파일을 워크스페이스 데이터 폴더의 attachments/ 아래에 저장한다 (0.5.0 B-1).
//
// 0.5.0 전에는 사용자 프로젝트 안 `<cwd>/.agentbridge/attachments/`에 썼다. 남의 저장소에
// 우리 폴더를 만드는 일이라 `.gitignore`까지 고쳐야 했다. 이제 우리 저장소 안에 두므로
// 프로젝트 폴더에 아무것도 남기지 않고, gitignore도 건드릴 이유가 없다.
//
// 대신 저장 위치가 작업 폴더 밖이 된다. claude는 밖의 경로를 읽을 때 승인을 요구하므로
// 기동 인자 `--add-dir <워크스페이스 폴더>`가 함께 있어야 첨부가 읽힌다 (research 06 §1).

import { promises as fs } from 'fs';
import { basename, dirname, join } from 'path';
import { type Logger, noopLogger } from '@agentbridge/core';
import { getWorkspacePath } from './workspaceStore';

// 단방향 의존: coreInstances가 init 시점에 setAttachmentLogger로 logger 주입.
let _logger: Logger = noopLogger;
export function setAttachmentLogger(logger: Logger): void {
  _logger = logger;
}

const TTL_MS = 60 * 60 * 1000; // 1 hour
// 구버전이 사용자 프로젝트 안에 만들던 폴더 이름. 이제 만들지 않고 정리만 한다.
const LEGACY_DIR_NAME = '.agentbridge';

function attachmentsRoot(workspaceId: string): string {
  return join(getWorkspacePath(workspaceId), 'attachments');
}

// sessionId는 디렉토리 분리용. 반환은 절대 경로.
// path.basename으로 filename에 포함된 경로 분리자(../, /)를 제거해 traversal 방어층을 둔다.
export function attachmentPathFor(
  workspaceId: string,
  sessionId: string,
  filename: string,
): string {
  return join(attachmentsRoot(workspaceId), basename(sessionId), basename(filename));
}

export async function writeAttachment(absPath: string, base64: string): Promise<void> {
  await fs.mkdir(dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, Buffer.from(base64, 'base64'));
}

export async function cleanupSessionAttachments(
  workspaceId: string,
  sessionId: string,
): Promise<void> {
  const dir = join(attachmentsRoot(workspaceId), basename(sessionId));
  try {
    await fs.rm(dir, { recursive: true, force: true });
    _logger.log(`attachments cleaned for session ${sessionId.slice(0, 8)}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      _logger.warn(`attachment cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export async function cleanupStaleAttachments(workspaceId: string): Promise<void> {
  const attRoot = attachmentsRoot(workspaceId);
  let sessionDirs: string[];
  try {
    sessionDirs = await fs.readdir(attRoot);
  } catch {
    return;
  }

  const now = Date.now();
  let deleted = 0;
  for (const sid of sessionDirs) {
    const sDir = join(attRoot, sid);
    let files: string[];
    try {
      files = await fs.readdir(sDir);
    } catch {
      continue;
    }
    for (const f of files) {
      const fp = join(sDir, f);
      try {
        const st = await fs.stat(fp);
        if (now - st.mtimeMs > TTL_MS) {
          await fs.unlink(fp);
          deleted++;
        }
      } catch {
        /* skip */
      }
    }
    try {
      if ((await fs.readdir(sDir)).length === 0) await fs.rmdir(sDir);
    } catch {
      /* skip */
    }
  }
  if (deleted > 0) {
    _logger.log(`attachment cleanup: removed ${deleted} stale files (>${TTL_MS / 60000}min)`);
  }
}

// 구버전이 사용자 프로젝트에 만든 `.agentbridge/` 폴더를 걷어낸다.
//
// 안에 있던 첨부는 옮기지 않고 지운다. 수명이 1시간짜리라 옮겨 봐야 곧 지워지고,
// 경로가 이미 지난 대화에 박혀 있어 옮기면 오히려 그 경로가 어긋난다.
//
// 우리가 아는 것(attachments/)만 지우고, 그 결과 폴더가 비면 폴더도 지운다. 모르는 내용이
// 들어 있으면 손대지 않는다. `.gitignore`에 덧붙였던 줄은 남긴다 — 지우면 사용자 저장소에
// 우리가 만든 diff가 하나 더 생기고, 남아 있어도 해가 없다.
export async function cleanupLegacyProjectFolder(cwd: string): Promise<boolean> {
  const legacyDir = join(cwd, LEGACY_DIR_NAME);
  try {
    await fs.rm(join(legacyDir, 'attachments'), { recursive: true, force: true });
    if ((await fs.readdir(legacyDir)).length > 0) return false;
    await fs.rmdir(legacyDir);
    _logger.log(`removed legacy project folder ${legacyDir}`);
    return true;
  } catch {
    return false; // 없거나 안 비었음
  }
}
