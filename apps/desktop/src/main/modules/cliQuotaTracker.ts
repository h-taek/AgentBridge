import { app, BrowserWindow, type WebContents } from 'electron'
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import log from 'electron-log/main'
import { IpcChannel, type CliKind } from '@shared/ipc'
import { broadcastToAll } from './windowManager'
import {
  deleteAgyConversationFiles,
  deleteAgyImplicitDelta,
  deleteAgyLogDelta,
  readLastConversationForCwd,
  snapshotAgyImplicit,
  snapshotAgyLogs
} from './cliAdapter/agyResume'
import { captureNewThreadId, snapshotCodexSessions } from './cliAdapter/codexSessionWatcher'

// CliQuotaTracker — Phase 2 (2026-05-21 재설계).
//
// 세 CLI(agy/codex/claude)의 quota를 *각자 슬래시 명령*으로 직접 캡처.
// 백그라운드 PTY spawn → /usage 또는 /status 입력 → 응답 파싱 → SIGTERM + native 세션 파일 unlink.
//
// 슬래시 명령:
//   agy:    `/usage`   응답에 "N% \n Quota available|exhausted" 블록 (N = 남은 %)
//   codex:  `/status`  응답에 "5h limit: ... N% left" (N = 남은 %)
//   claude: `/usage`   응답에 "Current session ... N% used" (N = 사용된 %)
//
// 정리 흐름 (per CLI):
//   agy:    spawn 직후 cwd → ~/.gemini/antigravity-cli/cache/last_conversations.json 매핑 polling
//           → UUID 캡처 시 deleteAgyConversationFiles(uuid)
//   codex:  spawn 직전 ~/.codex/sessions 스냅샷 → captureNewThreadId → 파일명 매칭 unlink
//   claude: 사전 발급한 UUID로 `--session-id <uuid>` spawn → ~/.claude/projects/*/${uuid}.jsonl 삭제
//
// 영속 위치: `~/Library/Application Support/AgentBridge/cli_quota.json` (이전 agy_quota.json /
// gemini_quota.json은 첫 read 시 자동 migration).

const QUOTA_FILE_NAME = 'cli_quota.json'
const LEGACY_AGY_QUOTA_FILE_NAME = 'agy_quota.json'
const LEGACY_GEMINI_QUOTA_FILE_NAME = 'gemini_quota.json'

// % used 기반 임계값. agy/codex/claude 동일 적용.
export const QUOTA_WARN_PERCENT = 80
export const QUOTA_CRITICAL_PERCENT = 95
export const QUOTA_EXCEEDED_PERCENT = 100

export type QuotaSeverity = 'unknown' | 'ok' | 'warn' | 'critical' | 'exceeded'

export type CliQuotaSnapshot = {
  // 슬래시 명령 응답에서 마지막 캡처한 % used. null이면 아직 한 번도 못 봄.
  usedPercent: number | null
  lastSeenAt: string | null
  severity: QuotaSeverity
  shouldFallback: boolean
  // 응답 에러로 강제 폴백 마킹된 상태 (UTC 자정 자동 해제).
  forcedFallback: boolean
}

type QuotaFile = {
  usedPercent: number | null
  lastSeenAt: string | null
  forcedFallbackDate: string | null
  forcedFallback: boolean
}

type QuotaFileMap = Partial<Record<CliKind, QuotaFile>>

const EMPTY_FILE: QuotaFile = {
  usedPercent: null,
  lastSeenAt: null,
  forcedFallbackDate: null,
  forcedFallback: false
}

function getQuotaFilePath(): string {
  return path.join(app.getPath('userData'), QUOTA_FILE_NAME)
}

function getLegacyAgyQuotaFilePath(): string {
  return path.join(app.getPath('userData'), LEGACY_AGY_QUOTA_FILE_NAME)
}

function getLegacyGeminiQuotaFilePath(): string {
  return path.join(app.getPath('userData'), LEGACY_GEMINI_QUOTA_FILE_NAME)
}

