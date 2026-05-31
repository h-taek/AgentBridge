import type { WebContents } from 'electron'
import log from 'electron-log/main'
import { getCliPath, getShellPath } from '../envProbe'
import { killPty, resizePty, startPty, writePty } from '../ptySession'
import { extractQuotaPercent, recordQuotaPercent } from '../cliQuotaTracker'
import { buildAdapterEnv } from './env'
import {
  readLastConversationForCwd,
  resolveResumeArgs,
  watchForNewConversationUuid
} from './agyResume'
import { deleteAgyNativeSession } from '@agentbridge/core'
import type {
  CLIAdapter,
  SpawnInteractiveHooks,
  SpawnInteractiveRequest,
  SpawnInteractiveResult
} from './types'

// ANSI escape strip — agyQuotaTracker.extractQuotaPercent에 정제된 라인 전달용.
const ANSI_STRIP_RE = new RegExp(
  '\\u001b\\[[0-?]*[ -/]*[@-~]' +
    '|\\u001b\\][\\s\\S]*?(?:\\u0007|\\u001b\\\\)' +
    '|\\u001b[PX^_][\\s\\S]*?\\u001b\\\\' +
    '|\\u001b[@-Z\\\\\\-_]',
  'g'
)

// 누적 buffer (tail 최대 4KB) — agy PTY data 들어올 때마다 footer 캡처 시도.
function createQuotaCaptureHook(): (data: string) => void {
  let tail = ''
  let lastPercent: number | null = null
  const TAIL_MAX = 4_000
  return (data: string): void => {
    tail = (tail + data).slice(-TAIL_MAX)
    const stripped = tail.replace(ANSI_STRIP_RE, '')
    const pct = extractQuotaPercent('agy', stripped)
    if (pct != null && pct !== lastPercent) {
      lastPercent = pct
      void recordQuotaPercent('agy', pct).catch((err) => {
        log.warn('agy quota footer 영속화 실패', { err: String(err) })
      })
    }
  }
}

// Agy(Antigravity, 구 Gemini CLI) 어댑터.
// - 새 세션: `agy --dangerously-skip-permissions` — agy가 UUID 자체 생성. 우리는 cwd 기반
//   `~/.gemini/antigravity-cli/cache/last_conversations.json` polling으로 후처리 캡처.
// - 이어가기: `agy --conversation <UUID> --dangerously-skip-permissions` — 캡처된 UUID 직접 전달.
// - chat submit: 80ms 지연 후 \r — 구 gemini readline fast-paste 패턴 유지 가정. agy가 input
//   처리를 어떻게 바꿨는지 라이브 검증 필요.
//
// IR 주입은 hook 시스템(`.agents/hooks.json` PreInvocation/Stop)이 담당.

async function spawnInteractive(
  req: SpawnInteractiveRequest,
  sender: WebContents,
  hooks: SpawnInteractiveHooks = {}
): Promise<SpawnInteractiveResult> {
  const cliPath = getCliPath('agy')
  if (!cliPath) {
    throw new Error('agy CLI not found in PATH (EnvProbe 결과 미발견)')
  }

  const isNewSession = req.sessionId == null
  const env = buildAdapterEnv({ shellPath: getShellPath() })

  // `--add-dir <cwd>` 명시 — agy는 spawn 직후 workspaceDirs=[]로 시작해 cwd의 .agents/hooks.json을
  // 즉시 로드하지 않는다(첫 입력/모델 호출 시점에 지연 로드됨). hookInstaller가 작성한 hooks.json이
  // spawn 즉시 등록되어야 첫 PreInvocation부터 IR이 inject되므로 cwd를 명시 추가.
  // 라이브 검증: --add-dir 없는 spawn은 `/hooks` 슬래시 화면에서 hook이 보이지 않다가 첫 모델 호출 후
  // 보이기 시작함. --add-dir로 spawn 시점부터 노출 보장.
  const cwdArgs = req.cwd ? ['--add-dir', req.cwd] : []

  let args: string[]
  let modelSessionId: string | null = req.sessionId
  // resume 흐름: conversation 파일이 디스크에 있으면 `--conversation <UUID>`로 이어가기. 없으면 새 세션처럼
  // 시작(빈 세션 reopen 케이스 — modelSessionId가 캡처됐어도 사용자가 메시지를 안 보냈으면 agy가 .pb 파일을
  // 영속화하지 않아 reopen 시 conversation 파일 없음. 이때 throw 대신 새 세션으로 fallback 후 새 UUID 캡처).
  if (isNewSession) {
    args = [...cwdArgs, '--dangerously-skip-permissions']
  } else {
    try {
      const resumeArgs = await resolveResumeArgs({ sessionId: req.sessionId })
      args = [...cwdArgs, ...resumeArgs, '--dangerously-skip-permissions']
    } catch (err) {
      log.warn('agy resume 불가 — 새 세션으로 fallback', {
        sessionId: req.sessionId,
        err: String(err)
      })
      args = [...cwdArgs, '--dangerously-skip-permissions']
      modelSessionId = null
    }
  }

  log.info('agy spawnInteractive', {
    sessionId: req.sessionId,
    isNewSession,
    cwd: req.cwd
  })

  // agy PTY 출력에 quota footer 캡처 hook chaining — 호출자 onData 보존.
  const quotaHook = createQuotaCaptureHook()
  const wrappedHooks: SpawnInteractiveHooks = {
    ...hooks,
    onData: (data): void => {
      quotaHook(data)
      hooks.onData?.(data)
    }
  }

  const result = startPty(
    {
      command: cliPath,
      args,
      cwd: req.cwd,
      cols: req.cols,
      rows: req.rows,
      env
    },
    sender,
    wrappedHooks
  )

  // 새 세션 또는 resume fallback(modelSessionId=null) 케이스 — UUID 후처리 캡처. spawn 직전 cwd
  // 매핑을 스냅샷으로 가져두고, 변경되면 그 값이 새 conversation UUID.
  // fire-and-forget — 캡처 실패해도 PTY 흐름은 그대로.
  if (modelSessionId === null && req.cwd) {
    const cwd = req.cwd
    void (async (): Promise<void> => {
      const existing = await readLastConversationForCwd(cwd)
      const exclude = new Set<string>(existing ? [existing] : [])
      await watchForNewConversationUuid({
        cwd,
        excludeUuids: exclude,
        onCaptured: (uuid) => {
          modelSessionId = uuid
          hooks.onModelSessionIdCaptured?.(uuid)
        }
      })
    })().catch((err) => {
      log.warn('agy modelSessionId 캡처 중 에러', { err: String(err) })
    })
  }

  return { ...result, modelSessionId }
}

// 네이티브 파일 삭제는 코어 sessionRegistry의 deleteAgyNativeSession에 위임.
async function deleteNativeSession(modelSessionId: string | null): Promise<void> {
  if (!modelSessionId) return
  await deleteAgyNativeSession(modelSessionId, {
    log: (msg) => log.info(msg),
    warn: (msg) => log.warn(msg)
  })
}

export const agyAdapter: CLIAdapter = {
  kind: 'agy',
  // text + 80ms 지연 + '\r' 두 번 분리 — 구 gemini readline fast-paste 회피 패턴 유지 가정.
  // agy가 input handling을 바꿨다면 동작 변경 가능 — 라이브 테스트로 검증.
  formatChatSubmit: (text) => [{ write: text, delayMs: 80 }, { write: '\r' }],
  spawnInteractive,
  write: writePty,
  resize: resizePty,
  killInteractive: killPty,
  deleteNativeSession
}
