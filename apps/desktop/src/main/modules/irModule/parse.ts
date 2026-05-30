// parseRefineOutput은 코어 그대로. assembleIR은 데스크탑 측에서 previousIR.meta의 gitBranch/gitHead를
// 그대로 보존하기 위해 코어의 gitInfo 파라미터로 매핑하는 facade.

import {
  assembleIR as coreAssembleIR,
  type CliKind,
  type IR,
  type ParsedIRBody,
} from '@agentbridge/core';

export { parseRefineOutput } from '@agentbridge/core';
export type { ParsedIRBody, ParseRefineResult } from '@agentbridge/core';

// 데스크탑 코드가 분리 노출하던 success/failure 변형 — 코어의 ParseRefineResult union을 두 갈래로 alias.
import type { ParseRefineResult } from '@agentbridge/core';
export type ParseRefineSuccess = Extract<ParseRefineResult, { ok: true }>;
export type ParseRefineFailure = Extract<ParseRefineResult, { ok: false }>;

export function assembleIR(args: {
  contextId: string;
  body: ParsedIRBody;
  fromModel: CliKind;
  workspacePath: string;
  previousIR: IR | null;
}): IR {
  // 원본 데스크탑 동작: previousIR.meta.gitBranch/gitHead를 그대로 보존 (git probe X).
  const gitInfo = args.previousIR?.meta
    ? { branch: args.previousIR.meta.gitBranch, head: args.previousIR.meta.gitHead }
    : undefined;
  return coreAssembleIR({ ...args, gitInfo });
}
