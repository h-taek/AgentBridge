// 프로젝트 지식 폴더가 어느 저장소 경로들을 쓰는지 projects/<projectId>/workspaces.json에 적는다.
// 정리 스킬이 기억 폴더의 파일만으로 일하면서 프로젝트 지식을 그 저장소의 코드와 대조하는 길이다.
//   형식: { "workspaces": ["<저장소 절대경로>", ...] }
import { existsSync, promises as fsp } from 'node:fs';
import { join } from 'node:path';

import { withFileLock } from './fileLock';
import { assertProfileSegment, projectsRoot } from './globalPaths';

function parseWorkspaces(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as { workspaces?: unknown };
    if (!Array.isArray(parsed.workspaces)) return [];
    return parsed.workspaces.filter((p): p is string => typeof p === 'string' && p !== '');
  } catch {
    return [];
  }
}

// 디스크에 없는 경로는 빼고 workspacePath가 없으면 더한다. 목록이 바뀌었을 때만 쓴다.
// 읽고 고쳐 쓰는 사이 다른 창이 끼어들지 못하게 globalDir 락 안에서 한다.
export async function recordProjectWorkspace(
  globalDir: string,
  projectId: string,
  workspacePath: string,
): Promise<void> {
  const dir = join(projectsRoot(globalDir), assertProfileSegment(projectId));
  const file = join(dir, 'workspaces.json');
  await withFileLock(globalDir, async () => {
    const raw = await fsp.readFile(file, 'utf8').catch(() => '');
    const before = parseWorkspaces(raw);
    const next = before.filter((p) => existsSync(p));
    if (!next.includes(workspacePath)) next.push(workspacePath);
    const unchanged = raw !== '' && next.length === before.length && next.every((p, i) => p === before[i]);
    if (unchanged) return;
    await fsp.mkdir(dir, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmp, JSON.stringify({ workspaces: next }, null, 2) + '\n', 'utf8');
    await fsp.rename(tmp, file);
  });
}
