// 익스텐션 전용 타입은 @agentbridge/core에서 re-export.
export type {
  CliKind,
  IR,
  IrFileStatus,
  IrTestStatus,
  IrIntent,
  IrDecision,
  IrFile,
  IrCommand,
  IrTest,
  IrPending,
  TurnRecord,
  TurnToolCall,
} from '@agentbridge/core';
export {
  CLI_DISPLAY_NAME,
  IR_CAP,
  COMPACTION_TRIGGER,
  TURNS_ROTATE,
} from '@agentbridge/core';
