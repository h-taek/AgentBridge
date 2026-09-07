// claude 폴더 신뢰 선점 (0.5.0 B-8).
//
// research 02 §2.2는 claude가 git 저장소 단위로 판단한다고 봤는데, 라이브에서 뒤집혔다. 우리가
// 만든 worktree(저장소 데이터 폴더 아래)에서 신뢰 창이 떴다. 그 화면은 단일 키를 읽으므로 첫
// 프롬프트가 그대로 답으로 먹히고, 서브는 시작도 못 한 채 멈춘다.
//
// 그래서 agy와 같은 방식으로 선점한다. 자리는 `~/.claude.json`의 `projects["<절대경로>"]`이고
// 필드는 `hasTrustDialogAccepted`다(디스크에서 확인).
//
// 우리가 만든 worktree에만 부른다. 사용자가 직접 만든 폴더의 신뢰 여부는 우리가 대신 정하지
// 않는다(A-3와 같은 경계).

import { promises as fsp } from 'fs';
import { join } from 'path';

type ClaudeConfig = Record<string, unknown> & {
  projects?: unknown;
};

export function resolveClaudeConfigFile(homeDir: string): string {
  return join(homeDir, '.claude.json');
}

// 이 폴더를 claude가 묻지 않고 열도록 미리 신뢰에 넣는다.
//
// 이 파일은 사용자 것이고 우리 것이 아니다. 항목 하나의 필드 하나만 켜고 나머지는 그대로 둔다.
// 깨져 있으면 덮어쓰지 않고 던진다 — 사용자 설정을 날리는 것이 신뢰 창 한 번보다 나쁘다.
export async function trustFolder(absolutePath: string, homeDir: string): Promise<void> {
  const filePath = resolveClaudeConfigFile(homeDir);

  let config: ClaudeConfig = {};
  let raw: string | null = null;
  try {
    raw = await fsp.readFile(filePath, 'utf8');
  } catch {
    raw = null; // 아직 없다 — claude를 한 번도 안 쓴 홈이다
  }
  if (raw !== null) {
    const parsed: unknown = JSON.parse(raw); // 깨졌으면 여기서 던진다
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`claude 설정이 객체가 아니다: ${filePath}`);
    }
    config = parsed as ClaudeConfig;
  }

  const projectsRaw = config.projects;
  const projects: Record<string, unknown> =
    projectsRaw && typeof projectsRaw === 'object' && !Array.isArray(projectsRaw)
      ? { ...(projectsRaw as Record<string, unknown>) }
      : {};

  const entryRaw = projects[absolutePath];
  const entry: Record<string, unknown> =
    entryRaw && typeof entryRaw === 'object' && !Array.isArray(entryRaw)
      ? { ...(entryRaw as Record<string, unknown>) }
      : {};

  if (entry.hasTrustDialogAccepted === true) return; // 이미 신뢰돼 있다

  entry.hasTrustDialogAccepted = true;
  projects[absolutePath] = entry;

  const next = JSON.stringify({ ...config, projects }, null, 2);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, next, 'utf8');
  await fsp.rename(tmp, filePath);
}
