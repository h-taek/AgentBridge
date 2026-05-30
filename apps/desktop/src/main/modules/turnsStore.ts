import { promises as fs } from 'fs'
import * as path from 'path'
import log from 'electron-log/main'
import type { TurnRecord } from '@shared/turns'
import { TURNS_ROTATE } from '@shared/turns'
import { getWorkspacePaths } from './workspaceStore'

// TurnsStore — M3 O 청크. architecture §15.3.
//
// turns.jsonl append-only NDJSON 단일 파일 (workspace 단위, multi-tab 공유).
// Compaction이 oldest N개 처리 후 turns.jsonl을 rewrite, 처리된 record는 archive/compressed_<TS>.jsonl로.
//
// 파일 자체에 별도 lock 없음 — 단일 main 프로세스에서만 쓰고, append는 한 줄 단위 atomic.
// rewrite는 tmp + rename atomic. concurrent rewrite는 CompactionScheduler 단에서 workspace.json
// compactionInProgress로 직렬화.

let atomicCounter = 0
function makeAtomicTmpPath(realPath: string): string {
  return `${realPath}.${process.pid}.${Date.now()}.${++atomicCounter}.tmp`
}

// 한 줄 JSON 직렬화 + 개행. NDJSON 표준.
function serialize(turn: TurnRecord): string {
  return JSON.stringify(turn) + '\n'
}

// 파싱 — 부분 손상된 줄은 skip하고 진단 로그만 남김 (운영 중 fs.appendFile race 등).
function deserialize(line: string): TurnRecord | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const obj = JSON.parse(trimmed)
    if (!obj || typeof obj !== 'object') return null
    // 최소 식별 필드만 확인. 그 외 필드 누락은 호출자에서 처리.
    if (typeof obj.id !== 'string') return null
    return obj as TurnRecord
  } catch {
    return null
  }
}

// turns.jsonl 끝에 한 record append. 파일이 없으면 생성.
// 호출 빈도가 높음 (turn마다 1회) — append-only이므로 빠른 경로.
export async function appendTurn(workspaceId: string, turn: TurnRecord): Promise<void> {
  const { turnsJsonl, dir } = getWorkspacePaths(workspaceId)
  await fs.mkdir(dir, { recursive: true })
  await fs.appendFile(turnsJsonl, serialize(turn), 'utf8')
}

// 전체 read — compaction trigger 체크 + buildCompactionPrompt 입력용.
// 정상 record만 반환. 1000개 이내 + 한 record 평균 ~2KB라 메모리 부담 작음.
// rotate 미실행 시 한도 도달 후 추가 누적될 수 있으므로 호출 측에서 너무 잦은 read는 피한다.
export async function readAllTurns(workspaceId: string): Promise<TurnRecord[]> {
  const { turnsJsonl } = getWorkspacePaths(workspaceId)
  let raw: string
  try {
    raw = await fs.readFile(turnsJsonl, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return []
    throw err
  }
  const lines = raw.split('\n')
  const out: TurnRecord[] = []
  for (const line of lines) {
    const t = deserialize(line)
    if (t) out.push(t)
  }
  return out
}

// 끝 N개만 — helper binary(hook 본문) 등 가벼운 조회용.
// 전체 read 후 slice — 한 워크스페이스가 너무 많이 누적되면 rotate가 먼저 발동되므로 충분.
export async function readRecentTurns(workspaceId: string, n: number): Promise<TurnRecord[]> {
  const all = await readAllTurns(workspaceId)
  if (n <= 0 || all.length <= n) return all
  return all.slice(all.length - n)
}

// turns.jsonl rewrite — compaction이 oldest N개 제거 후 남은 record로 덮어쓴다.
// 동시성 보장은 CompactionScheduler의 workspace lock에 위임.
export async function rewriteTurns(workspaceId: string, turns: TurnRecord[]): Promise<void> {
  const { turnsJsonl, dir } = getWorkspacePaths(workspaceId)
  await fs.mkdir(dir, { recursive: true })
  const tmp = makeAtomicTmpPath(turnsJsonl)
  const body = turns.map(serialize).join('')
  await fs.writeFile(tmp, body, 'utf8')
  await fs.rename(tmp, turnsJsonl)
}

// archive/compressed_<TS>.jsonl — compaction에서 처리된 turns + 결과 IR snapshot 보관.
// 디스크 사용량 trade-off — 사용자 진단(왜 IR이 이렇게 압축됐는지) 용도로 보관.
// rotate 정책 미적용 (사용자가 워크스페이스 디스크 차면 수동 정리).
export async function archiveCompactedTurns(
  workspaceId: string,
  processed: TurnRecord[],
  irSnapshot: unknown
): Promise<string> {
  const { archiveDir } = getWorkspacePaths(workspaceId)
  await fs.mkdir(archiveDir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const archivePath = path.join(archiveDir, `compressed_${ts}.jsonl`)
  // 첫 줄: IR snapshot (metadata)
  //   { type: 'ir_snapshot', ir: {...}, archivedAt }
  // 나머지 줄: 처리된 TurnRecord NDJSON
  const lines: string[] = [
    JSON.stringify({ type: 'ir_snapshot', archivedAt: new Date().toISOString(), ir: irSnapshot })
  ]
  for (const t of processed) lines.push(JSON.stringify(t))
  await fs.writeFile(archivePath, lines.join('\n') + '\n', 'utf8')
  return archivePath
}

// rotate — turns.jsonl이 5MB 또는 1000 record 초과 시 archive/turns_<TS>.jsonl.archive로 이동.
// 호출 시점은 appendTurn 직후 cheap check. compaction과 무관한 안전망 (compaction이 잘 돌면 보통 안 발동).
export async function rotateIfNeeded(
  workspaceId: string
): Promise<{ rotated: boolean; archivePath?: string }> {
  const { turnsJsonl, archiveDir } = getWorkspacePaths(workspaceId)
  let stat: { size: number }
  try {
    stat = await fs.stat(turnsJsonl)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { rotated: false }
    throw err
  }
  if (stat.size < TURNS_ROTATE.maxBytes) {
    // 크기 미달 — record 수 체크 (적은 record이나 long line 케이스 대비).
    // record 수 확인은 read 비용 — 크기 절반 이상일 때만 (heuristic).
    if (stat.size < TURNS_ROTATE.maxBytes / 2) return { rotated: false }
    const turns = await readAllTurns(workspaceId)
    if (turns.length < TURNS_ROTATE.maxRecords) return { rotated: false }
  }
  await fs.mkdir(archiveDir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const archivePath = path.join(archiveDir, `turns_${ts}.jsonl.archive`)
  try {
    await fs.rename(turnsJsonl, archivePath)
    // 빈 파일 새로 생성 — 다음 appendTurn 시 ENOENT 회피.
    await fs.writeFile(turnsJsonl, '', 'utf8')
    log.info('turns.jsonl rotate', { workspaceId, archivePath, size: stat.size })
    return { rotated: true, archivePath }
  } catch (err) {
    log.warn('turns.jsonl rotate 실패 — 다음 append 계속', {
      workspaceId,
      err: String(err)
    })
    return { rotated: false }
  }
}

// uncompacted 합산 — trigger 판정에 사용.
export function sumBytes(turns: TurnRecord[]): number {
  let total = 0
  for (const t of turns) {
    total += t.userBytes + t.assistantBodyBytes
  }
  return total
}
