import { SidebarLeftIcon, SidebarRightIcon } from './icons'

// 클린 모던 타이틀바 — frameless macOS 윈도우의 draggable 영역.
// 좌측: traffic light spacer
// 중앙: 메모리 상태 점 (워크스페이스 활성 시)
// 우측: 비어있음 (사이드바 토글은 각 사이드바 내부로 이동)
//
// 사이드바가 *collapsed*일 때만 fallback 토글이 보임 → reopen 경로 확보.

type Props = {
  leftOpen: boolean
  rightOpen: boolean
  onToggleLeft: () => void
  onToggleRight: () => void
  memoryActive?: boolean
}

export function TitleBar({
  leftOpen,
  rightOpen,
  onToggleLeft,
  onToggleRight,
  memoryActive
}: Props): React.JSX.Element {
  return (
    <header className="titlebar">
      <div className="titlebar-traffic-spacer" />
      {!leftOpen && (
        <button
          className="icon-btn"
          onClick={onToggleLeft}
          title="좌 사이드바 열기"
          aria-label="좌 사이드바 열기"
        >
          <SidebarLeftIcon />
        </button>
      )}
      <div className="titlebar-spacer" />
      {memoryActive && (
        <span className="titlebar-status">
          <span className="dot" />
          AgentBridge Memory Active
        </span>
      )}
      <div className="titlebar-spacer" />
      {!rightOpen && (
        <button
          className="icon-btn"
          onClick={onToggleRight}
          title="우 사이드바 열기"
          aria-label="우 사이드바 열기"
        >
          <SidebarRightIcon />
        </button>
      )}
    </header>
  )
}
