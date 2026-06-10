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

function getConversationFilePath(uuid: string): string {
  return path.join(getConversationsDir(), `${uuid}.pb`)
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

// 잔재 청소·probe snapshot 함수는 모두 제거됨 — agy/codex probe는 격리 박스에서만 실행하므로
// native 청소가 불필요하다(비격리 실행·청소는 claude 전용). 데스크탑에는 resume 변종만 남김.

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
