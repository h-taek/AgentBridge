// 프로젝트 폴더 이름 변경·이동 뒤 옛 워크스페이스 기록을 새 id로 이어받는다 (0.8.0).
//
// 이어받기 정책(표지 비교, 5단계 순서, 파일 락)은 이 모듈 한 곳에 모은다.
// 4단계는 workspaceStore.updateWorkspaceMeta를 쓰지 않고 workspace.json을 직접 덮어쓴다 —
// readWorkspaceMeta/writeWorkspaceMetaAtomic은 파일 안의 workspaceId로 경로를 정하므로 옛 id가
// 적힌 상태에서 부르면 옛 폴더가 다시 생긴다.

import { existsSync, realpathSync, promises as fsp } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { withFileLock } from './fileLock';
import { profileIdForPath } from './gitRemote';
import { getGlobalDir, projectsRoot } from './globalPaths';
import { canonicalWorkspacePath, deterministicWorkspaceId } from './workspaceId';
import {
  isSameFolderMark,
  type FolderMark,
  type WorkspaceListEntry,
  type WorkspaceMeta,
} from './workspaceStore';

export type TakeoverResult =
  | { kind: 'none' }                                    // 할 일 없음
  | { kind: 'took-over'; fromId: string; toId: string }
  | { kind: 'resumed'; toId: string }                   // 끊긴 이어받기를 마저 함
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'failed'; step: string; error: string };

export interface TakeoverDeps {
  listWorkspaces(): Promise<WorkspaceListEntry[]>;
  readFolderMark(path: string): FolderMark | null;
  repairWorktrees(repoPath: string, treePaths: string[]): Promise<void>; // 실패하면 던진다
  resolveProjectProfileId(cwd: string): Promise<{ id: string; keyedBy: 'remote' | 'path' }>;
  log(line: string): void;
}

function isSamePath(recorded: unknown, folderPath: string): boolean {
  if (typeof recorded !== 'string' || recorded.length === 0) return false;
  return canonicalWorkspacePath(recorded) === canonicalWorkspacePath(folderPath);
}

// 옛 경로는 이미 옮겨져 마지막 세그먼트가 없으므로, 남아 있는 상위 폴더까지 realpath를 풀어
// 옮기기 전 canonicalWorkspacePath(예: macOS /var → /private/var)와 일치시킨다.
function canonicalizeMovedPath(folderFsPath: string): string {
  const parts: string[] = [];
  let cur = resolve(folderFsPath);
  for (;;) {
    try {
      const real = realpathSync(cur);
      return (parts.length > 0 ? join(real, ...parts.reverse()) : real).normalize('NFC');
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(folderFsPath).normalize('NFC');
      parts.push(basename(cur));
      cur = parent;
    }
  }
}

