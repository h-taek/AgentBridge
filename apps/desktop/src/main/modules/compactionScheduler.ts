import log from 'electron-log/main'
import type { CliKind, SessionMeta } from '@shared/ipc'
import type { IR } from '@shared/ir'
import type { TurnRecord } from '@shared/turns'
import { COMPACTION_TRIGGER } from '@shared/turns'
import {
  loadWorkspace,
  loadWorkspaceIR,
  saveWorkspaceIRAtomic,
  updateWorkspaceMeta
} from './workspaceStore'
import { archiveCompactedTurns, readAllTurns, rewriteTurns, sumBytes } from './turnsStore'
import { assembleIR, buildCompactionPrompt, parseRefineOutput } from './irModule'
import { RefineOffError, runRefine } from './refineDispatcher'
import { broadcastIrUpdated } from './irBroadcast'

// CompactionScheduler — M3 O 청크. architecture §15.4.
//
// trigger 시점: TurnRecorder가 turns.jsonl append 직후 fire-and-forget으로 호출.
//
// trigger 조건:
//   uncompacted count > 3 (≥ 4)  OR
//   sum(userBytes + assistantBodyBytes) > 6_000
//
// 처리 단위:
//   oldest (uncompacted_count - 3)개 — 최근 3개는 *항상* turns.jsonl raw 보존.
//
// lock:
//   workspace.json.compactionInProgress { sessionId: 'compaction', startedAt: ISO }
//   atomic CAS. 5분 stale 강제 해제.
//
// 실패 정책:
//   - lock 획득 실패 → skip
//   - RefineDispatcher 실패 → log + skip (다음 trigger 재시도)
//   - parse 실패 → log + skip
//   - ir.json write 실패 → lock 해제 + 다음 trigger 재시도. turns.jsonl 그대로
//   - 5분 stale lock → 강제 해제

const LOCK_STALE_MS = 5 * 60 * 1000
const COMPACTION_TIMEOUT_MS = 60_000

// 같은 process 내 동시 호출 방어 — workspace 단위 in-flight 추적.
const inFlight = new Set<string>()

function shouldTrigger(turns: TurnRecord[]): boolean {
  // `>=` 의도: countThreshold=6 이면 정확히 6턴 도달 시 발동 → oldest 3개(=count-keepRecent) 처리.
  if (turns.length >= COMPACTION_TRIGGER.countThreshold) return true
  if (sumBytes(turns) >= COMPACTION_TRIGGER.bytesThreshold) return true
  return false
}

// lock CAS — workspace.json.compactionInProgress 읽고, 비었거나 stale이면 우리 값으로 set.
// 동시 작성자가 있을 수 있어 best-effort (single main process 가정에서 충분).
async function acquireLock(workspaceId: string): Promise<boolean> {
  const ws = await loadWorkspace(workspaceId)
  if (ws.compactionInProgress) {
    const startedAt = Date.parse(ws.compactionInProgress.startedAt)
    if (!Number.isFinite(startedAt) || Date.now() - startedAt > LOCK_STALE_MS) {
      log.warn('Compaction lock stale — 강제 해제', {
        workspaceId,
        startedAt: ws.compactionInProgress.startedAt
      })
      // fall through — set 시도
    } else {
      return false
    }
  }
  await updateWorkspaceMeta(workspaceId, {
    compactionInProgress: {
      sessionId: 'compaction',
      startedAt: new Date().toISOString()
    }
  })
  return true
}

async function releaseLock(workspaceId: string): Promise<void> {
  try {
    await updateWorkspaceMeta(workspaceId, { compactionInProgress: null })
  } catch (err) {
    log.warn('Compaction lock 해제 실패 (next trigger에서 stale 처리)', {
      workspaceId,
      err: String(err)
    })
  }
}

// active 모델 결정 — primarySession 우선. shell 세션은 어댑터 dispatch가 불가하므로 제외.
// 모든 세션이 shell이면 default 'claude' (turns는 어차피 안 쌓여 trigger 자체가 잘 안 됨).
function pickActiveModel(
  ws: { sessions: SessionMeta[]; primarySessionId: string | null },
  primarySession?: SessionMeta
): CliKind {
  if (primarySession && (primarySession.kind ?? 'cli') === 'cli') return primarySession.model
  const cliSession = ws.sessions.find((s) => (s.kind ?? 'cli') === 'cli')
  return cliSession?.model ?? 'claude'
}

export async function checkAndRunCompaction(workspaceId: string): Promise<void> {
  // 동시 호출 방어 (turns append가 빠르게 연속 발생하면 trigger도 연속)
  if (inFlight.has(workspaceId)) return
  inFlight.add(workspaceId)
  try {
    const turns = await readAllTurns(workspaceId)
    if (!shouldTrigger(turns)) return

    const processCount = turns.length - COMPACTION_TRIGGER.keepRecent
    if (processCount <= 0) return // defensive

    const acquired = await acquireLock(workspaceId)
    if (!acquired) {
      log.info('Compaction skip — lock busy', { workspaceId })
      return
    }

    try {
      await runCompaction(workspaceId, turns, processCount)
    } finally {
      await releaseLock(workspaceId)
    }
  } finally {
    inFlight.delete(workspaceId)
  }
}

