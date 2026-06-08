import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CliKind, EnvProbeResult, SessionMeta } from '@shared/ipc'
import { TerminalIcon } from './icons'

// M3 L3 청크 — Workspace 안 sessions[] 탭 표시.
// architecture §14 multi-tab UI 패턴.
//
// 표시 정책:
//   - 활성 탭(closedAt이 null)만 가로 배치 (탭바)
//   - 닫힌 탭은 보이지 않음 (좌 사이드바 트리에서 다시 클릭 시 PTY 재spawn으로 복원)
//   - 활성 탭 = 사용자가 현재 보고 있는 session (탭 강조)
//   - "x" 버튼  = sessions.close soft (사이드바에서 다시 열 수 있음)
//   - 이름 수정은 *좌 사이드바*에서만 (탭에는 펜 없음 — 좁은 폭 + 중복 회피)
//
// 너비 overflow 처리 — 탭 합산 폭이 bar 폭을 초과하면 끝부터 hidden + "..." 버튼 노출.
// "..." 클릭 시 hidden 탭 목록 dropdown으로 선택 가능. 한 줄 유지(flex-wrap: nowrap + overflow hidden).

type Props = {
  sessions: SessionMeta[]
  activeSessionId: string | null
  env: EnvProbeResult | null
  busy: boolean
  onSelectTab: (sessionId: string) => void
  onCloseTab: (sessionId: string) => void
  onAddTab: (target: CliKind | 'shell') => void
  // sessionId → hook 설치 실패 reason. 값 있으면 해당 탭에 "메모리 비활성" 배지 표시.
  hookDisabledMap: Map<string, string>
}

// dropdown 위치 — fixed positioning 좌표 (button rect 기반). render 중 ref 접근 회피용.
type MenuPos = { top: number; right: number }

const MODEL_LABELS: Record<CliKind, string> = {
  claude: 'Claude',
  codex: 'Codex',
  agy: 'Antigravity'
}

// "..." 버튼이 차지할 폭(추정) — measure 시 reserve용. 실 dom 측정도 가능하지만 단순화.
const OVERFLOW_BTN_RESERVED_PX = 36

