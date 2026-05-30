import { promises as fs, type Stats } from 'node:fs'
import * as path from 'node:path'
import { ipcMain } from 'electron'
import log from 'electron-log/main'
import {
  IpcChannel,
  type ArchiveDeleteRequest,
  type ArchiveDeleteResult,
  type ArchiveListRequest,
  type ArchiveListResult,
  type ArchiveLoadRequest,
  type ArchiveLoadResult,
  type ArchiveSnapshotMeta,
  type InstructionFileInfo,
  type InstructionFileKind,
  type InstructionsCreateRequest,
  type InstructionsCreateResult,
  type InstructionsListRequest,
  type InstructionsListResult,
  type MemoryPromoteArchiveRequest,
  type MemoryPromoteArchiveResult,
  type MemoryResetRequest,
  type MemoryResetResult,
  type TurnsSummaryRequest,
  type TurnsSummaryResult
} from '@shared/ipc'
import type { IR } from '@shared/ir'
import { COMPACTION_TRIGGER } from '@shared/turns'
import { getWorkspacePaths, loadWorkspace } from '../modules/workspaceStore'
import { readAllTurns, sumBytes } from '../modules/turnsStore'
import { broadcastIrUpdated } from '../modules/irBroadcast'
import { broadcastTurnsUpdated } from '../modules/turnRecorder'

// M3.5 UI-E 후속 — 메모리 관리 패널 IPC.
//   archive:list / archive:load — workspaces/<id>/archive/compressed_<TS>.jsonl 인덱싱 + 단건 read
//   turns:summary               — turns.jsonl count/bytes + compaction 임계 진행률
//   instructions:list/create    — cwd 안 AGENTS.md / CLAUDE.md / GEMINI.md 핸들 (open은 app:openPath 재사용)

const INSTRUCTION_FILENAMES: Record<InstructionFileKind, string> = {
  agents: 'AGENTS.md',
  claude: 'CLAUDE.md',
  gemini: 'GEMINI.md'
}

// archive/compressed_*.jsonl 첫 줄 = `{ type: 'ir_snapshot', archivedAt, ir }`. counts/intent만 추출.
async function readArchiveSnapshotMeta(archivePath: string): Promise<ArchiveSnapshotMeta | null> {
  let raw: string
  try {
    raw = await fs.readFile(archivePath, 'utf8')
  } catch {
    return null
  }
  const firstLine = raw.split('\n', 1)[0]?.trim()
  if (!firstLine) return null
  let parsed: { type?: string; archivedAt?: string; ir?: IR }
  try {
    parsed = JSON.parse(firstLine)
  } catch {
    return null
  }
  if (parsed.type !== 'ir_snapshot' || !parsed.ir || typeof parsed.archivedAt !== 'string') {
    return null
  }
  const ir = parsed.ir
  return {
    archivePath,
    archivedAt: parsed.archivedAt,
    updatedAt: ir.meta?.updatedAt || parsed.archivedAt,
    intentGoal: typeof ir.intent?.goal === 'string' ? ir.intent.goal : '',
    counts: {
      decisions: Array.isArray(ir.decisions) ? ir.decisions.length : 0,
      files: Array.isArray(ir.files) ? ir.files.length : 0,
      commands: Array.isArray(ir.commands) ? ir.commands.length : 0,
      tests: Array.isArray(ir.tests) ? ir.tests.length : 0,
      pending: Array.isArray(ir.pending) ? ir.pending.length : 0
    }
  }
}

