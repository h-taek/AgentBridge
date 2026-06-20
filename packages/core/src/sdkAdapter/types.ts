// 공통 어댑터 정규화 모델. 전체 설계 = docs/sdk/02_adapter_interface.md.
// v1: start/send + onTurn(TurnRecord)만. onApproval·interrupt·listCommands/runCommand는 후속 증분.
import type { CliKind } from '../shared/cli.js';
import type { TurnRecord, TurnsAssistantDetail } from '../shared/turns.js';

// GUI 셸이 렌더하는 정규화 이벤트. 모든 에이전트가 이 union으로 매핑된다.
export type ChatEvent =
  | { t: 'session'; sessionId: string; model?: string }
  | { t: 'text'; text: string; final: boolean } // 어시스턴트 본문(델타 or 완결)
  | { t: 'thinking'; text: string }
  | { t: 'tool'; id: string; name: string; input: unknown; status: 'started' | 'done'; output?: unknown }
  | { t: 'usage'; inputTokens: number; outputTokens: number }
  // 슬래시 명령 목록(6-4) — claude init의 slash_commands. 패널 / 버튼 팝업 채움. codex는 미제공(빈 목록).
  | { t: 'commands'; commands: string[] }
  // 승인 요청(5단계) — 호스트가 UI로 띄우고 respondApproval(id, approve)로 응답할 때까지 턴이 멈춘다.
  | { t: 'approval'; id: string; title: string; detail: string; tool: string }
  // 미로그인 감지(로그인) — 호스트가 로그인 화면을 띄운다. loggedIn:false면 인증 필요.
  | { t: 'auth'; loggedIn: boolean }
  | { t: 'turn_end'; reason: string }
  | { t: 'error'; message: string };

// 로그인 챌린지 — OAuth URL 2종. automatic=SDK 로컬 콜백서버가 자동 완료 / manual=코드 복붙 폴백.
export interface LoginChallenge {
  automaticUrl: string;
  manualUrl: string;
}

// 권한 모드(6-2) — 에이전트별로 모드 세트가 다르다(라벨/개수). 각 어댑터가 자기 id만 처리.
//   claude(4): default(Ask before edits) · acceptEdits(Edit automatically) · plan(Plan mode) · auto(Auto mode, 모델 분류기)
//   codex(3) : default(Default permissions) · autoReview(Auto-review) · fullAccess(Full access)
// claude=네이티브 PermissionMode로 매핑(setPermissionMode) / codex=approvalPolicy+sandboxPolicy로 매핑(turn/start 오버라이드).
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'autoReview' | 'fullAccess';

// 모델 선택(6-3) — 에이전트(회사) 내부 모델 전환용. id=API 모델값, label=표시명.
export interface ModelOption {
  id: string;
  label: string;
  desc?: string; // 모델 설명(버전·컨텍스트·용도). 메뉴에서 이름 아래 보조 줄로 표시.
  current?: boolean;
  efforts?: string[]; // 이 모델이 지원하는 effort 레벨(슬라이더 정지점). claude는 끝에 'ultra'(ultracode) 포함 가능.
}

// 계정·사용량(설정 1차) — Account & Usage 화면.
//   claude = accountInfo() + usage_EXPERIMENTAL_…() / codex = account/read + account/rateLimits/read.
export interface UsageLimit {
  label: string;            // 'Session (5hr)' · 'Weekly (7 day)' · 'Weekly Sonnet' …
  percent: number;          // 0–100
  resetsAt: string | null;  // ISO 시각 / null=해당 없음
}
// "What's contributing to your limits usage?" — claude 실험 API의 behaviors(day/week). 미지원 에이전트는 생략.
export interface UsageContributors {
  behaviors: Array<{ key: string; pct: number }>;   // subagent_heavy · cron · long_context …
  agents: Array<{ name: string; pct: number }>;
  skills: Array<{ name: string; pct: number }>;
  plugins: Array<{ name: string; pct: number }>;
  mcpServers: Array<{ name: string; pct: number }>;
}
export interface AccountUsage {
  account: { authMethod?: string; email?: string; organization?: string; plan?: string };
  limits: UsageLimit[];
  contributors?: { day: UsageContributors; week: UsageContributors }; // claude만(실험). 없으면 표/토글 숨김.
}

export interface StartOptions {
  cwd: string;
  workspaceId: string;
  detail?: TurnsAssistantDetail;
  context?: string; // IR/handoff를 systemPrompt로 주입 (후속 증분)
  resume?: string; // 기존 세션 이어가기 (resume sessionId) — 미지정 시 새 세션
  // 턴 완료 시 호출 — seam(CaptureSession 대체)이 appendTurn으로 영속. Promise면 어댑터가 대기.
  onTurn?: (turn: TurnRecord) => void | Promise<void>;
}

export interface Session {
  readonly sessionId: string;
  // 한 턴을 보내고 그 턴의 ChatEvent 스트림을 받는다(델타→완결). 내부는 지속 세션이라 맥락 유지.
  // 턴은 직렬: 이전 턴이 끝나야 다음 send가 시작된다.
  send(text: string): AsyncIterable<ChatEvent>;
  interrupt(): Promise<void>; // 진행 중 턴 중단 (streaming-input 전용 — SDK Query.interrupt)
  // 권한 모드 전환(6-2). claude=즉시 적용(Query.setPermissionMode) / codex=다음 턴부터 적용(turn/start 오버라이드).
  setPermissionMode(mode: PermissionMode): Promise<void>;
  // 모델 선택(6-3). 에이전트 내부 모델 목록 + 전환. claude=Query.supportedModels/setModel / codex=model/list + turn/start 오버라이드.
  listModels(): Promise<ModelOption[]>;
  setModel(id: string): Promise<void>;
  // 추론 effort 조정. claude=/effort 슬래시 명령(세터 없음) / codex=turn/start.effort 오버라이드.
  setEffort(level: string): Promise<void>;
  // Thinking 토글(설정 1차). claude=setMaxThinkingTokens(on?기본예산:0) / codex=effort에 통합(no-op).
  setThinking(on: boolean): Promise<void>;
  // 계정·사용량 조회(설정 1차). claude=accountInfo()+usage_EXPERIMENTAL / codex=account/read(+rateLimits).
  getAccountUsage(): Promise<AccountUsage>;
  // 'approval' ChatEvent에 대한 응답 — 진행 중 턴이 이 호출까지 멈춰 있다.
  respondApproval(id: string, approve: boolean): void;
  // 로그인 여부 조회(미로그인=false) — 세션 시작 시 입력 차단/로그인 화면 판단용. claude=accountInfo / codex=account/read.
  checkAuth(): Promise<boolean>;
  // 로그인(미로그인 사용자) — claude=q.claudeAuthenticate / codex=account/login/start.
  startLogin(): Promise<LoginChallenge>;   // OAuth URL 발급(+ 로컬 콜백서버 기동)
  waitLogin(): Promise<boolean>;           // 자동 모드 완료 대기(콜백서버가 코드 수신→토큰 저장)
  submitLoginCode(code: string, state?: string): Promise<boolean>; // 수동 폴백(코드 복붙)
  end(): Promise<void>; // 입력 스트림을 닫아 세션 종료
}

export interface AgentAdapter {
  readonly id: CliKind;
  start(opts: StartOptions): Promise<Session>;
}
