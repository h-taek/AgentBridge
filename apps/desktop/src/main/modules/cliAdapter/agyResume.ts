import { promises as fs } from 'fs'
import * as path from 'path'
import * as os from 'os'
import log from 'electron-log/main'

// Agy(Antigravity) resume 모듈.
//
// agy CLI는 ~/.gemini/ base directory를 그대로 공유하지만 CLI 전용 서브디렉토리
// (`~/.gemini/antigravity-cli/`)에 자체 conversation storage를 둔다.
//   - conversations: `~/.gemini/antigravity-cli/conversations/<UUID>.pb` (protobuf)
//   - cwd→UUID 매핑: `~/.gemini/antigravity-cli/cache/last_conversations.json`
//
// resume 메커니즘은 gemini와 다르다:
//   - gemini: `--resume <UUID>` 직접 통제
//   - agy:    `--conversation <UUID>`로 특정 ID resume, 또는 `-c`/`--continue`로 cwd 최신 resume
//
// 또한 새 세션 spawn 시 `--session-id <UUID>`로 *사전 통제 불가* — agy가 자체 UUID 생성.
// AgentBridge는 spawn 후 last_conversations.json을 watch해 cwd에 매핑된 UUID를 후처리 캡처한다.

const AGY_BASE_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli')

function getConversationsDir(): string {
  return path.join(AGY_BASE_DIR, 'conversations')
}

// implicit/ — agy가 last_conversations.json 매핑 없이도 spawn 시점에 자동으로 만드는
// 익명 conversation 파일들. 메시지 한 번도 안 보낸 probe 스폰도 여기 .pb 1개씩 떨궈서
// snapshot diff로 제거해야 한다 (라이브 검증 2026-05-21).
function getImplicitDir(): string {
  return path.join(AGY_BASE_DIR, 'implicit')
}

function getLogDir(): string {
  return path.join(AGY_BASE_DIR, 'log')
}

function getLastConversationsCachePath(): string {
  return path.join(AGY_BASE_DIR, 'cache', 'last_conversations.json')
}

function getConversationFilePath(uuid: string): string {
  return path.join(getConversationsDir(), `${uuid}.pb`)
}

// 스냅샷 — implicit/ 안 .pb 파일 절대경로 set. probe 시작 전 호출 후, probe 종료 시
// deleteAgyImplicitDelta(before)로 신규 항목 일괄 unlink.
export async function snapshotAgyImplicit(): Promise<Set<string>> {
  const out = new Set<string>()
  try {
    const entries = await fs.readdir(getImplicitDir())
    for (const e of entries) {
      if (e.endsWith('.pb')) out.add(path.join(getImplicitDir(), e))
    }
  } catch {
    /* dir 없으면 빈 set */
  }
  return out
}

// 스냅샷 이후 새로 생긴 implicit/ .pb를 모두 삭제. 같이 떨어진 cli-*.log도 진단용이라
// 같은 시간대 진행 중인 사용자 세션과 겹치지 않게 *스냅샷에 없던 파일만* 삭제 정책.
export async function deleteAgyImplicitDelta(before: Set<string>): Promise<void> {
  let entries: string[] = []
  try {
    entries = await fs.readdir(getImplicitDir())
  } catch {
    return
  }
  for (const e of entries) {
    if (!e.endsWith('.pb')) continue
    const abs = path.join(getImplicitDir(), e)
    if (before.has(abs)) continue
    try {
      await fs.unlink(abs)
      log.info('agy implicit .pb 삭제 (probe delta)', { file: abs })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        log.warn('agy implicit .pb 삭제 실패', { file: abs, err: String(err) })
      }
    }
  }
}

// 스냅샷 시점 이후 새로 생긴 cli-*.log 파일 삭제. probe가 새 spawn마다 1개씩 떨궈
// 누적되므로 cleanup 시 정리.
export async function snapshotAgyLogs(): Promise<Set<string>> {
  const out = new Set<string>()
  try {
    const entries = await fs.readdir(getLogDir())
    for (const e of entries) {
      if (e.startsWith('cli-') && e.endsWith('.log')) out.add(path.join(getLogDir(), e))
    }
  } catch {
    /* noop */
  }
  return out
}

