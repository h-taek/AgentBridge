// transcriptReader — 공통 타입. reader는 순수 함수: 증분 raw 단위 + carry → 완료 턴 + 새 carry.
import type { CliKind } from '../shared/cli';
import type { TurnRecord, TurnToolCall, TurnsAssistantDetail } from '../shared/turns';

// 한 세션을 식별하는 호스트 제공 컨텍스트. reader가 TurnRecord 필드를 채우는 데 사용.
export interface ReaderCtx {
  workspaceId: string;
  sessionId: string;
  detail: TurnsAssistantDetail;
  // 종료 훅이 "이 턴은 온전히 끝났다"고 알려온 tick인가 (0.5.0 A-2).
  // claude·codex는 transcript에 완료 태그가 있어 무시한다. agy는 태그가 없어 이 값이 유일한 근거다.
  turnClosed?: boolean;
}

// 아직 닫히지 않은(다음 user 미도착) 진행 중 턴. reader 간 공통 형태.
export interface OpenTurn {
  sourceKey: string;        // 결정적 turn id의 근거 (CLI별 고유키)
  user: string;
  startedAt: string;        // ISO; 없으면 ''
  lastAt: string;           // 관측된 마지막 활동 시각 ISO; completedAt 후보
  assistantParts: string[]; // text 블록 누적
  toolCalls: TurnToolCall[];
  // call_id → toolCalls 인덱스. tool 호출과 결과가 증분 읽기로 다른 consume에 걸려도 summary를
  // 매칭하도록 carry에 영속(로컬 Map은 호출마다 비워짐). finalizeTurn은 안 읽음(turns.jsonl 미노출).
  toolCallById?: Record<string, number>;
}

// reader가 다음 consume으로 넘기는 상태. turnIndex는 결정적 id용(append-only 가정).
export interface Carry {
  open: OpenTurn | null;
  turnIndex: number;
}

export const EMPTY_CARRY: Carry = { open: null, turnIndex: 0 };

export interface ConsumeResult {
  turns: TurnRecord[];
  carry: Carry;
  // 이 consume에서 "완료로 확정된 턴들"까지의 records 인덱스(= 미완 열린 턴의 첫 레코드 인덱스).
  // 열린 턴이 없으면 records.length. manager의 atomic-read가 이 위치까지만 cursor를 전진하고
  // 나머지(미완 꼬리)는 다음 tick에 다시 읽는다. carry.open이 들고 있는 턴이 곧 그 미완 꼬리.
  consumed: number;
}

export type { TurnRecord, TurnToolCall, CliKind };
