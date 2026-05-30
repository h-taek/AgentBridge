import { promises as fs } from 'node:fs'
import { ipcMain } from 'electron'
import log from 'electron-log/main'
import {
  IpcChannel,
  type IrLoadRequest,
  type IrLoadResult,
  type IrRefineRequest,
  type IrRefineResult
} from '@shared/ipc'
import { runManualCompaction } from '../modules/compactionScheduler'
import { broadcastIrUpdated } from '../modules/irBroadcast'
import { getWorkspacePaths, loadWorkspaceIR } from '../modules/workspaceStore'

// ir:refine — 사용자 명시 trigger ("메모리 갱신" 버튼). O 청크 이후 turns.jsonl 기반.
// architecture §15.3~15.6.
//
// 흐름:
//   1. turnsStore.readAllTurns(workspaceId)
//   2. buildCompactionPrompt({ fromModel, turns: oldest, currentIR })
//   3. RefineDispatcher.runRefine(prompt) → assistantText
//   4. parseRefineOutput + assembleIR → 슬림 IR
//   5. saveWorkspaceIRAtomic + archive + turns rewrite
//
// 본 함수는 CompactionScheduler.runManualCompaction wrapper.

export async function runIrRefine(args: {
  workspaceId: string
  timeoutMs?: number
}): Promise<IrRefineResult> {
  log.info('runIrRefine 시작 (turns 기반)', { workspaceId: args.workspaceId })
  const result = await runManualCompaction({
    workspaceId: args.workspaceId,
    timeoutMs: args.timeoutMs
  })
  log.info('runIrRefine 완료', {
    workspaceId: args.workspaceId,
    ok: result.ok,
    error: result.error,
    durationMs: result.durationMs,
    intentGoal: result.ir?.intent.goal.slice(0, 100),
    decisions: result.ir?.decisions.length,
    files: result.ir?.files.length,
    commands: result.ir?.commands.length,
    tests: result.ir?.tests.length,
    pending: result.ir?.pending.length
  })
  return {
    ok: result.ok,
    error: result.error,
    ir: result.ir,
    rawAssistantText: result.rawAssistantText,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    stderr: result.stderr,
    rawLineCount: result.rawLineCount,
    usage: result.usage
  }
}

async function handleIrRefine(_e: unknown, req: IrRefineRequest): Promise<IrRefineResult> {
  const result = await runIrRefine({
    workspaceId: req.workspaceId,
    timeoutMs: req.timeoutMs
  })
  if (result.ok && result.ir) {
    broadcastIrUpdated({ workspaceId: req.workspaceId, source: 'manual' })
  }
  // refine 종료 후 quota probe는 RefineDispatcher가 *실제 spawn된 CLI*만 trigger한다.
  return result
}

async function handleIrLoad(_e: unknown, req: IrLoadRequest): Promise<IrLoadResult> {
  const ir = await loadWorkspaceIR(req.workspaceId)
  let fileMtime: string | null = null
  try {
    const stat = await fs.stat(getWorkspacePaths(req.workspaceId).ir)
    fileMtime = stat.mtime.toISOString()
  } catch {
    fileMtime = null
  }
  return { ir, fileMtime }
}

export function registerIrHandlers(): void {
  ipcMain.handle(IpcChannel.IrLoad, handleIrLoad)
  ipcMain.handle(IpcChannel.IrRefine, handleIrRefine)
}
