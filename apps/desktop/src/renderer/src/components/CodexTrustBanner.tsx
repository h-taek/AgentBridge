import { useCallback, useEffect, useState } from 'react'
import type { HookTrustEntry, SessionMeta } from '@shared/ipc'

// M3 M 청크 — codex `/hooks` trust 게이트 안내 배너.
// architecture §14.8 / probe 08 — codex는 hook 자동 등록 안 되고 사용자가 codex 안에서
// `/hooks` 슬래시 명령 실행 후 trust 승인이 필요. AgentBridge는 trust 상태를 감지할 수
// 없으므로 사용자가 한 번 "승인 완료" 버튼을 눌러 영구 마킹한다.

type Props = {
  workspaceId: string
  sessions: SessionMeta[]
}

export function CodexTrustBanner({ workspaceId, sessions }: Props): React.JSX.Element | null {
  const [trust, setTrust] = useState<HookTrustEntry | null>(null)
  const [updating, setUpdating] = useState(false)

  const hasActiveCodex = sessions.some((s) => s.model === 'codex' && s.closedAt === null)

  useEffect(() => {
    let cancelled = false
    void window.agentbridge.hooks.trustGet(workspaceId).then((entry) => {
      if (!cancelled) setTrust(entry)
    })
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  const handleApprove = useCallback(async () => {
    setUpdating(true)
    try {
      const next = await window.agentbridge.hooks.trustSet({ workspaceId, trusted: true })
      setTrust(next)
    } finally {
      setUpdating(false)
    }
  }, [workspaceId])

  if (!hasActiveCodex) return null
  if (!trust) return null
  if (trust.codex === 'trusted') return null

  return (
    <div className="codex-trust-banner">
      <strong>codex `/hooks` 수동 승인 필요</strong>
      <div style={{ marginTop: 4, lineHeight: 1.4 }}>
        codex 탭 안에서 <code>/hooks</code> 슬래시 명령을 실행해 AgentBridge hook을 trust 처리해야
        매 메시지마다 IR이 자동 주입됩니다. 승인 완료 후 아래 버튼을 누르면 이 안내가 사라집니다 (한
        번만 필요).
      </div>
      <button
        className="btn"
        onClick={() => void handleApprove()}
        disabled={updating}
        style={{ marginTop: 8 }}
      >
        {updating ? '...' : 'codex에서 trust 승인 완료'}
      </button>
    </div>
  )
}
