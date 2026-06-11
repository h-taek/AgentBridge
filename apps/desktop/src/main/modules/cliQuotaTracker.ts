import { app, BrowserWindow, type WebContents } from 'electron'
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import log from 'electron-log/main'
import { IpcChannel, type CliKind } from '@shared/ipc'
import {
  createQuotaTracker,
  ensureRefineHome,
  parseQuotaFile,
  extractQuotaPercent as coreExtractQuotaPercent,
  looksLikeQuotaError as coreLooksLikeQuotaError,
  type CliQuotaSnapshot as CoreCliQuotaSnapshot,
  type QuotaFileMap,
  type QuotaSeverity as CoreQuotaSeverity,
  type QuotaStore,
  type QuotaTracker
} from '@agentbridge/core'
import { broadcastToAll } from './windowManager'

// CliQuotaTracker — Phase 2 (2026-05-21 재설계).
//
// 세 CLI(agy/codex/claude)의 quota를 *각자 슬래시 명령*으로 직접 캡처.
// 백그라운드 PTY spawn → /usage 또는 /status 입력 → 응답 파싱 → SIGTERM + native 세션 파일 unlink.
//
// 슬래시 명령:
//   agy:    `/usage`   응답에 "N% \n Quota available|exhausted" (미사용 시) 또는
//                      "N% remaining · Refreshes in ..." (일부 사용 시) 블록 (N = 남은 %)
//   codex:  `/status`  응답에 "5h limit: ... N% left" (N = 남은 %)
//   claude: `/usage`   응답에 "Current session ... N% used" (N = 사용된 %)
//
// 정리 흐름:
//   agy/codex: 격리 박스에서만 실행 — session 파일이 박스 안에 떨어지므로 native 청소 불필요.
//              격리 부트스트랩 실패 시 이번 사이클을 스킵(비격리 폴백 없음).
//   claude:    격리 미지원 → 비격리 실행. 사전 발급 UUID로 `--session-id <uuid>` spawn 후
//              ~/.claude/projects/*/${uuid}.jsonl 삭제 (유일한 native 청소 경로).
//
// 영속 위치: `~/Library/Application Support/AgentBridge/cli_quota.json` (이전 agy_quota.json /
// gemini_quota.json은 첫 read 시 자동 migration).

const QUOTA_FILE_NAME = 'cli_quota.json'
const LEGACY_AGY_QUOTA_FILE_NAME = 'agy_quota.json'
const LEGACY_GEMINI_QUOTA_FILE_NAME = 'gemini_quota.json'

// 코어 상수/타입 re-export — 호스트 모듈은 데스크탑 내부 export로 계속 사용.
export {
  QUOTA_WARN_PERCENT,
  QUOTA_CRITICAL_PERCENT,
  QUOTA_EXCEEDED_PERCENT
} from '@agentbridge/core'
export type QuotaSeverity = CoreQuotaSeverity
export type CliQuotaSnapshot = CoreCliQuotaSnapshot

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

// 데스크탑 QuotaStore 어댑터 — fs + legacy 마이그레이션. 신규 cli_quota.json 우선,
// 없으면 agy_quota.json/gemini_quota.json을 agy 슬롯으로 한 번 흡수.
const desktopQuotaStore: QuotaStore = {
  async read(): Promise<QuotaFileMap> {
    try {
      const raw = await fs.readFile(getQuotaFilePath(), 'utf8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const out: QuotaFileMap = {}
      for (const k of ['agy', 'codex', 'claude'] as CliKind[]) {
        if (parsed[k]) out[k] = parseQuotaFile(parsed[k])
      }
      return out
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        log.warn('cli_quota.json 파싱 실패 — 새 schema로 리셋', { err: String(err) })
      }
    }
    for (const legacyPath of [getLegacyAgyQuotaFilePath(), getLegacyGeminiQuotaFilePath()]) {
      try {
        const raw = await fs.readFile(legacyPath, 'utf8')
        const parsed = JSON.parse(raw)
        log.info('legacy quota 파일을 cli_quota.json/agy로 흡수', { legacyPath })
        return { agy: parseQuotaFile(parsed) }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') {
          log.warn(`${path.basename(legacyPath)} 파싱 실패 — 무시`, { err: String(err) })
        }
      }
    }
    return {}
  },
  async write(map: QuotaFileMap): Promise<void> {
    const p = getQuotaFilePath()
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.writeFile(tmp, JSON.stringify(map, null, 2), 'utf8')
    await fs.rename(tmp, p)
  }
}

