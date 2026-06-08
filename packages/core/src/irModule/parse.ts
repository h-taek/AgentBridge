// refine 응답 raw assistantText에서 IR JSON을 추출·검증.
//
// 단계:
// 1. assistantText에서 JSON 블록 추출 — 자연어 prefix/suffix 또는 ```json``` fence 모두 커버.
// 2. 파싱 + 스키마 강제 — 잘못된 타입은 default로 대체. 빈/부분 IR도 유효.
// 3. contextId/meta는 호출자가 채움 — parse는 본문 영역만 반환.
// 4. cap 5/5/3/3/3 적용 (가장 오래된 항목부터 잘라냄).

import type {
  CliKind,
} from '../shared/cli';
import type {
  IR,
  IrIntent,
  IrDecision,
  IrFile,
  IrFileStatus,
  IrCommand,
  IrTest,
  IrTestStatus,
  IrPending,
} from '../shared/ir';
import { IR_CAP } from '../shared/ir';

export type ParsedIRBody = Omit<IR, 'contextId' | 'meta'>;

export type ParseRefineResult =
  | { ok: true; body: ParsedIRBody; warnings: string[] }
  | { ok: false; error: string };

// ```json ... ``` 또는 ``` ... ``` fence 안의 본문을 추출. 없으면 원본 반환.
function stripCodeFence(s: string): string {
  const m = s.match(/```(?:json|javascript|js)?\s*\n?([\s\S]*?)\n?```/i);
  return m ? m[1].trim() : s.trim();
}

// 첫 번째 balanced { ... } JSON 객체를 추출. 문자열 안의 중괄호는 무시(따옴표 escape 처리).
function extractFirstBalancedObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) { escaped = false; }
      else if (ch === '\\') { escaped = true; }
      else if (ch === '"') { inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}

function asString(v: unknown, fb = ''): string {
  return typeof v === 'string' ? v : fb;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string');
  return out.length > 0 ? out : undefined;
}

const FILE_STATUSES: IrFileStatus[] = ['modified', 'created', 'deleted', 'read'];
const TEST_STATUSES: IrTestStatus[] = ['passed', 'failed', 'pending', 'skipped'];

function asEnum<T extends string>(v: unknown, allowed: T[], fb: T): T {
  return typeof v === 'string' && (allowed as string[]).includes(v) ? (v as T) : fb;
}

function tail<T>(arr: T[], cap: number): T[] {
  return arr.length <= cap ? arr : arr.slice(arr.length - cap);
}

function coerceIntent(v: unknown): IrIntent {
  if (!v || typeof v !== 'object') return { goal: '' };
  const o = v as Record<string, unknown>;
  const intent: IrIntent = { goal: asString(o.goal) };
  const role = asString(o.role, '');
  if (role) intent.role = role;
  const constraints = asStringArray(o.constraints);
  if (constraints) intent.constraints = constraints;
  return intent;
}

function coerceDecisions(v: unknown): IrDecision[] {
  return tail(
    asArray(v).flatMap((x): IrDecision[] => {
      if (!x || typeof x !== 'object') return [];
      const o = x as Record<string, unknown>;
      const topic = asString(o.topic).trim();
      const choice = asString(o.choice).trim();
      if (!topic && !choice) return [];
      const d: IrDecision = { topic, choice };
      const r = asString(o.rationale, '');
      if (r) d.rationale = r;
      const ts = asString(o.ts, '');
      if (ts) d.ts = ts;
      return [d];
    }),
    IR_CAP.decisions,
  );
}

function coerceFiles(v: unknown): IrFile[] {
  return tail(
    asArray(v).flatMap((x): IrFile[] => {
      if (!x || typeof x !== 'object') return [];
      const o = x as Record<string, unknown>;
      const p = asString(o.path).trim();
      if (!p) return [];
      const f: IrFile = { path: p, status: asEnum(o.status, FILE_STATUSES, 'read') };
      const s = asString(o.summary, '');
      if (s) f.summary = s;
      return [f];
    }),
    IR_CAP.files,
  );
}

