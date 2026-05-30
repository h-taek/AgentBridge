import { app } from 'electron'
import { promises as fs } from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import type {
  CliKind,
  SessionKind,
  SessionMeta,
  WorkspaceMeta,
  WorkspaceCreateRequest,
  WorkspaceListEntry
} from '@shared/ipc'
import type { IR } from '@shared/ir'
import { withWorkspaceLock } from './workspaceLock'
import { normalizeWorkspacePath, validateWorkspacePath } from './workspacePath'

// M3 K 청크 — Workspace 데이터 모델 + 영속화.
// architecture §14.2 / §14.3.
//
// ─── 세션 / 워크스페이스 관리 정책 ────────────────────────────────────────
//
// (1) 세션 삭제 = hard delete.
//     deleteSession()이 sessions/<sid>/ 디렉토리(meta.json + replay.log) +
//     workspace.json sessions[] 항목을 *동시에* 제거. soft delete(closedAt 마킹)는
//     "일시 닫음" 의미일 뿐 실제 삭제는 두 경로:
//       - 사용자 탭 x close (sessions:close { permanent: true })
//       - 빈 세션(replay.log < 1KB) 자동 정리 (sessions:close 안 isSessionEmpty)
//     hard delete 후엔 외부 agent가 워크스페이스 cwd를 직접 호출해도 그 세션 흔적 X.
//
// (2) 빈 세션은 워크스페이스 닫기 시 자동 hard delete.
//     워크스페이스 "닫기"는 closeAllAttachments → 모든 sessions:close 호출. 그 흐름에서
//     isSessionEmpty=true인 세션은 자동으로 deleteSession되어 sessions[]에서 사라짐.
//     작업 이력 있는 세션은 closedAt 마킹으로 보존(다음 reopen 시 부활).
//
// (3) 빈 워크스페이스(sessions[].length === 0) 정책 — 자동 삭제 *폐기* (2026-05-21).
//     이전엔 부팅 시 cleanupEmptyWorkspaces로 일괄 정리했으나, 사용자가 빈 ws를 명시 휴지통으로
//     관리하는 흐름이 더 직관적이라 자동 정리를 제거. 빈 ws는 사이드바에 카드로 표시되어 + 로
//     세션 재추가 가능, 또는 휴지통으로 hard delete.
//
// ────────────────────────────────────────────────────────────────────────
//
// 디렉토리 구조:
//   ~/Library/Application Support/AgentBridge/workspaces/<workspaceId>/
//     ├── workspace.json         ← WorkspaceMeta (atomic write)
//     ├── ir.json                ← 압축된 IR (M2 G 청크 schema 그대로)
//     ├── turns.jsonl            ← raw 턴 로그 (workspace 단위 단일 파일, O 청크에서 채움)
//     ├── archive/               ← 압축된 turns + IR snapshots
//     ├── sessions/<sid>/
//     │   ├── meta.json          ← SessionMeta
//     │   └── replay.log         ← PTY raw bytes (M1 위치에서 이전)
//     └── settings/
//         └── claude-settings.json   ← claude --settings flag로 가리킴 (M 청크)
//
// K 청크 범위:
//   - 디렉토리 + workspace.json + sessions/<sid>/meta.json CRUD
//   - thread → workspace *non-destructive 마이그레이션* (기존 threads/ 그대로 유지)
//   - turns.jsonl / archive / settings 폴더 생성만 (내용 채우는 건 M/N/O 청크)
//
// non-destructive 마이그레이션:
//   - 기존 ~/Library/Application Support/AgentBridge/threads/<contextId>.* 파일들은 *그대로*
//   - workspaces/<contextId>/ 에 *복사* (workspaceId = 기존 contextId 재사용)
//   - 기존 threads:* IPC + UI는 변경 없이 작동
//   - L 청크에서 UI 전환 시 threads/는 archive 처리

export type WorkspaceDirs = {
  root: string // ~/Library/Application Support/AgentBridge/
  workspaces: string // <root>/workspaces/
}

let dirsCache: WorkspaceDirs | null = null

export async function ensureWorkspaceDirs(): Promise<WorkspaceDirs> {
  const root = app.getPath('userData')
  const dirs: WorkspaceDirs = {
    root,
    workspaces: path.join(root, 'workspaces')
  }
  await fs.mkdir(dirs.workspaces, { recursive: true })
  dirsCache = dirs
  return dirs
}

