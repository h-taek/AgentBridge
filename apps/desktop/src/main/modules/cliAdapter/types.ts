import type { WebContents } from 'electron'
import type { CliKind, CliSpawnInteractiveResult } from '@shared/ipc'

// CLIAdapter 추상 — Claude/Codex/Agy(Antigravity) 세 어댑터가 동일 인터페이스를 노출한다.
// 메인 채팅은 spawnInteractive(PTY) 단일 모드이고, IR refine spawn(헤드리스 stream-json)은 M2에서 추가.
//
// 설계 원칙:
// - 어댑터는 모델별 args/모델 native session ID 통제/IR 주입만 책임진다.
// - 실제 PTY spawn/lifecycle은 ptySession에 위임 — PTY sessionId는 ptySession이 자체 발급한다.
// - 두 식별자 분리(PTY sessionId ≠ 모델 native session ID)로 같은 모델 UUID로 빠른 재spawn 시 race 회피.

export type SpawnInteractiveRequest = {
  // null  = 새 세션 (어댑터가 모델 UUID를 발급해 --session-id로 통제 후 modelSessionId로 반환)
  // 값    = 이어가기 (--resume <id>). Codex는 thread_id 캡처 휴리스틱.
  sessionId: string | null
  // 2026-06-01 Phase 5: 코어 createCliAdapters로 spawn options 위임 — workspaceId 필수.
  workspaceId: string
  // codex/agy resume 시 native modelSessionId가 있어야 thread_id/conversation 인자 생성 가능.
  modelSessionId?: string
  // 우리 세션 dir id. spawn env AGENTBRIDGE_WS_SESSION으로 주입돼 훅이 captured-<token>.json
  // 키잉에 쓴다(같은 워크스페이스 동종 N세션 구분).
  captureToken?: string
  cwd?: string
  cols?: number
  rows?: number
}

export type SpawnInteractiveResult = CliSpawnInteractiveResult

// IPC 직렬화 불가한 콜백 묶음 — main 내부 호출(thread handler)에서만 채워진다.
// 공개 IPC `cli:spawn-interactive`는 hooks 없이 호출되고, threads:* handler가 thread context를 묶는다.
export type SpawnInteractiveHooks = {
  replayLogPath?: string
  // 세션 디렉토리 절대 경로 — ptySession이 owner.json 수명주기에 사용 (Plan 2). 어댑터는 그대로 전달.
  ownerDir?: string
  onData?: (data: string) => void
  // ptySessionId가 info에 포함됨 — handoff:commit이 같은 contextId에 새 PTY를 등록한 후 직전
  // PTY의 onExit 도착 race를 회피하려면 호출자가 *active 매핑이 자기 ptySessionId일 때만 clear*
  // 해야 한다(threadActive.clearActiveIfMatches).
  onExit?: (info: { exitCode: number | null; signal: number | null; ptySessionId: string }) => void
  // Codex처럼 modelSessionId가 spawn 후 비동기 캡처되는 어댑터 전용. 캡처 성공 시 1회 호출.
  // 실패(timeout/abort)는 콜백 없이 어댑터 내부 로그로만 기록 — 사용자는 다음 resume이 안 되는
  // 거동으로 인지(에러 throw하지 않음 — spawn 자체는 성공한 상태).
  onModelSessionIdCaptured?: (modelSessionId: string) => void
}

// 채팅 입력 송신을 *순차 step*으로 표현. 단일 write로 끝나는 모델(claude/codex)은 length 1 배열,
// gemini처럼 fast-paste detection 회피를 위해 text와 submit 키를 시간 분리해야 하는 모델은 length 2.
export type ChatSubmitStep = {
  // PTY stdin으로 write할 raw bytes.
  write: string
  // 다음 step 전 지연(ms). 마지막 step의 delayMs는 무시.
  delayMs?: number
}

export type CLIAdapter = {
  kind: CliKind
  // 채팅 입력창에서 PTY stdin으로 메시지 보낼 때 어댑터별 송신 시퀀스 직렬화.
  // 모델별 TUI 입력 박스의 submit 인식이 다르다:
  //   - claude: text + '\r' 한 번 (Ink/React 기반)
  //   - codex: bracketed paste(\x1b[200~text\x1b[201~) + '\r' 한 번 (Rust TUI는 paste 종료 후 \r을 submit으로 처리)
  //   - agy: text → 80ms 지연 → '\r' 두 번 분리 (구 gemini readline fast-paste detection 동일 — 인터페이스
  //     리브랜드 이후에도 readline 패턴이 동일하다고 가정. 라이브 검증 시 동작 변경 가능성 있음.)
  // xterm.js 직접 입력은 별도 경로(pty:write)이므로 영향 없음.
  formatChatSubmit(text: string): ChatSubmitStep[]
  spawnInteractive(
    req: SpawnInteractiveRequest,
    sender: WebContents,
    hooks?: SpawnInteractiveHooks
  ): Promise<SpawnInteractiveResult>
  write(sessionId: string, data: string): void
  resize(sessionId: string, cols: number, rows: number): void
  killInteractive(sessionId: string): void
  // CLI native 세션 파일을 디스크에서 hard delete. AgentBridge에서 세션을 삭제했는데 외부
  // CLI(예: `claude --resume`, `codex resume`, `gemini --resume`)에서 그 세션이 보이면
  // 정책 (1) "외부 agent 노출 차단" 위반. 따라서 우리 sessions/<sid>/ 삭제와 동시에 각
  // 어댑터의 native 파일도 삭제한다. 우리가 spawn한 modelSessionId만 대상이라 사용자가
  // 따로 만든 다른 세션은 영향 없음. 파일 없으면 no-op (best-effort).
  deleteNativeSession(modelSessionId: string | null, cwd?: string): Promise<void>
}
