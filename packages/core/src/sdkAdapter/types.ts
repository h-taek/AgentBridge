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
  | { t: 'turn_end'; reason: string }
  | { t: 'error'; message: string };

// 권한 모드(6-2) — 에이전트별로 모드 세트가 다르다(라벨/개수). 각 어댑터가 자기 id만 처리.
//   claude(4): default(Ask before edits) · acceptEdits(Edit automatically) · plan(Plan mode) · auto(Auto mode, 모델 분류기)
//   codex(3) : default(Default permissions) · autoReview(Auto-review) · fullAccess(Full access)
// claude=네이티브 PermissionMode로 매핑(setPermissionMode) / codex=approvalPolicy+sandboxPolicy로 매핑(turn/start 오버라이드).
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'autoReview' | 'fullAccess';

// 모델 선택(6-3) — 에이전트(회사) 내부 모델 전환용. id=API 모델값, label=표시명.
export interface ModelOption {
  id: string;
  label: string;
  current?: boolean;
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
  // 'approval' ChatEvent에 대한 응답 — 진행 중 턴이 이 호출까지 멈춰 있다.
  respondApproval(id: string, approve: boolean): void;
  end(): Promise<void>; // 입력 스트림을 닫아 세션 종료
}

export interface AgentAdapter {
  readonly id: CliKind;
  start(opts: StartOptions): Promise<Session>;
}