function getDirs(): WorkspaceDirs {
  if (!dirsCache) {
    throw new Error('WorkspaceStore 미초기화 — ensureWorkspaceDirs() 먼저 호출')
  }
  return dirsCache
}

// workspaceId / sessionId 안전성 — randomUUID() 출력만 허용. legacy contextId 마이그레이션도 동일
// 포맷이라 호환된다. 정규식 거치지 않으면 `path.join`의 `..` collapse로 userData 상위로 escape 가능
// (예: workspaceId='../../etc' → fs.rm으로 임의 디렉토리 삭제).
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function assertUuid(label: string, id: string): void {
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
    throw new Error(`${label} 형식이 UUID가 아닙니다: ${JSON.stringify(id)}`)
  }
}

function assertWithinPrefix(targetDir: string, prefix: string, label: string): void {
  const resolved = path.resolve(targetDir)
  const resolvedPrefix = path.resolve(prefix)
  if (resolved !== resolvedPrefix && !resolved.startsWith(resolvedPrefix + path.sep)) {
    throw new Error(`${label} 경로가 허용 prefix 밖입니다: ${resolved}`)
  }
}

export type WorkspacePaths = {
  dir: string
  meta: string
  ir: string
  turnsJsonl: string
  archiveDir: string
  sessionsDir: string
  settingsDir: string
}

export function getWorkspacePaths(workspaceId: string): WorkspacePaths {
  assertUuid('workspaceId', workspaceId)
  const workspacesRoot = getDirs().workspaces
  const dir = path.join(workspacesRoot, workspaceId)
  // UUID 정규식 통과한 후에도 prefix 재확인 — 미래 호출자가 검증 우회한 경로를 직접 넘길 가능성 대비.
  assertWithinPrefix(dir, workspacesRoot, 'workspace')
  return {
    dir,
    meta: path.join(dir, 'workspace.json'),
    ir: path.join(dir, 'ir.json'),
    turnsJsonl: path.join(dir, 'turns.jsonl'),
    archiveDir: path.join(dir, 'archive'),
    sessionsDir: path.join(dir, 'sessions'),
    settingsDir: path.join(dir, 'settings')
  }
}

export type SessionPaths = {
  dir: string
  meta: string
  replayLog: string
}

export function getSessionPaths(workspaceId: string, sessionId: string): SessionPaths {
  assertUuid('sessionId', sessionId)
  const wsPaths = getWorkspacePaths(workspaceId)
  const sessionDir = path.join(wsPaths.sessionsDir, sessionId)
  assertWithinPrefix(sessionDir, wsPaths.sessionsDir, 'session')
  return {
    dir: sessionDir,
    meta: path.join(sessionDir, 'meta.json'),
    replayLog: path.join(sessionDir, 'replay.log')
  }
}

// atomic tmp counter — ConversationStore와 같은 패턴 (Date.now() 충돌 회피)
let writeAtomicCounter = 0
function makeAtomicTmpPath(realPath: string): string {
  return `${realPath}.${process.pid}.${Date.now()}.${++writeAtomicCounter}.tmp`
}

async function writeWorkspaceMetaAtomic(meta: WorkspaceMeta): Promise<void> {
  const paths = getWorkspacePaths(meta.workspaceId)
  const tmp = makeAtomicTmpPath(paths.meta)
  await fs.writeFile(tmp, JSON.stringify(meta, null, 2), 'utf8')
  await fs.rename(tmp, paths.meta)
  workspaceTitleCache.set(meta.workspaceId, meta.title)
}

// M3.6 C — workspaceManager가 동기로 윈도우 제목바 / dock 메뉴 라벨을 조회하기 위한 캐시.
// 모든 디스크 read/write 경로가 통과하는 지점에서 sync.
const workspaceTitleCache = new Map<string, string>()
export function getCachedWorkspaceTitle(workspaceId: string): string | null {
  return workspaceTitleCache.get(workspaceId) ?? null
}

async function writeSessionMetaAtomic(workspaceId: string, meta: SessionMeta): Promise<void> {
  const paths = getSessionPaths(workspaceId, meta.sessionId)
  const tmp = makeAtomicTmpPath(paths.meta)
  await fs.writeFile(tmp, JSON.stringify(meta, null, 2), 'utf8')
  await fs.rename(tmp, paths.meta)
}