export async function deleteAgyLogDelta(before: Set<string>): Promise<void> {
  let entries: string[] = []
  try {
    entries = await fs.readdir(getLogDir())
  } catch {
    return
  }
  for (const e of entries) {
    if (!e.startsWith('cli-') || !e.endsWith('.log')) continue
    const abs = path.join(getLogDir(), e)
    if (before.has(abs)) continue
    try {
      await fs.unlink(abs)
      log.info('agy cli log 삭제 (probe delta)', { file: abs })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        log.warn('agy cli log 삭제 실패', { file: abs, err: String(err) })
      }
    }
  }
}

// cwd → UUID 매핑 캐시 읽기. 형태: { "<cwd-absolute-path>": "<UUID>" }
export async function readLastConversationForCwd(cwd: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(getLastConversationsCachePath(), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, string>
    const uuid = parsed[cwd]
    if (typeof uuid === 'string' && uuid.length > 0) return uuid
    return null
  } catch {
    return null
  }
}

// 디스크에 agy native conversation 파일(.pb)이 존재하는지 + 비어있지 않은지.
// agy가 spawn 직후 빈 conversation을 영속화하는지는 확실치 않음 — 보수적으로 파일 존재 + size > 0
// 두 조건 모두 통과해야 "활동 있는 세션"으로 본다.
export async function hasAgyConversationFile(modelSessionId: string): Promise<boolean> {
  try {
    const stat = await fs.stat(getConversationFilePath(modelSessionId))
    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}

// 우리 sessionId(UUID)와 매칭되는 conversation .pb 파일 unlink.
// 외부 agent가 같은 sessionId를 resume하지 못하게 한다.
export async function deleteAgyConversationFiles(modelSessionId: string): Promise<void> {
  const file = getConversationFilePath(modelSessionId)
  try {
    await fs.unlink(file)
    log.info('agy native conversation 삭제', { file })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      log.warn('agy native conversation 삭제 실패', { file, err: String(err) })
    }
  }
}

// === 9종 청소 추가 함수 (2026-05-31 실측 기반) ===
// agy spawn은 cwd → 9곳에 흔적을 남김. 기존 conversation/.pb (3), implicit (5), log (6)에 더해
// 아래 5종 추가.

function getBrainDir(): string {
  return path.join(AGY_BASE_DIR, 'brain')
}

function getGeminiHomeDir(): string {
  return path.join(os.homedir(), '.gemini')
}

// (2) last_conversations.json의 cwd 키 제거. atomic rewrite로 진행.
export async function removeLastConversationsEntry(cwd: string): Promise<string | null> {
  const cachePath = getLastConversationsCachePath()
  let parsed: Record<string, string>
  try {
    const raw = await fs.readFile(cachePath, 'utf8')
    parsed = JSON.parse(raw) as Record<string, string>
  } catch {
    return null
  }
  const uuid = parsed[cwd]
  if (!uuid) return null
  delete parsed[cwd]
  const tmp = `${cachePath}.${process.pid}.${Date.now()}.tmp`
  try {
    await fs.writeFile(tmp, JSON.stringify(parsed, null, 2), 'utf8')
    await fs.rename(tmp, cachePath)
    log.info('agy last_conversations.json 엔트리 제거', { cwd, uuid })
  } catch (err) {
    log.warn('agy last_conversations.json rewrite 실패', { cwd, err: String(err) })
    await fs.unlink(tmp).catch(() => undefined)
  }
  return uuid
}

// (4) brain/<UUID>/ 폴더 전체 삭제. antigravity 데스크탑 사이드바가 brain transcript를 참조.
export async function deleteAgyBrainFolder(uuid: string): Promise<void> {
  const dir = path.join(getBrainDir(), uuid)
  try {
    await fs.rm(dir, { recursive: true, force: true })
    log.info('agy brain 폴더 삭제', { dir })
  } catch (err) {
    log.warn('agy brain 폴더 삭제 실패', { dir, err: String(err) })
  }
}

