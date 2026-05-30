import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CliKind, EnvProbeResult, WorkspaceListEntry, WorkspaceMeta } from '@shared/ipc'
import {
  ChevronRightIcon,
  FolderIcon,
  GearIcon,
  HomeIcon,
  PencilIcon,
  PlusIcon,
  SidebarLeftIcon,
  TerminalIcon,
  TrashIcon
} from './icons'
import { InlineRenameInput } from './InlineRenameInput'

// 좌 사이드바 — flat 워크스페이스 목록.
// 토글 정책:
//   - 활성 워크스페이스(openWorkspaceId)는 자동 펼침
//   - 활성이 바뀌면 이전 활성은 자동 접힘 (chevron 수동 펼침은 유지)
//   - chevron 버튼은 언제나 수동 토글 가능
//   - 워크스페이스 title 클릭:
//       * 비활성 → 워크스페이스 열기 (effect가 자동 펼침)
//       * 활성 → 재오픈 금지 + 트리 접기 (workspace는 열린 상태 유지)

// 모델 표시명 — SessionTabs와 동일한 라벨링 사용.
const MODEL_LABEL: Record<CliKind, string> = {
  claude: 'Claude',
  codex: 'Codex',
  agy: 'Antigravity'
}

// 세션 정렬 — SessionTabs와 동일 정책. lastChattedAt desc → 가장 최근 채팅 세션이 위.
// 채팅 안 한 세션은 createdAt asc로 아래.
function sortSessionsByLastChatted<T extends { lastChattedAt?: string; createdAt: string }>(
  list: T[]
): T[] {
  return [...list].sort((a, b) => {
    const ta = a.lastChattedAt
    const tb = b.lastChattedAt
    if (ta && tb) return tb.localeCompare(ta)
    if (ta) return -1
    if (tb) return 1
    return a.createdAt.localeCompare(b.createdAt)
  })
}

type Props = {
  env: EnvProbeResult | null
  workspaces: WorkspaceListEntry[]
  workspacesErr: string | null
  openWorkspaceId: string | null
  openWorkspace: WorkspaceMeta | null
  openSessionId: string | null

  workspacePath: string
  setWorkspacePath: (v: string) => void
  workspaceNameDraft: string
  setWorkspaceNameDraft: (v: string) => void
  initialModel: CliKind
  setInitialModel: (v: CliKind) => void
  busy: boolean

  onCreateWorkspace: () => Promise<void>
  onPickWorkspace: () => Promise<void>
  onGoHome: () => Promise<void>
  onOpenWorkspace: (w: WorkspaceListEntry, targetSessionId?: string) => Promise<void>
  // M3.6 C — 워크스페이스를 새 윈도우로 열기(또는 이미 열려있으면 그 윈도우 focus).
  onOpenWorkspaceInNewWindow: (w: WorkspaceListEntry) => void
  onDeleteWorkspace: (w: WorkspaceListEntry) => Promise<void>
  onRenameWorkspace: (workspaceId: string, title: string) => Promise<void>
  onSelectSession: (sessionId: string) => void
  onCloseSession: (sessionId: string) => Promise<void>
  onAddSession: (w: WorkspaceListEntry, target: CliKind | 'shell') => Promise<void>
  onRenameSession: (workspaceId: string, sessionId: string, title: string) => Promise<void>

  onOpenSettings: () => void
  onClose: () => void
}

