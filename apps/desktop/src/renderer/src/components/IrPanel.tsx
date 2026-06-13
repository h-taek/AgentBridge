import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AppSettings,
  ArchiveSnapshotMeta,
  CliKind,
  InstructionFileInfo,
  QuotaSnapshot,
  QuotaSnapshotsByCli,
  TurnsSummaryResult,
  WorkspaceMeta
} from '@shared/ipc'
import type { IR } from '@shared/ir'
import {
  ChevronRightIcon,
  ExternalLinkIcon,
  InfoIcon,
  PlusIcon,
  RefreshIcon,
  SparkleIcon,
  TrashIcon
} from './icons'
import { IrDetailModal } from './IrDetailModal'
import { ProfilePanel } from './ProfilePanel'
import { useT, type Messages } from '../i18n'

// M3.5 UI-E 후속 — 메모리 관리 패널 (3 collapsible 그룹).
//   Group 1: AI 지시 (cwd 안 AGENTS.md / CLAUDE.md / GEMINI.md)
//   Group 2: Refine / Quota (정책 + gemini quota %)
//   Group 3: 메모리 (Turn 흐름 + 현재 IR + Archive 스냅샷)
// 각 그룹은 접기/펼치기. 카드 클릭(현재 IR / Archive) → 큰 모달에서 6 섹션 stacked view.

type Props = {
  workspaceId: string
}

type DetailTarget =
  | { kind: 'current'; ir: IR; mtime: string | null }
  | { kind: 'archive'; meta: ArchiveSnapshotMeta }

const ARCHIVE_INITIAL_VISIBLE = 5

function formatRelative(iso: string | null, now: number, t: Messages): string {
  if (!iso) return t.time.never
  const ms = new Date(iso).getTime()
  if (Number.isNaN(ms)) return t.time.never
  const diffSec = Math.max(0, Math.round((now - ms) / 1000))
  if (diffSec < 10) return t.time.justNow
  if (diffSec < 60) return t.time.secondsAgo(diffSec)
  const min = Math.floor(diffSec / 60)
  if (min < 60) return t.time.minutesAgo(min)
  const hr = Math.floor(min / 60)
  if (hr < 24) return t.time.hoursAgo(hr)
  const day = Math.floor(hr / 24)
  if (day < 7) return t.time.daysAgo(day)
  return new Date(iso).toLocaleDateString()
}

