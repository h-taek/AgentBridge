// IRModule — IR 스키마/직렬화/검증/compaction prompt 빌드/결과 파싱.
// architecture §3.1 / §8 / §15.6 — 순수 모듈(CLI/파일 I/O 호출 없음).
// IR 영속화는 workspaceStore가, refine spawn은 RefineDispatcher가, 둘을 묶는 절차는
// CompactionScheduler / IPC 핸들러가.

export { buildCompactionPrompt } from './prompt'
export type { CompactionPromptArgs } from './prompt'

export { parseRefineOutput, assembleIR } from './parse'
export type {
  ParseRefineResult,
  ParseRefineSuccess,
  ParseRefineFailure,
  ParsedIRBody
} from './parse'
