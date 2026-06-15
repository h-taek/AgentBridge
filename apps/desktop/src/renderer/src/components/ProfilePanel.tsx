import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ProposalListResult } from '@shared/ipc'
import { FolderIcon } from './icons'
import { useT } from '../i18n'

// gc-tree §E — 장기 메모리(프로필) 탭. IrPanel의 [장기·메모리] 탭 아래 렌더.
//   ① 승인 큐: 자동제안 카드(카테고리·제목·요약·본문 미리보기 + 승인/버림)
//   ② 읽기전용 문서 목록(카테고리별 그룹) — 수동 편집은 "폴더 열기"로 .md 직접 편집
// 제안·문서는 default 프로필 단위로 모든 워크스페이스가 공유 — workspaceId는 resolveProfile 입력일 뿐.

type Props = {
  workspaceId: string
  // 비활성 탭일 때도 마운트 유지(제안 개수 배지 계산을 위해) — display로만 숨김.
  active: boolean
  // 제안 개수를 부모(IrPanel)로 끌어올려 탭 배지에 표시.
  onProposalCount: (n: number) => void
}

type Proposal = ProposalListResult['proposals'][number]
type Doc = ProposalListResult['docs'][number]

const BODY_PREVIEW_MAX = 200

function bodyPreview(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  return flat.length > BODY_PREVIEW_MAX ? `${flat.slice(0, BODY_PREVIEW_MAX).trimEnd()}…` : flat
}

export function ProfilePanel({ workspaceId, active, onProposalCount }: Props): React.JSX.Element {
  const t = useT()
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [docs, setDocs] = useState<Doc[]>([])
  const [profileDir, setProfileDir] = useState<string>('')
  // 승인/버림 in-flight 중인 제안 id — 진행 중엔 모든 액션 버튼 비활성.
  const [busyId, setBusyId] = useState<string | null>(null)
  // 승인/버림이 진짜 에러(권한·디스크 등)로 실패했을 때 표면화 — 무반응처럼 보이지 않게.
  const [actionError, setActionError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await window.agentbridge.proposal.list({ workspaceId })
    setProposals(res.proposals)
    setDocs(res.docs)
    setProfileDir(res.profileDir)
    onProposalCount(res.proposals.length)
  }, [workspaceId, onProposalCount])

  // 마운트 + 워크스페이스 변경 시 일괄 fetch.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setProposals([])
    setDocs([])
    setProfileDir('')
    void load().catch(() => undefined)
  }, [workspaceId, load])
  /* eslint-enable react-hooks/set-state-in-effect */

  // 승인/버림 또는 자동제안 패스 종료 시 main broadcast → 목록 재조회.
  // 제안/문서는 default 프로필 전역 공유라 workspaceId 필터 없이 항상 재조회.
  useEffect(() => {
    const unsub = window.agentbridge.proposal.onUpdated(() => {
      void load().catch(() => undefined)
    })
    return unsub
  }, [load])

  const handleApprove = useCallback(
    async (id: string) => {
      if (busyId) return
      setBusyId(id)
      setActionError(null)
      try {
        await window.agentbridge.proposal.approve({ workspaceId, id })
        await load()
      } catch {
        // 진짜 실패(권한·디스크 등) — 카드에 인라인 에러를 띄워 무반응처럼 보이지 않게.
        setActionError(t.profile.actionError)
      } finally {
        setBusyId(null)
      }
    },
    [busyId, workspaceId, load, t]
  )

  const handleDiscard = useCallback(
    async (id: string) => {
      if (busyId) return
      setBusyId(id)
      setActionError(null)
      try {
        await window.agentbridge.proposal.discard({ workspaceId, id })
        await load()
      } catch {
        setActionError(t.profile.actionError)
      } finally {
        setBusyId(null)
      }
    },
    [busyId, workspaceId, load, t]
  )

  const openFolder = useCallback(() => {
    if (!profileDir) return
    void window.agentbridge.openPath(profileDir).catch(() => undefined)
  }, [profileDir])

  // 문서를 카테고리별로 그룹 — 입력 순서를 보존하며 카테고리 첫 등장 순으로 묶는다.
  const docGroups = useMemo(() => {
    const groups: { category: string; docs: Doc[] }[] = []
    const byCat = new Map<string, Doc[]>()
    for (const d of docs) {
      let bucket = byCat.get(d.category)
      if (!bucket) {
        bucket = []
        byCat.set(d.category, bucket)
        groups.push({ category: d.category, docs: bucket })
      }
      bucket.push(d)
    }
    return groups
  }, [docs])

  return (
    <section
      className="profile-panel"
      aria-label={t.profile.panelAria}
      style={{ display: active ? undefined : 'none' }}
    >
      <div className="profile-loc">
        <FolderIcon className="profile-loc-icon" />
        <span className="profile-loc-name">{t.profile.profileLabel}</span>
        <button
          type="button"
          className="profile-open-folder"
          onClick={openFolder}
          disabled={!profileDir}
          title={t.profile.openFolderTitle}
          aria-label={t.profile.openFolder}
        >
          <FolderIcon />
          {t.profile.openFolder}
        </button>
      </div>

      {actionError && <div className="mem-error">{actionError}</div>}

      <div className="profile-sechead">
        <span>{t.profile.queueTitle}</span>
        {proposals.length > 0 && (
          <span className="profile-sechead-count">{proposals.length}</span>
        )}
      </div>
      {proposals.length === 0 ? (
        <div className="mem-card mem-card-empty">{t.profile.queueEmpty}</div>
      ) : (
        proposals.map((p) => (
          <div key={p.id} className="mem-card">
            <span className="profile-cat">{p.category}</span>
            <div className="mem-card-title">{p.title}</div>
            {p.summary && <div className="mem-row-sub">{p.summary}</div>}
            {p.body && <div className="profile-body">{bodyPreview(p.body)}</div>}
            <div className="profile-card-acts">
              <button
                type="button"
                className="profile-act profile-act-approve"
                onClick={() => void handleApprove(p.id)}
                disabled={busyId !== null}
              >
                {t.profile.approve}
              </button>
              <button
                type="button"
                className="profile-act profile-act-discard"
                onClick={() => void handleDiscard(p.id)}
                disabled={busyId !== null}
              >
                {t.profile.discard}
              </button>
            </div>
          </div>
        ))
      )}

      <div className="profile-sechead">
        <span>{t.profile.docsTitle}</span>
        {docs.length > 0 && <span className="profile-sechead-count">{docs.length}</span>}
      </div>
      {docs.length === 0 ? (
        <div className="mem-card mem-card-empty">{t.profile.docsEmpty}</div>
      ) : (
        <div className="profile-docs">
          {docGroups.map((g) => (
            <div key={g.category} className="profile-doc-group">
              <div className="profile-doc-cat">{g.category}</div>
              {g.docs.map((d) => (
                <div key={`${d.category}/${d.slug}`} className="profile-doc">
                  <div className="profile-doc-title">{d.title}</div>
                  {d.summary && <div className="profile-doc-summary">{d.summary}</div>}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
