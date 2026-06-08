import type { WebContents } from 'electron'
import log from 'electron-log/main'
import { killPty, resizePty, startPty, writePty } from '../ptySession'
import { extractQuotaPercent, recordQuotaPercent } from '../cliQuotaTracker'
import { deleteAgyNativeSession, watchForNewConversationUuid } from '@agentbridge/core'
import { getCoreCliAdapters } from './coreCliAdapters'
import type {
  CLIAdapter,
  SpawnInteractiveHooks,
  SpawnInteractiveRequest,
  SpawnInteractiveResult
} from './types'

// Agy 어댑터 — 2026-06-01 Phase 5: spawn args/env + resume args 빌드를 코어 createCliAdapters로
// 위임. 데스크탑은 PTY + quota footer hook + post-spawn UUID 캡처만 유지.

const ANSI_STRIP_RE = new RegExp(
  '\\u001b\\[[0-?]*[ -/]*[@-~]' +
    '|\\u001b\\][\\s\\S]*?(?:\\u0007|\\u001b\\\\)' +
    '|\\u001b[PX^_][\\s\\S]*?\\u001b\\\\' +
    '|\\u001b[@-Z\\\\\\-_]',
  'g'
)

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

async function spawnInteractive(
  req: SpawnInteractiveRequest,
  sender: WebContents,
  hooks: SpawnInteractiveHooks = {}
): Promise<SpawnInteractiveResult> {
  const opts = await getCoreCliAdapters().agy.buildSpawnOptions(
    req.cwd ?? '',
    req.workspaceId,
    req.sessionId ?? undefined,
    req.modelSessionId
  )
  log.info('agy spawnInteractive', {
    sessionId: req.sessionId,
    isNewSession: req.sessionId == null,
    cwd: req.cwd
  })

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

  // 새 세션 또는 resume fallback 케이스 — UUID 후처리 캡처.
  // 캡처 결과는 hooks.onModelSessionIdCaptured 콜백으로만 호출자에 전달 (반환값은 이미 결정됨).
  // core watchForNewConversationUuid 사용 — conversations/ FS 스캔(mtime) + spawn 전 스냅샷
  // (opts.agyWatchUuid.excludeUuids). cwd-키 캐시 폴링(/private 불일치로 실패)을 대체 (V-17).
  const initialModelSessionId: string | null = opts.modelSessionId ?? null
  if (initialModelSessionId === null && req.cwd && opts.agyWatchUuid) {
    const cwd = req.cwd
    const exclude = opts.agyWatchUuid.excludeUuids
    void watchForNewConversationUuid({
      cwd,
      excludeUuids: exclude,
      onCaptured: (uuid) => {
        hooks.onModelSessionIdCaptured?.(uuid)
      },
      logger: { log: (m) => log.info(m), warn: (m) => log.warn(m) }
    }).catch((err) => {
      log.warn('agy modelSessionId 캡처 중 에러', { err: String(err) })
    })
  }

  return { ...result, modelSessionId: initialModelSessionId }
}

async function deleteNativeSession(modelSessionId: string | null): Promise<void> {
  if (!modelSessionId) return
  await deleteAgyNativeSession(modelSessionId, {
    log: (msg) => log.info(msg),
    warn: (msg) => log.warn(msg)
  })
}

export const agyAdapter: CLIAdapter = {
  kind: 'agy',
  formatChatSubmit: (text) => [{ write: text, delayMs: 80 }, { write: '\r' }],
  spawnInteractive,
  write: writePty,
  resize: resizePty,
  killInteractive: killPty,
  deleteNativeSession
}