// 코어 함수(quotaTracker / agy 잔재 청소)에 주입할 Logger 어댑터 — electron-log 바인딩.
const coreLogger = { log: (m: string) => log.info(m), warn: (m: string) => log.warn(m) }

const tracker: QuotaTracker = createQuotaTracker({
  store: desktopQuotaStore,
  onChange: broadcastQuotaUpdated,
  logger: coreLogger
})

export async function getQuotaSnapshot(cli: CliKind): Promise<CliQuotaSnapshot> {
  return tracker.getSnapshot(cli)
}

export async function getAllQuotaSnapshots(): Promise<Record<CliKind, CliQuotaSnapshot>> {
  return tracker.getAllSnapshots()
}

export async function recordQuotaPercent(cli: CliKind, percent: number): Promise<CliQuotaSnapshot> {
  return tracker.recordPercent(cli, percent)
}

export async function markForcedFallback(cli: CliKind): Promise<CliQuotaSnapshot> {
  return tracker.markForcedFallback(cli)
}

// 슬래시 응답 파싱 / 에러 정규식 — 코어 위임.
export function extractQuotaPercent(cli: CliKind, stripped: string): number | null {
  return coreExtractQuotaPercent(cli, stripped)
}

export function looksLikeQuotaError(
  stderr: string,
  assistantText: string,
  exitCode?: number | null
): boolean {
  return coreLooksLikeQuotaError(stderr, assistantText, exitCode)
}

// ─── Background quota probe — per CLI ───────────────────────────────────

// CLI별 step maxWait 누적 + responseMax(+ codex 재전송 여유)가 PROBE_TIMEOUT_MS 안에 들어가야 함
// (idle 게이트라 보통은 훨씬 빨리 끝남 — 이건 화면이 끝내 안 떴을 때의 상한).
const PROBE_TIMEOUT_MS = 80_000
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

// 입력 step — spawn 후 *순차적으로* PTY stdin에 쓰는 작업.
// 고정 시계 대신 idle 게이트: PTY 출력이 minIdleMs 동안 잠잠하면(= TUI가 이 단계 화면을 다 그림)
// 입력을 보낸다. maxWaitMs는 그 신호가 끝내 안 와도 보내는 상한(폴백).
type InputStep = {
  // PTY stdin에 쓸 raw 바이트 (예: '\r' = Enter, '/usage' = 텍스트).
  write: string
  // 진단용 라벨 (로그에 표시).
  label: string
  // 출력이 이만큼 잠잠하면 입력 전송 (TUI 렌더 완료 신호).
  minIdleMs: number
  // idle 신호가 안 와도 이 시간이 지나면 전송 (상한 폴백).
  maxWaitMs: number
}

