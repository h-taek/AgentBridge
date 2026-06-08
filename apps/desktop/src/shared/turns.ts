// Turn 타입 + cap 상수는 @agentbridge/core 단일 소스. 데스크탑 앱은 re-export로만 사용한다.

export type { TurnToolCall, TurnRecord, TurnsAssistantDetail } from '@agentbridge/core';
export {
  TURN_CAP,
  TURNS_ASSISTANT_DETAIL_CAP,
  COMPACTION_TRIGGER,
  TURNS_ROTATE,
} from '@agentbridge/core';