async function handleArchiveList(_e: unknown, req: ArchiveListRequest): Promise<ArchiveListResult> {
  const { archiveDir } = getWorkspacePaths(req.workspaceId)
  let names: string[]
  try {
    names = await fs.readdir(archiveDir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { snapshots: [] }
    throw err
  }
  const compressed = names
    .filter((n) => n.startsWith('compressed_') && n.endsWith('.jsonl'))
    .map((n) => path.join(archiveDir, n))
  const snapshots: ArchiveSnapshotMeta[] = []
  for (const p of compressed) {
    const meta = await readArchiveSnapshotMeta(p)
    if (meta) snapshots.push(meta)
  }
  // 최신순 정렬 (archivedAt descending).
  snapshots.sort((a, b) => (a.archivedAt < b.archivedAt ? 1 : -1))
  return { snapshots }
}

// archive 파일 경로 안전 검증 — 3중 가드를 헬퍼로 추출 (load/delete 양쪽 공유).
//   1) basename 패턴 — `compressed_*.jsonl`만 허용
//   2) lstat — symlink면 즉시 거부 (archiveDir 안 symlink가 외부 파일 가리키는 우회 차단)
//   3) realpath 비교 — symlink 아니어도 realpath 후 archiveDir prefix 비교로 traversal 차단
// 반환값: 검증 통과한 realpath (호출자가 read/unlink 대상으로 그대로 사용).
async function resolveArchivePathSafe(
  archiveDir: string,
  inputPath: string,
  errPrefix: string
): Promise<string> {
  const resolved = path.resolve(inputPath)
  const basename = path.basename(resolved)
  if (!/^compressed_.+\.jsonl$/.test(basename)) {
    throw new Error(`${errPrefix} 거부 — 파일명 패턴 불일치`)
  }
  let lstats: Stats
  try {
    lstats = await fs.lstat(resolved)
  } catch {
    throw new Error(`${errPrefix} 거부 — 파일 없음`)
  }
  if (lstats.isSymbolicLink()) {
    throw new Error(`${errPrefix} 거부 — symlink 비허용`)
  }
  if (!lstats.isFile()) {
    throw new Error(`${errPrefix} 거부 — 일반 파일 아님`)
  }
  const realArchiveDir = await fs.realpath(archiveDir)
  const realTarget = await fs.realpath(resolved)
  if (!realTarget.startsWith(realArchiveDir + path.sep)) {
    throw new Error(`${errPrefix} 거부 — 워크스페이스 archive 외부 경로`)
  }
  return realTarget
}

async function handleArchiveLoad(_e: unknown, req: ArchiveLoadRequest): Promise<ArchiveLoadResult> {
  const { archiveDir } = getWorkspacePaths(req.workspaceId)
  const realTarget = await resolveArchivePathSafe(archiveDir, req.archivePath, 'archive:load')
  const raw = await fs.readFile(realTarget, 'utf8')
  const firstLine = raw.split('\n', 1)[0]?.trim()
  if (!firstLine) throw new Error('archive 파일 비어있음')
  const parsed = JSON.parse(firstLine) as { type?: string; archivedAt?: string; ir?: IR }
  if (parsed.type !== 'ir_snapshot' || !parsed.ir || typeof parsed.archivedAt !== 'string') {
    throw new Error('archive 파일 형식 불일치')
  }
  return { archivedAt: parsed.archivedAt, ir: parsed.ir }
}

// archive:delete — 메모리 패널 이전 스냅샷 카드 휴지통 click 시 호출.
// archive:load와 동일한 안전 가드(basename + lstat symlink 거부 + realpath prefix)를 통과한 경로만 unlink.
async function handleArchiveDelete(
  _e: unknown,
  req: ArchiveDeleteRequest
): Promise<ArchiveDeleteResult> {
  log.info('archive:delete', { workspaceId: req.workspaceId, archivePath: req.archivePath })
  try {
    const { archiveDir } = getWorkspacePaths(req.workspaceId)
    const realTarget = await resolveArchivePathSafe(archiveDir, req.archivePath, 'archive:delete')
    await fs.unlink(realTarget)
    return { ok: true }
  } catch (err) {
    log.warn('archive:delete 실패', { workspaceId: req.workspaceId, err: String(err) })
    return { ok: false, error: String(err) }
  }
}

async function handleTurnsSummary(
  _e: unknown,
  req: TurnsSummaryRequest
): Promise<TurnsSummaryResult> {
  const turns = await readAllTurns(req.workspaceId)
  const bytes = sumBytes(turns)
  // 자동 compaction은 keepRecent 초과 *uncompacted* 부분에 대해서만 trigger 평가.
  // 단순화: 현재 turns.length 자체가 keepRecent 이상이고 임계 도달 시 발동 → 카드에선
  // "count - keepRecent" 가 임계 비교 대상이 됨. 사용자에게 직관적으로는 "총 N turn 중 임계까지 X 남음".
  const uncompactable = Math.max(0, turns.length - COMPACTION_TRIGGER.keepRecent)
  return {
    count: turns.length,
    bytes,
    countThreshold: COMPACTION_TRIGGER.countThreshold,
    bytesThreshold: COMPACTION_TRIGGER.bytesThreshold,
    keepRecent: COMPACTION_TRIGGER.keepRecent,
    remainingCount: Math.max(0, COMPACTION_TRIGGER.countThreshold - uncompactable),
    remainingBytes: Math.max(0, COMPACTION_TRIGGER.bytesThreshold - bytes)
  }
}

async function statInstructionFile(
  cwd: string,
  kind: InstructionFileKind
): Promise<InstructionFileInfo> {
  const filename = INSTRUCTION_FILENAMES[kind]
  const absolutePath = path.join(cwd, filename)
  try {
    const stat = await fs.stat(absolutePath)
    return {
      kind,
      filename,
      absolutePath,
      exists: true,
      mtime: stat.mtime.toISOString(),
      sizeBytes: stat.size
    }
  } catch {
    return { kind, filename, absolutePath, exists: false, mtime: null, sizeBytes: null }
  }
}

async function handleInstructionsList(
  _e: unknown,
  req: InstructionsListRequest
): Promise<InstructionsListResult> {
  const ws = await loadWorkspace(req.workspaceId)
  if (!ws.workspacePath) return { files: [] }
  const kinds: InstructionFileKind[] = ['agents', 'claude', 'gemini']
  const files = await Promise.all(kinds.map((k) => statInstructionFile(ws.workspacePath, k)))
  return { files }
}

async function handleInstructionsCreate(
  _e: unknown,
  req: InstructionsCreateRequest
): Promise<InstructionsCreateResult> {
  const ws = await loadWorkspace(req.workspaceId)
  if (!ws.workspacePath) throw new Error('워크스페이스 cwd가 없음')
  const filename = INSTRUCTION_FILENAMES[req.kind]
  const absolutePath = path.join(ws.workspacePath, filename)
  try {
    await fs.access(absolutePath)
    return { absolutePath, created: false }
  } catch {
    // 빈 파일 생성. 본문 작성은 사용자 몫.
    await fs.writeFile(absolutePath, '', 'utf8')
    log.info('instructions:create', { workspaceId: req.workspaceId, absolutePath })
    return { absolutePath, created: true }
  }
}

// memory:reset — 사용자가 명시적으로 IR/turns/archive를 비울 때 호출.
//   - ir.json을 '{}'로 atomic write (loadWorkspaceIR이 빈 IR로 인식)
//   - alsoTurns=true면 turns.jsonl도 빈 파일로 rewrite
//   - archive 디렉토리 안 모든 스냅샷 파일 unlink (디렉토리 자체는 보존)
//   - ir:updated broadcast(source='manual') + alsoTurns면 turns:updated broadcast → IrPanel 즉시 갱신
//
// 정책 변경 (2026-05-21): 이전엔 archive 보존이 기본이었으나, 사용자가 "메모리 초기화"를 누른 의도가
// 보통 archive까지 포함한 *완전 초기화*임이 확인되어 archive도 함께 정리하도록 통합.
async function handleMemoryReset(_e: unknown, req: MemoryResetRequest): Promise<MemoryResetResult> {
  log.info('memory:reset', { workspaceId: req.workspaceId, alsoTurns: !!req.alsoTurns })
  try {
    // 워크스페이스 존재 검증 (잘못된 id면 throw — 손상된 워크스페이스의 빈 파일 생성 회피).
    await loadWorkspace(req.workspaceId)
    const paths = getWorkspacePaths(req.workspaceId)

    // ir.json atomic write — tmp 후 rename으로 동시 read 중에도 일관성 보장.
    const irTmp = `${paths.ir}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(irTmp, '{}', 'utf8')
    await fs.rename(irTmp, paths.ir)

    if (req.alsoTurns) {
      const turnsTmp = `${paths.turnsJsonl}.${process.pid}.${Date.now()}.tmp`
      await fs.writeFile(turnsTmp, '', 'utf8')
      await fs.rename(turnsTmp, paths.turnsJsonl)
    }

    // archive 디렉토리 안 모든 파일 unlink — 디렉토리 자체는 유지(다음 compaction이 재생성).
    try {
      const entries = await fs.readdir(paths.archiveDir)
      await Promise.all(
        entries.map(async (name) => {
          try {
            await fs.unlink(path.join(paths.archiveDir, name))
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code
            if (code !== 'ENOENT') {
              log.warn('archive 항목 unlink 실패', { name, err: String(err) })
            }
          }
        })
      )
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        log.warn('archive 디렉토리 정리 실패', { err: String(err) })
      }
    }

    broadcastIrUpdated({ workspaceId: req.workspaceId, source: 'manual' })
    if (req.alsoTurns) {
      broadcastTurnsUpdated(req.workspaceId)
    }
    return { ok: true }
  } catch (err) {
    log.warn('memory:reset 실패', { workspaceId: req.workspaceId, err: String(err) })
    return { ok: false, error: String(err) }
  }
}

// memory:promoteLatestArchive — CurrentIrCard 휴지통 클릭 동작.
//   - archive 디렉토리에서 최신 compressed_*.jsonl 1개 선택 (archivedAt desc)
//   - 첫 줄 JSON에서 ir 추출 → ir.json에 atomic write
//   - 그 archive 파일 unlink (다음 promote 가능하게)
//   - archive 비어있으면 빈 IR('{}')로 reset 동일 동작
//   - broadcast ir:updated(source='manual') → IrPanel 자동 fetch chain
async function handleMemoryPromoteArchive(
  _e: unknown,
  req: MemoryPromoteArchiveRequest
): Promise<MemoryPromoteArchiveResult> {
  log.info('memory:promoteLatestArchive', { workspaceId: req.workspaceId })
  try {
    await loadWorkspace(req.workspaceId)
    const { archiveDir, ir: irPath } = getWorkspacePaths(req.workspaceId)

    // archive 목록 — basename pattern 통과 + 첫 줄 메타 파싱하여 archivedAt 최신 1개 선택.
    let names: string[]
    try {
      names = await fs.readdir(archiveDir)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        names = []
      } else {
        throw err
      }
    }
    const candidates: { path: string; archivedAt: string; ir: IR }[] = []
    for (const name of names) {
      if (!/^compressed_.+\.jsonl$/.test(name)) continue
      const filePath = path.join(archiveDir, name)
      try {
        const raw = await fs.readFile(filePath, 'utf8')
        const first = raw.split('\n', 1)[0]?.trim()
        if (!first) continue
        const parsed = JSON.parse(first) as { type?: string; archivedAt?: string; ir?: IR }
        if (parsed.type !== 'ir_snapshot' || !parsed.ir || typeof parsed.archivedAt !== 'string') {
          continue
        }
        candidates.push({ path: filePath, archivedAt: parsed.archivedAt, ir: parsed.ir })
      } catch {
        // 깨진 파일 skip
      }
    }
    // 최신순 정렬
    candidates.sort((a, b) => (a.archivedAt < b.archivedAt ? 1 : -1))
    const latest = candidates[0] ?? null

    // ir.json atomic write — latest 있으면 그 ir, 없으면 '{}'.
    const irBody = latest ? JSON.stringify(latest.ir, null, 2) : '{}'
    const irTmp = `${irPath}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(irTmp, irBody, 'utf8')
    await fs.rename(irTmp, irPath)

    // archive 파일 unlink (다음 promote 호출 시 그 다음 본이 최신이 되도록).
    if (latest) {
      try {
        await fs.unlink(latest.path)
      } catch (err) {
        log.warn('promote — archive 파일 unlink 실패 (계속 진행)', {
          path: latest.path,
          err: String(err)
        })
      }
    }

    broadcastIrUpdated({ workspaceId: req.workspaceId, source: 'manual' })
    return { ok: true, promotedFromArchivedAt: latest ? latest.archivedAt : null }
  } catch (err) {
    log.warn('memory:promoteLatestArchive 실패', { workspaceId: req.workspaceId, err: String(err) })
    return { ok: false, promotedFromArchivedAt: null, error: String(err) }
  }
}

export function registerMemoryHandlers(): void {
  ipcMain.handle(IpcChannel.ArchiveList, handleArchiveList)
  ipcMain.handle(IpcChannel.ArchiveLoad, handleArchiveLoad)
  ipcMain.handle(IpcChannel.ArchiveDelete, handleArchiveDelete)
  ipcMain.handle(IpcChannel.TurnsSummary, handleTurnsSummary)
  ipcMain.handle(IpcChannel.InstructionsList, handleInstructionsList)
  ipcMain.handle(IpcChannel.InstructionsCreate, handleInstructionsCreate)
  ipcMain.handle(IpcChannel.MemoryReset, handleMemoryReset)
  ipcMain.handle(IpcChannel.MemoryPromoteArchive, handleMemoryPromoteArchive)
}