function broadcastQuotaUpdated(cli: CliKind, snap: CliQuotaSnapshot): void {
  broadcastToAll(IpcChannel.QuotaUpdated, { cli, snapshot: snap })
}

function todayKey(): string {
  const now = new Date()
  const y = now.getUTCFullYear()
  const m = String(now.getUTCMonth() + 1).padStart(2, '0')
  const d = String(now.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function severityFor(usedPercent: number | null, forcedFallback: boolean): QuotaSeverity {
  if (forcedFallback) return 'exceeded'
  if (usedPercent == null) return 'unknown'
  if (usedPercent >= QUOTA_EXCEEDED_PERCENT) return 'exceeded'
  if (usedPercent >= QUOTA_CRITICAL_PERCENT) return 'critical'
  if (usedPercent >= QUOTA_WARN_PERCENT) return 'warn'
  return 'ok'
}

function shouldFallbackFor(severity: QuotaSeverity): boolean {
  return severity === 'critical' || severity === 'exceeded'
}

function parseFile(raw: unknown): QuotaFile {
  const o = (raw ?? {}) as Partial<QuotaFile>
  return {
    usedPercent: typeof o.usedPercent === 'number' ? o.usedPercent : null,
    lastSeenAt: typeof o.lastSeenAt === 'string' ? o.lastSeenAt : null,
    forcedFallbackDate: typeof o.forcedFallbackDate === 'string' ? o.forcedFallbackDate : null,
    forcedFallback: o.forcedFallback === true
  }
}

async function readQuotaFile(): Promise<QuotaFileMap> {
  // 신규 cli_quota.json 우선. 없으면 legacy agy_quota.json/gemini_quota.json을 agy 슬롯으로 흡수.
  try {
    const raw = await fs.readFile(getQuotaFilePath(), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: QuotaFileMap = {}
    for (const k of ['agy', 'codex', 'claude'] as CliKind[]) {
      if (parsed[k]) out[k] = parseFile(parsed[k])
    }
    return out
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      log.warn('cli_quota.json 파싱 실패 — 새 schema로 리셋', { err: String(err) })
    }
  }
  // legacy single-file fallback (agy 슬롯으로 한 번만 흡수, 이후 cli_quota.json에 정착).
  for (const legacyPath of [getLegacyAgyQuotaFilePath(), getLegacyGeminiQuotaFilePath()]) {
    try {
      const raw = await fs.readFile(legacyPath, 'utf8')
      const parsed = JSON.parse(raw)
      log.info('legacy quota 파일을 cli_quota.json/agy로 흡수', { legacyPath })
      return { agy: parseFile(parsed) }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        log.warn(`${path.basename(legacyPath)} 파싱 실패 — 무시`, { err: String(err) })
      }
    }
  }
  return {}
}

async function writeQuotaFile(map: QuotaFileMap): Promise<void> {
  const p = getQuotaFilePath()
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(tmp, JSON.stringify(map, null, 2), 'utf8')
  await fs.rename(tmp, p)
}

function rolloverIfNeeded(state: QuotaFile): QuotaFile {
  if (!state.forcedFallback) return state
  if (state.forcedFallbackDate === todayKey()) return state
  return { ...state, forcedFallback: false, forcedFallbackDate: null }
}

function reconcileForcedFallback(state: QuotaFile): QuotaFile {
  if (
    state.forcedFallback &&
    typeof state.usedPercent === 'number' &&
    state.usedPercent < QUOTA_CRITICAL_PERCENT
  ) {
    return { ...state, forcedFallback: false, forcedFallbackDate: null }
  }
  return state
}

function snapshotFrom(state: QuotaFile): CliQuotaSnapshot {
  const severity = severityFor(state.usedPercent, state.forcedFallback)
  return {
    usedPercent: state.usedPercent,
    lastSeenAt: state.lastSeenAt,
    severity,
    shouldFallback: shouldFallbackFor(severity),
    forcedFallback: state.forcedFallback
  }
}

export async function getQuotaSnapshot(cli: CliKind): Promise<CliQuotaSnapshot> {
  const map = await readQuotaFile()
  const raw = map[cli] ?? EMPTY_FILE
  const afterRollover = rolloverIfNeeded(raw)
  const afterReconcile = reconcileForcedFallback(afterRollover)
  if (
    afterReconcile.forcedFallback !== raw.forcedFallback ||
    afterReconcile.forcedFallbackDate !== raw.forcedFallbackDate
  ) {
    const next = { ...map, [cli]: afterReconcile }
    await writeQuotaFile(next)
    const snap = snapshotFrom(afterReconcile)
    broadcastQuotaUpdated(cli, snap)
    return snap
  }
  return snapshotFrom(afterReconcile)
}

export async function getAllQuotaSnapshots(): Promise<Record<CliKind, CliQuotaSnapshot>> {
  const map = await readQuotaFile()
  const out = {} as Record<CliKind, CliQuotaSnapshot>
  for (const k of ['agy', 'codex', 'claude'] as CliKind[]) {
    const raw = map[k] ?? EMPTY_FILE
    out[k] = snapshotFrom(reconcileForcedFallback(rolloverIfNeeded(raw)))
  }
  return out
}

export async function recordQuotaPercent(cli: CliKind, percent: number): Promise<CliQuotaSnapshot> {
  if (!Number.isFinite(percent) || percent < 0 || percent > 1000) {
    return getQuotaSnapshot(cli)
  }
  const map = await readQuotaFile()
  let state = rolloverIfNeeded(map[cli] ?? EMPTY_FILE)
  if (state.usedPercent === percent) {
    return snapshotFrom(state)
  }
  state = { ...state, usedPercent: percent, lastSeenAt: new Date().toISOString() }
  state = reconcileForcedFallback(state)
  await writeQuotaFile({ ...map, [cli]: state })
  log.info('quota 캡처', { cli, usedPercent: percent })
  const snap = snapshotFrom(state)
  broadcastQuotaUpdated(cli, snap)
  return snap
}

export async function markForcedFallback(cli: CliKind): Promise<CliQuotaSnapshot> {
  const map = await readQuotaFile()
  let state = rolloverIfNeeded(map[cli] ?? EMPTY_FILE)
  state = { ...state, forcedFallback: true, forcedFallbackDate: todayKey() }
  await writeQuotaFile({ ...map, [cli]: state })
  log.warn('quota 강제 폴백 마킹', { cli })
  const snap = snapshotFrom(state)
  broadcastQuotaUpdated(cli, snap)
  return snap
}

// ─── 슬래시 명령 응답 파싱 ─────────────────────────────────────────────

// agy: `<bar> N%\nQuota available|exhausted` — N = 남은 quota → usedPercent = 100 - N.
const AGY_USAGE_RE = /(\d+)\s*%\s*\n\s*Quota\s+(?:available|exhausted)/i

// codex: `5h limit: ... N% left` — N = 남은 quota → usedPercent = 100 - N.
const CODEX_STATUS_RE = /5h\s*limit:[\s\S]{0,200}?(\d+)\s*%\s+left/i

// claude: `Current session ... N%used` — N = 사용된 quota 그대로.
// 라이브 검증: ANSI strip 후 `%`와 `used` 사이 공백이 사라지는 경우(`39%used`)가 있어 \s* 사용.
const CLAUDE_USAGE_RE = /Current\s+session[\s\S]{0,200}?(\d+)\s*%\s*used/i

export function extractQuotaPercent(cli: CliKind, stripped: string): number | null {
  let m: RegExpExecArray | null
  let n: number
  switch (cli) {
    case 'agy':
      m = AGY_USAGE_RE.exec(stripped)
      if (!m) return null
      n = Number.parseInt(m[1], 10)
      if (!Number.isFinite(n) || n < 0 || n > 100) return null
      return 100 - n
    case 'codex':
      m = CODEX_STATUS_RE.exec(stripped)
      if (!m) return null
      n = Number.parseInt(m[1], 10)
      if (!Number.isFinite(n) || n < 0 || n > 100) return null
      return 100 - n
    case 'claude':
      m = CLAUDE_USAGE_RE.exec(stripped)
      if (!m) return null
      n = Number.parseInt(m[1], 10)
      if (!Number.isFinite(n) || n < 0 || n > 100) return null
      return n
  }
}

// agy quota 에러 휴리스틱 — 자연어 응답에 'quota' 단어가 우연 등장하는 false positive를
// 막기 위해 *에러 컨텍스트와 결합된 강한 패턴*만 매칭.
const QUOTA_STRONG_PATTERNS: RegExp[] = [
  /quota\s*(?:exceeded|exhausted|limit|reached|hit|error)/i,
  /exceed(?:ed|ing)?\s+(?:your\s+)?quota/i,
  /out\s+of\s+quota/i,
  /rate[\s_-]*limit(?:ed|ing|\s+exceeded|\s+reached|\s+error)?/i,
  /resource[\s_-]*exhausted/i,
  /(?:http\s*\/?\s*)?status[:\s]+429\b/i,
  /\b429\s+(?:too\s+many|error|status|response|resource|client)/i,
  /too\s+many\s+requests/i
]

export function looksLikeQuotaError(
  stderr: string,
  assistantText: string,
  exitCode?: number | null
): boolean {
  if (QUOTA_STRONG_PATTERNS.some((re) => re.test(stderr))) return true
  if (exitCode != null && exitCode !== 0) {
    if (QUOTA_STRONG_PATTERNS.some((re) => re.test(assistantText))) return true
  }
  return false
}

// ─── Background quota probe — per CLI ───────────────────────────────────

// CLI별 step delay 누적이 PROBE_TIMEOUT_MS 안에 들어가야 함.
const PROBE_TIMEOUT_MS = 40_000
const ANSI_STRIP_RE = new RegExp(
  '\\u001b\\[[0-?]*[ -/]*[@-~]' +
    '|\\u001b\\][\\s\\S]*?(?:\\u0007|\\u001b\\\\)' +
    '|\\u001b[PX^_][\\s\\S]*?\\u001b\\\\' +
    '|\\u001b[@-Z\\\\\\-_]',
  'g'
)

export type ProbeResult = {
  ok: boolean
  cli: CliKind
  snapshot: CliQuotaSnapshot
  reason?: string
  durationMs: number
}

type ProbeDeps = {
  startPty: (
    req: {
      command: string
      args: string[]
      cwd: string
      cols?: number
      rows?: number
      env?: Record<string, string>
    },
    sender: WebContents,
    hooks: { onData?: (data: string) => void; onExit?: () => void }
  ) => { sessionId: string; pid: number }
  killPty: (sessionId: string) => void
  writePty: (sessionId: string, data: string) => void
  // CLI 절대경로 조회 — null이면 미설치.
  getCliPath: (cli: CliKind) => string | null
  // PTY spawn env 빌더 — buildAdapterEnv 결과를 inject (login shell PATH 등 포함).
  buildEnv: () => Record<string, string>
}

let depsCache: ProbeDeps | null = null
export function registerProbeDeps(deps: ProbeDeps): void {
  depsCache = deps
}

function pickAnyWebContents(): WebContents | null {
  const wins = BrowserWindow.getAllWindows()
  for (const w of wins) {
    if (!w.isDestroyed() && !w.webContents.isDestroyed()) return w.webContents
  }
  return null
}

// In-flight probe 가드 (CLI 단위). 같은 CLI 동시 trigger 시 중복 spawn 방지.
const inflightProbes: Partial<Record<CliKind, Promise<ProbeResult>>> = {}

export async function probeQuotaIfStale(cli: CliKind, maxAgeMs: number): Promise<ProbeResult> {
  const snap = await getQuotaSnapshot(cli)
  if (snap.lastSeenAt && maxAgeMs > 0) {
    const ageMs = Date.now() - new Date(snap.lastSeenAt).getTime()
    if (ageMs < maxAgeMs) {
      return { ok: true, cli, snapshot: snap, durationMs: 0, reason: 'fresh, skipped' }
    }
  }
  const existing = inflightProbes[cli]
  if (existing) return existing
  const p = probeQuotaInBackground(cli).finally(() => {
    delete inflightProbes[cli]
  })
  inflightProbes[cli] = p
  return p
}

// 입력 step — spawn 후 *순차적으로* PTY stdin에 쓰는 작업. delayBeforeMs만큼 *대기 후* 입력.
// 마지막 step 이후 finalDelayMs 대기 후 응답 파싱.
type InputStep = {
  // 이 step 입력 전 대기 시간 (이전 step 종료 시점부터).
  delayBeforeMs: number
  // PTY stdin에 쓸 raw 바이트 (예: '\r' = Enter, '/usage' = 텍스트).
  write: string
  // 진단용 라벨 (로그에 표시).
  label: string
}

// CLI별 probe 사양 (spawn args / 입력 시퀀스 / cleanup).
type ProbeSpec = {
  // spawn args (CLI 실행 파일 제외). 격리 cwd에서 호출됨.
  argsFor(opts: { cwd: string; sessionId: string }): string[]
  // 순차 입력 step 리스트. trust 확인 + 슬래시 명령 + Enter 분할 등.
  steps: InputStep[]
  // 마지막 step 후 응답 누적 대기.
  responseDelayMs: number
  // spawn 전 사전 작업 (디렉토리 snapshot 등 — agy implicit/, log/ 추적용).
  // 반환값은 cleanupExtras에 전달.
  beforeSpawn?(): Promise<Record<string, unknown>>
  // spawn 완료 후 modelSessionId 캡처 (cleanup용). null이면 캡처 실패 — cleanup은 cwd rm만.
  captureModelSessionId(opts: {
    cwd: string
    preSpawnSessionId: string
    signal: AbortSignal
  }): Promise<string | null>
  // native 세션 파일 삭제 (modelSessionId 있으면).
  cleanupNativeSession(modelSessionId: string | null): Promise<void>
  // beforeSpawn 결과를 받아 추가 cleanup (예: agy implicit/ delta unlink).
  cleanupExtras?(ctx: Record<string, unknown>): Promise<void>
}

function makeSpec(cli: CliKind): ProbeSpec {
  switch (cli) {
    case 'agy':
      // agy 부팅 흐름:
      //   1) ~3s — 사인인 + trust 다이얼로그 표시 ("> Yes, I trust this folder" 기본 하이라이트)
      //   2) Enter로 trust 확정 → 메인 TUI 진입
      //   3) ~2s 대기 → /usage 텍스트 입력
      //   4) 200ms 대기 → Enter 송신 (텍스트 등록 시간 확보)
      //   5) 5s 응답 대기
      return {
        argsFor: (): string[] => ['--dangerously-skip-permissions'],
        steps: [
          { delayBeforeMs: 4_000, write: '\r', label: 'trust confirm' },
          { delayBeforeMs: 3_000, write: '/usage', label: 'slash text' },
          { delayBeforeMs: 250, write: '\r', label: 'slash submit' }
        ],
        responseDelayMs: 6_000,
        // implicit/<UUID>.pb + log/cli-*.log는 모든 agy spawn마다 새로 생성됨. snapshot diff로
        // probe 동안 새로 생긴 파일만 cleanup (사용자 다른 agy 세션에 영향 X).
        beforeSpawn: async () => ({
          implicitBefore: await snapshotAgyImplicit(),
          logsBefore: await snapshotAgyLogs()
        }),
        captureModelSessionId: async ({ cwd }) => readLastConversationForCwd(cwd),
        cleanupNativeSession: async (uuid) => {
          if (uuid) await deleteAgyConversationFiles(uuid)
        },
        cleanupExtras: async (ctx) => {
          const implicitBefore = ctx.implicitBefore as Set<string> | undefined
          const logsBefore = ctx.logsBefore as Set<string> | undefined
          if (implicitBefore) await deleteAgyImplicitDelta(implicitBefore)
          if (logsBefore) await deleteAgyLogDelta(logsBefore)
        }
      }
    case 'codex': {
      // codex 부팅 흐름:
      //   1) ~2s — trust 다이얼로그 ("› 1. Yes, continue 2. No, quit" 기본 1 하이라이트)
      //   2) Enter로 trust 확정 → MCP 부팅 시작
      //   3) ~7s 대기 (MCP server 부팅) → /status 텍스트 입력
      //   4) 200ms 대기 → Enter 송신
      //   5) 5s 응답 대기
      let snapshotPromise: Promise<{ files: Set<string> }> | null = null
      return {
        argsFor: (): string[] => [],
        steps: [
          { delayBeforeMs: 3_000, write: '\r', label: 'trust confirm' },
          { delayBeforeMs: 8_000, write: '/status', label: 'slash text' },
          { delayBeforeMs: 250, write: '\r', label: 'slash submit' }
        ],
        responseDelayMs: 6_000,
        captureModelSessionId: async ({ signal }) => {
          if (!snapshotPromise) snapshotPromise = snapshotCodexSessions()
          const snap = await snapshotPromise
          try {
            return await captureNewThreadId(snap, { signal, timeoutMs: PROBE_TIMEOUT_MS })
          } catch (err) {
            // /status 단독으로는 codex가 native jsonl을 만들지 않아 capture가
            // cleanup의 abort에 의해 중단되는 것이 정상 경로. info로 강등.
            log.info('codex probe — thread_id 캡처 종료 (정상: /status는 native 미생성)', {
              err: String(err)
            })
            return null
          }
        },
        cleanupNativeSession: async (threadId) => {
          if (!threadId) return
          const root = path.join(os.homedir(), '.codex', 'sessions')
          const target = `-${threadId.toLowerCase()}.jsonl`
          let years: string[] = []
          try {
            years = await fs.readdir(root)
          } catch {
            return
          }
          for (const y of years) {
            const yDir = path.join(root, y)
            let months: string[] = []
            try {
              months = await fs.readdir(yDir)
            } catch {
              continue
            }
            for (const m of months) {
              const mDir = path.join(yDir, m)
              let days: string[] = []
              try {
                days = await fs.readdir(mDir)
              } catch {
                continue
              }
              for (const d of days) {
                const dDir = path.join(mDir, d)
                let files: string[] = []
                try {
                  files = await fs.readdir(dDir)
                } catch {
                  continue
                }
                for (const f of files) {
                  if (!f.toLowerCase().endsWith(target)) continue
                  try {
                    await fs.unlink(path.join(dDir, f))
                    log.info('codex probe — native session 삭제', { file: f })
                  } catch (err) {
                    const code = (err as NodeJS.ErrnoException).code
                    if (code !== 'ENOENT') {
                      log.warn('codex probe — native session 삭제 실패', { err: String(err) })
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    case 'claude':
      // claude 부팅 흐름 (라이브 검증 — 새 cwd에서 trust 다이얼로그 표시됨):
      //   1) ~4s — "Quick safety check: Is this a project you trust?" 다이얼로그
      //      ("❯ 1. Yes, I trust this folder" 기본 하이라이트, "Enter to confirm · Esc to cancel")
      //      ※ 이전 시도에서 Esc 보냈더니 "Esc to cancel"로 처리돼 exit 1 종료됨 — Enter 사용 필수.
      //   2) Enter로 trust 확정 → 웰컴 화면 + 입력 프롬프트
      //   3) ~4s 대기 (웰컴 + What's new 패널 + 입력 박스 안정화)
      //   4) /usage 텍스트 입력
      //   5) 500ms 대기 (Ink 슬래시 메뉴 렌더 시간) → Enter
      //   6) 10s 응답 대기
      return {
        argsFor: ({ sessionId }): string[] => ['--session-id', sessionId],
        steps: [
          { delayBeforeMs: 4_000, write: '\r', label: 'trust confirm' },
          { delayBeforeMs: 4_000, write: '/usage', label: 'slash text' },
          { delayBeforeMs: 500, write: '\r', label: 'slash submit' }
        ],
        responseDelayMs: 10_000,
        captureModelSessionId: async ({ preSpawnSessionId }) => preSpawnSessionId,
        cleanupNativeSession: async (uuid) => {
          if (!uuid) return
          const root = path.join(os.homedir(), '.claude', 'projects')
          let entries: string[] = []
          try {
            entries = await fs.readdir(root)
          } catch {
            return
          }
          for (const p of entries) {
            const subDir = path.join(root, p)
            try {
              const stat = await fs.stat(subDir)
              if (!stat.isDirectory()) continue
            } catch {
              continue
            }
            const file = path.join(subDir, `${uuid}.jsonl`)
            try {
              await fs.unlink(file)
              log.info('claude probe — native session 삭제', { file })
            } catch (err) {
              const code = (err as NodeJS.ErrnoException).code
              if (code !== 'ENOENT') {
                log.warn('claude probe — native session 삭제 실패', { err: String(err) })
              }
            }
          }
        }
      }
  }
}

export async function probeQuotaInBackground(cli: CliKind): Promise<ProbeResult> {
  const startedAt = Date.now()
  if (!depsCache) {
    return {
      ok: false,
      cli,
      reason: 'probe deps not registered',
      snapshot: await getQuotaSnapshot(cli),
      durationMs: 0
    }
  }
  const cliPath = depsCache.getCliPath(cli)
  if (!cliPath) {
    return {
      ok: false,
      cli,
      reason: `${cli} CLI not found`,
      snapshot: await getQuotaSnapshot(cli),
      durationMs: Date.now() - startedAt
    }
  }
  const sender = pickAnyWebContents()
  if (!sender) {
    return {
      ok: false,
      cli,
      reason: 'no WebContents available',
      snapshot: await getQuotaSnapshot(cli),
      durationMs: Date.now() - startedAt
    }
  }

  // 격리 cwd — 매 probe마다 새 디렉토리. cwd-local hook 없음.
  const probeCwd = path.join(os.tmpdir(), `agentbridge-quota-probe-${cli}-${Date.now()}`)
  await fs.mkdir(probeCwd, { recursive: true })
  const preSpawnSessionId = randomUUID()
  const spec = makeSpec(cli)
  // spec.beforeSpawn (있다면) 실행 — agy의 implicit/, log/ 스냅샷 등.
  const beforeCtx: Record<string, unknown> = spec.beforeSpawn ? await spec.beforeSpawn() : {}

  // codex는 spawn 직전 snapshot이 필요하므로 spec.captureModelSessionId 안에 lazy 진입.
  // claude/agy는 spec.argsFor에 sessionId만 흘려보내면 됨.

  return new Promise<ProbeResult>((resolve) => {
    let resolved = false
    let allOutput = ''
    const OUTPUT_MAX = 50_000
    let ptySessionId: string | null = null
    const stepTimers: ReturnType<typeof setTimeout>[] = []
    let hardTimer: ReturnType<typeof setTimeout> | null = null
    const captureCtrl = new AbortController()
    let capturePromise: Promise<string | null> | null = null

    const cleanup = async (): Promise<void> => {
      for (const t of stepTimers) clearTimeout(t)
      if (hardTimer) clearTimeout(hardTimer)
      captureCtrl.abort()
      if (ptySessionId) {
        try {
          depsCache!.killPty(ptySessionId)
        } catch {
          /* noop */
        }
      }
      try {
        // capturePromise는 captureCtrl.abort 후 즉시 reject되어야 하나, 일부 spec(파일 watch
        // 폴링 등)이 abort 신호를 늦게 받으면 cleanup이 무한 대기할 수 있다. 2초 race로 가드 —
        // 캡처 실패해도 native cleanup은 modelSessionId=null로 진행(파일 흔적은 cleanupExtras가
        // 디렉토리 단위로 정리).
        const modelSessionId = capturePromise
          ? await Promise.race([
              capturePromise,
              new Promise<null>((res) => setTimeout(() => res(null), 2_000))
            ])
          : null
        await spec.cleanupNativeSession(modelSessionId)
      } catch (err) {
        log.warn(`${cli} probe — native cleanup 실패`, { err: String(err) })
      }
      if (spec.cleanupExtras) {
        try {
          await spec.cleanupExtras(beforeCtx)
        } catch (err) {
          log.warn(`${cli} probe — cleanupExtras 실패`, { err: String(err) })
        }
      }
      await fs.rm(probeCwd, { recursive: true, force: true }).catch(() => undefined)
    }

    const finalize = async (
      ok: boolean,
      reason: string | undefined,
      pct: number | null
    ): Promise<void> => {
      if (resolved) return
      resolved = true
      await cleanup()
      const snap = pct != null ? await recordQuotaPercent(cli, pct) : await getQuotaSnapshot(cli)
      resolve({
        ok,
        cli,
        snapshot: snap,
        reason: ok ? undefined : reason,
        durationMs: Date.now() - startedAt
      })
    }

    hardTimer = setTimeout(() => {
      void finalize(false, 'hard timeout', null)
    }, PROBE_TIMEOUT_MS)

    log.info(`quota probe — ${cli} background spawn`, { cwd: probeCwd })
    try {
      // captureModelSessionId는 spawn 직후 즉시 시작 — codex는 internal snapshot 캡처가 필요해
      // spawn 전에 dispatch (snapshot이 spec 안에서 lazy하게 잡힘).
      capturePromise = spec.captureModelSessionId({
        cwd: probeCwd,
        preSpawnSessionId,
        signal: captureCtrl.signal
      })

      const { sessionId } = depsCache!.startPty(
        {
          command: cliPath,
          args: spec.argsFor({ cwd: probeCwd, sessionId: preSpawnSessionId }),
          cwd: probeCwd,
          cols: 120,
          rows: 30,
          env: depsCache!.buildEnv()
        },
        sender,
        {
          onData: (data): void => {
            if (resolved) return
            allOutput += data
            if (allOutput.length > OUTPUT_MAX) {
              allOutput = allOutput.slice(-OUTPUT_MAX)
            }
          },
          onExit: (): void => {
            if (resolved) return
            void finalize(false, 'pty exited before quota captured', null)
          }
        }
      )
      ptySessionId = sessionId

      // 누적 delay로 step + 응답 파싱 timer 스케줄링. 모든 timer는 stepTimers에 저장돼
      // cleanup 시 일괄 clear (finalize 후 stray fire 방지).
      let elapsed = 0
      const t0 = Date.now()
      for (const step of spec.steps) {
        elapsed += step.delayBeforeMs
        const scheduledAt = elapsed
        stepTimers.push(
          setTimeout(() => {
            if (resolved) return
            try {
              depsCache!.writePty(sessionId, step.write)
              log.info(`quota probe — ${cli} step`, {
                label: step.label,
                write: step.write === '\r' ? '<CR>' : step.write,
                scheduledAt,
                actualMs: Date.now() - t0
              })
            } catch (err) {
              void finalize(false, `step '${step.label}' failed: ${String(err)}`, null)
            }
          }, scheduledAt)
        )
      }
      elapsed += spec.responseDelayMs
      stepTimers.push(
        setTimeout(() => {
          if (resolved) return
          const stripped = allOutput.replace(ANSI_STRIP_RE, '')
          const pct = extractQuotaPercent(cli, stripped)
          // 정규식 실패 시에만 디버깅용 preview 동봉.
          log.info(`quota probe — ${cli} 응답 파싱`, {
            outputLen: stripped.length,
            usedPercent: pct,
            tailPreview: pct == null ? stripped.slice(-2048) : undefined
          })
          void finalize(pct != null, pct != null ? undefined : 'no quota in output', pct)
        }, elapsed)
      )
    } catch (err) {
      log.warn(`quota probe — ${cli} spawn 실패`, { err: String(err) })
      void finalize(false, `spawn failed: ${String(err)}`, null)
    }
  })
}
