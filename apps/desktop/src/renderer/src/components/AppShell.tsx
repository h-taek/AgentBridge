import { useEffect, useRef, useState, type ReactNode } from 'react'
import { TitleBar } from './TitleBar'

// 3 column grid shell — 좌 사이드바 + 중앙 + 우 사이드바, 각 사이드바 토글 가능.
// 단축키: ⌘B (좌), ⌘⌥B (우) — VSCode 동일 (사용자에게 칩으로 안내하지 않음).
// collapsed 상태에서도 자식은 mount 유지 → 토글 애니메이션 중 layout shift 최소화.
//
// 토글 버튼은 사이드바 *내부* 상단에 위치 — 타이틀바엔 collapsed 시 fallback만.
// 사이드바가 직접 닫힘 버튼을 노출하므로 토글이 패널에 "속한" 느낌.
//
// 우 사이드바 자동 동작:
//   - workspaceOpen=false (홈 화면): 강제 접힘 (사용자 토글 무효)
//   - workspaceOpen 전환 (false → true): 자동 펼침
//   - workspaceOpen 전환 (true → false): 자동 접힘
//   사용자가 워크스페이스 활성 상태에서 명시적으로 토글한 상태는 유지.
//
// 화면 폭 기반 자동 접힘 (좁은 디스플레이 / 윈도우 축소 대응):
//   - innerWidth < AUTO_COLLAPSE_RIGHT_PX → 우 사이드바 자동 접힘
//   - innerWidth < AUTO_COLLAPSE_LEFT_PX  → 좌 사이드바도 자동 접힘
//
// 사용자 명시 토글 우선 정책:
//   사용자가 토글 버튼을 한 번이라도 누르면 그 상태가 명시 의도로 간주됨. 이후엔 화면 폭과
//   무관하게 사용자가 set한 leftOpen/rightOpen 값 그대로 적용 — 좁은 화면에서도 사용자가
//   사이드바를 명시적으로 열면 열림 유지.

const AUTO_COLLAPSE_RIGHT_PX = 1100
const AUTO_COLLAPSE_LEFT_PX = 820

type LeftRenderer = (ctx: { onClose: () => void }) => ReactNode
type RightRenderer = (ctx: { onClose: () => void }) => ReactNode

type Props = {
  left: LeftRenderer
  right: RightRenderer
  children: ReactNode
  memoryActive?: boolean
  // 워크스페이스가 열려 있는지 여부. 홈 화면(false)일 땐 우 사이드바 자동 접힘.
  workspaceOpen?: boolean
}

export function AppShell({
  left,
  right,
  children,
  memoryActive,
  workspaceOpen
}: Props): React.JSX.Element {
  const [leftOpen, setLeftOpen] = useState(true)
  const [rightOpen, setRightOpen] = useState(false)
  // 사용자가 토글 버튼을 명시적으로 누르면 true — 이후엔 화면 폭 기반 auto-collapse 무시하고
  // 사용자 set 값(leftOpen/rightOpen) 그대로 따름.
  const [leftUserOverride, setLeftUserOverride] = useState(false)
  const [rightUserOverride, setRightUserOverride] = useState(false)
  const [winWidth, setWinWidth] = useState(() => window.innerWidth)
  const prevWorkspaceOpenRef = useRef<boolean | undefined>(workspaceOpen)

  // 화면 폭 추적 — 좁아지면 자동 접힘.
  useEffect(() => {
    const onResize = (): void => setWinWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const forceCollapseLeft = winWidth < AUTO_COLLAPSE_LEFT_PX
  const forceCollapseRight = winWidth < AUTO_COLLAPSE_RIGHT_PX
  // user override가 true면 사용자 의도(leftOpen) 그대로. false면 width 기반 자동 분기.
  const effectiveLeftOpen = leftUserOverride ? leftOpen : leftOpen && !forceCollapseLeft
  const effectiveRightOpen = rightUserOverride ? rightOpen : rightOpen && !forceCollapseRight

  const toggleLeft = (): void => {
    setLeftOpen((v) => !v)
    setLeftUserOverride(true)
  }
  const toggleRight = (): void => {
    setRightOpen((v) => !v)
    setRightUserOverride(true)
  }
  const closeLeft = (): void => {
    setLeftOpen(false)
    setLeftUserOverride(true)
  }
  const closeRight = (): void => {
    setRightOpen(false)
    setRightUserOverride(true)
  }

  // 워크스페이스 활성 전환 시 우 사이드바 자동 토글 (open → 펼침 / close → 접힘).
  // rightOpen은 사용자 토글 가능한 state라 derive 불가 — prev 비교로 1회만 발사하는 동기 setState.
  useEffect(() => {
    const prev = prevWorkspaceOpenRef.current
    if (prev !== workspaceOpen) {
      setRightOpen(Boolean(workspaceOpen))
    }
    prevWorkspaceOpenRef.current = workspaceOpen
  }, [workspaceOpen])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.code !== 'KeyB') return
      e.preventDefault()
      if (e.altKey) {
        // 홈 화면(workspaceOpen=false)에선 우 사이드바 토글 무효 — 표시할 컨텍스트 없음.
        if (!workspaceOpen) return
        toggleRight()
      } else toggleLeft()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
    // toggleLeft/toggleRight는 컴포넌트 lifetime 동안 안정 — workspaceOpen만 의존
  }, [workspaceOpen])

  return (
    <div className="app-shell">
      <TitleBar
        leftOpen={effectiveLeftOpen}
        rightOpen={effectiveRightOpen}
        onToggleLeft={toggleLeft}
        onToggleRight={toggleRight}
        memoryActive={memoryActive}
      />
      <aside className={`sidebar sidebar-left${effectiveLeftOpen ? '' : ' collapsed'}`}>
        <div className="sidebar-inner">{left({ onClose: closeLeft })}</div>
      </aside>
      <section className="app-center">{children}</section>
      <aside className={`sidebar sidebar-right${effectiveRightOpen ? '' : ' collapsed'}`}>
        <div className="sidebar-inner">{right({ onClose: closeRight })}</div>
      </aside>
    </div>
  )
}