function formatAbsolute(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString()
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

export function IrPanel({ workspaceId }: Props): React.JSX.Element {
  const t = useT()
  // 단기·IR / 장기·메모리 2-탭. 장기 탭의 ProfilePanel은 비활성일 때도 마운트 유지(배지 개수 계산).
  const [tab, setTab] = useState<'ir' | 'profile'>('ir')
  const [proposalCount, setProposalCount] = useState(0)
  const [ir, setIr] = useState<IR | null>(null)
  const [irMtime, setIrMtime] = useState<string | null>(null)
  const [turns, setTurns] = useState<TurnsSummaryResult | null>(null)
  const [instructions, setInstructions] = useState<InstructionFileInfo[]>([])
  const [archive, setArchive] = useState<ArchiveSnapshotMeta[]>([])
  const [quota, setQuota] = useState<QuotaSnapshotsByCli | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  // refineModel='active' 정책 시 활성 CLI 판정용 — workspace.sessions[].lastChattedAt max.
  const [workspace, setWorkspace] = useState<WorkspaceMeta | null>(null)
  const [refining, setRefining] = useState(false)
  const [refineError, setRefineError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const [openInstructions, setOpenInstructions] = useState(true)
  const [openRefine, setOpenRefine] = useState(true)
  const [openMemory, setOpenMemory] = useState(true)
  const [showAllArchive, setShowAllArchive] = useState(false)

  // 메모리 초기화 확인 모달.
  const [resetOpen, setResetOpen] = useState(false)
  const [resetAlsoTurns, setResetAlsoTurns] = useState(true)
  const [resetting, setResetting] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)

  const [detail, setDetail] = useState<DetailTarget | null>(null)
  const [archiveDetailIr, setArchiveDetailIr] = useState<{
    ir: IR | null
    loading: boolean
    error: string | null
  }>({ ir: null, loading: false, error: null })

  // 1분 tick — 상대 시간 라벨 갱신.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])

  const loadIr = useCallback(async () => {
    const res = await window.agentbridge.ir.load({ workspaceId })
    setIr(res.ir)
    setIrMtime(res.fileMtime)
  }, [workspaceId])

  const loadTurns = useCallback(async () => {
    const res = await window.agentbridge.memory.turnsSummary({ workspaceId })
    setTurns(res)
  }, [workspaceId])

  const loadInstructions = useCallback(async () => {
    const res = await window.agentbridge.memory.instructionsList({ workspaceId })
    setInstructions(res.files)
  }, [workspaceId])

  const loadArchive = useCallback(async () => {
    const res = await window.agentbridge.memory.archiveList({ workspaceId })
    setArchive(res.snapshots)
  }, [workspaceId])

  const loadQuota = useCallback(async () => {
    const snap = await window.agentbridge.quota.get()
    setQuota(snap)
  }, [])

  const loadSettings = useCallback(async () => {
    const s = await window.agentbridge.settings.get()
    setSettings(s)
  }, [])

  const loadWorkspace = useCallback(async () => {
    const ws = await window.agentbridge.workspaces.get(workspaceId)
    setWorkspace(ws)
  }, [workspaceId])

  // 워크스페이스 변경 시 일괄 fetch — workspaceId(외부 시그널) → 패널 내부 state 동기화 패턴.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setIr(null)
    setIrMtime(null)
    setTurns(null)
    setInstructions([])
    setArchive([])
    setRefineError(null)
    setShowAllArchive(false)
    void loadIr().catch(() => undefined)
    void loadTurns().catch(() => undefined)
    void loadInstructions().catch(() => undefined)
    void loadArchive().catch(() => undefined)
    void loadQuota().catch(() => undefined)
    void loadSettings().catch(() => undefined)
    void loadWorkspace().catch(() => undefined)
  }, [
    workspaceId,
    loadIr,
    loadTurns,
    loadInstructions,
    loadArchive,
    loadQuota,
    loadSettings,
    loadWorkspace
  ])
  /* eslint-enable react-hooks/set-state-in-effect */

  // 자동/수동 정제 완료 시 통보 — IR + turns + archive 동기화.
  useEffect(() => {
    const unsub = window.agentbridge.ir.onUpdated((evt) => {
      if (evt.workspaceId !== workspaceId) return
      void loadIr().catch(() => undefined)
      void loadTurns().catch(() => undefined)
      void loadArchive().catch(() => undefined)
    })
    return unsub
  }, [workspaceId, loadIr, loadTurns, loadArchive])

  // background probe / 응답 에러 마킹 / 모순 reconcile 시 main이 broadcast (CLI별 이벤트).
  useEffect(() => {
    const unsub = window.agentbridge.quota.onUpdated((evt) => {
      setQuota((prev) => {
        const base: QuotaSnapshotsByCli =
          prev ??
          ({
            agy: {
              usedPercent: null,
              lastSeenAt: null,
              severity: 'unknown',
              shouldFallback: false,
              forcedFallback: false
            },
            codex: {
              usedPercent: null,
              lastSeenAt: null,
              severity: 'unknown',
              shouldFallback: false,
              forcedFallback: false
            },
            claude: {
              usedPercent: null,
              lastSeenAt: null,
              severity: 'unknown',
              shouldFallback: false,
              forcedFallback: false
            }
          } as QuotaSnapshotsByCli)
        return { ...base, [evt.cli]: evt.snapshot }
      })
    })
    return unsub
  }, [])

  // SettingsModal/RefineSettingsPanel에서 설정 변경 시 main이 broadcast — 활성 CLI 라벨 즉시 갱신.
  useEffect(() => {
    const unsub = window.agentbridge.settings.onUpdated((s) => {
      setSettings(s)
    })
    return unsub
  }, [])

  // turnRecorder가 새 turn append할 때마다 통보 — Turn 흐름 바 즉시 갱신.
  useEffect(() => {
    const unsub = window.agentbridge.memory.onTurnsUpdated((evt) => {
      if (evt.workspaceId !== workspaceId) return
      void loadTurns().catch(() => undefined)
    })
    return unsub
  }, [workspaceId, loadTurns])

  const handleRefine = useCallback(async () => {
    if (refining) return
    setRefining(true)
    setRefineError(null)
    try {
      const res = await window.agentbridge.ir.refine({ workspaceId, timeoutMs: 120_000 })
      if (!res.ok) setRefineError(res.error ?? t.mem.refineFailed)
      else if (res.error) setRefineError(t.mem.refineWarn(res.error))
      await loadIr()
      await loadTurns()
      await loadArchive()
    } catch (e) {
      setRefineError(String(e))
    } finally {
      setRefining(false)
    }
  }, [refining, workspaceId, loadIr, loadTurns, loadArchive, t])

  // 메모리 초기화 — ir.json + (옵션) turns.jsonl 비움. archive 보존.
  // main이 ir:updated / turns:updated broadcast → 자동 fetch chain 재실행하지만,
  // broadcast race/지연으로 화면이 stale로 남는 케이스가 있어 handleRefine과 동일하게 명시 fetch.
  const handleResetConfirm = useCallback(async () => {
    if (resetting) return
    setResetting(true)
    setResetError(null)
    try {
      const res = await window.agentbridge.memory.reset({
        workspaceId,
        alsoTurns: resetAlsoTurns
      })
      if (!res.ok) {
        setResetError(res.error ?? t.mem.resetFailed)
        return
      }
      setResetOpen(false)
      // broadcast 누락/지연 안전망 — 디스크는 이미 비워졌으므로 즉시 다시 읽어 화면 동기화.
      await loadIr()
      await loadTurns()
      await loadArchive()
    } catch (e) {
      setResetError(String(e))
    } finally {
      setResetting(false)
    }
  }, [resetting, workspaceId, resetAlsoTurns, loadIr, loadTurns, loadArchive, t])

  // 워크스페이스 변경 시 reset 모달 닫기 — 외부 시그널 동기화. workspaceId 자체가 외부 입력이고
  // 모달은 워크스페이스에 종속이라 동기 setState 정당.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setResetOpen(false)
    setResetError(null)
  }, [workspaceId])

  // CurrentIrCard 카드 헤더 휴지통 → 현재 IR을 비우고 archive 최신 스냅샷을 promote.
  // archive 비어있으면 빈 IR로 떨어짐. archive 최신을 소비(unlink)하므로 반복 클릭 시
  // 이전 스냅샷을 한 단계씩 거슬러 복원하는 효과.
  // main이 ir:updated broadcast + loadArchive 자동 갱신.
  const handleDeleteCurrentIr = useCallback(async () => {
    if (!ir) return
    const hasArchive = archive.length > 0
    const msg = hasArchive
      ? t.mem.confirmDeleteCurrentWithArchive
      : t.mem.confirmDeleteCurrentNoArchive
    if (!window.confirm(msg)) return
    try {
      const res = await window.agentbridge.memory.promoteLatestArchive({ workspaceId })
      if (!res.ok) setRefineError(res.error ?? t.mem.restoreFailed)
    } catch (e) {
      setRefineError(String(e))
    }
  }, [ir, workspaceId, archive.length, t])

  // ArchiveCard 카드 헤더 휴지통 → 개별 스냅샷 파일 삭제.
  // archive:delete(workspaceId, archivePath) — main이 안전 가드 통과 후 unlink. 성공 시 loadArchive 갱신.
  const handleDeleteArchive = useCallback(
    async (meta: ArchiveSnapshotMeta) => {
      if (!window.confirm(t.mem.confirmDeleteSnapshot(formatAbsolute(meta.archivedAt)))) return
      try {
        const res = await window.agentbridge.memory.archiveDelete({
          workspaceId,
          archivePath: meta.archivePath
        })
        if (!res.ok) {
          setRefineError(res.error ?? t.mem.snapshotDeleteFailed)
          return
        }
        await loadArchive()
      } catch (e) {
        setRefineError(String(e))
      }
    },
    [workspaceId, loadArchive, t]
  )

  // archive 카드 클릭 → IR 본문 fetch 후 모달 표시.
  const openArchiveDetail = useCallback(
    async (meta: ArchiveSnapshotMeta) => {
      setDetail({ kind: 'archive', meta })
      setArchiveDetailIr({ ir: null, loading: true, error: null })
      try {
        const res = await window.agentbridge.memory.archiveLoad({
          workspaceId,
          archivePath: meta.archivePath
        })
        setArchiveDetailIr({ ir: res.ir, loading: false, error: null })
      } catch (e) {
        setArchiveDetailIr({ ir: null, loading: false, error: String(e) })
      }
    },
    [workspaceId]
  )

  const closeDetail = useCallback(() => {
    setDetail(null)
    setArchiveDetailIr({ ir: null, loading: false, error: null })
  }, [])

  const handleOpenInstructionFile = useCallback(
    async (info: InstructionFileInfo) => {
      if (!info.exists) {
        const res = await window.agentbridge.memory.instructionsCreate({
          workspaceId,
          kind: info.kind
        })
        await loadInstructions()
        await window.agentbridge.openPath(res.absolutePath)
        return
      }
      await window.agentbridge.openPath(info.absolutePath)
    },
    [workspaceId, loadInstructions]
  )

  const visibleArchive = useMemo(
    () => (showAllArchive ? archive : archive.slice(0, ARCHIVE_INITIAL_VISIBLE)),
    [archive, showAllArchive]
  )

  const currentUpdatedAt = ir?.meta.updatedAt ?? irMtime

  // refine 정책에 따라 다음 refine에 사용될 CLI 추정 — UI에 'active' 라벨 표시.
  //   fixed    → refineFixedCli
  //   priority → refinePriorityOrder[0] (실제 첫 시도 후보, fallback 발생 시 다를 수 있음)
  //   active   → workspace.sessions 중 lastChattedAt이 가장 최근인 cli 세션
  //   off      → 없음
  const activeCli = useMemo((): CliKind | null => {
    if (!settings) return null
    const policy = settings.refineModel
    if (policy === 'off') return null
    if (policy === 'fixed') return settings.refineFixedCli
    if (policy === 'priority') {
      return settings.refinePriorityOrder?.[0] ?? null
    }
    // 'active'
    if (!workspace) return null
    let latest: { cli: CliKind; at: string } | null = null
    for (const s of workspace.sessions) {
      if ((s.kind ?? 'cli') !== 'cli') continue
      if (!s.lastChattedAt) continue
      if (!latest || s.lastChattedAt > latest.at) {
        latest = { cli: s.model, at: s.lastChattedAt }
      }
    }
    return latest?.cli ?? null
  }, [settings, workspace])

  return (
    <>
      <div className="ir-tabbar" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'ir'}
          className={`ir-tab${tab === 'ir' ? ' active' : ''}`}
          onClick={() => setTab('ir')}
        >
          {t.profile.tabIr}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'profile'}
          className={`ir-tab${tab === 'profile' ? ' active' : ''}`}
          onClick={() => setTab('profile')}
        >
          {t.profile.tabProfile}
          {proposalCount > 0 && <span className="ir-tab-badge">{proposalCount}</span>}
        </button>
      </div>

      <section
        className="mem-panel"
        aria-label={t.mem.panelAria}
        style={{ display: tab === 'ir' ? undefined : 'none' }}
      >
        <MemGroup
          title={t.mem.groupInstructions}
          open={openInstructions}
          onToggle={() => setOpenInstructions((v) => !v)}
        >
          <InstructionsCard files={instructions} onAction={handleOpenInstructionFile} now={now} />
        </MemGroup>

        <MemGroup title="Refine / Quota" open={openRefine} onToggle={() => setOpenRefine((v) => !v)}>
          <RefineQuotaCard settings={settings} quota={quota} activeCli={activeCli} />
        </MemGroup>

        <MemGroup
          title={t.mem.groupMemory}
          open={openMemory}
          onToggle={() => setOpenMemory((v) => !v)}
          action={
            <>
              <span
                className="mem-info-tip"
                title={t.mem.infoTip}
                role="img"
                aria-label={t.mem.infoTipAria}
                onClick={(e) => e.stopPropagation()}
              >
                <InfoIcon />
              </span>
              <button
                type="button"
                className="mem-refine-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  void handleRefine()
                }}
                disabled={refining}
                title={t.mem.refineNow}
                aria-label={t.mem.refineNow}
              >
                {refining ? <RefreshIcon className="spin" /> : <SparkleIcon />}
              </button>
              <button
                type="button"
                className="mem-reset-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  setResetAlsoTurns(true)
                  setResetError(null)
                  setResetOpen(true)
                }}
                disabled={refining || resetting}
                title={t.mem.resetMemory}
                aria-label={t.mem.resetMemory}
              >
                <TrashIcon />
              </button>
            </>
          }
        >
          {refineError && <div className="mem-error">{refineError}</div>}
          <TurnFlowCard summary={turns} />
          <CurrentIrCard
            ir={ir}
            updatedLabel={formatRelative(currentUpdatedAt, now, t)}
            onOpen={() => {
              if (ir) setDetail({ kind: 'current', ir, mtime: irMtime })
            }}
            onDelete={handleDeleteCurrentIr}
          />
          {archive.length > 0 && (
            <>
              <div className="mem-subhead">
                {t.mem.prevSnapshots} · {archive.length}
              </div>
              {visibleArchive.map((s) => (
                <ArchiveCard
                  key={s.archivePath}
                  snapshot={s}
                  relativeLabel={formatRelative(s.updatedAt, now, t)}
                  onOpen={() => void openArchiveDetail(s)}
                  onDelete={() => void handleDeleteArchive(s)}
                />
              ))}
              {archive.length > ARCHIVE_INITIAL_VISIBLE && (
                <button
                  type="button"
                  className="mem-archive-more"
                  onClick={() => setShowAllArchive((v) => !v)}
                >
                  {showAllArchive
                    ? t.mem.collapse
                    : t.mem.archiveMore(archive.length - ARCHIVE_INITIAL_VISIBLE)}
                </button>
              )}
            </>
          )}
        </MemGroup>

        <IrDetailModal
          open={detail !== null}
          title={detail?.kind === 'archive' ? t.mem.snapshotDetailTitle : t.mem.currentMemoryTitle}
          subtitle={
            detail?.kind === 'archive'
              ? `${formatAbsolute(detail.meta.updatedAt)} · ${formatRelative(detail.meta.updatedAt, now, t)}`
              : currentUpdatedAt
                ? t.mem.lastRefined(formatAbsolute(currentUpdatedAt))
                : undefined
          }
          ir={detail?.kind === 'current' ? detail.ir : archiveDetailIr.ir}
          loading={detail?.kind === 'archive' ? archiveDetailIr.loading : false}
          error={detail?.kind === 'archive' ? archiveDetailIr.error : null}
          onClose={closeDetail}
        />

        <MemoryResetConfirm
          open={resetOpen}
          alsoTurns={resetAlsoTurns}
          onToggleAlsoTurns={() => setResetAlsoTurns((v) => !v)}
          busy={resetting}
          error={resetError}
          onCancel={() => {
            if (resetting) return
            setResetOpen(false)
            setResetError(null)
          }}
          onConfirm={handleResetConfirm}
        />
      </section>

      <ProfilePanel
        workspaceId={workspaceId}
        active={tab === 'profile'}
        onProposalCount={setProposalCount}
      />
    </>
  )
}

