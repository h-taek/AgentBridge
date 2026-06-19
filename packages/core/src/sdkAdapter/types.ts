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
  | { t: 'turn_end'; reason: string }
  | { t: 'error'; message: string };

export interface StartOptions {
  cwd: string;
  workspaceId: string;
  detail?: TurnsAssistantDetail;
  context?: string; // IR/handoff를 systemPrompt로 주입 (후속 증분)
  // 턴 완료 시 호출 — seam(CaptureSession 대체)이 appendTurn으로 영속. Promise면 어댑터가 대기.
  onTurn?: (turn: TurnRecord) => void | Promise<void>;
}

export interface Session {
  readonly sessionId: string;
  send(text: string): AsyncIterable<ChatEvent>;
}

export interface AgentAdapter {
  readonly id: CliKind;
  start(opts: StartOptions): Promise<Session>;
}