// 워크스페이스 생성 + 첫 세션 등록.
export async function createWorkspace(
  input: WorkspaceCreateRequest
): Promise<{ workspace: WorkspaceMeta; firstSession: SessionMeta }> {
  const workspaceId = randomUUID()
  const sessionId = randomUUID()
  const now = new Date().toISOString()

  const firstSession: SessionMeta = {
    sessionId,
    model: input.initialModel,
    modelSessionId: null,
    createdAt: now,
    closedAt: null,
    kind: 'cli'
  }

  // Finder "경로 복사" / zsh escape / 따옴표 / ~ 등 사용자 입력 변형을 OS cwd로 정상화.
  // 미존재/파일 경로는 즉시 throw — 잘못된 저장으로 인한 spawn 후속 ENOENT를 사전 차단.
  // home:submit이 자동 생성한 신규 폴더 등 "이미 검증된" 호출자도 동일 정규화 통과해 무해.
  const normalizedPath = normalizeWorkspacePath(input.workspacePath)
  validateWorkspacePath(normalizedPath)

  const folderName = path.basename(normalizedPath.trim()) || 'workspace'
  const workspace: WorkspaceMeta = {
    workspaceId,
    title: input.title?.trim() || folderName,
    createdAt: now,
    updatedAt: now,
    workspacePath: normalizedPath,
    sessions: [firstSession],
    primarySessionId: sessionId,
    compactionInProgress: null
  }

  // 디렉토리 구조 생성
  const wp = getWorkspacePaths(workspaceId)
  await fs.mkdir(wp.dir, { recursive: true })
  await fs.mkdir(wp.archiveDir, { recursive: true })
  await fs.mkdir(wp.sessionsDir, { recursive: true })
  await fs.mkdir(wp.settingsDir, { recursive: true })
  // 빈 IR + 빈 turns.jsonl 파일 미리 — append/read 시 ENOENT 회피
  await fs.writeFile(wp.ir, '{}', 'utf8')
  await fs.writeFile(wp.turnsJsonl, '', 'utf8')

  // 첫 세션 디렉토리 + replay.log 빈 파일
  const sp = getSessionPaths(workspaceId, sessionId)
  await fs.mkdir(sp.dir, { recursive: true })
  await fs.writeFile(sp.replayLog, '', 'utf8')

  await writeWorkspaceMetaAtomic(workspace)
  await writeSessionMetaAtomic(workspaceId, firstSession)

  return { workspace, firstSession }
}

// legacy 마이그레이션 — 2026 agy(Antigravity) 리브랜드 이전 'gemini' 값을 'agy'로 in-place 치환.
// 디스크의 workspace.json은 다음 atomic write(updateWorkspaceMeta 등) 시점에 자동 영속화됨.
// session.model이 'gemini' 문자열을 가진 경우만 대상 — 타입 시스템 우회용 narrow cast.
function migrateLegacyGeminiToAgy(meta: WorkspaceMeta): WorkspaceMeta {
  let touched = false
  const sessions = meta.sessions.map((s) => {
    if ((s.model as unknown as string) === 'gemini') {
      touched = true
      return { ...s, model: 'agy' as CliKind }
    }
    return s
  })
  if (!touched) return meta
  return { ...meta, sessions }
}

export async function loadWorkspace(workspaceId: string): Promise<WorkspaceMeta> {
  const paths = getWorkspacePaths(workspaceId)
  const raw = await fs.readFile(paths.meta, 'utf8')
  const meta = migrateLegacyGeminiToAgy(JSON.parse(raw) as WorkspaceMeta)
  workspaceTitleCache.set(meta.workspaceId, meta.title)
  return meta
}

export async function listWorkspaces(): Promise<WorkspaceListEntry[]> {
  const dir = getDirs().workspaces
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return []
    throw err
  }
  const workspaces: WorkspaceListEntry[] = []
  for (const name of entries) {
    if (name.startsWith('.') || name.startsWith('_')) continue
    const metaPath = path.join(dir, name, 'workspace.json')
    try {
      const raw = await fs.readFile(metaPath, 'utf8')
      const meta = migrateLegacyGeminiToAgy(JSON.parse(raw) as WorkspaceMeta)
      if (typeof meta.workspaceId !== 'string' || meta.workspaceId.length === 0) continue
      workspaceTitleCache.set(meta.workspaceId, meta.title)
      // activeSessionCount는 메모리 derive — sessionActive 모듈에서 조회. K 청크 단계에선 0으로 표시.
      // L 청크에서 sessionActive 모듈 통합 시 정확 값으로 교체.
      workspaces.push({ ...meta, activeSessionCount: 0 })
    } catch {
      // 깨진 메타는 무시
    }
  }
  workspaces.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  return workspaces
}