export function LeftSidebar({
  env,
  workspaces,
  workspacesErr,
  openWorkspaceId,
  openWorkspace,
  openSessionId,
  workspacePath,
  setWorkspacePath,
  workspaceNameDraft,
  setWorkspaceNameDraft,
  initialModel,
  setInitialModel,
  busy,
  onCreateWorkspace,
  onPickWorkspace,
  onGoHome,
  onOpenWorkspace,
  onOpenWorkspaceInNewWindow,
  onDeleteWorkspace,
  onRenameWorkspace,
  onSelectSession,
  onCloseSession,
  onAddSession,
  onRenameSession,
  onOpenSettings,
  onClose
}: Props): React.JSX.Element {
  const [showNew, setShowNew] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [addMenuFor, setAddMenuFor] = useState<string | null>(null)
  // 인라인 편집 중인 식별자. workspace는 `ws:<id>`, session은 `sess:<id>` 키.
  const [editing, setEditing] = useState<string | null>(null)
  // 워크스페이스 row 우클릭 컨텍스트 메뉴 — 열기 / 새 창 / 이름 수정 / 삭제 4개 항목.
  const [contextMenu, setContextMenu] = useState<{
    workspaceId: string
    x: number
    y: number
  } | null>(null)
  const prevOpenRef = useRef<string | null>(null)

  // 컨텍스트 메뉴 outside click / Esc close.
  useEffect(() => {
    if (!contextMenu) return
    const onDown = (): void => setContextMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setContextMenu(null)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [contextMenu])

  // FLIP 애니메이션 — workspaces 순서 바뀔 때 각 row가 이전 위치에서 새 위치로
  // 부드럽게 이동하도록. updatedAt 정렬로 활성 ws가 위로 올라올 때 자연스럽게.
  const itemRefs = useRef<Map<string, HTMLLIElement>>(new Map())
  const prevRects = useRef<Map<string, DOMRect>>(new Map())

  useLayoutEffect(() => {
    // 1) 새 위치를 먼저 측정 (transform 적용 전이라 실제 layout 위치).
    const newRects = new Map<string, DOMRect>()
    itemRefs.current.forEach((el, id) => {
      // 이전 frame에서 inline transform이 남아있을 수 있어 측정 직전에 reset.
      if (el.style.transform) {
        el.style.transform = ''
        el.style.transition = 'transform 0s'
      }
      newRects.set(id, el.getBoundingClientRect())
    })
    // 2) prevRects와 비교해 invert + play.
    itemRefs.current.forEach((el, id) => {
      const prev = prevRects.current.get(id)
      const curr = newRects.get(id)
      if (!prev || !curr) return
      const dy = prev.top - curr.top
      if (Math.abs(dy) < 1) return
      el.style.transform = `translateY(${dy}px)`
      el.style.transition = 'transform 0s'
      requestAnimationFrame(() => {
        el.style.transform = ''
        el.style.transition = 'transform 320ms cubic-bezier(0.2, 0.8, 0.2, 1)'
      })
    })
    // 3) 다음 render 비교용으로 실제 layout 위치 저장.
    prevRects.current = newRects
  })

  // 바깥 클릭 시 + 메뉴 닫기
  useEffect(() => {
    if (!addMenuFor) return
    const onDocClick = (): void => setAddMenuFor(null)
    document.addEventListener('click', onDocClick)
    return () => document.removeEventListener('click', onDocClick)
  }, [addMenuFor])

  // 활성 전환 시 자동 접고/펼치기
  useEffect(() => {
    setExpanded((prev) => {
      const next = new Set(prev)
      // 이전 활성은 자동 접기 (chevron 수동 펼침이라도 활성 바뀔 때 정리)
      if (prevOpenRef.current && prevOpenRef.current !== openWorkspaceId) {
        next.delete(prevOpenRef.current)
      }
      // 새 활성은 자동 펼치기
      if (openWorkspaceId) {
        next.add(openWorkspaceId)
      }
      return next
    })
    prevOpenRef.current = openWorkspaceId
  }, [openWorkspaceId])

  const toggleExpand = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const collapse = (id: string): void => {
    setExpanded((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  const trimmedWorkspace = workspacePath.trim()
  const initialModelReady = env?.clis.find((c) => c.kind === initialModel)?.found === true

  // 빈 워크스페이스도 표시 — 빈 *세션*은 서버에서 자동 hard-delete 되지만,
  // 그 결과 sessions=0이 된 워크스페이스 자체는 list에 유지되어야 한다 (사용자가
  // + 로 세션을 다시 추가하거나 휴지통으로 삭제).
  const visibleWorkspaces = workspaces

  return (
    <>
      <div className="sidebar-pane-head">
        <button
          className="icon-btn"
          onClick={onClose}
          title="사이드바 접기"
          aria-label="사이드바 접기"
        >
          <SidebarLeftIcon />
        </button>
      </div>

      <div className="sidebar-quick">
        <button
          className={`sidebar-quick-row${openWorkspaceId === null ? ' active' : ''}`}
          onClick={() => void onGoHome()}
          disabled={busy || openWorkspaceId === null}
          title="홈 화면으로"
        >
          <HomeIcon />
          <span>홈</span>
        </button>
      </div>

      <div className={`sidebar-quick${showNew ? ' expanded' : ''}`}>
        <button className="sidebar-quick-row" onClick={() => setShowNew((v) => !v)} disabled={busy}>
          <PlusIcon />
          <span>새 워크스페이스</span>
        </button>
        {showNew && (
          <div className="new-ws">
            <label>경로</label>
            <div className="row">
              <input
                className="input"
                placeholder="/Users/you/projects/foo"
                value={workspacePath}
                onChange={(e) => setWorkspacePath(e.target.value)}
              />
              <button
                className="icon-btn"
                onClick={() => void onPickWorkspace()}
                disabled={busy}
                title="폴더 선택"
                aria-label="폴더 선택"
              >
                <FolderIcon />
              </button>
            </div>
            <label>이름 (선택)</label>
            <div className="row">
              <input
                className="input"
                placeholder={
                  trimmedWorkspace
                    ? (trimmedWorkspace.split('/').filter(Boolean).pop() ?? '폴더명')
                    : '폴더명'
                }
                value={workspaceNameDraft}
                onChange={(e) => setWorkspaceNameDraft(e.target.value)}
                maxLength={120}
              />
            </div>
            <label>모델</label>
            <div className="row">
              <select
                className="select"
                value={initialModel}
                onChange={(e) => setInitialModel(e.target.value as CliKind)}
                disabled={busy}
              >
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
                <option value="agy">Antigravity</option>
              </select>
              <button
                className="btn btn-primary"
                style={{ marginLeft: 'auto' }}
                onClick={() => void onCreateWorkspace().then(() => setShowNew(false))}
                disabled={!initialModelReady || !trimmedWorkspace || busy}
              >
                만들기
              </button>
            </div>
            {!initialModelReady && (
              <div className="hint" style={{ color: 'var(--color-danger)' }}>
                {initialModel} CLI 미설치 — 설치 후 앱 재시작
              </div>
            )}
          </div>
        )}
      </div>

      <div className="sidebar-section-label">
        <span>활성</span>
      </div>

      {workspacesErr && (
        <div className="sidebar-section">
          <pre className="error" style={{ whiteSpace: 'pre-wrap', fontSize: 11 }}>
            {workspacesErr}
          </pre>
        </div>
      )}

      <div className="sidebar-scroll">
        {visibleWorkspaces.length === 0 ? (
          <div className="ws-empty">워크스페이스 없음 — 상단에서 생성</div>
        ) : (
          <ul className="ws-list">
            {visibleWorkspaces.map((w) => {
              const isOpen = w.workspaceId === openWorkspaceId
              const isExpanded = expanded.has(w.workspaceId)
              const sessionsRaw = isOpen && openWorkspace ? openWorkspace.sessions : w.sessions
              // 최근 채팅 세션이 상단으로 오도록 정렬.
              const sessions = sortSessionsByLastChatted(sessionsRaw)

              const isEmpty = sessions.length === 0
              const primarySession =
                sessions.find((s) => s.sessionId === w.primarySessionId) ?? sessions[0] ?? null
              const primaryIsShell = (primarySession?.kind ?? 'cli') === 'shell'
              const cliPresent = primarySession
                ? primaryIsShell ||
                  env?.clis.find((c) => c.kind === primarySession.model)?.found === true
                : false
              // shell 세션은 매번 새 zsh spawn — modelSessionId 무관하게 resume 가능.
              const canResume = primaryIsShell || primarySession?.modelSessionId != null
              // 빈 워크스페이스는 세션 spawn 없이 우 사이드바 메타만 표시 — 항상 열기 가능.
              const canOpen = !isOpen && !busy && (isEmpty || (cliPresent && canResume))

              return (
                <li
                  key={w.workspaceId}
                  ref={(el) => {
                    if (el) itemRefs.current.set(w.workspaceId, el)
                    else itemRefs.current.delete(w.workspaceId)
                  }}
                  className={`ws-group${isExpanded ? ' expanded' : ''}`}
                >
                  <div
                    className={`ws-row${isOpen ? ' open' : ''}`}
                    role="group"
                    onContextMenu={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setContextMenu({
                        workspaceId: w.workspaceId,
                        x: e.clientX,
                        y: e.clientY
                      })
                    }}
                  >
                    <button
                      className="icon-btn-xs"
                      onClick={() => toggleExpand(w.workspaceId)}
                      title={isExpanded ? '접기' : '펼치기'}
                      aria-label="펼치기"
                    >
                      <ChevronRightIcon className={`chev${isExpanded ? ' expanded' : ''}`} />
                    </button>
                    {editing === `ws:${w.workspaceId}` ? (
                      <InlineRenameInput
                        className="ws-row-title-input"
                        initialValue={w.title}
                        maxLength={120}
                        onSave={(v) => {
                          setEditing(null)
                          void onRenameWorkspace(w.workspaceId, v)
                        }}
                        onCancel={() => setEditing(null)}
                      />
                    ) : (
                      <button
                        className="ws-row-title"
                        onClick={() => {
                          if (isOpen) {
                            // 재오픈 금지 — 트리만 접기
                            collapse(w.workspaceId)
                          } else if (canOpen) {
                            void onOpenWorkspace(w)
                          }
                        }}
                        disabled={!isOpen && !canOpen}
                        title={
                          isEmpty
                            ? w.workspacePath
                            : !canResume
                              ? '모델 native 세션 미영속화 — resume 불가'
                              : !cliPresent
                                ? `${primarySession?.model} CLI 미설치`
                                : w.workspacePath
                        }
                      >
                        {w.title}
                      </button>
                    )}
                    <div className="ws-row-actions">
                      <div className="ws-add-wrap">
                        <button
                          className="icon-btn-xs"
                          onClick={(e) => {
                            e.stopPropagation()
                            setAddMenuFor((cur) => (cur === w.workspaceId ? null : w.workspaceId))
                          }}
                          disabled={busy}
                          title="세션 추가"
                          aria-label="세션 추가"
                        >
                          <PlusIcon />
                        </button>
                        {addMenuFor === w.workspaceId && (
                          <div
                            className="ws-add-menu"
                            role="menu"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {(['claude', 'codex', 'agy'] as CliKind[]).map((k) => {
                              const available = env?.clis.find((c) => c.kind === k)?.found === true
                              return (
                                <button
                                  key={k}
                                  className="ws-add-menu-item"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setAddMenuFor(null)
                                    if (!available || busy) return
                                    void onAddSession(w, k)
                                  }}
                                  disabled={!available || busy}
                                  title={
                                    !available ? `${MODEL_LABEL[k]} CLI가 PATH에 없음` : undefined
                                  }
                                >
                                  <span className={`ws-session-dot model-${k}`} />
                                  {MODEL_LABEL[k]}
                                  {!available && <span className="hint"> (미설치)</span>}
                                </button>
                              )
                            })}
                            <button
                              className="ws-add-menu-item"
                              onClick={(e) => {
                                e.stopPropagation()
                                setAddMenuFor(null)
                                if (busy) return
                                void onAddSession(w, 'shell')
                              }}
                              disabled={busy}
                              title="내장 터미널 (zsh) — AgentBridge 메모리 없음"
                            >
                              <span className="ws-session-icon">
                                <TerminalIcon />
                              </span>
                              터미널
                            </button>
                          </div>
                        )}
                      </div>
                      <button
                        className="icon-btn-xs"
                        onClick={(e) => {
                          e.stopPropagation()
                          void onDeleteWorkspace(w)
                        }}
                        disabled={busy}
                        title="워크스페이스 삭제"
                        aria-label="워크스페이스 삭제"
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="ws-sessions">
                      {sessions.length === 0 && (
                        <div className="hint" style={{ padding: '4px 8px' }}>
                          세션 없음
                        </div>
                      )}
                      {sessions.map((s) => {
                        const isActive = isOpen && s.sessionId === openSessionId
                        const isClosed = s.closedAt !== null
                        const isShellSess = (s.kind ?? 'cli') === 'shell'
                        // shell 세션은 어댑터 무관 — 워크스페이스 자체가 열릴 수 있으면 항상 활성화 가능.
                        const sessDisabled = isShellSess
                          ? busy || (!isOpen && !canResume)
                          : busy || (!isOpen && (!cliPresent || !canResume))
                        const isEditing = editing === `sess:${s.sessionId}`
                        const displayName =
                          s.title?.trim() || (isShellSess ? '터미널' : MODEL_LABEL[s.model])
                        return (
                          <div
                            key={s.sessionId}
                            className={`ws-session${isActive ? ' active' : ''}${sessDisabled ? ' disabled' : ''}`}
                            // View Transitions API — startViewTransition으로 setState를 감싼 시점에
                            // 같은 name을 가진 element를 자동으로 reorder 애니메이션 처리. 워크스페이스
                            // scope를 같이 묶어 다른 ws 동일 sessionId 충돌 방지.
                            style={{ viewTransitionName: `ses-sb-${w.workspaceId}-${s.sessionId}` }}
                            role="button"
                            tabIndex={sessDisabled || isEditing ? -1 : 0}
                            aria-disabled={sessDisabled}
                            onClick={() => {
                              if (sessDisabled || isEditing) return
                              if (isOpen) onSelectSession(s.sessionId)
                              else void onOpenWorkspace(w, s.sessionId)
                            }}
                            onKeyDown={(e) => {
                              if (sessDisabled || isEditing) return
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                if (isOpen) onSelectSession(s.sessionId)
                                else void onOpenWorkspace(w, s.sessionId)
                              }
                            }}
                            title={
                              isShellSess
                                ? '내장 터미널 (zsh)'
                                : !isOpen
                                  ? !canResume
                                    ? '모델 native 세션 미영속화 — resume 불가'
                                    : !cliPresent
                                      ? `${primarySession ? MODEL_LABEL[primarySession.model] : ''} CLI 미설치`
                                      : `워크스페이스 열기 + ${MODEL_LABEL[s.model]} 활성`
                                  : MODEL_LABEL[s.model]
                            }
                          >
                            {isShellSess ? (
                              <span
                                className={`ws-session-icon${isClosed ? ' closed' : ''}`}
                                aria-hidden="true"
                              >
                                <TerminalIcon />
                              </span>
                            ) : (
                              <span
                                className={`ws-session-dot model-${s.model}${isClosed ? ' closed' : ''}`}
                              />
                            )}
                            {isEditing ? (
                              <InlineRenameInput
                                className="ws-session-label-input"
                                initialValue={s.title ?? ''}
                                placeholder={isShellSess ? '터미널' : MODEL_LABEL[s.model]}
                                maxLength={80}
                                onSave={(v) => {
                                  setEditing(null)
                                  void onRenameSession(w.workspaceId, s.sessionId, v)
                                }}
                                onCancel={() => setEditing(null)}
                              />
                            ) : (
                              <span className="ws-session-label">{displayName}</span>
                            )}
                            {isOpen && !isEditing && (
                              <div className="ws-session-actions">
                                <button
                                  className="icon-btn-xs ws-session-rename"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setEditing(`sess:${s.sessionId}`)
                                  }}
                                  disabled={busy}
                                  title="세션 이름 수정"
                                  aria-label="세션 이름 수정"
                                >
                                  <PencilIcon />
                                </button>
                                <button
                                  className="icon-btn-xs ws-session-close"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    void onCloseSession(s.sessionId)
                                  }}
                                  disabled={busy}
                                  title="세션 삭제 (되돌릴 수 없음)"
                                  aria-label="세션 삭제"
                                >
                                  <TrashIcon />
                                </button>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="sidebar-footer">
        <button className="icon-btn" onClick={onOpenSettings} title="설정" aria-label="설정">
          <GearIcon />
        </button>
      </div>
      {contextMenu &&
        (() => {
          const w = workspaces.find((x) => x.workspaceId === contextMenu.workspaceId)
          if (!w) return null
          const isOpen = w.workspaceId === openWorkspaceId
          return (
            <div
              className="ws-context-menu"
              role="menu"
              style={{ top: contextMenu.y, left: contextMenu.x }}
              onMouseDown={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.preventDefault()}
            >
              <button
                className="ws-context-item"
                disabled={isOpen || busy}
                onClick={() => {
                  setContextMenu(null)
                  if (isOpen || busy) return
                  void onOpenWorkspace(w)
                }}
              >
                워크스페이스 열기
              </button>
              <button
                className="ws-context-item"
                onClick={() => {
                  setContextMenu(null)
                  onOpenWorkspaceInNewWindow(w)
                }}
              >
                새 창으로 열기
              </button>
              <button
                className="ws-context-item"
                disabled={busy}
                onClick={() => {
                  setContextMenu(null)
                  setEditing(`ws:${w.workspaceId}`)
                  setAddMenuFor(null)
                }}
              >
                이름 수정
              </button>
              <div className="ws-context-divider" />
              <button
                className="ws-context-item ws-context-danger"
                disabled={busy}
                onClick={() => {
                  setContextMenu(null)
                  void onDeleteWorkspace(w)
                }}
              >
                삭제
              </button>
            </div>
          )
        })()}
    </>
  )
}