export function SessionTabs({
  sessions,
  activeSessionId,
  env,
  busy,
  onSelectTab,
  onCloseTab,
  onAddTab,
  hookDisabledMap
}: Props): React.JSX.Element {
  // 두 dropdown은 *상호 배타* — 한쪽 열면 다른쪽 자동 닫힘. 어느 한쪽이라도 열려 있으면 외부
  // 클릭 + 세션 탭 선택 시 둘 다 닫힘 (이슈 4).
  // dropdown 위치는 click 시점에 button rect를 캡처해 state로 저장 — render 중 ref.current 접근
  // 회피 (React 19 권장 패턴). 둘 다 null이면 닫힘.
  const [addMenuPos, setAddMenuPos] = useState<MenuPos | null>(null)
  const [overflowMenuPos, setOverflowMenuPos] = useState<MenuPos | null>(null)
  const addOpen = addMenuPos !== null
  const overflowOpen = overflowMenuPos !== null
  const closeAllDropdowns = useCallback(() => {
    setAddMenuPos(null)
    setOverflowMenuPos(null)
  }, [])
  const computeMenuPos = (el: HTMLElement): MenuPos => {
    const r = el.getBoundingClientRect()
    return { top: r.bottom + 4, right: Math.max(window.innerWidth - r.right, 8) }
  }
  // 정렬: 마지막 채팅 시점(lastChattedAt) desc — 가장 최근 채팅 세션이 좌측 끝.
  // 채팅 안 한 세션(lastChattedAt 없음)은 createdAt asc로 뒤(우측).
  const openSessions = (() => {
    const opened = sessions.filter((s) => s.closedAt === null)
    return [...opened].sort((a, b) => {
      const ta = a.lastChattedAt
      const tb = b.lastChattedAt
      if (ta && tb) return tb.localeCompare(ta) // 둘 다 채팅 — 최근 먼저
      if (ta) return -1 // a만 채팅함 → 앞
      if (tb) return 1 // b만 채팅함 → 앞
      // 둘 다 채팅 안 함 — createdAt asc (오래된 것 좌측)
      return (a.createdAt ?? '').localeCompare(b.createdAt ?? '')
    })
  })()
  const [visibleCount, setVisibleCount] = useState(openSessions.length)

  const barRef = useRef<HTMLDivElement | null>(null)
  const tabRefs = useRef<Map<string, HTMLDivElement | null>>(new Map())
  const addWrapRef = useRef<HTMLDivElement | null>(null)

  const isAvailable = useCallback(
    (k: CliKind) => env?.clis.find((c) => c.kind === k)?.found === true,
    [env]
  )

  // bar / tabs / add 버튼 폭을 측정해 끝부터 hide하면서 fit 확인.
  // measure는 layout effect로 — DOM mount 직후 ResizeObserver subscribe.
  const measure = useCallback(() => {
    const bar = barRef.current
    if (!bar) return
    const barWidth = bar.clientWidth
    const addBtnWidth = addWrapRef.current?.offsetWidth ?? 0
    // 모든 탭 폭 측정 (display:none 상태가 아니어야 정확).
    const tabWidths = openSessions.map((s) => tabRefs.current.get(s.sessionId)?.offsetWidth ?? 0)
    // 좌측부터 누적해 fit 가능한 개수 결정. 끝에 hidden이 있을 거면 "..." 버튼 폭도 reserve.
    let total = addBtnWidth
    let count = 0
    for (let i = 0; i < openSessions.length; i++) {
      const isLast = i === openSessions.length - 1
      const reserve = isLast ? 0 : OVERFLOW_BTN_RESERVED_PX
      if (total + tabWidths[i] + reserve > barWidth) break
      total += tabWidths[i]
      count++
    }
    setVisibleCount(count)
  }, [openSessions])

  // 탭 개수 / 윈도우 폭 변화 시 재측정. layout effect로 첫 paint 전 적용 → flicker 최소화.
  useLayoutEffect(() => {
    // 새 탭 추가/삭제 직후엔 measure 결과가 부정확할 수 있으니 다음 frame에 한 번 더.
    measure()
    const id = requestAnimationFrame(measure)
    return () => cancelAnimationFrame(id)
  }, [measure, openSessions.length])

  useEffect(() => {
    const bar = barRef.current
    if (!bar) return
    const ro = new ResizeObserver(() => measure())
    ro.observe(bar)
    return () => ro.disconnect()
  }, [measure])

  // 외부(다른 영역) 클릭 시 dropdown 닫기. portal 렌더지만 mousedown 이벤트는 document 전체에 발사.
  // dropdown 자체 또는 button 클릭이면 그 핸들러가 알아서 처리하므로 여기선 다른 영역만 닫는다.
  useEffect(() => {
    if (!addOpen && !overflowOpen) return
    const onMouseDown = (e: MouseEvent): void => {
      const target = e.target as Node | null
      if (!target) return
      const inMenu = (target as Element).closest?.(
        '.session-tab-add-menu, .session-tab-overflow-menu'
      )
      const onBtn = (target as Element).closest?.('.session-tab-add, .session-tab-overflow')
      if (inMenu || onBtn) return
      closeAllDropdowns()
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [addOpen, overflowOpen, closeAllDropdowns])

  const visibleSessions = openSessions.slice(0, visibleCount)
  const hiddenSessions = openSessions.slice(visibleCount)

  const renderTab = (s: SessionMeta, hidden = false): React.JSX.Element => {
    const isActive = s.sessionId === activeSessionId
    const isShell = (s.kind ?? 'cli') === 'shell'
    const displayName = s.title?.trim() || (isShell ? '터미널' : MODEL_LABELS[s.model])
    const hookReason = hookDisabledMap.get(s.sessionId)
    return (
      <div
        key={s.sessionId}
        ref={(el) => {
          tabRefs.current.set(s.sessionId, el)
        }}
        className={`session-tab model-${isShell ? 'shell' : s.model}${isActive ? ' active' : ''}`}
        role="tab"
        aria-selected={isActive}
        // hidden 탭 — 측정용으로만 DOM에 둠. 화면 밖(left: -99999px)으로 보내 visible 영역의 클릭/
        // hover 가로채기 차단. visibility:hidden + pointerEvents:none 중복 가드.
        // 동시에 viewTransitionName 부여 — App.tsx가 setOpenWorkspace를 startViewTransition으로
        // 감싸면 lastChattedAt 변경으로 인한 탭 재정렬이 자연스럽게 슬라이드. hidden 탭은
        // 측정용이라 transition에서 제외.
        style={
          hidden
            ? {
                visibility: 'hidden',
                position: 'absolute',
                left: '-99999px',
                top: 0,
                pointerEvents: 'none'
              }
            : { viewTransitionName: `ses-tab-${s.sessionId}` }
        }
      >
        <button
          className="session-tab-label"
          onClick={() => {
            closeAllDropdowns()
            if (busy) return
            if (!isActive) onSelectTab(s.sessionId)
          }}
          disabled={busy}
          title={`${displayName} · ${s.sessionId.slice(0, 8)}…`}
        >
          {isShell ? (
            <span className="session-tab-icon" aria-hidden="true">
              <TerminalIcon />
            </span>
          ) : (
            <span className={`session-tab-dot model-${s.model}`} />
          )}
          {displayName}
          {hookReason && (
            <span
              className="session-tab-hook-disabled"
              title={`메모리 주입 비활성 — ${hookReason}`}
              aria-label="메모리 비활성"
            >
              ⚠
            </span>
          )}
        </button>
        <button
          className="session-tab-close"
          onClick={() => {
            if (busy) return
            onCloseTab(s.sessionId)
          }}
          disabled={busy}
          title="탭 닫기 (사이드바에서 다시 열 수 있음)"
          aria-label="탭 닫기"
        >
          ×
        </button>
      </div>
    )
  }

  return (
    <div className="session-tabs">
      <div className="session-tabs-bar" ref={barRef}>
        {visibleSessions.map((s) => renderTab(s))}
        {/* hidden 탭은 측정 정확성을 위해 같은 DOM에 visibility:hidden으로 둠 */}
        {hiddenSessions.map((s) => renderTab(s, true))}

        {hiddenSessions.length > 0 && (
          <div className="session-tab-overflow-wrap">
            <button
              className="session-tab-overflow"
              onClick={(e) => {
                // updater 함수는 비동기로 평가될 수 있어 그 시점엔 React가 e.currentTarget을
                // null로 만들 수 있음 → 동기 capture 필수 (검은 화면 회귀 방지).
                const target = e.currentTarget
                const pos = computeMenuPos(target)
                setAddMenuPos(null)
                setOverflowMenuPos((cur) => (cur ? null : pos))
              }}
              disabled={busy}
              title={`${hiddenSessions.length}개 더 보기`}
              aria-label="더 많은 탭"
            >
              ⋯
            </button>
          </div>
        )}

        <div className="session-tab-add-wrap" ref={addWrapRef}>
          <button
            className="session-tab-add"
            onClick={(e) => {
              const target = e.currentTarget
              const pos = computeMenuPos(target)
              setOverflowMenuPos(null)
              setAddMenuPos((cur) => (cur ? null : pos))
            }}
            disabled={busy}
            title="다른 모델 탭 추가"
          >
            + 모델
          </button>
        </div>
      </div>
      {/* dropdown들 — 부모(.app-center)의 overflow:hidden에 잘리지 않도록 portal로 body에 렌더.
          위치는 button click 시점에 캡처된 좌표(MenuPos state)를 사용 — render 중 ref 접근 회피. */}
      {overflowMenuPos &&
        createPortal(
          <div
            className="session-tab-overflow-menu"
            role="menu"
            style={{
              position: 'fixed',
              top: overflowMenuPos.top,
              right: overflowMenuPos.right,
              // CSS의 left:0 / top:100% 등을 inline에서 명시 reset — portal로 body에 렌더돼도
              // 클래스의 absolute 좌표가 잔존하면 dropdown이 잘못 펼쳐짐.
              left: 'auto',
              bottom: 'auto',
              marginTop: 0
            }}
          >
            {hiddenSessions.map((s) => {
              const isShell = (s.kind ?? 'cli') === 'shell'
              const displayName = s.title?.trim() || (isShell ? '터미널' : MODEL_LABELS[s.model])
              return (
                <button
                  key={s.sessionId}
                  className="session-tab-overflow-item"
                  onClick={() => {
                    setOverflowMenuPos(null)
                    if (busy) return
                    onSelectTab(s.sessionId)
                  }}
                  disabled={busy}
                >
                  {isShell ? (
                    <span className="session-tab-icon" aria-hidden="true">
                      <TerminalIcon />
                    </span>
                  ) : (
                    <span className={`session-tab-dot model-${s.model}`} />
                  )}
                  {displayName}
                </button>
              )
            })}
          </div>,
          document.body
        )}
      {addMenuPos &&
        createPortal(
          <div
            className="session-tab-add-menu"
            role="menu"
            style={{
              position: 'fixed',
              top: addMenuPos.top,
              right: addMenuPos.right,
              left: 'auto',
              bottom: 'auto',
              marginTop: 0
            }}
          >
            {(['claude', 'codex', 'agy'] as CliKind[]).map((k) => (
              <button
                key={k}
                className="session-tab-add-item"
                onClick={() => {
                  setAddMenuPos(null)
                  if (!isAvailable(k) || busy) return
                  onAddTab(k)
                }}
                disabled={!isAvailable(k) || busy}
                title={!isAvailable(k) ? `${MODEL_LABELS[k]} CLI가 PATH에 없음` : undefined}
              >
                <span className={`session-tab-dot model-${k}`} />
                {MODEL_LABELS[k]}
                {!isAvailable(k) && <span className="hint"> (미설치)</span>}
              </button>
            ))}
            <button
              className="session-tab-add-item"
              onClick={() => {
                setAddMenuPos(null)
                if (busy) return
                onAddTab('shell')
              }}
              disabled={busy}
              title="내장 터미널 (zsh) — AgentBridge 메모리 없음"
            >
              <span className="session-tab-icon" aria-hidden="true">
                <TerminalIcon />
              </span>
              터미널
            </button>
          </div>,
          document.body
        )}
    </div>
  )
}