export type WorkspaceUpdatePatch = Partial<{
  title: string
  workspacePath: string
  primarySessionId: string | null
  compactionInProgress: WorkspaceMeta['compactionInProgress']
  codexHookTrust: WorkspaceMeta['codexHookTrust']
}>

export async function updateWorkspaceMeta(
  workspaceId: string,
  patch: WorkspaceUpdatePatch
): Promise<WorkspaceMeta> {
  return withWorkspaceLock(workspaceId, async () => {
    const current = await loadWorkspace(workspaceId)
    const merged: WorkspaceMeta = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString()
    }
    await writeWorkspaceMetaAtomic(merged)
    return merged
  })
}

export async function deleteWorkspace(workspaceId: string): Promise<void> {
  const paths = getWorkspacePaths(workspaceId)
  await fs.rm(paths.dir, { recursive: true, force: true })
  workspaceTitleCache.delete(workspaceId)
}

// 사용자가 워크스페이스를 삭제했을 때 *원본 thread 백업도 cascade 삭제*.
// 이렇게 하지 않으면 다음 부팅 시 migrateThreadsToWorkspaces가 *해당 thread를 다시 보고*
// workspace.json 없으니 마이그레이션 → 사용자가 삭제한 워크스페이스 재출현.
//
// workspaceId == legacy contextId이므로 threads/<workspaceId>.{json,user.jsonl,replay.log,ir.json}
// 4 파일 best-effort 삭제. 마이그레이션된 적 없는 새 워크스페이스에선 ENOENT만 — 무시.
// user.jsonl은 채널 폐기 후에도 *legacy 사용자 데이터*가 존재할 수 있으므로 cleanup 포함.
export async function deleteLegacyThreadBackup(
  threadsDir: string,
  contextId: string
): Promise<void> {
  const candidates = [
    path.join(threadsDir, `${contextId}.json`),
    path.join(threadsDir, `${contextId}.user.jsonl`),
    path.join(threadsDir, `${contextId}.replay.log`),
    path.join(threadsDir, `${contextId}.ir.json`)
  ]
  await Promise.all(
    candidates.map(async (p) => {
      try {
        await fs.unlink(p)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') throw err
      }
    })
  )
}

// 빈 세션 판정은 어댑터의 hasNativeSession에 위임 — 각 CLI는 사용자 메시지 도착 전엔
// native 세션 파일을 디스크에 만들지 않으므로, 그 파일 존재 여부가 진실의 원천.
// workspaceStore가 직접 cliAdapter를 import하면 모듈 사이클이 생겨, 호출은 sessions:close
// handler(workspacesHandlers)에서 직접 어댑터 dispatch하도록 한다 — 여기엔 isSessionEmpty
// 헬퍼를 두지 않는다.

// 세션 디렉토리 + workspace.json sessions[]에서 제거. closedAt 무관.
// 호출 전 sessionActive 정리 + PTY kill은 호출자 책임.
export async function deleteSession(workspaceId: string, sessionId: string): Promise<void> {
  return withWorkspaceLock(workspaceId, async () => {
    const sessionPaths = getSessionPaths(workspaceId, sessionId)
    await fs.rm(sessionPaths.dir, { recursive: true, force: true })

    // workspace.json sessions[]에서 제거 + primarySessionId가 이거면 null로
    const ws = await loadWorkspace(workspaceId)
    const newSessions = ws.sessions.filter((s) => s.sessionId !== sessionId)
    const newPrimary = ws.primarySessionId === sessionId ? null : ws.primarySessionId
    const updated: WorkspaceMeta = {
      ...ws,
      sessions: newSessions,
      primarySessionId: newPrimary,
      updatedAt: new Date().toISOString()
    }
    await writeWorkspaceMetaAtomic(updated)
  })
}

