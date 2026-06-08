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

// 9종 잔재 청소(cleanupAgyArtifactsForCwd / rmIsolatedCwd 등)는 2026-06-01 코어
// (@agentbridge/core cliAdapter/agyResume)로 이동 — 양 호스트 공용. 데스크탑에는 PTY/probe 전용
// snapshot delta 함수와 resume 변종만 남김.

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

// 새 세션 spawn 후 conversation UUID 캡처는 core watchForNewConversationUuid(conversations/
// FS 스캔 + spawn 전 스냅샷)로 일원화 (V-17). 과거 데스크탑 전용
// watchForNewConversationUuidViaCache(last_conversations.json cwd-키 폴링)는 macOS
// /var↔/private/var 불일치로 캡처가 빗나가는 문제가 있어 제거.
// (readLastConversationForCwd는 cliQuotaTracker probe 경로에서 계속 사용하므로 유지.)
