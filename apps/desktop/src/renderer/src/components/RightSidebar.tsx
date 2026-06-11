import type { WorkspaceMeta } from '@shared/ipc'
import { CodexTrustBanner } from './CodexTrustBanner'
import { IrPanel } from './IrPanel'
import { SidebarRightIcon, TerminalIcon } from './icons'
import { useT } from '../i18n'

// 우 사이드바 — 활성 워크스페이스 컨텍스트 + 메모리(IR).
// 활성 세션이 shell(내장 터미널)이면 IR 패널 대신 안내문 — shell 세션은 hook/turnRecorder/refine
// 전부 bypass라 보여줄 메모리 자체가 없음.

type Props = {
  openWorkspaceId: string | null
  openWorkspace: WorkspaceMeta | null
  openSessionId: string | null
  onClose: () => void
}

export function RightSidebar({
  openWorkspaceId,
  openWorkspace,
  openSessionId,
  onClose
}: Props): React.JSX.Element {
  const t = useT()
  const activeSession = openWorkspace?.sessions.find((s) => s.sessionId === openSessionId) ?? null
  const isShellActive = activeSession ? (activeSession.kind ?? 'cli') === 'shell' : false

  return (
    <>
      <div className="sidebar-pane-head right">
        <button
          className="icon-btn"
          onClick={onClose}
          title={t.rightSidebar.collapse}
          aria-label={t.rightSidebar.collapse}
        >
          <SidebarRightIcon />
        </button>
      </div>

      {!openWorkspaceId || !openWorkspace ? (
        <>
          <div className="right-header">
            <div className="right-eyebrow">WORKSPACE</div>
            <div className="right-title">{t.rightSidebar.noSelection}</div>
          </div>
          <div className="right-empty">{t.rightSidebar.empty}</div>
        </>
      ) : (
        <>
          <div className="right-header">
            <div className="right-eyebrow">WORKSPACE</div>
            <div className="right-title">{openWorkspace.title}</div>
          </div>

          {isShellActive ? (
            <div className="right-empty right-shell-empty">
              <div className="right-shell-icon" aria-hidden="true">
                <TerminalIcon />
              </div>
              <div className="right-shell-title">{t.rightSidebar.shellNoMemory}</div>
              <div className="right-shell-sub">{t.rightSidebar.shellNoMemorySub}</div>
            </div>
          ) : (
            <div className="sidebar-scroll">
              <CodexTrustBanner workspaceId={openWorkspaceId} sessions={openWorkspace.sessions} />
              <IrPanel workspaceId={openWorkspaceId} />
            </div>
          )}
        </>
      )}
    </>
  )
}