// ─── 메모리 초기화 확인 모달 ────────────────────────────────────────────
// SettingsModal 톤. 본문에 "되돌릴 수 없음 + archive 보존" 명시. turns 초기화는 옵션 토글.
function MemoryResetConfirm({
  open,
  alsoTurns,
  onToggleAlsoTurns,
  busy,
  error,
  onCancel,
  onConfirm
}: {
  open: boolean
  alsoTurns: boolean
  onToggleAlsoTurns: () => void
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void | Promise<void>
}): React.JSX.Element | null {
  const t = useT()
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (!busy) onCancel()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, busy, onCancel])

  if (!open) return null
  return (
    <div className="modal-backdrop" onClick={() => !busy && onCancel()}>
      <div
        className="mem-reset-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
      >
        <div className="mem-reset-title">{t.mem.resetMemory}</div>
        <div className="mem-reset-body">{t.mem.resetBody}</div>
        <label className="mem-reset-option">
          <input type="checkbox" checked={alsoTurns} onChange={onToggleAlsoTurns} disabled={busy} />
          <span>{t.mem.resetAlsoTurns}</span>
        </label>
        {error && <div className="mem-reset-error">{error}</div>}
        <div className="mem-reset-actions">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            {t.common.cancel}
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => void onConfirm()}
            disabled={busy}
          >
            {busy ? t.mem.resetting : t.mem.reset}
          </button>
        </div>
      </div>
    </div>
  )
}