// 워크스페이스 안에 새 세션 추가 (= 새 모델 탭 추가).
// 기존 sessions[]에 append, primarySessionId는 변경 없음 (UI가 active 결정).
// kind='shell'이면 일반 터미널 세션 — model 값은 placeholder(UI 미사용, 어댑터 dispatch X).
export async function addSessionToWorkspace(
  workspaceId: string,
  model: CliKind,
  kind: SessionKind = 'cli'
): Promise<SessionMeta> {
  return withWorkspaceLock(workspaceId, async () => {
    const sessionId = randomUUID()
    const now = new Date().toISOString()
    const newSession: SessionMeta = {
      sessionId,
      model,
      modelSessionId: null,
      createdAt: now,
      closedAt: null,
      kind
    }

    // 세션 디렉토리 + 빈 replay.log 생성
    const sp = getSessionPaths(workspaceId, sessionId)
    await fs.mkdir(sp.dir, { recursive: true })
    await fs.writeFile(sp.replayLog, '', 'utf8')
    await writeSessionMetaAtomic(workspaceId, newSession)

    // workspace.json sessions[]에 append
    const ws = await loadWorkspace(workspaceId)
    const updated: WorkspaceMeta = {
      ...ws,
      sessions: [...ws.sessions, newSession],
      updatedAt: now
    }
    await writeWorkspaceMetaAtomic(updated)

    return newSession
  })
}

export type SessionUpdatePatch = Partial<{
  modelSessionId: string | null
  closedAt: string | null
  title: string | undefined
  lastChattedAt: string
}>

export async function updateSessionMeta(
  workspaceId: string,
  sessionId: string,
  patch: SessionUpdatePatch
): Promise<SessionMeta> {
  return withWorkspaceLock(workspaceId, async () => {
    const ws = await loadWorkspace(workspaceId)
    const sessionIdx = ws.sessions.findIndex((s) => s.sessionId === sessionId)
    if (sessionIdx < 0) {
      throw new Error(`session not found: ${workspaceId}/${sessionId}`)
    }
    const merged: SessionMeta = { ...ws.sessions[sessionIdx], ...patch }
    // sessions[]도 갱신, workspace.json도 atomic write
    const newSessions = [...ws.sessions]
    newSessions[sessionIdx] = merged
    const updatedWs: WorkspaceMeta = {
      ...ws,
      sessions: newSessions,
      updatedAt: new Date().toISOString()
    }
    await writeWorkspaceMetaAtomic(updatedWs)
    await writeSessionMetaAtomic(workspaceId, merged)
    return merged
  })
}

export async function loadSession(workspaceId: string, sessionId: string): Promise<SessionMeta> {
  const paths = getSessionPaths(workspaceId, sessionId)
  const raw = await fs.readFile(paths.meta, 'utf8')
  return JSON.parse(raw) as SessionMeta
}

// PTY data 도착 시 workspace meta updatedAt 갱신용 — 매 chunk마다 디스크 쓰면 부담이라 throttle.
const TOUCH_INTERVAL_MS = 5_000
const lastTouchAt = new Map<string, number>()

export async function touchWorkspace(workspaceId: string): Promise<void> {
  const last = lastTouchAt.get(workspaceId) ?? 0
  const now = Date.now()
  if (now - last < TOUCH_INTERVAL_MS) return
  lastTouchAt.set(workspaceId, now)
  try {
    await withWorkspaceLock(workspaceId, async () => {
      const meta = await loadWorkspace(workspaceId)
      meta.updatedAt = new Date(now).toISOString()
      await writeWorkspaceMetaAtomic(meta)
    })
  } catch {
    // 메타가 사라졌거나 io 실패 — 무시. 다음 touch에서 재시도.
  }
}