async function runCompaction(
  workspaceId: string,
  allTurns: TurnRecord[],
  processCount: number
): Promise<void> {
  const ws = await loadWorkspace(workspaceId)
  const primarySession = ws.primarySessionId
    ? ws.sessions.find((s) => s.sessionId === ws.primarySessionId)
    : undefined
  const fromModel = pickActiveModel(ws, primarySession)
  const currentIR = await loadWorkspaceIR(workspaceId)

  const oldest = allTurns.slice(0, processCount)
  const remaining = allTurns.slice(processCount)

  log.info('Compaction 시작', {
    workspaceId,
    total: allTurns.length,
    processCount,
    keepRecent: remaining.length,
    fromModel
  })

  const prompt = buildCompactionPrompt({
    fromModel,
    workspacePath: ws.workspacePath,
    turns: oldest,
    currentIR
  })

  let dispatch
  try {
    dispatch = await runRefine({
      activeModel: fromModel,
      prompt,
      cwd: ws.workspacePath,
      timeoutMs: COMPACTION_TIMEOUT_MS
    })
  } catch (err) {
    if (err instanceof RefineOffError) {
      log.info('Compaction skip — refineModel=off', { workspaceId })
      return
    }
    log.warn('Compaction RefineDispatcher 실패 (다음 trigger 재시도)', {
      workspaceId,
      err: String(err)
    })
    return
  }
  const refine = dispatch.result
  if (refine.exitCode !== 0 && refine.assistantText.length === 0) {
    log.warn('Compaction refine spawn 실패 (다음 trigger 재시도)', {
      workspaceId,
      exitCode: refine.exitCode,
      stderrSlice: refine.stderr.slice(0, 200)
    })
    return
  }

  const parsed = parseRefineOutput(refine.assistantText)
  if (!parsed.ok) {
    log.warn('Compaction parse 실패 (다음 trigger 재시도)', {
      workspaceId,
      error: parsed.error
    })
    return
  }
  const ir = assembleIR({
    contextId: workspaceId,
    body: parsed.body,
    fromModel,
    workspacePath: ws.workspacePath,
    previousIR: currentIR
  })

  // 영속화 — ir.json 먼저, 그 다음 turns.jsonl rewrite. 순서:
  //   ir.json write 실패 시 turns.jsonl은 그대로 — 다음 trigger 재시도 가능.
  //   turns.jsonl rewrite 실패 시 ir.json은 갱신됐지만 turns가 그대로 — 다음 trigger에서
  //     같은 oldest 영역을 다시 refine해 IR 누적. 안전 (오버페이로 약간의 비용만).
  try {
    await saveWorkspaceIRAtomic(workspaceId, ir)
  } catch (err) {
    log.warn('Compaction ir.json write 실패 (다음 trigger 재시도)', {
      workspaceId,
      err: String(err)
    })
    return
  }

  // archive에는 *직전 IR*(currentIR)을 push — 새 IR은 current로만 들어가 archive list와
  // 중복을 만들지 않게. 첫 compaction(currentIR=null)은 push skip.
  if (currentIR) {
    try {
      await archiveCompactedTurns(workspaceId, oldest, currentIR)
    } catch (err) {
      log.warn('Compaction archive 실패 (계속 진행)', {
        workspaceId,
        err: String(err)
      })
    }
  }

  try {
    await rewriteTurns(workspaceId, remaining)
  } catch (err) {
    log.warn('Compaction turns.jsonl rewrite 실패 — 다음 trigger 재처리', {
      workspaceId,
      err: String(err)
    })
    return
  }

  log.info('Compaction 완료', {
    workspaceId,
    fromModel,
    spawnedModel: dispatch.spawnedModel,
    fallback: dispatch.fallback,
    fallbackReason: dispatch.fallbackReason,
    processed: oldest.length,
    kept: remaining.length,
    irDecisions: ir.decisions.length,
    irFiles: ir.files.length,
    irCommands: ir.commands.length,
    irTests: ir.tests.length,
    irPending: ir.pending.length
  })
  broadcastIrUpdated({ workspaceId, source: 'auto' })
}

// 사용자 명시 trigger (ir:refine IPC) — 모든 uncompacted turn 처리 (3개 유지 정책 동일).
// 결과 IR + raw 응답을 반환해 호출자가 추가 진단/표시.
export type ManualCompactionResult = {
  ok: boolean
  error?: string
  ir?: IR
  rawAssistantText: string
  durationMs: number
  exitCode: number | null
  stderr: string
  rawLineCount: number
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
  }
}

