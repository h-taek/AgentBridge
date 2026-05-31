import type { WebContents } from 'electron'
import log from 'electron-log/main'
import { getCliPath, getShellPath } from '../envProbe'
import { killPty, resizePty, startPty, writePty } from '../ptySession'
import { buildAdapterEnv } from './env'
import { captureNewThreadId, snapshotCodexSessions } from './codexSessionWatcher'
import { deleteCodexNativeSession } from '@agentbridge/core'
import type {
  CLIAdapter,
  SpawnInteractiveHooks,
  SpawnInteractiveRequest,
  SpawnInteractiveResult
} from './types'

// Codex 어댑터.
// - 새 세션: `codex` (인자 없음 — trust 다이얼로그가 첫 화면). thread_id 사전 통제 불가.
//   spawn 직전 ~/.codex/sessions 스냅샷 → 백그라운드 polling으로 새 jsonl 감지 → 파일명에서
//   thread_id 추출. 캡처는 onModelSessionIdCaptured hook으로 비동기 통보.
// - 이어가기: `codex resume <thread_id>` (subcommand. exec --resume 플래그 아님 — probe_results §32).
//
// IR 주입은 hook 시스템(M 청크 — cwd/.codex/hooks.json의 UserPromptSubmit)이 담당. M2의 argv 기반
// bracketed paste 흐름은 폐기됨.

async function spawnInteractive(
  req: SpawnInteractiveRequest,
  sender: WebContents,
  hooks: SpawnInteractiveHooks = {}
): Promise<SpawnInteractiveResult> {
  const cliPath = getCliPath('codex')
  if (!cliPath) {
    throw new Error('codex CLI not found in PATH (EnvProbe 결과 미발견)')
  }

  const isNewSession = req.sessionId == null
  const args: string[] = isNewSession ? [] : ['resume', req.sessionId as string]

  const env = buildAdapterEnv({ shellPath: getShellPath() })
  log.info('codex spawnInteractive', {
    isNewSession,
    threadId: req.sessionId ?? null,
    cwd: req.cwd
  })

  // 새 세션이면 spawn 직전에 디렉토리 스냅샷 + abort controller. 폴링은 spawn 후 시작.
  const snapshot = isNewSession ? await snapshotCodexSessions() : null
  const captureCtrl = snapshot && hooks.onModelSessionIdCaptured ? new AbortController() : null

  // PTY exit 시 폴링 중단 — wrapper로 기존 hook 체이닝.
  const wrappedHooks: SpawnInteractiveHooks = captureCtrl
    ? {
        ...hooks,
        onExit: (info) => {
          captureCtrl.abort()
          hooks.onExit?.(info)
        }
      }
    : hooks

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

  // 비동기 캡처 — fire-and-forget. timeout/abort 실패는 로그만, 사용자는 다음 resume이 안 되는
  // 거동으로 인지(thread 메타에 sessions.codex가 비어있어 threads:open이 명시 에러).
  if (snapshot && captureCtrl && hooks.onModelSessionIdCaptured) {
    const onCapture = hooks.onModelSessionIdCaptured
    void captureNewThreadId(snapshot, { signal: captureCtrl.signal })
      .then((threadId) => {
        onCapture(threadId)
      })
      .catch((err) => {
        log.warn('codex thread_id capture 실패', { err: String(err) })
      })
  }

  return { ...result, modelSessionId: isNewSession ? null : (req.sessionId as string) }
}

// 네이티브 파일 삭제는 코어 sessionRegistry의 deleteCodexNativeSession에 위임.
async function deleteNativeSession(modelSessionId: string | null): Promise<void> {
  if (!modelSessionId) return
  await deleteCodexNativeSession(modelSessionId, {
    log: (msg) => log.info(msg),
    warn: (msg) => log.warn(msg)
  })
}

export const codexAdapter: CLIAdapter = {
  kind: 'codex',
  // codex Rust TUI는 \r/\n 모두 줄바꿈으로 처리해 단순 suffix로는 submit 불가.
  // bracketed paste(\x1b[200~ ... \x1b[201~)로 감싸면 텍스트는 paste 데이터로 받고,
  // paste 종료 직후 도착한 \r을 submit 키로 처리한다. modern TUI(crossterm 기반) 표준 동작.
  // xterm.js 직접 입력은 별도 경로(pty:write)라 적용 안 됨 — 사용자가 xterm에서 직접 Enter는
  // 줄바꿈으로 처리됨(향후 매핑 검토).
  formatChatSubmit: (text) => [{ write: `\x1b[200~${text}\x1b[201~\r` }],
  spawnInteractive,
  write: writePty,
  resize: resizePty,
  killInteractive: killPty,
  deleteNativeSession
}
