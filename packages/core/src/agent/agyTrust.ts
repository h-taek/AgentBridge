// agy(Antigravity CLI) 신뢰 폴더 선점 (0.5.0 B-8).
//
// 우리가 서브에이전트용으로 새 git worktree를 만들면 agy가 그 폴더에서 신뢰 프롬프트를
// 띄운다. 그 프롬프트는 단일 키 입력을 읽으므로, 뜬 상태에서 텍스트를 밀어넣으면 임의 옵션이
// 선택되거나 세션이 끝난다(research 02 §2.4). 그래서 우리가 만든 worktree는 열기 전에 미리
// 신뢰에 넣는다.
//
// 실제 신뢰 파일은 `~/.gemini/trustedFolders.json`이 아니라
// `~/.gemini/antigravity-cli/settings.json`이다(research 02 §2.3, 라이브 실측 확인).
// claude는 저장소 단위로 판단해 worktree가 자동 통과하고 codex는 애초에 프롬프트가 뜨지 않아,
// 선점이 필요한 것은 agy 하나뿐이다 — 이 모듈도 agy만 다룬다.

import { promises as fsp } from 'fs';
import { dirname, join } from 'path';

type AgySettings = Record<string, unknown> & {
  trustedWorkspaces?: unknown;
};

// 이 파일이 가리키는 자리는 실측으로 확정된 값이라 홈 경로만 바꿔 끼울 수 있게 인자로 받는다.
// 테스트가 실제 사용자 홈을 건드리지 않고 가짜 홈으로 검증하기 위함이다.
export function resolveAgyTrustFile(homeDir: string): string {
  return join(homeDir, '.gemini', 'antigravity-cli', 'settings.json');
}

// 이 폴더를 agy가 묻지 않고 열도록 신뢰 목록에 미리 넣는다. 우리가 만든 worktree에만 부른다 —
// 사용자가 직접 만든 폴더의 신뢰 여부는 우리가 대신 정하지 않는다(spec 01 B-8 신뢰 관문 경계).
export async function trustWorkspace(absolutePath: string, homeDir: string): Promise<void> {
  const filePath = resolveAgyTrustFile(homeDir);

  let settings: AgySettings = {};
  let raw: string | null = null;
  try {
    raw = await fsp.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  if (raw !== null) {
    // 파일이 있는데 깨져 있으면 던진다. 사용자 설정을 우리가 덮어써서 날리는 것이
    // 신뢰 프롬프트가 한 번 더 뜨는 것보다 나쁘다.
    settings = JSON.parse(raw) as AgySettings;
  }

  const existing = Array.isArray(settings.trustedWorkspaces)
    ? (settings.trustedWorkspaces as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];

  // 대소문자를 그대로 비교한다. agy는 소문자로 내린 경로를 신뢰로 인식하지 않는다(실측).
  if (existing.includes(absolutePath)) return;

  const next: AgySettings = {
    ...settings,
    trustedWorkspaces: [...existing, absolutePath],
  };

  await fsp.mkdir(dirname(filePath), { recursive: true });

  // 원자적으로 쓴다: tmp에 쓰고 rename. hostRequest.ts의 atomicWrite와 같은 패턴이다.
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
  await fsp.rename(tmp, filePath);
}
