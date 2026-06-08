import type { WebContents } from 'electron'
import log from 'electron-log/main'
import { killPty, resizePty, startPty, writePty } from '../ptySession'
import { deleteClaudeNativeSession } from '@agentbridge/core'
import { getCoreCliAdapters } from './coreCliAdapters'
import type {
  CLIAdapter,
  SpawnInteractiveHooks,
  SpawnInteractiveRequest,
  SpawnInteractiveResult
} from './types'

// Claude 어댑터 — 2026-06-01 Phase 5: spawn args/env 조립을 코어 createCliAdapters로 위임.
// 데스크탑은 PTY 띄우기(node-pty)와 quota footer hook 등 호스트 책임만 유지.

async function spawnInteractive(
  req: SpawnInteractiveRequest,
  sender: WebContents,
  hooks: SpawnInteractiveHooks = {}
): Promise<SpawnInteractiveResult> {
  const opts = await getCoreCliAdapters().claude.buildSpawnOptions(
    req.cwd ?? '',
    req.workspaceId,
    req.sessionId ?? undefined
  )
  log.info('claude spawnInteractive', {
    claudeSessionId: opts.sessionId,
    isNewSession: req.sessionId == null,
    cwd: req.cwd
  })
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
    hooks
  )
  return { ...result, modelSessionId: opts.sessionId ?? null }
}

// 네이티브 파일 삭제는 코어 sessionRegistry의 deleteClaudeNativeSession에 위임.
async function deleteNativeSession(modelSessionId: string | null): Promise<void> {
  if (!modelSessionId) return
  await deleteClaudeNativeSession(modelSessionId, {
    log: (msg) => log.info(msg),
    warn: (msg) => log.warn(msg)
  })
}

export const claudeAdapter: CLIAdapter = {
  kind: 'claude',
  formatChatSubmit: (text) => [{ write: text + '\r' }],
  spawnInteractive,
  write: writePty,
  resize: resizePty,
  killInteractive: killPty,
  deleteNativeSession
}