async function listTreeDirs(treesDir: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(treesDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => join(treesDir, e.name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function finishTakeover(params: {
  storageRoot: string;
  folderPath: string;
  newId: string;
  newDir: string;
  mark: FolderMark;
  oldId: string;
  oldPath: string;
  resumed: boolean;
  deps: TakeoverDeps;
}): Promise<TakeoverResult> {
  const { storageRoot, folderPath, newId, newDir, mark, oldId, oldPath, resumed, deps } = params;

  // 2단계: trees/ 아래 worktree가 있으면 양쪽 연결(.git/worktrees ↔ trees/*)을 새 경로로 잇는다.
  try {
    const treePaths = await listTreeDirs(join(newDir, 'trees'));
    if (treePaths.length > 0) {
      await deps.repairWorktrees(folderPath, treePaths);
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    deps.log(`workspaceTakeover: worktree repair 실패 — ${error}`);
    return { kind: 'failed', step: 'repair-worktrees', error };
  }

  // 3단계: 프로젝트 기억이 경로 키인 경우에만 옛 경로 키 폴더를 새 경로 키로 옮긴다.
  try {
    const profile = await deps.resolveProjectProfileId(folderPath);
    if (profile.keyedBy === 'path' && oldPath) {
      const oldKey = profileIdForPath(canonicalizeMovedPath(oldPath));
      const newKey = profile.id;
      if (oldKey !== newKey) {
        const projectsDir = projectsRoot(getGlobalDir(storageRoot));
        const from = join(projectsDir, oldKey);
        const to = join(projectsDir, newKey);
        if (existsSync(from)) {
          if (existsSync(to)) {
            deps.log(
              `workspaceTakeover: 새 프로젝트 기억 자리(${newKey})가 이미 있어 ${oldKey}를 옮기지 않았다`,
            );
          } else {
            await fsp.rename(from, to);
          }
        }
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    deps.log(`workspaceTakeover: 프로젝트 기억 이전 실패 — ${error}`);
    return { kind: 'failed', step: 'migrate-project-profile', error };
  }

  // 4단계: workspace.json을 직접 덮어쓴다(updateWorkspaceMeta 금지 — 옛 폴더 재생성 방지).
  const metaPath = join(newDir, 'workspace.json');
  try {
    const raw = await fsp.readFile(metaPath, 'utf8');
    const parsed = JSON.parse(raw) as WorkspaceMeta;
    const title = basename(canonicalWorkspacePath(folderPath)) || basename(folderPath) || newId;
    const next: WorkspaceMeta = {
      ...parsed,
      workspaceId: newId,
      workspacePath: folderPath,
      title,
      folderMark: mark,
      updatedAt: new Date().toISOString(),
    };
    const tmp = `${metaPath}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
    await fsp.rename(tmp, metaPath);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    deps.log(`workspaceTakeover: workspace.json 갱신 실패 — ${error}`);
    return { kind: 'failed', step: 'write-meta', error };
  }

  // 5단계: 출력 로그에 <옛 id> → <새 id>를 남긴다.
  deps.log(`workspaceTakeover: ${oldId} → ${newId}`);
  return resumed ? { kind: 'resumed', toId: newId } : { kind: 'took-over', fromId: oldId, toId: newId };
}

export async function takeOverRenamedWorkspace(
  storageRoot: string,
  folderPath: string,
  deps: TakeoverDeps,
): Promise<TakeoverResult> {
  const workspacesRoot = join(storageRoot, 'workspaces');

  return withFileLock(workspacesRoot, async () => {
    const newId = deterministicWorkspaceId(folderPath);
    const mark = deps.readFolderMark(folderPath);
    if (!mark) return { kind: 'none' };

    const newDir = join(workspacesRoot, newId);
    const newMetaPath = join(newDir, 'workspace.json');

    // 새 id 자리의 workspace.json이 이미 있는 경우: 정상 / 끊긴 이어받기 / 다른 프로젝트 충돌을 가른다.
    if (existsSync(newMetaPath)) {
      let existing: Partial<WorkspaceMeta>;
      try {
        existing = JSON.parse(await fsp.readFile(newMetaPath, 'utf8')) as Partial<WorkspaceMeta>;
      } catch {
        return { kind: 'none' };
      }

      if (isSamePath(existing.workspacePath, folderPath)) {
        return { kind: 'none' };
      }

      if (isSameFolderMark(existing.folderMark, mark)) {
        const oldId = typeof existing.workspaceId === 'string' && existing.workspaceId ? existing.workspaceId : newId;
        const oldPath = typeof existing.workspacePath === 'string' ? existing.workspacePath : '';
        return finishTakeover({
          storageRoot,
          folderPath,
          newId,
          newDir,
          mark,
          oldId,
          oldPath,
          resumed: true,
          deps,
        });
      }

      // 표지가 다르거나 없으면 이름이 같은 다른 프로젝트다 — 뒤이은 getOrCreateWorkspaceId가 거절한다.
      return { kind: 'none' };
    }

    // 새 id 자리가 없을 때: 표지가 같고 경로가 이 폴더가 아닌 후보를 찾는다.
    const entries = await deps.listWorkspaces();
    const candidates = entries.filter(
      (e) => isSameFolderMark(e.folderMark, mark) && !isSamePath(e.workspacePath, folderPath),
    );
    if (candidates.length === 0) return { kind: 'none' };
    if (candidates.length >= 2) {
      const ids = candidates.map((c) => c.workspaceId);
      deps.log(`workspaceTakeover: 이어받을 후보가 둘 이상이라 건너뛴다 (${ids.join(', ')})`);
      return { kind: 'ambiguous', candidates: ids };
    }

    const candidate = candidates[0];
    const oldId = candidate.workspaceId;
    const oldDir = join(workspacesRoot, oldId);

    // 1단계: 워크스페이스 폴더를 새 id 이름으로 옮긴다.
    try {
      await fsp.rename(oldDir, newDir);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      deps.log(`workspaceTakeover: 폴더 이동 실패 (${oldId} → ${newId}) — ${error}`);
      return { kind: 'failed', step: 'rename', error };
    }

    return finishTakeover({
      storageRoot,
      folderPath,
      newId,
      newDir,
      mark,
      oldId,
      oldPath: candidate.workspacePath ?? '',
      resumed: false,
      deps,
    });
  });
}
