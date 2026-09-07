// 첨부파일을 저장소 루트의 attachments/ 아래에 평평하게 저장한다 (0.5.0 B-1).
//
// 0.5.0 전에는 사용자 프로젝트 안 `<cwd>/.agentbridge/attachments/<세션>/`에 썼다. 남의 저장소에
// 우리 폴더를 만드는 일이라 `.gitignore`까지 고쳐야 했다.
//
// 자리는 `~/agentbridge/attachments/<경로 다이제스트 4자>-<원본 이름>` 하나다.
// 세션으로 나누지 않는다 — 첨부는 대화에 경로로 박혀 나가고 수명이 한 시간짜리라, 어느 세션이
// 만들었는지가 쓰이는 자리가 없다. 다이제스트는 프로젝트를 가른다(같은 `screenshot.png`가
// 다른 프로젝트에서 서로를 덮지 않게).
//
// 저장 위치가 작업 폴더 밖이므로 claude는 `--add-dir`로 이 폴더를 함께 열어야 읽는다
// (research 06 §1).

import { promises as fs } from 'fs';
import { basename, dirname, join } from 'path';
import { type Logger, noopLogger, workspacePathDigest } from '@agentbridge/core';
import { getStorageRootPath } from './workspaceStore';

// 단방향 의존: coreInstances가 init 시점에 setAttachmentLogger로 logger 주입.
let _logger: Logger = noopLogger;
export function setAttachmentLogger(logger: Logger): void {
  _logger = logger;
}

const TTL_MS = 60 * 60 * 1000; // 1 hour
// 구버전이 사용자 프로젝트 안에 만들던 폴더 이름. 이제 만들지 않고 정리만 한다.
const LEGACY_DIR_NAME = '.agentbridge';

export function attachmentsRoot(): string {
  return join(getStorageRootPath(), 'attachments');
}

// 파일명을 한 세그먼트로 못박는다. 경로 분리자와 제어문자를 걷어내고, 앞뒤 점·하이픈을 떨어뜨려
// 숨김 파일이나 인자처럼 보이는 이름이 되지 않게 한다. 확장자는 따로 떼어 보존한다.
export function sanitizeAttachmentName(raw: string): string {
  const name = basename(String(raw ?? '')).replace(/[\u0000-\u001f\u007f]/g, '');
  const dot = name.lastIndexOf('.');
  // 앞이 비어 있으면(.gitignore 같은) 확장자로 치지 않는다.
  const hasExt = dot > 0 && dot < name.length - 1;
  const ext = hasExt ? name.slice(dot + 1).slice(0, 16) : '';
  const base = (hasExt ? name.slice(0, dot) : name)
    .replace(/\s+/g, ' ')
    .replace(/^[.\-\s]+/, '')
    .replace(/[.\-\s]+$/, '')
    .slice(0, 80)
    .trim();
  const safeBase = base || 'file';
  return ext ? `${safeBase}.${ext}` : safeBase;
}

// 반환은 절대 경로. 같은 프로젝트에서 같은 이름을 다시 넣으면 같은 자리에 덮어쓴다 —
// 첨부는 방금 넣은 것만 쓰이므로 그게 맞고, 경로가 예측 가능해진다.
export function attachmentPathFor(workspacePath: string, filename: string): string {
  const digest = workspacePathDigest(workspacePath);
  return join(attachmentsRoot(), `${digest}-${sanitizeAttachmentName(filename)}`);
}

export async function writeAttachment(absPath: string, base64: string): Promise<void> {
  await fs.mkdir(dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, Buffer.from(base64, 'base64'));
}

export async function cleanupStaleAttachments(): Promise<void> {
  const attRoot = attachmentsRoot();
  let files: string[];
  try {
    files = await fs.readdir(attRoot);
  } catch {
    return;
  }

  const now = Date.now();
  let deleted = 0;
  for (const f of files) {
    const fp = join(attRoot, f);
    try {
      const st = await fs.stat(fp);
      if (st.isFile() && now - st.mtimeMs > TTL_MS) {
        await fs.unlink(fp);
        deleted++;
      }
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