// (7) ~/.gemini/config/projects/<UUID>.json 삭제. antigravity 데스크탑 Projects 사이드바의 진짜 출처.
export async function deleteGeminiConfigProjectFile(uuid: string): Promise<void> {
  const file = path.join(getGeminiHomeDir(), 'config', 'projects', `${uuid}.json`)
  try {
    await fs.unlink(file)
    log.info('agy config/projects/<UUID>.json 삭제', { file })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      log.warn('agy config/projects/<UUID>.json 삭제 실패', { file, err: String(err) })
    }
  }
}

// (8) ~/.gemini/history/<cwd-basename>/ 폴더 삭제. agy가 cwd마다 history 폴더를 만듦.
//      cwd가 격리 tmpdir이라 basename이 그대로 폴더명 (`agentbridge-refine-<ts>-<pid>` 등).
export async function deleteGeminiHistoryFolderForCwd(cwd: string): Promise<void> {
  const base = path.basename(cwd)
  // 안전 가드: agentbridge-refine-* 또는 agentbridge-quota-probe-* 패턴만 정리.
  if (!base.startsWith('agentbridge-refine-') && !base.startsWith('agentbridge-quota-probe-')) {
    return
  }
  const dir = path.join(getGeminiHomeDir(), 'history', base)
  try {
    await fs.rm(dir, { recursive: true, force: true })
    log.info('agy history 폴더 삭제', { dir })
  } catch (err) {
    log.warn('agy history 폴더 삭제 실패', { dir, err: String(err) })
  }
}

// (9) antigravity-cli/settings.json의 .trustedWorkspaces[] 배열에서 cwd 항목 제거.
//      agy가 spawn 시 cwd를 trust 목록에 자동 등록. atomic rewrite.
export async function removeTrustedWorkspaceEntry(cwd: string): Promise<void> {
  const settingsPath = path.join(AGY_BASE_DIR, 'settings.json')
  let parsed: { trustedWorkspaces?: string[]; [k: string]: unknown }
  try {
    const raw = await fs.readFile(settingsPath, 'utf8')
    parsed = JSON.parse(raw) as { trustedWorkspaces?: string[] }
  } catch {
    return
  }
  if (!Array.isArray(parsed.trustedWorkspaces)) return
  const before = parsed.trustedWorkspaces.length
  parsed.trustedWorkspaces = parsed.trustedWorkspaces.filter((w) => w !== cwd)
  if (parsed.trustedWorkspaces.length === before) return
  const tmp = `${settingsPath}.${process.pid}.${Date.now()}.tmp`
  try {
    await fs.writeFile(tmp, JSON.stringify(parsed, null, 2), 'utf8')
    await fs.rename(tmp, settingsPath)
    log.info('agy settings.json trustedWorkspaces 엔트리 제거', { cwd })
  } catch (err) {
    log.warn('agy settings.json rewrite 실패', { cwd, err: String(err) })
    await fs.unlink(tmp).catch(() => undefined)
  }
}

// (5) implicit/<UUID>.pb 직접 unlink. UUID가 있으면 snapshot delta 없이도 매칭.
export async function deleteAgyImplicitFile(uuid: string): Promise<void> {
  const file = path.join(getImplicitDir(), `${uuid}.pb`)
  try {
    await fs.unlink(file)
    log.info('agy implicit/<UUID>.pb 삭제', { file })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      log.warn('agy implicit/<UUID>.pb 삭제 실패', { file, err: String(err) })
    }
  }
}

// 통합 헬퍼 — refine 격리 cwd 끝난 직후 9곳 중 8곳을 한 번에 청소 (tmpdir 자체 rm은 호출자).
// UUID 기반이라 spawn 전 snapshot 불필요. log/cli-*.log는 보수적으로 건드리지 않음 (진단 가치).
export async function cleanupAgyArtifactsForCwd(cwd: string): Promise<void> {
  // (2) cache 엔트리 제거하면서 UUID 회수
  const uuid = await removeLastConversationsEntry(cwd)
  if (uuid) {
    // (3) conversations/.pb
    await deleteAgyConversationFiles(uuid)
    // (4) brain/<UUID>/
    await deleteAgyBrainFolder(uuid)
    // (5) implicit/<UUID>.pb
    await deleteAgyImplicitFile(uuid)
    // (7) config/projects/<UUID>.json
    await deleteGeminiConfigProjectFile(uuid)
  }
  // (8) history/<basename>/
  await deleteGeminiHistoryFolderForCwd(cwd)
  // (9) settings.json trustedWorkspaces[]
  await removeTrustedWorkspaceEntry(cwd)
}