function coerceCommands(v: unknown): IrCommand[] {
  return tail(
    asArray(v).flatMap((x): IrCommand[] => {
      if (!x || typeof x !== 'object') return [];
      const o = x as Record<string, unknown>;
      const cmd = asString(o.cmd).trim();
      if (!cmd) return [];
      const c: IrCommand = { cmd };
      const ec = asNumber(o.exitCode);
      if (ec !== undefined) c.exitCode = ec;
      const s = asString(o.summary, '');
      if (s) c.summary = s;
      return [c];
    }),
    IR_CAP.commands,
  );
}

function coerceTests(v: unknown): IrTest[] {
  return tail(
    asArray(v).flatMap((x): IrTest[] => {
      if (!x || typeof x !== 'object') return [];
      const o = x as Record<string, unknown>;
      const name = asString(o.name).trim();
      if (!name) return [];
      const t: IrTest = { name, status: asEnum(o.status, TEST_STATUSES, 'pending') };
      const f = asString(o.failureSummary, '');
      if (f) t.failureSummary = f;
      return [t];
    }),
    IR_CAP.tests,
  );
}

function coercePending(v: unknown): IrPending[] {
  return tail(
    asArray(v).flatMap((x): IrPending[] => {
      if (!x || typeof x !== 'object') return [];
      const o = x as Record<string, unknown>;
      const task = asString(o.task).trim();
      if (!task) return [];
      const p: IrPending = { task };
      const b = asStringArray(o.blockers);
      if (b) p.blockers = b;
      const n = asString(o.nextStep, '');
      if (n) p.nextStep = n;
      return [p];
    }),
    IR_CAP.pending,
  );
}

export function parseRefineOutput(assistantText: string): ParseRefineResult {
  const text = (assistantText ?? '').trim();
  if (text.length === 0) return { ok: false, error: 'refine response empty' };

  const candidate = stripCodeFence(text);
  const jsonStr = extractFirstBalancedObject(candidate) ?? candidate;
  let raw: unknown;
  try {
    raw = JSON.parse(jsonStr);
  } catch (err) {
    return { ok: false, error: `JSON parse failed: ${(err as Error).message}` };
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'IR body is not an object' };
  }
  const obj = raw as Record<string, unknown>;
  const warnings: string[] = [];
  const intent = coerceIntent(obj.intent);
  if (!intent.goal) warnings.push('intent.goal is empty');

  return {
    ok: true,
    body: {
      intent,
      decisions: coerceDecisions(obj.decisions),
      files: coerceFiles(obj.files),
      commands: coerceCommands(obj.commands),
      tests: coerceTests(obj.tests),
      pending: coercePending(obj.pending),
    },
    warnings,
  };
}

// ─── assembleIR ─────────────────────────────────────────────────────────
// pure: previousIR.meta.createdAt 보존, 새로운 updatedAt 부여, gitInfo는 호출자가 주입.
// 호출자(데스크탑 main 또는 익스텐션 host)가 git 정보 probing을 책임지고 전달한다 — 코어는 child_process를 모름.

export type GitInfo = {
  branch?: string;
  head?: string;
};

export function assembleIR(args: {
  contextId: string;
  body: ParsedIRBody;
  fromModel: CliKind;
  workspacePath: string;
  previousIR: IR | null;
  gitInfo?: GitInfo;
  now?: string; // 테스트 주입용 — 미지정 시 new Date().toISOString().
}): IR {
  const now = args.now ?? new Date().toISOString();
  const git = args.gitInfo ?? {};
  return {
    contextId: args.contextId,
    meta: {
      createdAt: args.previousIR?.meta.createdAt ?? now,
      updatedAt: now,
      lastModel: args.fromModel,
      workspacePath: args.workspacePath,
      gitBranch: git.branch,
      gitHead: git.head,
    },
    ...args.body,
  };
}
