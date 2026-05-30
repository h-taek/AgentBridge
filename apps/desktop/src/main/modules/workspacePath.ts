import { existsSync, statSync } from 'fs'
import * as os from 'os'
import * as path from 'path'

// 사용자가 input에 입력한 workspace 경로를 시스템 cwd로 안전하게 변환한다.
// 사용자가 어느 형태로 복붙하든(셸 escape, ~/, 따옴표 둘러싼 경로) 정상화한다.
//
// 정상화하지 않으면: macOS Finder에서 "경로 복사" 또는 zsh 명령행에서 가져온 경로가
// `Mobile\ Documents` 형태로 들어와 ENOENT → 자식 즉시 exit 1.
export function normalizeWorkspacePath(input: string): string {
  let s = input.trim()
  if (s.length === 0) return s
  // 따옴표로 감싼 경우 제거
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1)
  }
  // 백슬래시 escape 제거 — `\<문자>` → `<문자>` (셸이 공백/틸드 등을 escape한 경우)
  s = s.replace(/\\(.)/g, '$1')
  // ~/... → $HOME/...
  if (s === '~') {
    s = os.homedir()
  } else if (s.startsWith('~/')) {
    s = path.join(os.homedir(), s.slice(2))
  }
  return path.normalize(s)
}

// CLI 글로벌 설정 디렉토리 — 워크스페이스로 지정 시 hookInstaller가
// `<cwd>/.codex/hooks.json`, `<cwd>/.agents/hooks.json` 등을 쓰면서 *글로벌 hook 파일*을
// 덮어쓸 수 있어 차단한다. 홈 디렉토리 자체도 차단 — `~/.codex/hooks.json`이 이미 codex의
// 글로벌 hook 경로이기 때문.
//
// 매칭 규칙: 해당 디렉토리 *자체* + 그 *하위 모든 경로*.
const BLOCKED_GLOBAL_DIRS = [
  '', // homedir 자체
  '.codex',
  '.agents',
  '.gemini',
  '.claude',
  '.antigravity',
  '.antigravity-ide',
  '.antigravitycli'
]

function isInsideGlobalCliConfigDir(p: string): string | null {
  const home = path.normalize(os.homedir())
  const target = path.normalize(p)
  if (target === home) return '홈 디렉토리'
  const rel = path.relative(home, target)
  // home 밖이면 차단 대상 아님
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  const firstSegment = rel.split(path.sep)[0] ?? ''
  for (const blocked of BLOCKED_GLOBAL_DIRS) {
    if (blocked === '') continue
    if (firstSegment === blocked) return `~/${blocked}`
  }
  return null
}

// workspace 경로가 디렉토리로 존재하는지 검증. 실패 시 친절한 에러 메시지.
export function validateWorkspacePath(p: string): void {
  if (!p) {
    throw new Error('workspace 경로가 비어있습니다')
  }
  const blocked = isInsideGlobalCliConfigDir(p)
  if (blocked) {
    throw new Error(
      `워크스페이스로 지정할 수 없는 경로입니다: ${p}\n` +
        `(${blocked} 하위 — CLI 글로벌 설정 디렉토리를 덮어쓸 위험이 있어 차단)`
    )
  }
  let stat
  try {
    stat = existsSync(p) ? statSync(p) : null
  } catch (err) {
    throw new Error(`workspace 경로 접근 실패: ${p} — ${(err as Error).message}`)
  }
  if (!stat) {
    throw new Error(`workspace 경로가 존재하지 않습니다: ${p}`)
  }
  if (!stat.isDirectory()) {
    throw new Error(`workspace 경로가 디렉토리가 아닙니다: ${p}`)
  }
}
