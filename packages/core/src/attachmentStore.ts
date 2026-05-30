// 워크스페이스 cwd 아래 .agentbridge/attachments/ 디렉토리에 첨부파일을 저장한다.
//
// 호스트 차이 흡수: 원본은 vscode.workspace.workspaceFolders로 cwd를 얻었지만, 코어는
// 호스트가 cwd를 인자로 전달한다. (Electron 앱은 활성 워크스페이스 폴더, 익스텐션은 VS Code
// workspaceFolders[0])

import { promises as fs } from 'fs';
import { basename, dirname, join } from 'path';
import type { Logger } from './interfaces';
import { noopLogger } from './interfaces';

const TTL_MS = 60 * 60 * 1000; // 1 hour
const ATTACH_DIR_NAME = '.agentbridge';

function attachmentsRoot(cwd: string): string {
  return join(cwd, ATTACH_DIR_NAME, 'attachments');
}

// sessionId는 디렉토리 분리용. 반환은 절대 경로.
// path.basename으로 filename에 포함된 경로 분리자(../, /)를 제거해 traversal 방어층을 둔다.
export function attachmentPathFor(cwd: string, sessionId: string, filename: string): string {
  const safeName = basename(filename);
  const safeSession = basename(sessionId);
  return join(attachmentsRoot(cwd), safeSession, safeName);
}

export type AttachmentStoreOptions = {
  logger?: Logger;
};

export async function writeAttachment(
  cwd: string,
  absPath: string,
  base64: string,
  opts: AttachmentStoreOptions = {},
): Promise<void> {
  await fs.mkdir(dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, Buffer.from(base64, 'base64'));
  await ensureGitignoreEntry(cwd, opts);
}

// .gitignore에 .agentbridge/ 항목 자동 추가 (이미 있으면 skip).
async function ensureGitignoreEntry(
  cwd: string,
  opts: AttachmentStoreOptions,
): Promise<void> {
  const log = opts.logger ?? noopLogger;
  const gitignore = join(cwd, '.gitignore');
  try {
    const raw = await fs.readFile(gitignore, 'utf8');
    const lines = raw.split(/\r?\n/);
    if (lines.some((l) => l.trim() === ATTACH_DIR_NAME || l.trim() === ATTACH_DIR_NAME + '/'))
      return;
    const appended = (raw.endsWith('\n') ? raw : raw + '\n') + ATTACH_DIR_NAME + '/\n';
    await fs.writeFile(gitignore, appended, 'utf8');
    log.log(`appended ${ATTACH_DIR_NAME}/ to .gitignore`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // git 리포가 아닐 수도 있음 — .gitignore 새로 만들지는 않음.
      return;
    }
    log.warn(`gitignore update failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// 세션 단위 청소 — sessionRegistry.deleteSession에서 호출.
export async function cleanupSessionAttachments(
  cwd: string,
  sessionId: string,
  opts: AttachmentStoreOptions = {},
): Promise<void> {
  const log = opts.logger ?? noopLogger;
  const dir = join(attachmentsRoot(cwd), sessionId);
  try {
    await fs.rm(dir, { recursive: true, force: true });
    log.log(`attachments cleaned for session ${sessionId.slice(0, 8)}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(
        `attachment cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

// 워크스페이스 .agentbridge/attachments에서 TTL 초과 파일 삭제.
export async function cleanupStaleAttachments(
  cwd: string,
  opts: AttachmentStoreOptions = {},
): Promise<void> {
  const log = opts.logger ?? noopLogger;
  const attRoot = attachmentsRoot(cwd);
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
      const remaining = await fs.readdir(sDir);
      if (remaining.length === 0) await fs.rmdir(sDir);
    } catch {
      /* skip */
    }
  }
  if (deleted > 0)
    log.log(`attachment cleanup: removed ${deleted} stale files (>${TTL_MS / 60000}min)`);
}
