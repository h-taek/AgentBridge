// CLI 글로벌 설정 디렉토리 가드 — 워크스페이스(cwd)로 지정되면 hookInstaller가
// `<cwd>/.codex/hooks.json`, `<cwd>/.agents/hooks.json` 등을 쓰면서 *글로벌 hook 파일*을
// 덮어쓸 위험이 있어 차단한다. 홈 디렉토리 자체도 차단 — `~/.codex/hooks.json`이 이미
// codex의 글로벌 hook 경로이기 때문.
//
// 두 호스트(데스크탑/익스텐션)가 공유하는 단일 진실 공급원 — 데스크탑은 워크스페이스 생성
// 시점에, 코어 hookInstaller는 hook 설치 시점에 이 함수로 검증한다.

import { homedir } from 'os';
import { normalize, relative, isAbsolute, sep } from 'path';

const BLOCKED_GLOBAL_DIRS = [
  '.codex',
  '.agents',
  '.gemini',
  '.claude',
  '.antigravity',
  '.antigravity-ide',
  '.antigravitycli',
];

// 매칭 규칙: 홈 디렉토리 자체 + 위 디렉토리들 *자체와 그 하위 모든 경로*.
// 반환: 차단 사유 토큰(`~` 또는 `~/.codex` 등) / 허용 시 null.
export function findBlockedGlobalCliConfigDir(p: string): string | null {
  const home = normalize(homedir());
  const target = normalize(p);
  if (target === home) return '~';
  const rel = relative(home, target);
  // 홈 밖이면 차단 대상 아님
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  const firstSegment = rel.split(sep)[0] ?? '';
  for (const blocked of BLOCKED_GLOBAL_DIRS) {
    if (firstSegment === blocked) return `~/${blocked}`;
  }
  return null;
}