function MemGroup({
  title,
  open,
  onToggle,
  action,
  children
}: {
  title: string
  open: boolean
  onToggle: () => void
  action?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={`mem-group${open ? ' open' : ''}`}>
      <button type="button" className="mem-group-head" onClick={onToggle} aria-expanded={open}>
        <ChevronRightIcon className={`mem-group-chevron${open ? ' rot' : ''}`} />
        <span className="mem-group-title">{title}</span>
        {action && <span className="mem-group-action">{action}</span>}
      </button>
      {open && <div className="mem-group-body">{children}</div>}
    </div>
  )
}

// ─── γ AI 지시 카드 ────────────────────────────────────────────────────
function InstructionsCard({
  files,
  onAction,
  now
}: {
  files: InstructionFileInfo[]
  onAction: (info: InstructionFileInfo) => Promise<void> | void
  now: number
}): React.JSX.Element {
  const t = useT()
  if (files.length === 0) {
    return <div className="mem-card mem-card-empty">{t.mem.noWorkspacePath}</div>
  }
  return (
    <div className="mem-card mem-card-static">
      <ul className="mem-instructions-list">
        {files.map((f) => (
          <li key={f.kind} className="mem-instruction-row">
            <div className="mem-instruction-meta">
              <div className="mem-instruction-name mono">{f.filename}</div>
              <div className="mem-instruction-sub">
                {f.exists
                  ? `${formatBytes(f.sizeBytes ?? 0)} · ${formatRelative(f.mtime, now, t)}`
                  : t.mem.notCreated}
              </div>
            </div>
            <button
              type="button"
              className="mem-instruction-action"
              onClick={() => void onAction(f)}
              title={f.exists ? t.mem.openInEditor : t.mem.createEmptyAndOpen}
              aria-label={f.exists ? t.mem.openInEditor : t.mem.create}
            >
              {f.exists ? <ExternalLinkIcon /> : <PlusIcon />}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ─── δ Refine / Quota 카드 ────────────────────────────────────────────
const CLI_QUOTA_LABEL: Record<CliKind, string> = {
  agy: 'Antigravity',
  codex: 'Codex',
  claude: 'Claude'
}

function RefineQuotaCard({
  settings,
  quota,
  activeCli
}: {
  settings: AppSettings | null
  quota: QuotaSnapshotsByCli | null
  activeCli: CliKind | null
}): React.JSX.Element {
  const t = useT()
  const policyLabel = settings
    ? {
        priority: t.mem.policyPriority,
        fixed: t.mem.policyFixed,
        active: t.mem.policyActiveHeadless,
        off: t.mem.policyOff
      }[settings.refineModel]
    : '—'

  const severityLabel: Record<QuotaSnapshot['severity'], string> = {
    unknown: t.mem.sevUnknown,
    ok: t.mem.sevOk,
    warn: t.mem.sevWarn,
    critical: t.mem.sevCritical,
    exceeded: t.mem.sevExceeded
  }
  const severityCls: Record<QuotaSnapshot['severity'], string> = {
    unknown: 'mem-badge-skip',
    ok: 'mem-badge-pass',
    warn: 'mem-badge-pend',
    critical: 'mem-badge-mod',
    exceeded: 'mem-badge-fail'
  }

  const order: CliKind[] = ['agy', 'codex', 'claude']

  return (
    <div className="mem-card mem-card-static">
      <div className="mem-kv-row">
        <span className="mem-kv-key">{t.mem.refinePolicy}</span>
        <span className="mem-kv-val">{policyLabel}</span>
      </div>
      <div className="mem-quota-row">
        {order.map((cli, i) => {
          const snap = quota?.[cli]
          const isActive = cli === activeCli
          const pctText =
            snap?.usedPercent !== null && snap?.usedPercent !== undefined
              ? `${snap.usedPercent}%`
              : '—'
          return (
            <span key={cli} className="mem-quota-group">
              {i > 0 && <span className="mem-quota-sep" aria-hidden />}
              <span
                className={`mem-quota-item model-${cli}${isActive ? ' is-active' : ''}`}
                title={
                  isActive ? t.mem.nextRefineCli(CLI_QUOTA_LABEL[cli]) : CLI_QUOTA_LABEL[cli]
                }
              >
                <span className="mem-quota-dot" aria-hidden />
                {isActive && <span className="mem-quota-name">{CLI_QUOTA_LABEL[cli]}</span>}
                <span className="mem-quota-pct">{pctText}</span>
                {isActive && snap && (
                  <span className={`mem-badge ${severityCls[snap.severity]}`}>
                    {severityLabel[snap.severity]}
                  </span>
                )}
              </span>
            </span>
          )
        })}
      </div>
      {order.some((cli) => quota?.[cli]?.forcedFallback) && (
        <div className="mem-kv-note">{t.mem.forcedFallbackNote}</div>
      )}
    </div>
  )
}

// ─── β Turn 흐름 카드 ─────────────────────────────────────────────────
// 막대 시각 단순화 — 실제 trigger 임계(countThreshold + keepRecent)와 별개로 막대를
// 7칸으로 분할(tick 6개). turn 누적이 시각상 일정 간격으로 채워지는 게이지 역할.
// trigger 코드 조건은 그대로(`uncompacted >= countThreshold`), 막대 100% 도달과 실제
// trigger 시점은 일치하지 않을 수 있음 — 정확한 trigger 조건은 hint·문서에서 별도 안내.
const BAR_DIVISIONS = 7

function TurnFlowCard({ summary }: { summary: TurnsSummaryResult | null }): React.JSX.Element {
  const t = useT()
  if (!summary) {
    return <div className="mem-card mem-card-static mem-card-empty">{t.mem.aggregating}</div>
  }
  const uncompacted = Math.max(0, summary.count - summary.keepRecent)
  const countPct = Math.min(100, (summary.count / BAR_DIVISIONS) * 100)
  const bytePct = Math.min(100, (summary.bytes / summary.bytesThreshold) * 100)
  const willTrigger =
    uncompacted >= summary.countThreshold || summary.bytes >= summary.bytesThreshold

  // tick 6개, 7칸 분할 — 1/7, 2/7, ..., 6/7 위치.
  const ticks = Array.from({ length: BAR_DIVISIONS - 1 }, (_, i) => i + 1)

  return (
    <div className="mem-card mem-card-static">
      <div className="mem-flow-header">
        <span className="mem-flow-label">
          {willTrigger ? t.mem.willAutoRefine : t.mem.untilNextRefine}
        </span>
        <span className="mem-flow-count">
          {summary.count} turn · {formatBytes(summary.bytes)}
        </span>
      </div>

      <div className="mem-flow-row">
        <span className="mem-flow-axis">Turn</span>
        <div className="mem-flow-bar" title={`${summary.count} turn`}>
          <div className="mem-flow-bar-fill" style={{ width: `${countPct}%` }} />
          {ticks.map((t) => (
            <span
              key={t}
              className="mem-flow-tick"
              style={{ left: `${(t / BAR_DIVISIONS) * 100}%` }}
            />
          ))}
        </div>
      </div>

      <div className="mem-flow-row">
        <span className="mem-flow-axis">Bytes</span>
        <div className="mem-flow-bar" title={`${summary.bytes}/${summary.bytesThreshold} bytes`}>
          <div className="mem-flow-bar-fill alt" style={{ width: `${bytePct}%` }} />
        </div>
      </div>
    </div>
  )
}

// ─── 현재 IR 단일 카드 ────────────────────────────────────────────────
function CurrentIrCard({
  ir,
  updatedLabel,
  onOpen,
  onDelete
}: {
  ir: IR | null
  updatedLabel: string
  onOpen: () => void
  onDelete: () => void
}): React.JSX.Element {
  const t = useT()
  if (!ir) {
    return <div className="mem-card mem-card-static mem-card-empty">{t.mem.noIrYet}</div>
  }
  // key 동기화 — IR 본문이 바뀌면(promote 또는 refine 직후) wrapper가 remount되며
  // CSS animation 'mem-card-promote'가 한 번 발동해 새 카드가 위에서 내려오는 효과.
  const animKey = ir.meta?.updatedAt ?? ir.intent.goal ?? 'current'
  return (
    <div className="mem-card-wrap mem-card-promote" key={animKey}>
      <button type="button" className="mem-card mem-card-button" onClick={onOpen}>
        <div className="mem-card-head">
          <span className="mem-card-eyebrow">{t.mem.currentMemoryTitle}</span>
          <span className="mem-card-time">{updatedLabel}</span>
        </div>
        <div className="mem-card-title">{ir.intent.goal?.trim() || t.mem.goalUnset}</div>
        <div className="mem-card-counts">
          <CountChip label={t.mem.sectionDecisions} n={ir.decisions.length} />
          <CountChip label={t.mem.sectionFiles} n={ir.files.length} />
          <CountChip label={t.mem.sectionCommands} n={ir.commands.length} />
          <CountChip label={t.mem.sectionTests} n={ir.tests.length} />
          <CountChip label={t.mem.sectionPending} n={ir.pending.length} />
        </div>
      </button>
      <button
        type="button"
        className="mem-card-delete"
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
        title={t.mem.clearCurrentTitle}
        aria-label={t.mem.clearCurrent}
      >
        <TrashIcon />
      </button>
    </div>
  )
}

// ─── Archive 스냅샷 카드 ──────────────────────────────────────────────
function ArchiveCard({
  snapshot,
  relativeLabel,
  onOpen,
  onDelete
}: {
  snapshot: ArchiveSnapshotMeta
  relativeLabel: string
  onOpen: () => void
  onDelete: () => void
}): React.JSX.Element {
  const t = useT()
  const total =
    snapshot.counts.decisions +
    snapshot.counts.files +
    snapshot.counts.commands +
    snapshot.counts.tests +
    snapshot.counts.pending
  return (
    <div className="mem-card-wrap">
      <button type="button" className="mem-card mem-card-button mem-card-history" onClick={onOpen}>
        <div className="mem-card-head">
          <span className="mem-card-eyebrow">{t.mem.snapshotEyebrow}</span>
          <span className="mem-card-time">{relativeLabel}</span>
        </div>
        <div className="mem-card-title">{snapshot.intentGoal?.trim() || t.mem.goalUnset}</div>
        <div className="mem-card-counts">
          <CountChip label={t.mem.sectionDecisions} n={snapshot.counts.decisions} />
          <CountChip label={t.mem.sectionFiles} n={snapshot.counts.files} />
          <CountChip label={t.mem.sectionCommands} n={snapshot.counts.commands} />
          <CountChip label={t.mem.sectionTests} n={snapshot.counts.tests} />
          <CountChip label={t.mem.sectionPending} n={snapshot.counts.pending} />
          <span className="mem-count-total">{t.mem.total(total)}</span>
        </div>
      </button>
      <button
        type="button"
        className="mem-card-delete"
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
        title={t.mem.deleteSnapshotTitle}
        aria-label={t.mem.deleteSnapshot}
      >
        <TrashIcon />
      </button>
    </div>
  )
}

function CountChip({ label, n }: { label: string; n: number }): React.JSX.Element {
  return (
    <span className={`mem-count-chip${n === 0 ? ' empty' : ''}`}>
      <span className="mem-count-chip-label">{label}</span>
      <span className="mem-count-chip-n">{n}</span>
    </span>
  )
}
