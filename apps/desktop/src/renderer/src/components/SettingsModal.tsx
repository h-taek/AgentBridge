import { useCallback, useEffect, useState } from 'react'
import type {
  AppHealth,
  AppSettings,
  AppUpdaterStatus,
  CliKind,
  EnvProbeResult,
  LanguageCode,
  RefineModelPolicy,
  ThemeMode,
  TurnsAssistantDetail
} from '@shared/ipc'
import {
  ArrowLeftIcon,
  ArrowUpIcon,
  ChevronRightIcon,
  CloseIcon,
  DatabaseIcon,
  ExternalLinkIcon,
  FolderIcon,
  GlobeIcon,
  HelpIcon,
  HomeIcon,
  InfoIcon,
  KeyboardIcon,
  SparkleIcon,
  TerminalIcon,
  ThemeIcon
} from './icons'
import appIcon from '../../../../resources/icon.png'
import { useT, useLang, type Messages } from '../i18n'

// 설정 모달 — Apple/ChatGPT 스타일.
// 헤더가 본문과 자연스럽게 이어지도록 border 제거 + 동일 배경.
// 카드 = 그룹화된 list-row. row 사이 hairline divider, 클릭 가능한 row는 chevron 우측.
// Sub-page (요약 모델 / 단축키 / 사용 설명서)는 모달 내부 navigate (header 좌측 ← 버튼).

const GITHUB_URL = 'https://github.com/h-taek/AgentBridge'

const CLI_LABEL: Record<CliKind, string> = {
  claude: 'Claude',
  codex: 'Codex',
  agy: 'Antigravity'
}
const CLI_ORDER_FULL: CliKind[] = ['agy', 'codex', 'claude']

const LANGUAGE_LABEL: Record<LanguageCode, string> = {
  ko: '한국어',
  en: 'English'
}

type SubPage = 'main' | 'cli' | 'shortcuts' | 'help' | 'license'

type Props = {
  health: AppHealth | null
  env: EnvProbeResult | null
  onClose: () => void
}

