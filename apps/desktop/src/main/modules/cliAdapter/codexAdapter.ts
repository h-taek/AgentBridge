import type { WebContents } from 'electron'
import log from 'electron-log/main'
import { killPty, resizePty, startPty, writePty } from '../ptySession'
import { captureNewThreadId } from './codexSessionWatcher'
import { deleteCodexNativeSession } from '@agentbridge/core'
import { getCoreCliAdapters } from './coreCliAdapters'
import type {
  CLIAdapter,
  SpawnInteractiveHooks,
  SpawnInteractiveRequest,
  SpawnInteractiveResult
} from './types'

// Codex 어댑터 — 2026-06-01 Phase 5: spawn args/env + 새 세션 snapshot을 코어 createCliAdapters로
// 위임. 데스크탑은 PTY 띄우기 + post-spawn thread_id 캡처 폴링 책임만 유지.

async function spawnInteractive(
  req: SpawnInteractiveRequest,
  sender: WebContents,
  hooks: SpawnInteractiveHooks = {}
): Promise<SpawnInteractiveResult> {
  const opts = await getCoreCliAdapters().codex.buildSpawnOptions(
    req.cwd ?? '',
    req.workspaceId,
    req.sessionId ?? undefined,
    req.modelSessionId
  )
  const isNewSession = req.sessionId == null
  log.info('codex spawnInteractive', {
    isNewSession,
    threadId: req.sessionId ?? null,
    cwd: req.cwd
  })

  const snapshot = opts.codexSessionSnapshot ?? null
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
      command: opts.command,
      args: opts.args,
      cwd: opts.cwd,
      cols: req.cols,
      rows: req.rows,
      env: opts.env
    },
    sender,
    wrappedHooks
  )

  // 비동기 캡처 — fire-and-forget.
  if (snapshot && captureCtrl && hooks.onModelSessionIdCaptured) {
    const onCapture = hooks.onModelSessionIdCaptured
    void captureNewThreadId(snapshot, { signal: captureCtrl.signal })
      .then((threadId) => {
        if (threadId) onCapture(threadId)
      })
      .catch((err) => {
        log.warn('codex thread_id capture 실패', { err: String(err) })
      })
  }

  return { ...result, modelSessionId: opts.modelSessionId ?? null }
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
  formatChatSubmit: (text) => [{ write: `\x1b[200~${text}\x1b[201~\r` }],
  spawnInteractive,
  write: writePty,
  resize: resizePty,
  killInteractive: killPty,
  deleteNativeSession
}
