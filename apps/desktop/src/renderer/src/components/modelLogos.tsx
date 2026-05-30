// 각 모델의 메인 로고 — 실제 이미지 파일을 import.
// 파일 위치: src/renderer/src/assets/logos/{claude,codex,agy}.png
// 각 PNG는 배경이 투명해야 한다. Codex의 경우 클라우드 안 `>_` 커서도 transparent.

import claudeLogo from '../assets/logos/claude.png'
import codexLogo from '../assets/logos/codex.png'
import agyLogo from '../assets/logos/agy.png'

type LogoProps = {
  className?: string
}

export function ClaudeLogo({ className }: LogoProps): React.JSX.Element {
  return <img src={claudeLogo} alt="" className={className} draggable={false} />
}

export function CodexLogo({ className }: LogoProps): React.JSX.Element {
  return <img src={codexLogo} alt="" className={className} draggable={false} />
}

export function AgyLogo({ className }: LogoProps): React.JSX.Element {
  return <img src={agyLogo} alt="" className={className} draggable={false} />
}