// session의 replay.log 그대로 반환 (xterm.js 화면 복원용). 없으면 빈 문자열.
export async function readSessionReplay(workspaceId: string, sessionId: string): Promise<string> {
  const paths = getSessionPaths(workspaceId, sessionId)
  try {
    return await fs.readFile(paths.replayLog, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return ''
    throw err
  }
}

// ─── workspace 단위 ir.json + replay 통합 ─────────────────────────────────
//
// user.jsonl 채널은 폐기됨 (GUI 입력창 제거 결정 2026-05-11). O 청크에서 turns.jsonl이
// user/assistant 명시 분리 책임을 가짐.

// ir.json 로드 — workspace 위치. createWorkspace가 '{}'로 초기화하므로 빈 IR이면 null.
export async function loadWorkspaceIR(workspaceId: string): Promise<IR | null> {
  const paths = getWorkspacePaths(workspaceId)
  let raw: string
  try {
    raw = await fs.readFile(paths.ir, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    throw err
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed === '{}') return null
  try {
    const obj = JSON.parse(trimmed) as IR
    // contextId 필드는 workspaceId로 매핑. 누락 시 null 처리.
    if (typeof obj.contextId !== 'string' || obj.contextId.length === 0) return null
    return obj
  } catch {
    return null
  }
}

export async function saveWorkspaceIRAtomic(workspaceId: string, ir: IR): Promise<void> {
  const paths = getWorkspacePaths(workspaceId)
  const tmp = makeAtomicTmpPath(paths.ir)
  await fs.writeFile(tmp, JSON.stringify(ir, null, 2), 'utf8')
  await fs.rename(tmp, paths.ir)
}

// ─── 마이그레이션 — thread → workspace (non-destructive) ─────────────────
//
// 기존 threads/<contextId>.{json,user.jsonl,replay.log,ir.json} → workspaces/<contextId>/...
//   - workspaceId = 기존 contextId 재사용 (URL/북마크 안정성)
//   - thread.activeModel + thread.sessions 매핑 → 모델별 SessionMeta record (sessions[]에 모두 보존)
//   - primarySessionId = activeModel의 session
//   - replay.log → primary session의 replay.log로 복사 (M1/M2의 단일 active 가정)
//   - user.jsonl → workspace 루트에 보존 (turns.jsonl는 별개 — O 청크에서 채움)
//   - ir.json → workspace 루트로 복사
//
// 멱등 — 이미 마이그레이션된 워크스페이스는 skip.
// 기존 threads/ 데이터는 *그대로 유지* (L 청크에서 archive 처리).

// legacy threads/*.json은 2026 agy 리브랜드 이전 시점이라 'gemini' 키 / activeModel='gemini'를 가짐.
// 파싱 시 'gemini' 문자열을 그대로 받고 normalizeLegacyMeta에서 'agy'로 치환.
type LegacyCliKindRaw = CliKind | 'gemini'
type LegacyThreadMeta = {
  contextId: string
  title: string
  createdAt: string
  updatedAt: string
  activeModel: LegacyCliKindRaw
  workspacePath: string
  sessions: { claude?: string; codex?: string; agy?: string; gemini?: string }
}

function normalizeLegacyCliKind(raw: LegacyCliKindRaw): CliKind {
  return raw === 'gemini' ? 'agy' : raw
}

// 일부 legacy thread JSON 파일이 *두 객체가 이어져 쓰여진* 손상 형태로 발견됨
// (M2 H 이전 race condition 잔재 — atomic rename 도입 전). 첫 번째 *완성된* JSON 객체만
// 추출해 best-effort 마이그레이션 가능하게.
//
// 입력 예: '{ "a": 1, "obj": {...} }"b": 2 } }'  → '{ "a": 1, "obj": {...} }'
function extractFirstJsonObject(raw: string): string | null {
  let i = 0
  while (i < raw.length && /\s/.test(raw[i])) i++
  if (raw[i] !== '{') return null
  let depth = 0
  let inString = false
  let escape = false
  for (let j = i; j < raw.length; j++) {
    const ch = raw[j]
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\') {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return raw.slice(i, j + 1)
    }
  }
  return null
}

function parseLegacyMetaSafe(raw: string): { meta: LegacyThreadMeta | null; recovered: boolean } {
  try {
    return { meta: JSON.parse(raw) as LegacyThreadMeta, recovered: false }
  } catch {
    // 손상 — 첫 JSON 객체만 추출해 재시도
    const trimmed = extractFirstJsonObject(raw)
    if (!trimmed) return { meta: null, recovered: false }
    try {
      return { meta: JSON.parse(trimmed) as LegacyThreadMeta, recovered: true }
    } catch {
      return { meta: null, recovered: false }
    }
  }
}

export type MigrationResult = {
  scanned: number
  migrated: number
  skipped: number
  // race condition 잔재로 손상된 legacy meta(이중 객체 형태)를 best-effort 복구해 마이그레이션한 케이스.
  // migrated 카운터에도 잡힘 — 별개 보고 목적.
  recovered: number
  // L3 fix — 이미 한 번 마이그레이션된 적 있으나 워크스페이스가 *없는* (= 사용자가 삭제) 케이스.
  // 다시 마이그레이션 안 함. skipped와 분리 표시.
  alreadyMigrated: number
  errors: { contextId: string; error: string }[]
}

// 마이그레이션 처리 기록 — `<root>/migration_state.json`.
// 한 번이라도 마이그레이션된 contextId는 영구 기록. 워크스페이스 삭제 후에도 marker 유지 → 재 마이그레이션 방지.
type MigrationState = {
  // ISO 8601 마지막 갱신 시각
  updatedAt: string
  // 한 번이라도 마이그레이션 처리된 contextId 목록
  migratedContextIds: string[]
}

function getMigrationStatePath(): string {
  return path.join(getDirs().root, 'migration_state.json')
}

async function loadMigrationState(): Promise<MigrationState> {
  const p = getMigrationStatePath()
  try {
    const raw = await fs.readFile(p, 'utf8')
    const parsed = JSON.parse(raw) as MigrationState
    if (!Array.isArray(parsed.migratedContextIds)) {
      return { updatedAt: new Date().toISOString(), migratedContextIds: [] }
    }
    return parsed
  } catch {
    return { updatedAt: new Date().toISOString(), migratedContextIds: [] }
  }
}

async function saveMigrationState(state: MigrationState): Promise<void> {
  const p = getMigrationStatePath()
  const tmp = makeAtomicTmpPath(p)
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
  await fs.rename(tmp, p)
}

export async function migrateThreadsToWorkspaces(threadsDir: string): Promise<MigrationResult> {
  const result: MigrationResult = {
    scanned: 0,
    migrated: 0,
    skipped: 0,
    recovered: 0,
    alreadyMigrated: 0,
    errors: []
  }

  let entries: string[]
  try {
    entries = await fs.readdir(threadsDir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return result // threads/ 자체가 없음 — 마이그레이션할 것 없음
    throw err
  }

  // 이미 한 번이라도 마이그레이션된 contextId 목록 — 사용자가 워크스페이스 삭제 후 재출현 방지
  const migrationState = await loadMigrationState()
  const alreadyMigrated = new Set(migrationState.migratedContextIds)

  // contextId 추출 — `<id>.json` 메타 파일 기준
  const contextIds: string[] = []
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    if (name.endsWith('.ir.json')) continue
    if (name.includes('.tmp')) continue
    contextIds.push(name.slice(0, -'.json'.length))
  }
  result.scanned = contextIds.length

  // 새로 처리한 contextId 누적 — 끝에 marker에 일괄 추가
  const newlyMigrated: string[] = []

  for (const contextId of contextIds) {
    try {
      // L3 fix — 한 번 마이그레이션된 contextId는 *워크스페이스가 없어도* 재 처리 안 함
      // (= 사용자가 의도적으로 삭제한 워크스페이스가 부팅 시 다시 부활하는 것을 방지)
      if (alreadyMigrated.has(contextId)) {
        result.alreadyMigrated++
        continue
      }

      const wp = getWorkspacePaths(contextId)
      // 이미 마이그레이션된 경우 skip — 동시에 marker에도 추가 (legacy 사용자 케이스)
      try {
        await fs.access(wp.meta)
        result.skipped++
        // legacy 케이스 — 워크스페이스 있고 marker 없으면 marker 갱신 (이후 사용자 삭제 시 재 마이그레이션 방지)
        newlyMigrated.push(contextId)
        continue
      } catch {
        // 없음 — 진행
      }

      const threadMetaPath = path.join(threadsDir, `${contextId}.json`)
      const threadMetaRaw = await fs.readFile(threadMetaPath, 'utf8')
      const parsed = parseLegacyMetaSafe(threadMetaRaw)
      if (!parsed.meta) {
        throw new Error('legacy thread meta parse failed (recovery 시도 실패)')
      }
      const legacy = parsed.meta
      if (parsed.recovered) {
        result.recovered++
      }

      // 기존 sessions 맵에서 모델별 SessionMeta 생성. activeModel은 primarySessionId로.
      const now = new Date().toISOString()
      const migratedSessions: SessionMeta[] = []
      let primarySessionId: string | null = null

      const modelsInOrder: CliKind[] = ['claude', 'codex', 'agy']
      // 'gemini' key는 legacy → 'agy' 슬롯에 우선 채워둠.
      if (legacy.sessions?.gemini && !legacy.sessions.agy) {
        legacy.sessions.agy = legacy.sessions.gemini
      }
      const activeModelNormalized = normalizeLegacyCliKind(legacy.activeModel)
      for (const model of modelsInOrder) {
        const modelSessionId = legacy.sessions?.[model]
        if (!modelSessionId) continue
        const sessionId = randomUUID()
        const session: SessionMeta = {
          sessionId,
          model,
          modelSessionId,
          createdAt: legacy.createdAt,
          closedAt: now // 마이그레이션 시점엔 모두 비활성으로 기록 — 사용자가 다시 열어야 활성
        }
        migratedSessions.push(session)
        if (model === activeModelNormalized) primarySessionId = sessionId
      }

      // activeModel이 sessions에 없는 경우 (예: legacy.sessions가 비어있는 경우 = M1 직후) → 빈 세션 추가
      if (migratedSessions.length === 0) {
        const sessionId = randomUUID()
        const fallbackSession: SessionMeta = {
          sessionId,
          model: activeModelNormalized,
          modelSessionId: null,
          createdAt: legacy.createdAt,
          closedAt: now
        }
        migratedSessions.push(fallbackSession)
        primarySessionId = sessionId
      }

      const workspace: WorkspaceMeta = {
        workspaceId: contextId,
        title: legacy.title,
        createdAt: legacy.createdAt,
        updatedAt: legacy.updatedAt,
        workspacePath: legacy.workspacePath,
        sessions: migratedSessions,
        primarySessionId,
        compactionInProgress: null
      }

      // 디렉토리 + 파일 생성/복사
      await fs.mkdir(wp.dir, { recursive: true })
      await fs.mkdir(wp.archiveDir, { recursive: true })
      await fs.mkdir(wp.sessionsDir, { recursive: true })
      await fs.mkdir(wp.settingsDir, { recursive: true })

      // ir.json 복사 (legacy <id>.ir.json → workspace ir.json)
      const legacyIrPath = path.join(threadsDir, `${contextId}.ir.json`)
      try {
        const irRaw = await fs.readFile(legacyIrPath, 'utf8')
        await fs.writeFile(wp.ir, irRaw, 'utf8')
      } catch {
        await fs.writeFile(wp.ir, '{}', 'utf8')
      }

      // turns.jsonl은 빈 파일로 시작 — O 청크에서 채움. legacy user.jsonl 채널은 폐기 —
      // 마이그레이션 시점에 복사하지 않음 (refine 입력 source는 replay.log + O 청크 turns).

      // 각 세션 디렉토리 + replay.log 복사 (primary session에만 legacy replay.log 복사)
      const legacyReplayPath = path.join(threadsDir, `${contextId}.replay.log`)
      let legacyReplayContent = ''
      try {
        legacyReplayContent = await fs.readFile(legacyReplayPath, 'utf8')
      } catch {
        // 없으면 빈 문자열
      }

      for (const session of migratedSessions) {
        const sp = getSessionPaths(contextId, session.sessionId)
        await fs.mkdir(sp.dir, { recursive: true })
        // primary session에만 legacy replay 복사 (M1/M2는 단일 active 가정이라 replay.log가 1개)
        const replayContent = session.sessionId === primarySessionId ? legacyReplayContent : ''
        await fs.writeFile(sp.replayLog, replayContent, 'utf8')
        await writeSessionMetaAtomic(contextId, session)
      }

      await writeWorkspaceMetaAtomic(workspace)
      result.migrated++
      newlyMigrated.push(contextId)
    } catch (err) {
      result.errors.push({ contextId, error: String(err) })
    }
  }

  // marker 갱신 — 새로 처리된 contextId를 누적 기록
  if (newlyMigrated.length > 0) {
    const merged = new Set([...migrationState.migratedContextIds, ...newlyMigrated])
    await saveMigrationState({
      updatedAt: new Date().toISOString(),
      migratedContextIds: Array.from(merged)
    })
  }

  return result
}