// tmpdir 자체 삭제 — 호출자가 lifecycle 알 때 사용.
export async function rmIsolatedCwd(cwd: string): Promise<void> {
  try {
    await fs.rm(cwd, { recursive: true, force: true })
    log.info('agy isolated tmpdir 삭제', { cwd })
  } catch (err) {
    log.warn('agy isolated tmpdir 삭제 실패', { cwd, err: String(err) })
  }
}

export type ResumeResolveOptions = {
  // 우리가 캡처해둔 modelSessionId(full UUID). 없으면 fallback으로 `--continue` 사용.
  sessionId: string | null
}

// resume args 결정. UUID 있고 .pb 파일 존재하면 `--conversation <UUID>`. 없으면 친절한 에러.
// agy가 모호한 UUID를 받으면 새 conversation을 만들어버리는 동작이 있어, 사전 디스크 확인이 더 안전.
export async function resolveResumeArgs(opts: ResumeResolveOptions): Promise<string[]> {
  if (!opts.sessionId) {
    throw new Error(
      'agy resume — modelSessionId가 비어있습니다. 이 thread를 삭제하고 새 워크스페이스를 만드세요.'
    )
  }
  const exists = await hasAgyConversationFile(opts.sessionId)
  if (!exists) {
    throw new Error(
      `agy conversation ${opts.sessionId}을(를) ${getConversationsDir()}에서 찾을 수 없습니다 — 메시지 교환 전 닫힌 빈 세션은 agy가 영속화하지 않습니다. 이 thread를 삭제하고 새로 만드세요.`
    )
  }
  log.info('agy resume — UUID 직접 전달', { uuid: opts.sessionId })
  return ['--conversation', opts.sessionId]
}

// 새 세션 spawn 후 cwd→UUID 매핑이 last_conversations.json에 나타날 때까지 대기.
// agy는 첫 사용자 메시지가 도착해야 UUID를 생성·영속화한다(추정). 따라서 spawn 직후엔 매핑이
// 없을 수 있어 polling으로 캡처.
//
// 이름에 "ViaCache"가 들어간 이유 — 코어 cliAdapter/agyResume의 동명 함수는 conversations/
// 디렉토리 FS 스냅샷 diff로 새 UUID를 감지함. 이 데스크탑 변종은 agy가 별도 관리하는
// last_conversations.json 캐시 파일을 폴링. 같은 목적, 다른 메커니즘 — 통합 가능성은 있지만
// 우선 이름으로 의도를 명시.
//
// 호출자는 spawn 후 fire-and-forget으로 호출하고, 캡처되면 onCaptured 콜백으로 modelSessionId
// 전달. 워크스페이스 메타에 영속화는 호출자 책임.
export async function watchForNewConversationUuidViaCache(opts: {
  cwd: string
  // 이미 알려진 UUID 목록 — polling 결과가 이 set 안에 있으면 무시(새 UUID만 캡처).
  excludeUuids: Set<string>
  // 최대 대기 시간. 미설정 시 5분.
  timeoutMs?: number
  // 캡처 성공 시 1회 호출.
  onCaptured: (uuid: string) => void
  // 외부 abort 시 polling 중지.
  abortSignal?: AbortSignal
}): Promise<void> {
  const start = Date.now()
  const limit = opts.timeoutMs ?? 5 * 60_000
  const interval = 1_000
  while (!opts.abortSignal?.aborted) {
    const elapsed = Date.now() - start
    if (elapsed > limit) {
      log.warn('agy modelSessionId 캡처 timeout', { cwd: opts.cwd, elapsed })
      return
    }
    const uuid = await readLastConversationForCwd(opts.cwd)
    if (uuid && !opts.excludeUuids.has(uuid)) {
      log.info('agy modelSessionId 캡처 완료', { cwd: opts.cwd, uuid })
      opts.onCaptured(uuid)
      return
    }
    await new Promise<void>((r) => setTimeout(r, interval))
  }
}
