// 각 모델의 메인 로고 — @agentbridge/assets 단일 원본의 공식 SVG를 import.
// (Vite가 .svg를 URL로 해소 → <img src>에 그대로 사용. PNG에서 SVG로 전환.)

import claudeLogo from '@agentbridge/assets/logos/claude.svg'
import codexLogo from '@agentbridge/assets/logos/codex.svg'
import agyLogo from '@agentbridge/assets/logos/agy.svg'

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