// priority 정책의 CLI 우선순위 list 편집 row — 위/아래 화살표로 순서 조정.
function PriorityOrderRow({
  order,
  onUpdate
}: {
  order: CliKind[]
  onUpdate: (next: CliKind[]) => void
}): React.JSX.Element {
  const t = useT()
  // missing CLI를 끝에 자동 추가하여 모든 CLI 표시.
  const fullOrder: CliKind[] = [...order]
  for (const k of CLI_ORDER_FULL) {
    if (!fullOrder.includes(k)) fullOrder.push(k)
  }
  const move = (idx: number, delta: -1 | 1): void => {
    const next = [...fullOrder]
    const swapIdx = idx + delta
    if (swapIdx < 0 || swapIdx >= next.length) return
    ;[next[idx], next[swapIdx]] = [next[swapIdx], next[idx]]
    onUpdate(next)
  }
  return (
    <div className="settings-row settings-row-column">
      <div className="settings-row-line">
        <SparkleIcon className="settings-row-icon" />
        <span className="settings-row-label">{t.settings.priorityRow.label}</span>
        <span className="settings-row-value settings-row-desc">{t.settings.priorityRow.desc}</span>
      </div>
      <div className="settings-priority-list">
        {fullOrder.map((cli, idx) => (
          <div key={cli} className="settings-priority-item">
            <span className={`ws-session-dot model-${cli}`} />
            <span className="settings-priority-label">{CLI_LABEL[cli]}</span>
            <button
              className="settings-priority-btn"
              onClick={() => move(idx, -1)}
              disabled={idx === 0}
              aria-label={t.settings.priorityRow.up}
              title={t.settings.priorityRow.up}
            >
              ↑
            </button>
            <button
              className="settings-priority-btn"
              onClick={() => move(idx, 1)}
              disabled={idx === fullOrder.length - 1}
              aria-label={t.settings.priorityRow.down}
              title={t.settings.priorityRow.down}
            >
              ↓
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

export function SettingsModal({ health, env, onClose }: Props): React.JSX.Element {
  const t = useT()
  const [page, setPage] = useState<SubPage>('main')
  const [settings, setSettings] = useState<AppSettings | null>(null)
  // 자동 업데이트 status — 모달 mount 시 1회 getStatus + onStatus 구독으로 후속 동기화.
  // 사용자가 sub-page로 이동해도 SettingsModal root는 mount 유지되므로 status가 끊기지 않음.
  const [updaterStatus, setUpdaterStatus] = useState<AppUpdaterStatus>({ phase: 'idle' })
  const [updaterChecking, setUpdaterChecking] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (page !== 'main') setPage('main')
        else onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, page])

  useEffect(() => {
    window.agentbridge.settings
      .get()
      .then(setSettings)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    let cancelled = false
    window.agentbridge.appUpdater
      .getStatus()
      .then((s) => {
        if (!cancelled) setUpdaterStatus(s)
      })
      .catch(() => undefined)
    const off = window.agentbridge.appUpdater.onStatus((s) => {
      setUpdaterStatus(s)
    })
    return () => {
      cancelled = true
      off()
    }
  }, [])

  const handleCheckForUpdates = useCallback(async (): Promise<void> => {
    if (updaterChecking) return
    setUpdaterChecking(true)
    try {
      const res = await window.agentbridge.appUpdater.checkForUpdates()
      // 즉시 반환된 status로 ui 우선 갱신. 후속 broadcast가 더 정확한 phase 동기화.
      setUpdaterStatus(res.status)
      if (!res.ok && res.reason) {
        setUpdaterStatus({ phase: 'error', message: res.reason })
      }
    } catch (e) {
      setUpdaterStatus({ phase: 'error', message: String(e) })
    } finally {
      setUpdaterChecking(false)
    }
  }, [updaterChecking])

  const updateSettings = useCallback(async (patch: Partial<AppSettings>): Promise<void> => {
    const next = await window.agentbridge.settings.set(patch)
    setSettings(next)
  }, [])

  const pickBasePath = useCallback(async (): Promise<void> => {
    const picked = await window.agentbridge.dialog.pickWorkspace(
      settings?.defaultBasePath || undefined
    )
    if (picked) await updateSettings({ defaultBasePath: picked })
  }, [settings, updateSettings])

  const titles: Record<SubPage, string> = {
    main: t.settings.titles.main,
    cli: t.settings.titles.cli,
    shortcuts: t.settings.titles.shortcuts,
    help: t.settings.titles.help,
    license: t.settings.titles.license
  }

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t.settings.titles.main}
      >
        <header className="modal-head settings-head">
          <div className="settings-head-left">
            {page !== 'main' && (
              <button
                className="icon-btn settings-back"
                onClick={() => setPage('main')}
                title={t.common.back}
                aria-label={t.common.back}
              >
                <ArrowLeftIcon />
              </button>
            )}
            <h2>{titles[page]}</h2>
          </div>
          <button
            className="icon-btn"
            onClick={onClose}
            title={t.settings.closeEsc}
            aria-label={t.common.close}
          >
            <CloseIcon />
          </button>
        </header>
        <div className="modal-body settings-body">
          {page === 'main' && (
            <MainPage
              health={health}
              env={env}
              settings={settings}
              onSubPage={setPage}
              onUpdate={updateSettings}
              onPickBasePath={pickBasePath}
              updaterStatus={updaterStatus}
              updaterChecking={updaterChecking}
              onCheckForUpdates={handleCheckForUpdates}
            />
          )}
          {page === 'cli' && <CliPage env={env} />}
          {page === 'shortcuts' && <ShortcutsPage />}
          {page === 'help' && <HelpPage />}
          {page === 'license' && <LicensePage />}
        </div>
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────

type MainPageProps = {
  health: AppHealth | null
  env: EnvProbeResult | null
  settings: AppSettings | null
  onSubPage: (page: SubPage) => void
  onUpdate: (patch: Partial<AppSettings>) => Promise<void>
  onPickBasePath: () => Promise<void>
  updaterStatus: AppUpdaterStatus
  updaterChecking: boolean
  onCheckForUpdates: () => Promise<void>
}

// AppUpdaterStatus를 사용자 친화 라벨로 변환. (라벨, 보조 텍스트, 강조 여부) 반환.
function describeUpdaterStatus(
  status: AppUpdaterStatus,
  currentVersion: string | undefined,
  t: Messages
): { label: string; sub?: string; tone: 'idle' | 'progress' | 'good' | 'warn' } {
  const u = t.settings.updater
  switch (status.phase) {
    case 'idle':
      return { label: u.idle, tone: 'idle' }
    case 'skipped-dev':
      return { label: u.skippedDev, tone: 'idle' }
    case 'checking':
      return { label: u.checking, tone: 'progress' }
    case 'available':
      return {
        label: u.available(status.version),
        sub: u.availableSub,
        tone: 'progress'
      }
    case 'not-available':
      return { label: u.notAvailable(status.version), tone: 'good' }
    case 'downloading': {
      const pct = Math.max(0, Math.min(100, Math.round(status.percent)))
      const verLabel = status.version ? ` v${status.version}` : ''
      return {
        label: u.downloading(verLabel, pct),
        tone: 'progress'
      }
    }
    case 'downloaded':
      return {
        label: u.downloaded(status.version),
        sub: currentVersion === status.version ? undefined : u.downloadedSub,
        tone: 'good'
      }
    case 'error':
      return { label: u.error, sub: status.message, tone: 'warn' }
    default:
      return { label: u.none, tone: 'idle' }
  }
}

function MainPage({
  health,
  env,
  settings,
  onSubPage,
  onUpdate,
  onPickBasePath,
  updaterStatus,
  updaterChecking,
  onCheckForUpdates
}: MainPageProps): React.JSX.Element {
  const t = useT()
  const foundCount = env?.clis.filter((c) => c.found).length ?? 0
  const totalCount = env?.clis.length ?? 0
  const basePathValue = settings?.defaultBasePath?.trim() || '~/AgentBridge'

  return (
    <div className="settings-pages">
      {/* About 박스 */}
      <section className="settings-about">
        <div className="settings-about-head">
          <img src={appIcon} alt="" className="settings-app-logo" />
          <div className="settings-about-meta">
            <div className="settings-app-name">AgentBridge</div>
            <div className="settings-app-sub">
              v{health?.version ?? '–'} · {t.settings.main.tagline}
            </div>
          </div>
          <button
            className="settings-row-control"
            onClick={() => void window.agentbridge.openExternal(GITHUB_URL)}
            title={t.settings.main.openRepo}
            aria-label={t.settings.main.openRepo}
          >
            <ExternalLinkIcon />
          </button>
        </div>
        {health && (
          <div className="settings-about-rows">
            <div className="settings-row">
              <HomeIcon className="settings-row-icon" />
              <span className="settings-row-label">{t.settings.main.version}</span>
              <span className="settings-row-value">v{health.version}</span>
            </div>
            <div className="settings-row">
              <SparkleIcon className="settings-row-icon" />
              <span className="settings-row-label">{t.settings.main.runtime}</span>
              <span className="settings-row-value">
                Electron {health.electron} · Node {health.node}
              </span>
            </div>
            <div className="settings-row">
              <GlobeIcon className="settings-row-icon" />
              <span className="settings-row-label">{t.settings.main.platform}</span>
              <span className="settings-row-value">
                {health.platform} · {health.arch}
              </span>
            </div>
            <div className="settings-row">
              <DatabaseIcon className="settings-row-icon" />
              <span className="settings-row-label">{t.settings.main.dataLocation}</span>
              <span className="settings-row-value mono settings-path-val">
                {health.userDataDir}
              </span>
              <button
                className="settings-row-control"
                onClick={() => void window.agentbridge.openPath(health.userDataDir)}
                title={t.common.openInFinder}
                aria-label={t.common.openInFinder}
              >
                <FolderIcon />
              </button>
            </div>
          </div>
        )}
      </section>

      {/* 앱 그룹 */}
      <div className="settings-group">
        <div className="settings-group-label">{t.settings.main.groupApp}</div>
        <div className="settings-card-list">
          <div className="settings-row">
            <ThemeIcon className="settings-row-icon" />
            <span className="settings-row-label">{t.settings.main.appearance}</span>
            <select
              className="settings-row-select"
              value={settings?.theme ?? 'dark'}
              disabled
              onChange={(e) => void onUpdate({ theme: e.target.value as ThemeMode })}
              title={t.settings.main.appearanceLocked}
            >
              <option value="dark">{t.settings.themeLabel.dark}</option>
              <option value="light">
                {t.settings.themeLabel.light} ({t.settings.locked})
              </option>
              <option value="system">
                {t.settings.themeLabel.system} ({t.settings.locked})
              </option>
            </select>
          </div>
          <div className="settings-row">
            <GlobeIcon className="settings-row-icon" />
            <span className="settings-row-label">{t.settings.main.language}</span>
            <select
              className="settings-row-select"
              value={settings?.language ?? 'ko'}
              onChange={(e) => void onUpdate({ language: e.target.value as LanguageCode })}
            >
              <option value="ko">{LANGUAGE_LABEL.ko}</option>
              <option value="en">{LANGUAGE_LABEL.en}</option>
            </select>
          </div>
          <div className="settings-row">
            <FolderIcon className="settings-row-icon" />
            <span className="settings-row-label">{t.settings.main.defaultPath}</span>
            <span className="settings-row-value mono settings-path-val">{basePathValue}</span>
            <button
              className="settings-row-control"
              onClick={() => void onPickBasePath()}
              title={t.common.pickFolder}
              aria-label={t.common.pickFolder}
            >
              <FolderIcon />
            </button>
          </div>
        </div>
      </div>

      {/* 에이전트 그룹 */}
      <div className="settings-group">
        <div className="settings-group-label">{t.settings.main.groupAgent}</div>
        <div className="settings-card-list">
          <button
            className="settings-row settings-row-button"
            onClick={() => onSubPage('cli')}
            title={t.settings.main.cliDetectTitle}
          >
            <TerminalIcon className="settings-row-icon" />
            <span className="settings-row-label">{t.settings.main.cliDetect}</span>
            <span className="settings-row-value">
              {env ? t.settings.main.cliDetectedCount(foundCount, totalCount) : t.settings.main.probing}
            </span>
            <ChevronRightIcon className="settings-row-chev" />
          </button>
          <div className="settings-row">
            <SparkleIcon className="settings-row-icon" />
            <span className="settings-row-label">{t.settings.main.refineModelPolicy}</span>
            <span className="settings-row-value settings-row-desc">
              {settings ? t.settings.refinePolicyDesc[settings.refineModel] : ''}
            </span>
            <select
              className="settings-row-select"
              value={settings?.refineModel ?? 'priority'}
              onChange={(e) => void onUpdate({ refineModel: e.target.value as RefineModelPolicy })}
              title={t.settings.main.refineModelPolicyTitle}
            >
              <option value="priority">{t.settings.refinePolicyLabel.priority}</option>
              <option value="fixed">{t.settings.refinePolicyLabel.fixed}</option>
              <option value="active">{t.settings.refinePolicyLabel.active}</option>
              <option value="off">{t.settings.refinePolicyLabel.off}</option>
            </select>
          </div>
          {settings && settings.refineModel !== 'off' && (
            <div className="settings-row">
              <SparkleIcon className="settings-row-icon" />
              <span className="settings-row-label">{t.settings.main.useClaude}</span>
              <span className="settings-row-value settings-row-desc">
                {t.settings.main.useClaudeDesc}
              </span>
              <select
                className="settings-row-select"
                value={settings.refineUseClaude ? 'on' : 'off'}
                onChange={(e) => void onUpdate({ refineUseClaude: e.target.value === 'on' })}
                title={t.settings.main.useClaude}
              >
                <option value="on">{t.settings.main.useClaudeOn}</option>
                <option value="off">{t.settings.main.useClaudeOff}</option>
              </select>
            </div>
          )}
          {settings?.refineModel === 'priority' && (
            <PriorityOrderRow
              order={settings.refinePriorityOrder}
              onUpdate={(next) => void onUpdate({ refinePriorityOrder: next })}
            />
          )}
          {settings?.refineModel === 'fixed' && (
            <div className="settings-row">
              <SparkleIcon className="settings-row-icon" />
              <span className="settings-row-label">{t.settings.main.fixedCli}</span>
              <span className="settings-row-value settings-row-desc">
                {t.settings.main.fixedCliDesc}
              </span>
              <select
                className="settings-row-select"
                value={settings.refineFixedCli}
                onChange={(e) => void onUpdate({ refineFixedCli: e.target.value as CliKind })}
              >
                {CLI_ORDER_FULL.map((k) => (
                  <option key={k} value={k}>
                    {CLI_LABEL[k]}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      </div>

      {/* 데이터 그룹 */}
      <div className="settings-group">
        <div className="settings-group-label">{t.settings.main.groupData}</div>
        <div className="settings-card-list">
          <div className="settings-row">
            <DatabaseIcon className="settings-row-icon" />
            <span className="settings-row-label">{t.settings.main.dataManage}</span>
            <span className="settings-row-value mono settings-path-val">
              {health?.userDataDir ?? '–'}
            </span>
            <button
              className="settings-row-control"
              onClick={() => health && void window.agentbridge.openPath(health.userDataDir)}
              title={t.common.openInFinder}
              aria-label={t.common.openInFinder}
            >
              <FolderIcon />
            </button>
          </div>
          <div className="settings-row">
            <DatabaseIcon className="settings-row-icon" />
            <span className="settings-row-label">{t.settings.main.turnsDetail}</span>
            <span className="settings-row-value settings-row-desc">
              {settings ? t.settings.turnsDetailDesc[settings.turnsAssistantDetail] : ''}
            </span>
            <select
              className="settings-row-select"
              value={settings?.turnsAssistantDetail ?? 'compact'}
              onChange={(e) =>
                void onUpdate({ turnsAssistantDetail: e.target.value as TurnsAssistantDetail })
              }
              title={t.settings.main.turnsDetailTitle}
            >
              <option value="full">{t.settings.turnsDetailLabel.full}</option>
              <option value="compact">{t.settings.turnsDetailLabel.compact}</option>
              <option value="minimal">{t.settings.turnsDetailLabel.minimal}</option>
            </select>
          </div>
          <div className="settings-row">
            <DatabaseIcon className="settings-row-icon" />
            <span className="settings-row-label">{t.settings.main.archiveCount}</span>
            <span className="settings-row-value settings-row-desc">
              {t.settings.main.archiveCountDesc}
            </span>
            <input
              type="number"
              min={1}
              max={100}
              step={1}
              className="settings-row-number"
              value={settings?.maxArchiveSnapshots ?? 15}
              onChange={(e) => {
                const n = Math.floor(Number(e.target.value))
                if (Number.isFinite(n) && n >= 1) {
                  void onUpdate({ maxArchiveSnapshots: n })
                }
              }}
              title={t.settings.main.archiveCountTitle}
            />
          </div>
        </div>
      </div>

      {/* 정보 그룹 */}
      <div className="settings-group">
        <div className="settings-group-label">{t.settings.main.groupInfo}</div>
        <div className="settings-card-list">
          {(() => {
            const desc = describeUpdaterStatus(updaterStatus, health?.version, t)
            const disabled =
              updaterChecking ||
              updaterStatus.phase === 'checking' ||
              updaterStatus.phase === 'downloading' ||
              updaterStatus.phase === 'skipped-dev'
            return (
              <button
                className={`settings-row settings-row-button settings-updater-row tone-${desc.tone}`}
                onClick={() => void onCheckForUpdates()}
                disabled={disabled}
                title={
                  updaterStatus.phase === 'skipped-dev'
                    ? t.settings.main.checkUpdateDevTitle
                    : t.settings.main.checkUpdateTitle
                }
              >
                <ArrowUpIcon className="settings-row-icon" />
                <span className="settings-row-label">{t.settings.main.checkUpdate}</span>
                <span className="settings-row-value settings-updater-value">
                  <span className="settings-updater-label">{desc.label}</span>
                  {desc.sub && <span className="settings-updater-sub">{desc.sub}</span>}
                </span>
                <ChevronRightIcon className="settings-row-chev" />
              </button>
            )
          })()}
          <button
            className="settings-row settings-row-button"
            onClick={() => void window.agentbridge.openExternal(`${GITHUB_URL}/releases`)}
            title={t.settings.main.releaseNotesTitle}
          >
            <ExternalLinkIcon className="settings-row-icon" />
            <span className="settings-row-label">{t.settings.main.releaseNotes}</span>
            <span className="settings-row-value">v{health?.version ?? '–'}</span>
            <ChevronRightIcon className="settings-row-chev" />
          </button>
          <button
            className="settings-row settings-row-button"
            onClick={() => onSubPage('shortcuts')}
          >
            <KeyboardIcon className="settings-row-icon" />
            <span className="settings-row-label">{t.settings.main.shortcuts}</span>
            <ChevronRightIcon className="settings-row-chev" />
          </button>
          <button className="settings-row settings-row-button" onClick={() => onSubPage('help')}>
            <HelpIcon className="settings-row-icon" />
            <span className="settings-row-label">{t.settings.main.helpAndCautions}</span>
            <ChevronRightIcon className="settings-row-chev" />
          </button>
          <button className="settings-row settings-row-button" onClick={() => onSubPage('license')}>
            <InfoIcon className="settings-row-icon" />
            <span className="settings-row-label">{t.settings.main.license}</span>
            <span className="settings-row-value">MIT</span>
            <ChevronRightIcon className="settings-row-chev" />
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Sub pages ────────────────────────────────────────────────────

function CliPage({ env }: { env: EnvProbeResult | null }): React.JSX.Element {
  const t = useT()
  return (
    <div className="settings-pages">
      <p className="hint settings-page-intro">{t.settings.cliPage.intro}</p>
      <div className="settings-group">
        <div className="settings-group-label">{t.settings.cliPage.detectedGroup}</div>
        <div className="settings-card-list">
          {env?.clis.map((c) => (
            <div className="settings-row" key={c.kind}>
              <TerminalIcon className="settings-row-icon" />
              <span className="settings-row-label">{c.kind}</span>
              {c.found ? (
                <>
                  <span className="settings-row-value mono settings-path-val">{c.path ?? ''}</span>
                  <span className="settings-row-value settings-row-version">
                    {c.version ?? c.error ?? t.settings.cliPage.versionUnknown}
                  </span>
                </>
              ) : (
                <span className="settings-row-value settings-row-missing">
                  {t.settings.cliPage.notInPath}
                </span>
              )}
            </div>
          ))}
          {!env && (
            <div className="settings-row">
              <span className="hint">{t.settings.main.probing}</span>
            </div>
          )}
        </div>
      </div>
      <div className="settings-group">
        <div className="settings-card-list">
          <button
            className="settings-row settings-row-button"
            onClick={() => window.location.reload()}
            title={t.settings.cliPage.redetectTitle}
          >
            <SparkleIcon className="settings-row-icon" />
            <span className="settings-row-label">{t.settings.cliPage.redetect}</span>
            <ChevronRightIcon className="settings-row-chev" />
          </button>
        </div>
      </div>
    </div>
  )
}

function ShortcutsPage(): React.JSX.Element {
  const t = useT()
  return (
    <div className="settings-pages">
      <div className="settings-group">
        <div className="settings-group-label">{t.settings.shortcuts.groupWindow}</div>
        <div className="settings-card-list">
          <div className="settings-row">
            <span className="settings-row-label">{t.settings.shortcuts.newWindow}</span>
            <span className="settings-row-value mono">⌘ N</span>
          </div>
          <div className="settings-row">
            <span className="settings-row-label">{t.settings.shortcuts.quit}</span>
            <span className="settings-row-value mono">⌘ Q</span>
          </div>
        </div>
      </div>
      <div className="settings-group">
        <div className="settings-group-label">{t.settings.shortcuts.groupSidebar}</div>
        <div className="settings-card-list">
          <div className="settings-row">
            <span className="settings-row-label">{t.settings.shortcuts.toggleLeft}</span>
            <span className="settings-row-value mono">⌘ B</span>
          </div>
          <div className="settings-row">
            <span className="settings-row-label">{t.settings.shortcuts.toggleRight}</span>
            <span className="settings-row-value mono">⌘ ⌥ B</span>
          </div>
        </div>
      </div>
      <div className="settings-group">
        <div className="settings-group-label">{t.settings.shortcuts.groupHome}</div>
        <div className="settings-card-list">
          <div className="settings-row">
            <span className="settings-row-label">{t.settings.shortcuts.send}</span>
            <span className="settings-row-value mono">Enter</span>
          </div>
          <div className="settings-row">
            <span className="settings-row-label">{t.settings.shortcuts.newline}</span>
            <span className="settings-row-value mono">⇧ Enter</span>
          </div>
        </div>
      </div>
      <div className="settings-group">
        <div className="settings-group-label">{t.settings.shortcuts.groupTerminal}</div>
        <div className="settings-card-list">
          <div className="settings-row">
            <span className="settings-row-label">{t.settings.shortcuts.newlineInput}</span>
            <span className="settings-row-value mono">⇧ Enter</span>
          </div>
          <div className="settings-row">
            <span className="settings-row-label">{t.settings.shortcuts.interrupt}</span>
            <span className="settings-row-value mono">Ctrl C</span>
          </div>
        </div>
      </div>
      <div className="settings-group">
        <div className="settings-group-label">{t.settings.shortcuts.groupModal}</div>
        <div className="settings-card-list">
          <div className="settings-row">
            <span className="settings-row-label">{t.settings.shortcuts.closeBack}</span>
            <span className="settings-row-value mono">Esc</span>
          </div>
        </div>
      </div>
    </div>
  )
}

// 사용 설명서는 <code>/<strong> 섞인 리치 마크업이라 문자열 테이블에 못 담는다 →
// 언어별 JSX로 분기(useLang). 나머지 화면은 useT() 문자열 테이블로 충분.
function HelpPage(): React.JSX.Element {
  const lang = useLang()
  return lang === 'en' ? <HelpPageEn /> : <HelpPageKo />
}

function HelpPageKo(): React.JSX.Element {
  return (
    <div className="settings-pages">
      <div className="settings-group">
        <div className="settings-group-label">기본</div>
        <div className="settings-card-list settings-card-list-pad">
          <ul className="settings-help-list">
            <li>
              홈 화면에서 메시지를 입력하고 모델을 선택하면 워크스페이스가 자동 생성되어 모델이
              시작됩니다.
            </li>
            <li>
              한 워크스페이스 안에서 상단 <code>+ 모델</code> 버튼으로 다른 모델 탭을 추가할 수
              있습니다. 탭 전환 = 모델 전환이며 IR이 자동으로 따라갑니다.
            </li>
            <li>
              우 사이드바 메모리 패널에서 현재 IR과 이전 스냅샷을 확인할 수 있고, 수동 정제 / 메모리
              초기화 / IR 카드 개별 삭제가 가능합니다.
            </li>
            <li>
              좌 사이드바에서 다른 워크스페이스로 진입하거나, 우클릭으로 새 창으로 열기 / 이름 수정
              / 삭제 등의 액션이 가능합니다.
            </li>
          </ul>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group-label">주요 기능</div>
        <div className="settings-card-list settings-card-list-pad">
          <ul className="settings-help-list">
            <li>
              <strong>드래그 앤 드롭 첨부</strong> — 파일을 xterm 영역에 떨어뜨리면 절대 경로가 모델
              입력에 자동 paste됩니다. bracketed paste로 자동 submit이 차단되어 사용자가 직접
              Enter를 누를 때까지 전송되지 않습니다. 한 번에 최대 20개 파일.
            </li>
            <li>
              <strong>멀티 윈도우</strong> — 워크스페이스를 별도 윈도우로 띄울 수 있습니다.{' '}
              <code>⌘ N</code>으로 새 빈 윈도우, 좌 사이드바 우클릭 메뉴에서 &quot;새 창으로
              열기&quot;를 선택할 수 있습니다. 한 워크스페이스는 한 윈도우 정책으로 중복 열림이
              차단됩니다.
            </li>
            <li>
              <strong>내장 터미널 세션</strong> — 모델 spawn 없이 일반 zsh 터미널 탭을 띄울 수
              있습니다. CLI 환경 점검이나 잡일에 활용하세요.
            </li>
            <li>
              <strong>Antigravity quota 자동 폴백</strong> — agy CLI footer의 사용량 표시(
              <code>X% used</code>)를 자동 감지해 95% 이상이면 활성 모델로 폴백합니다. UTC 자정에
              자동 해제됩니다.
            </li>
          </ul>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group-label">주의사항</div>
        <div className="settings-card-list settings-card-list-pad">
          <ul className="settings-help-list">
            <li>
              각 CLI(claude / codex / agy(Antigravity))는 사전에 설치되어 PATH에 등록되어 있어야
              합니다. 감지 결과는 &quot;CLI 감지&quot; 페이지에서 확인하세요.
            </li>
            <li>
              워크스페이스 폴더에 다음 3개 파일이 마커 블록 merge로 추가됩니다 —{' '}
              <code>.codex/hooks.json</code>, <code>.codex/config.toml</code>,{' '}
              <code>.agents/hooks.json</code>. 마커 블록 외 사용자 콘텐츠는 변경되지 않습니다.
              claude는 워크스페이스 폴더에 어떤 파일도 만들지 않습니다.
            </li>
            <li>
              codex의 hook 시스템은 첫 실행 시 <code>/hooks</code> 슬래시 명령으로 사용자의 수동
              승인이 필요합니다. 미승인 상태에서는 IR 주입이 동작하지 않으며, 상단에 안내 배너가
              표시됩니다.
            </li>
            <li>
              터미널 안에서 <code>/clear</code>로 모델 컨텍스트를 비워도 AgentBridge가 매 메시지마다
              IR을 다시 주입합니다. 메모리 자체를 비우려면 메모리 패널의 초기화 버튼을 사용하세요.
            </li>
            <li>
              Antigravity의 무료 quota는 인터랙티브 세션 footer로만 정확히 측정됩니다. 한도 근접 시
              자동으로 활성 모델로 폴백하며 UTC 자정에 자동 해제됩니다.
            </li>
            <li>
              메인 모델 메시지는 사용자가 인증한 각 CLI를 통해 그 CLI가 원래 통신하는 백엔드
              (Anthropic / OpenAI / Google)로만 전송됩니다. IR 정제는 인증된 Antigravity를 통해서만
              전송됩니다. 이 두 경로 외 어떤 외부 서비스로도 전송되지 않습니다.
            </li>
          </ul>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group-label">피드백</div>
        <div className="settings-card-list">
          <button
            className="settings-row settings-row-button"
            onClick={() => void window.agentbridge.openExternal(`${GITHUB_URL}/issues`)}
          >
            <ExternalLinkIcon className="settings-row-icon" />
            <span className="settings-row-label">GitHub Issues 열기</span>
            <ChevronRightIcon className="settings-row-chev" />
          </button>
        </div>
      </div>
    </div>
  )
}

function HelpPageEn(): React.JSX.Element {
  return (
    <div className="settings-pages">
      <div className="settings-group">
        <div className="settings-group-label">Basics</div>
        <div className="settings-card-list settings-card-list-pad">
          <ul className="settings-help-list">
            <li>
              Type a message and pick a model on the home screen — a workspace is created
              automatically and the model starts.
            </li>
            <li>
              Inside a workspace, add another model tab with the <code>+ Model</code> button at the
              top. Switching tabs = switching models, and the IR follows automatically.
            </li>
            <li>
              In the memory panel on the right sidebar you can view the current IR and past
              snapshots, and manually refine / reset memory / delete individual IR cards.
            </li>
            <li>
              From the left sidebar you can enter another workspace, or right-click for actions like
              open in new window / rename / delete.
            </li>
          </ul>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group-label">Key features</div>
        <div className="settings-card-list settings-card-list-pad">
          <ul className="settings-help-list">
            <li>
              <strong>Drag &amp; drop attach</strong> — drop files onto the xterm area and their
              absolute paths are auto-pasted into the model input. Bracketed paste blocks
              auto-submit, so nothing is sent until you press Enter yourself. Up to 20 files at once.
            </li>
            <li>
              <strong>Multi-window</strong> — open a workspace in its own window.{' '}
              <code>⌘ N</code> opens a new empty window, or pick &quot;Open in new window&quot; from
              the left sidebar&apos;s right-click menu. One workspace = one window, so duplicate
              opens are blocked.
            </li>
            <li>
              <strong>Built-in terminal session</strong> — open a plain zsh terminal tab without
              spawning a model. Handy for checking the CLI environment or odd jobs.
            </li>
            <li>
              <strong>Antigravity quota auto-fallback</strong> — the agy CLI footer&apos;s usage
              display (<code>X% used</code>) is auto-detected, and at 95%+ it falls back to the
              active model. Released automatically at UTC midnight.
            </li>
          </ul>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group-label">Cautions</div>
        <div className="settings-card-list settings-card-list-pad">
          <ul className="settings-help-list">
            <li>
              Each CLI (claude / codex / agy (Antigravity)) must be installed and on PATH
              beforehand. Check detection on the &quot;CLI detection&quot; page.
            </li>
            <li>
              Three files are added to the workspace folder via marker-block merge —{' '}
              <code>.codex/hooks.json</code>, <code>.codex/config.toml</code>,{' '}
              <code>.agents/hooks.json</code>. Content outside the marker block is left untouched.
              claude creates no files in the workspace folder.
            </li>
            <li>
              codex&apos;s hook system requires manual approval via the <code>/hooks</code> slash
              command on first run. Until approved, IR injection does not work and a notice banner is
              shown at the top.
            </li>
            <li>
              Even if you clear the model context with <code>/clear</code> in the terminal,
              AgentBridge re-injects the IR on every message. To clear the memory itself, use the
              reset button in the memory panel.
            </li>
            <li>
              Antigravity&apos;s free quota is measured accurately only from the interactive session
              footer. Near the limit it auto-falls back to the active model and is released
              automatically at UTC midnight.
            </li>
            <li>
              Main-model messages are sent only through each CLI you authenticated, to the backend
              that CLI natively talks to (Anthropic / OpenAI / Google). IR refinement is sent only
              through authenticated Antigravity. Nothing is sent to any external service outside
              these two paths.
            </li>
          </ul>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group-label">Feedback</div>
        <div className="settings-card-list">
          <button
            className="settings-row settings-row-button"
            onClick={() => void window.agentbridge.openExternal(`${GITHUB_URL}/issues`)}
          >
            <ExternalLinkIcon className="settings-row-icon" />
            <span className="settings-row-label">Open GitHub Issues</span>
            <ChevronRightIcon className="settings-row-chev" />
          </button>
        </div>
      </div>
    </div>
  )
}

// LICENSE 본문은 루트의 LICENSE 파일과 동기 유지. MIT 본문은 사실상 변하지 않으므로
// build-time embed보다 source 내 string 상수로 둔다(vite root 밖 raw import 회피).
const LICENSE_TEXT = `MIT License

Copyright (c) 2026 h-taek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

function LicensePage(): React.JSX.Element {
  const t = useT()
  return (
    <div className="settings-pages">
      <p className="hint settings-page-intro">{t.settings.licensePage.intro}</p>
      <div className="settings-group">
        <div className="settings-card-list">
          <pre className="settings-license-text">{LICENSE_TEXT}</pre>
        </div>
      </div>
      <div className="settings-group">
        <div className="settings-card-list">
          <button
            className="settings-row settings-row-button"
            onClick={() => void window.agentbridge.openExternal(`${GITHUB_URL}/blob/main/LICENSE`)}
          >
            <ExternalLinkIcon className="settings-row-icon" />
            <span className="settings-row-label">{t.settings.licensePage.viewInRepo}</span>
            <ChevronRightIcon className="settings-row-chev" />
          </button>
        </div>
      </div>
    </div>
  )
}
