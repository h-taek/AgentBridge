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
  cwd?: string
  cols?: number
  rows?: number
  // claude는 우리 격리 settings.json을 `--settings <path>`로 가리켜 hook을 적용한다.
  // codex/gemini는 cwd 안 hook config를 자동 로드하므로 어댑터 측에서 별도 인자 불필요 —
  // HookInstaller가 sessions:create/open 시점에 cwd 파일을 작성해두면 spawn 시 그대로 적용.
  claudeSettingsPath?: string
}

export type SpawnInteractiveResult = CliSpawnInteractiveResult

// IPC 직렬화 불가한 콜백 묶음 — main 내부 호출(thread handler)에서만 채워진다.
// 공개 IPC `cli:spawn-interactive`는 hooks 없이 호출되고, threads:* handler가 thread context를 묶는다.
export type SpawnInteractiveHooks = {
  replayLogPath?: string
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

// IR refine 헤드리스 spawn — 메인 PTY와 별도 child_process. architecture §7.1/§7.2.
// stream-json 출력을 정규화해 assistant.text 누적 + usage 추출.
export type SpawnRefineRequest = {
  prompt: string
  cwd?: string
  abortSignal?: AbortSignal
  // optional 정밀 비용 추적용 — 미설정 시 60s.
  timeoutMs?: number
  // 모델 지정. agy는 CLI flag로 지정 불가 — 무시. codex는 `-c model=`, claude는 `--model`로 전달.
  // null/undefined면 각 CLI의 default 모델 사용.
  modelHint?: string | null
}

export type RefineUsage = {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}

export type SpawnRefineResult = {
  // 정규화된 assistant.text 누적 — refine 응답 본문.
  assistantText: string
  usage?: RefineUsage
  // 디버깅·진단용 raw JSONL 라인 (정상/비정상 모두).
  rawLines: string[]
  // child 자식 종료 코드.
  exitCode: number | null
  // child stderr (있으면 진단용).
  stderr: string
  durationMs: number
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
  // IR refine 헤드리스 spawn — 메인 PTY를 건드리지 않고 새 child_process로 stream-json 호출.
  // 결과로 누적 assistant.text + usage 반환.
  spawnRefineIR(req: SpawnRefineRequest): Promise<SpawnRefineResult>
  // 빈 세션 판정 — 각 CLI는 *사용자 메시지가 도착해야 native 세션 파일을 디스크에 만든다*.
  // 그 사실을 직접 확인해 빈 세션을 판별. AgentBridge가 자체적으로 입력 추적할 필요 없이
  // 진실의 원천(disk) 그대로 위임. 호출 시점은 sessions:close 직후 PTY kill 끝난 뒤.
  //   - claude: ~/.claude/projects/<cwd-encoded>/<modelSessionId>.jsonl 존재 확인
  //   - codex:  modelSessionId === null이면 native session 미생성 (codex thread_id 캡처는
  //             첫 사용자 메시지가 도착해야 발생)
  //   - agy:    ~/.gemini/antigravity-cli/conversations/<UUID>.pb 존재 확인
  hasNativeSession(modelSessionId: string | null, cwd?: string): Promise<boolean>
  // CLI native 세션 파일을 디스크에서 hard delete. AgentBridge에서 세션을 삭제했는데 외부
  // CLI(예: `claude --resume`, `codex resume`, `gemini --resume`)에서 그 세션이 보이면
  // 정책 (1) "외부 agent 노출 차단" 위반. 따라서 우리 sessions/<sid>/ 삭제와 동시에 각
  // 어댑터의 native 파일도 삭제한다. 우리가 spawn한 modelSessionId만 대상이라 사용자가
  // 따로 만든 다른 세션은 영향 없음. 파일 없으면 no-op (best-effort).
  deleteNativeSession(modelSessionId: string | null, cwd?: string): Promise<void>
}
