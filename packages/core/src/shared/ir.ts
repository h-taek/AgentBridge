// IR (Intermediate Representation) — handoff context schema.
//
// 모든 필드는 *옵션 또는 빈 배열 허용*. refine LLM이 정보가 없는 영역을 빈 배열로 두는 것이 자연스럽고,
// 빈 IR도 유효하다.
//
// 두 영역 분리:
//   - 모델이 채우는 본문(intent / decisions / files / commands / tests / pending)
//   - AgentBridge가 채우는 메타(contextId / meta) — refine 후 이 영역은 항상 우리가 덮어씀.

import type { CliKind } from './cli';

export type IrFileStatus = 'modified' | 'created' | 'deleted' | 'read';
export type IrTestStatus = 'passed' | 'failed' | 'pending' | 'skipped';

export type IrMeta = {
  createdAt: string;
  updatedAt: string;
  lastModel: CliKind;
  workspacePath: string;
  gitBranch?: string;
  gitHead?: string;
};

export type IrIntent = {
  goal: string;
  role?: string;
  constraints?: string[];
};

export type IrDecision = {
  topic: string;
  choice: string;
  rationale?: string;
  ts?: string;
};

export type IrFile = {
  path: string;
  status: IrFileStatus;
  lastReadAt?: string;
  summary?: string;
};

export type IrCommand = {
  cmd: string;
  exitCode?: number;
  summary?: string;
  fullOutputRef?: string;
};

export type IrTest = {
  name: string;
  status: IrTestStatus;
  failureSummary?: string;
};

export type IrPending = {
  task: string;
  blockers?: string[];
  nextStep?: string;
};

export type IR = {
  contextId: string;
  meta: IrMeta;
  intent: IrIntent;
  decisions: IrDecision[];
  files: IrFile[];
  commands: IrCommand[];
  tests: IrTest[];
  pending: IrPending[];
};

// IR 섹션 cap — refine LLM이 누적 시 가장 오래된 항목부터 잘라낸다.
// hook 본문 ~1K 토큰 목표.
export const IR_CAP = {
  decisions: 5,
  files: 5,
  commands: 3,
  tests: 3,
  pending: 3,
} as const;

// ─── 사용자 편집본 검증 ─────────────────────────────────────────────────
// commit 거부 정책: 잘못된 키/타입 1건이라도 발견되면 first error 반환.
// parseRefineOutput과 별개:
//   - parseRefineOutput: LLM 출력 → IR (관대한 coerce, 누락 필드 default 채움)
//   - validateIR        : 사용자 편집본 검증 (구조 위반 거부)
// meta / contextId는 commit handler가 다시 채우므로 검증에서 관대하게 허용(누락 OK).

const FILE_STATUSES: readonly IrFileStatus[] = ['modified', 'created', 'deleted', 'read'];
const TEST_STATUSES: readonly IrTestStatus[] = ['passed', 'failed', 'pending', 'skipped'];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

export function validateIR(ir: unknown): { ok: true } | { ok: false; error: string } {
  if (!isPlainObject(ir)) return { ok: false, error: 'IR이 객체가 아니다' };

  // intent
  if (!isPlainObject(ir.intent)) return { ok: false, error: 'intent: 객체 필요' };
  if (typeof ir.intent.goal !== 'string') return { ok: false, error: 'intent.goal: 문자열 필요' };
  if (ir.intent.role !== undefined && typeof ir.intent.role !== 'string') {
    return { ok: false, error: 'intent.role: 문자열 또는 미설정' };
  }
  if (ir.intent.constraints !== undefined && !isStringArray(ir.intent.constraints)) {
    return { ok: false, error: 'intent.constraints: 문자열 배열 또는 미설정' };
  }

  // decisions
  if (!Array.isArray(ir.decisions)) return { ok: false, error: 'decisions: 배열 필요' };
  for (let i = 0; i < ir.decisions.length; i++) {
    const d = ir.decisions[i] as unknown;
    if (!isPlainObject(d)) return { ok: false, error: `decisions[${i}]: 객체 필요` };
    if (typeof d.topic !== 'string') return { ok: false, error: `decisions[${i}].topic: 문자열 필요` };
    if (typeof d.choice !== 'string') return { ok: false, error: `decisions[${i}].choice: 문자열 필요` };
  }

  // files
  if (!Array.isArray(ir.files)) return { ok: false, error: 'files: 배열 필요' };
  for (let i = 0; i < ir.files.length; i++) {
    const f = ir.files[i] as unknown;
    if (!isPlainObject(f)) return { ok: false, error: `files[${i}]: 객체 필요` };
    if (typeof f.path !== 'string') return { ok: false, error: `files[${i}].path: 문자열 필요` };
    if (typeof f.status !== 'string' || !FILE_STATUSES.includes(f.status as IrFileStatus)) {
      return { ok: false, error: `files[${i}].status: ${FILE_STATUSES.join('|')} 중 하나` };
    }
  }

  // commands
  if (!Array.isArray(ir.commands)) return { ok: false, error: 'commands: 배열 필요' };
  for (let i = 0; i < ir.commands.length; i++) {
    const c = ir.commands[i] as unknown;
    if (!isPlainObject(c)) return { ok: false, error: `commands[${i}]: 객체 필요` };
    if (typeof c.cmd !== 'string') return { ok: false, error: `commands[${i}].cmd: 문자열 필요` };
  }

  // tests
  if (!Array.isArray(ir.tests)) return { ok: false, error: 'tests: 배열 필요' };
  for (let i = 0; i < ir.tests.length; i++) {
    const t = ir.tests[i] as unknown;
    if (!isPlainObject(t)) return { ok: false, error: `tests[${i}]: 객체 필요` };
    if (typeof t.name !== 'string') return { ok: false, error: `tests[${i}].name: 문자열 필요` };
    if (typeof t.status !== 'string' || !TEST_STATUSES.includes(t.status as IrTestStatus)) {
      return { ok: false, error: `tests[${i}].status: ${TEST_STATUSES.join('|')} 중 하나` };
    }
  }

  // pending
  if (!Array.isArray(ir.pending)) return { ok: false, error: 'pending: 배열 필요' };
  for (let i = 0; i < ir.pending.length; i++) {
    const p = ir.pending[i] as unknown;
    if (!isPlainObject(p)) return { ok: false, error: `pending[${i}]: 객체 필요` };
    if (typeof p.task !== 'string') return { ok: false, error: `pending[${i}].task: 문자열 필요` };
    if (p.blockers !== undefined && !isStringArray(p.blockers)) {
      return { ok: false, error: `pending[${i}].blockers: 문자열 배열 또는 미설정` };
    }
  }

  return { ok: true };
}