export async function runManualCompaction(args: {
  workspaceId: string
  timeoutMs?: number
}): Promise<ManualCompactionResult> {
  const turns = await readAllTurns(args.workspaceId)
  const ws = await loadWorkspace(args.workspaceId)
  const primarySession = ws.primarySessionId
    ? ws.sessions.find((s) => s.sessionId === ws.primarySessionId)
    : undefined
  const fromModel = pickActiveModel(ws, primarySession)
  const currentIR = await loadWorkspaceIR(args.workspaceId)

  if (turns.length === 0) {
    log.info('runManualCompaction skip — turns 비어있음', {
      workspaceId: args.workspaceId
    })
    return {
      ok: false,
      error: 'turns.jsonl이 비어있어 정제할 내용 없음',
      rawAssistantText: '',
      durationMs: 0,
      exitCode: null,
      stderr: '',
      rawLineCount: 0
    }
  }

  // 처리 단위: 사용자 명시 trigger는 *모든 turn* 처리 (auto trigger는 oldest만).
  // 정책 일관: 최근 3개는 raw 보존, 나머지 정제.
  const keep = COMPACTION_TRIGGER.keepRecent
  const processCount = Math.max(turns.length - keep, 0)
  const oldest = turns.slice(0, processCount)
  const remaining = turns.slice(processCount)
  // 처리 대상 0개여도 IR refine은 의미 있음 (현재 IR + 최근 3 turn 누적).
  // 빈 oldest로 prompt 호출 시 buildCompactionPrompt에서 "(처리할 turn 없음)" 처리됨.

  log.info('runManualCompaction 시작', {
    workspaceId: args.workspaceId,
    total: turns.length,
    processCount,
    fromModel
  })

  const prompt = buildCompactionPrompt({
    fromModel,
    workspacePath: ws.workspacePath,
    turns: oldest.length > 0 ? oldest : remaining, // 처리 대상이 비면 최근 raw로 IR 추출
    currentIR
  })

  let dispatch
  try {
    dispatch = await runRefine({
      activeModel: fromModel,
      prompt,
      cwd: ws.workspacePath,
      timeoutMs: args.timeoutMs ?? COMPACTION_TIMEOUT_MS
    })
  } catch (err) {
    if (err instanceof RefineOffError) {
      return {
        ok: false,
        error: "refine 비활성 (settings.refineModel='off')",
        rawAssistantText: '',
        durationMs: 0,
        exitCode: null,
        stderr: '',
        rawLineCount: 0
      }
    }
    throw err
  }
  const refine = dispatch.result

  if (refine.exitCode !== 0 && refine.assistantText.length === 0) {
    return {
      ok: false,
      error: `refine spawn 실패 (exit=${refine.exitCode}). stderr 일부: ${refine.stderr.slice(0, 400)}`,
      rawAssistantText: refine.assistantText,
      durationMs: refine.durationMs,
      exitCode: refine.exitCode,
      stderr: refine.stderr,
      rawLineCount: refine.rawLines.length,
      usage: refine.usage
    }
  }

  const parsed = parseRefineOutput(refine.assistantText)
  if (!parsed.ok) {
    return {
      ok: false,
      error: parsed.error,
      rawAssistantText: refine.assistantText,
      durationMs: refine.durationMs,
      exitCode: refine.exitCode,
      stderr: refine.stderr,
      rawLineCount: refine.rawLines.length,
      usage: refine.usage
    }
  }

  const ir = assembleIR({
    contextId: args.workspaceId,
    body: parsed.body,
    fromModel,
    workspacePath: ws.workspacePath,
    previousIR: currentIR
  })

  // 영속화 + turns rewrite (processCount > 0일 때만 — 0이면 IR만 갱신, turns 유지)
  try {
    await saveWorkspaceIRAtomic(args.workspaceId, ir)
  } catch (err) {
    return {
      ok: false,
      error: `ir.json write 실패: ${String(err)}`,
      ir,
      rawAssistantText: refine.assistantText,
      durationMs: refine.durationMs,
      exitCode: refine.exitCode,
      stderr: refine.stderr,
      rawLineCount: refine.rawLines.length,
      usage: refine.usage
    }
  }

  if (processCount > 0) {
    // archive에는 *직전 IR*(currentIR)을 push — current와 중복 회피. 첫 정제는 skip.
    if (currentIR) {
      try {
        await archiveCompactedTurns(args.workspaceId, oldest, currentIR)
      } catch (err) {
        log.warn('runManualCompaction archive 실패 (계속 진행)', {
          workspaceId: args.workspaceId,
          err: String(err)
        })
      }
    }
    try {
      await rewriteTurns(args.workspaceId, remaining)
    } catch (err) {
      log.warn('runManualCompaction turns rewrite 실패 — IR은 갱신됨', {
        workspaceId: args.workspaceId,
        err: String(err)
      })
    }
  }

  log.info('runManualCompaction 완료', {
    workspaceId: args.workspaceId,
    spawnedModel: dispatch.spawnedModel,
    fallback: dispatch.fallback,
    fallbackReason: dispatch.fallbackReason,
    processed: oldest.length,
    kept: remaining.length,
    durationMs: refine.durationMs
  })

  return {
    ok: true,
    ir,
    error: parsed.warnings.length > 0 ? parsed.warnings.join(' / ') : undefined,
    rawAssistantText: refine.assistantText,
    durationMs: refine.durationMs,
    exitCode: refine.exitCode,
    stderr: refine.stderr,
    rawLineCount: refine.rawLines.length,
    usage: refine.usage
  }
}
