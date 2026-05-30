import { useEffect } from 'react'
import type { IR } from '@shared/ir'
import { CloseIcon } from './icons'
import { IrSectionList } from './IrSectionList'

// 메모리 패널 카드 클릭 시 열리는 큰 모달. 6 섹션 stacked layout.
// 현재 IR + archive 스냅샷 양쪽에서 사용.

type Props = {
  open: boolean
  title: string
  subtitle?: string
  ir: IR | null
  loading?: boolean
  error?: string | null
  onClose: () => void
}

export function IrDetailModal({
  open,
  title,
  subtitle,
  ir,
  loading,
  error,
  onClose
}: Props): React.JSX.Element | null {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="modal mem-detail-modal"
        role="dialog"
        aria-modal="true"
        aria-label="메모리 상세"
      >
        <header className="modal-head settings-head">
          <div className="settings-head-left">
            <div>
              <h2>{title}</h2>
              {subtitle && <div className="mem-detail-subtitle">{subtitle}</div>}
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} title="닫기 (Esc)" aria-label="닫기">
            <CloseIcon />
          </button>
        </header>
        <div className="modal-body mem-detail-body">
          {loading && <div className="mem-status">불러오는 중…</div>}
          {error && <div className="mem-error">{error}</div>}
          {!loading && !error && !ir && <div className="mem-status">표시할 IR이 없습니다.</div>}
          {!loading && !error && ir && <IrSectionList ir={ir} />}
        </div>
      </div>
    </div>
  )
}