// CLI별 probe 사양 (spawn args / 입력 시퀀스 / cleanup).
// 비격리 실행(claude)만 native 세션 파일을 남기므로 capture/cleanup은 선택 필드 — agy/codex는
// 격리 박스에서만 실행해 박스가 청소를 책임지므로 미지정.
type ProbeSpec = {
  // spawn args (CLI 실행 파일 제외). 격리 cwd에서 호출됨.
  argsFor(opts: { cwd: string; sessionId: string }): string[]
  // 순차 입력 step 리스트. trust 확인 + 슬래시 명령 + Enter 분할 등.
  steps: InputStep[]
  // 마지막 step(슬래시 submit) 후 응답 누적 대기 — 잠잠해지거나(responseIdleMs) 상한(responseMaxMs)에서 파싱.
  responseIdleMs: number
  responseMaxMs: number
  // (비격리 전용) spawn 완료 후 modelSessionId 캡처. null이면 캡처 실패 — cleanup은 cwd rm만.
  captureModelSessionId?(opts: {
    cwd: string
    preSpawnSessionId: string
    signal: AbortSignal
  }): Promise<string | null>
  // (비격리 전용) native 세션 파일 삭제 (modelSessionId 있으면).
  cleanupNativeSession?(modelSessionId: string | null): Promise<void>
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
      // 격리 박스(HOME override)에서만 실행 — session 파일이 박스 안에 떨어져 native 청소 불필요.
      return {
        argsFor: (): string[] => ['--dangerously-skip-permissions'],
        steps: [
          { write: '\r', label: 'trust confirm', minIdleMs: 800, maxWaitMs: 8_000 },
          { write: '/usage', label: 'slash text', minIdleMs: 800, maxWaitMs: 8_000 },
          { write: '\r', label: 'slash submit', minIdleMs: 300, maxWaitMs: 2_000 }
        ],
        responseIdleMs: 1_500,
        responseMaxMs: 8_000
      }
    case 'codex': {
      // codex 부팅 흐름:
      //   1) ~2s — trust 다이얼로그 ("› 1. Yes, continue 2. No, quit" 기본 1 하이라이트)
      //   2) Enter로 trust 확정 → MCP 부팅 시작
      //   3) ~7s 대기 (MCP server 부팅) → /status 텍스트 입력
      //   4) 200ms 대기 → Enter 송신
      //   5) 5s 응답 대기
      // 격리 박스(CODEX_HOME)에서만 실행 — session 파일이 박스 안에 떨어져 native 청소 불필요.
      return {
        argsFor: (): string[] => [],
        steps: [
          { write: '\r', label: 'trust confirm', minIdleMs: 800, maxWaitMs: 6_000 },
          // MCP 부팅이 끝나 컴포저가 떠 잠잠해질 때까지 대기 — 부팅 애니메이션이 도는 동안은 idle 안 됨.
          { write: '/status', label: 'slash text', minIdleMs: 1_200, maxWaitMs: 30_000 },
          { write: '\r', label: 'slash submit', minIdleMs: 300, maxWaitMs: 2_000 }
        ],
        responseIdleMs: 1_500,
        responseMaxMs: 10_000
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
          { write: '\r', label: 'trust confirm', minIdleMs: 800, maxWaitMs: 6_000 },
          { write: '/usage', label: 'slash text', minIdleMs: 800, maxWaitMs: 8_000 },
          { write: '\r', label: 'slash submit', minIdleMs: 400, maxWaitMs: 2_000 }
        ],
        responseIdleMs: 1_500,
        responseMaxMs: 12_000,
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
  // agy/codex는 격리 박스에서만 probe 실행 — session 파일이 박스 안에 떨어진다. 격리 부트스트랩이
  // 실패하면 비격리로 폴백하지 않고 이번 사이클을 스킵(quota stale 유지) → 실 HOME 오염 0.
  // claude는 격리 미지원이라 빈 env를 받아 비격리로 실행되며, 이게 유일한 native 청소 경로다.
  let isoEnv: Record<string, string>
  try {
    isoEnv = ensureRefineHome(cli, { binPath: cliPath }).env
  } catch (err) {
    log.warn(`${cli} probe — 격리 HOME 부트스트랩 실패, 이번 사이클 스킵`, { err: String(err) })
    return {
      ok: false,
      cli,
      reason: 'isolation bootstrap failed',
      snapshot: await getQuotaSnapshot(cli),
      durationMs: Date.now() - startedAt
    }
  }
  const isolatedHome = Object.keys(isoEnv).length > 0

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

  // codex는 spawn 직전 snapshot이 필요하므로 spec.captureModelSessionId 안에 lazy 진입.
  // claude/agy는 spec.argsFor에 sessionId만 흘려보내면 됨.

  return new Promise<ProbeResult>((resolve) => {
    let resolved = false
    let allOutput = ''
    let lastDataAt = Date.now()
    const OUTPUT_MAX = 50_000
    let ptySessionId: string | null = null
    let driveTimer: ReturnType<typeof setInterval> | null = null
    let hardTimer: ReturnType<typeof setTimeout> | null = null
    const captureCtrl = new AbortController()
    let capturePromise: Promise<string | null> | null = null

    const cleanup = async (): Promise<void> => {
      if (driveTimer) clearInterval(driveTimer)
      if (hardTimer) clearTimeout(hardTimer)
      captureCtrl.abort()
      if (ptySessionId) {
        try {
          depsCache!.killPty(ptySessionId)
        } catch {
          /* noop */
        }
      }
      // 비격리 실행(claude)만 native 세션 파일을 남긴다 — 그 경로에서만 청소. agy/codex는 격리
      // 박스가 책임지므로 건너뛴다. probeCwd rm은 항상 수행.
      if (!isolatedHome && spec.cleanupNativeSession) {
        try {
          // capturePromise는 captureCtrl.abort 후 즉시 reject되어야 하나, abort 신호를 늦게 받으면
          // cleanup이 무한 대기할 수 있다. 2초 race로 가드 — 캡처 실패해도 modelSessionId=null로 진행.
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
      // captureModelSessionId는 비격리(claude) 경로에서만 필요 — native 세션 파일 청소용.
      // 격리 박스 모드(agy/codex)에서는 청소가 없으므로 dispatch 생략.
      capturePromise =
        !isolatedHome && spec.captureModelSessionId
          ? spec.captureModelSessionId({
              cwd: probeCwd,
              preSpawnSessionId,
              signal: captureCtrl.signal
            })
          : null

      const { sessionId } = depsCache!.startPty(
        {
          command: cliPath,
          args: spec.argsFor({ cwd: probeCwd, sessionId: preSpawnSessionId }),
          cwd: probeCwd,
          cols: 120,
          rows: 30,
          env: { ...depsCache!.buildEnv(), ...isoEnv }
        },
        sender,
        {
          onData: (data): void => {
            if (resolved) return
            lastDataAt = Date.now()
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

      // idle 게이트 드라이버: 고정 시계 대신 "PTY 출력이 minIdleMs 동안 잠잠하면(= TUI가 그 단계
      // 화면을 다 그림) 다음 입력 전송". maxWaitMs는 신호가 끝내 안 와도 보내는 상한. codex MCP
      // 부팅 지연·agy 온보딩 등 가변 타이밍에 강건. 모든 step 후 응답이 잠잠해지면 파싱.
      let stepIdx = 0
      let stepStartedAt = Date.now()
      // codex: 첫 /status는 'refresh requested'(rate-limit 비동기 로드 중)라 정적 스냅샷이 자동 갱신 안 됨.
      // limit이 채워지면 /status를 다시 쳐야 새 화면이 그려진다 → miss 시 재전송(최대 2회).
      let codexRetriesLeft = cli === 'codex' ? 2 : 0
      let resendPendingAt: number | null = null // /status 텍스트 후 CR 보낼 시각(250ms 뒤)
      driveTimer = setInterval(() => {
        if (resolved) return
        const now = Date.now()
        const idleFor = now - lastDataAt
        const waited = now - stepStartedAt
        const hasOutput = allOutput.length > 0

        // 재전송 /status의 CR(텍스트 보낸 뒤 250ms) — 다른 로직보다 먼저 처리.
        if (resendPendingAt !== null) {
          if (now >= resendPendingAt) {
            try {
              depsCache!.writePty(sessionId, '\r')
            } catch {
              /* noop */
            }
            resendPendingAt = null
            stepStartedAt = now // 응답 타이머 리셋
          }
          return
        }

        if (stepIdx < spec.steps.length) {
          const step = spec.steps[stepIdx]
          const idleReady = hasOutput && idleFor >= step.minIdleMs
          if (!idleReady && waited < step.maxWaitMs) return // 아직 화면 그리는 중
          try {
            depsCache!.writePty(sessionId, step.write)
            log.info(`quota probe — ${cli} step`, {
              label: step.label,
              write: step.write === '\r' ? '<CR>' : step.write,
              gate: idleReady ? 'idle' : 'maxWait',
              idleForMs: idleFor,
              waitedMs: waited
            })
          } catch (err) {
            void finalize(false, `step '${step.label}' failed: ${String(err)}`, null)
            return
          }
          stepIdx++
          stepStartedAt = now
          return
        }

        // 모든 step 전송 완료 → 응답이 잠잠해지거나(responseIdleMs) 상한(responseMaxMs)에서 파싱.
        const responseReady = (hasOutput && idleFor >= spec.responseIdleMs) || waited >= spec.responseMaxMs
        if (!responseReady) return
        const stripped = allOutput.replace(ANSI_STRIP_RE, '')
        const pct = extractQuotaPercent(cli, stripped)
        // codex: limit 미로드('refresh requested')면 /status 재전송 후 재대기 (정적 스냅샷이라 다시 쳐야 채워짐).
        if (pct == null && codexRetriesLeft > 0 && /refresh requested/i.test(stripped)) {
          codexRetriesLeft--
          log.info(`quota probe — codex /status 재전송 (refresh requested, ${codexRetriesLeft} left)`)
          try {
            depsCache!.writePty(sessionId, '/status')
          } catch (err) {
            void finalize(false, `codex retry write failed: ${String(err)}`, null)
            return
          }
          resendPendingAt = now + 250 // 250ms 뒤 CR → 응답 타이머 리셋
          return
        }
        // 정규식 실패 시에만 디버깅용 preview 동봉.
        log.info(`quota probe — ${cli} 응답 파싱`, {
          outputLen: stripped.length,
          usedPercent: pct,
          tailPreview: pct == null ? stripped.slice(-2048) : undefined
        })
        void finalize(pct != null, pct != null ? undefined : 'no quota in output', pct)
      }, 150)
    } catch (err) {
      log.warn(`quota probe — ${cli} spawn 실패`, { err: String(err) })
      void finalize(false, `spawn failed: ${String(err)}`, null)
    }
  })
}
