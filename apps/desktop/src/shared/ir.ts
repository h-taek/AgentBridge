// IR 스키마 + 검증은 @agentbridge/core 단일 소스. 데스크탑 앱은 re-export로만 사용한다.

export type {
  IrFileStatus,
  IrTestStatus,
  IrMeta,
  IrIntent,
  IrDecision,
  IrFile,
  IrCommand,
  IrTest,
  IrPending,
  IR,
} from '@agentbridge/core';
export { IR_CAP, validateIR } from '@agentbridge/core';
