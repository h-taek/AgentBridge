import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { WebContents } from 'electron'
import log from 'electron-log/main'
import { getCliPath, getShellPath } from '../envProbe'
import { killPty, resizePty, startPty, writePty } from '../ptySession'
import { buildAdapterEnv } from './env'
import { captureNewThreadId, snapshotCodexSessions } from './codexSessionWatcher'
import { runRefineSpawn } from './refineHeadless'
import type {
  CLIAdapter,
  RefineUsage,
  SpawnInteractiveHooks,
  SpawnInteractiveRequest,
  SpawnInteractiveResult,
  SpawnRefineRequest,
  SpawnRefineResult
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

// codex refine 헤드리스 — `codex exec --json --skip-git-repo-check -s read-only -` (stdin으로
// prompt). probe_results §1: stdin이 닫혀야 codex가 종료. JSONL 라인:
//   {"type":"thread.started","thread_id":"..."}
//   {"type":"turn.started"}
//   {"type":"item.completed","item":{...,"text":"..."}}
//   {"type":"turn.completed","usage":{...}}
async function spawnRefineIRCodex(req: SpawnRefineRequest): Promise<SpawnRefineResult> {
  const cliPath = getCliPath('codex')
  if (!cliPath) {
    throw new Error('codex CLI not found in PATH')
  }
  const env = buildAdapterEnv({ shellPath: getShellPath() })
  let assistantText = ''
  let usage: RefineUsage | undefined
  log.info('codex spawnRefineIR', {
    promptLen: req.prompt.length,
    cwd: req.cwd,
    modelHint: req.modelHint
  })
  // -c model="..."는 codex exec 앞에 위치해야 함 (top-level config override).
  const modelArgs = req.modelHint ? ['-c', `model="${req.modelHint}"`] : []
  const base = await runRefineSpawn({
    command: cliPath,
    args: [...modelArgs, 'exec', '--json', '--skip-git-repo-check', '-s', 'read-only', '-'],
    cwd: req.cwd,
    env,
    stdinPayload: req.prompt,
    abortSignal: req.abortSignal,
    timeoutMs: req.timeoutMs,
    onLine: (line) => {
      let evt: unknown
      try {
        evt = JSON.parse(line)
      } catch {
        return
      }
      const o = evt as { type?: string; item?: unknown; usage?: unknown }
      if (o.type === 'item.completed' && o.item && typeof o.item === 'object') {
        const it = o.item as { text?: string; type?: string }
        if (typeof it.text === 'string') {
          assistantText += it.text
        }
      } else if (o.type === 'turn.completed' && o.usage && typeof o.usage === 'object') {
        const u = o.usage as Record<string, number>
        usage = {
          inputTokens: u.input_tokens,
          outputTokens: u.output_tokens,
          cacheReadTokens: u.cached_input_tokens
        }
      }
    }
  })
  return { assistantText, usage, ...base }
}

// codex thread_id는 codex가 *첫 사용자 메시지를 받아야* 발급되어 ~/.codex/sessions/...
// jsonl을 만든다. modelSessionId === null이면 codex가 아직 native 세션을 생성하지 않은 것.
async function hasNativeSession(modelSessionId: string | null): Promise<boolean> {
  return modelSessionId != null && modelSessionId.length > 0
}

// ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<UUID>.jsonl 트리에서 thread_id 매칭 파일 삭제.
// 트리 walk 비용 최소화를 위해 최근 6개월(통상 사용 범위)만 순회. 파일명 suffix로 빠르게 매칭.
async function deleteNativeSession(modelSessionId: string | null): Promise<void> {
  if (!modelSessionId) return
  const root = path.join(os.homedir(), '.codex', 'sessions')
  const target = `-${modelSessionId.toLowerCase()}.jsonl`
  let years: string[]
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
          const file = path.join(dDir, f)
          try {
            await fs.unlink(file)
            log.info('codex native session 삭제', { file })
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code
            if (code !== 'ENOENT') {
              log.warn('codex native session 삭제 실패', { file, err: String(err) })
            }
          }
        }
      }
    }
  }
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
  spawnRefineIR: spawnRefineIRCodex,
  hasNativeSession,
  deleteNativeSession
}
