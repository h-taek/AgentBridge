import type { CliKind } from '@shared/ipc'
import type {
  IR,
  IrCommand,
  IrDecision,
  IrFile,
  IrFileStatus,
  IrIntent,
  IrPending,
  IrTest,
  IrTestStatus
} from '@shared/ir'
import { IR_CAP } from '@shared/ir'

// refine 응답 raw assistantText에서 IR JSON을 추출·검증.
//
// 단계:
// 1. assistantText에서 JSON 블록 추출 — 모델이 자연어를 앞뒤로 붙이거나 ```json``` fence를
//    사용하는 경우를 모두 커버.
// 2. 파싱 + 스키마 강제 — 잘못된 타입은 default로 대체(엄격하게 거부하지 않음 — refine 첫 시도는
//    모델 출력이 거칠 수 있고, 빈/부분 IR도 유용하다).
// 3. contextId/meta는 호출자가 채움 — parse는 본문 영역만 반환.
// 4. O 청크 슬림화: trajectory/artifacts 제거. cap 5/5/3/3/3 적용 (가장 오래된 항목부터 잘라냄).

export type ParsedIRBody = Omit<IR, 'contextId' | 'meta'>

export type ParseRefineSuccess = {
  ok: true
  body: ParsedIRBody
  warnings: string[]
}

export type ParseRefineFailure = {
  ok: false
  error: string
}

export type ParseRefineResult = ParseRefineSuccess | ParseRefineFailure

// ```json ... ``` 또는 ``` ... ``` fence 안의 본문을 추출. 없으면 원본 반환.
function stripCodeFence(s: string): string {
  const m = s.match(/```(?:json|javascript|js)?\s*\n?([\s\S]*?)\n?```/i)
  return m ? m[1].trim() : s.trim()
}

// 첫 번째 balanced { ... } JSON 객체를 추출. 문자열 안의 중괄호는 무시(따옴표 escape 처리).
function extractFirstBalancedObject(s: string): string | null {
  const start = s.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        return s.slice(start, i + 1)
      }
    }
  }
  return null
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out = v.filter((x): x is string => typeof x === 'string')
  return out.length > 0 ? out : undefined
}

const FILE_STATUSES: IrFileStatus[] = ['modified', 'created', 'deleted', 'read']
const TEST_STATUSES: IrTestStatus[] = ['passed', 'failed', 'pending', 'skipped']

function asEnum<T extends string>(v: unknown, allowed: T[], fallback: T): T {
  return typeof v === 'string' && (allowed as string[]).includes(v) ? (v as T) : fallback
}

// cap이 적용된 결과는 *최신 N개*만 유지. refine LLM이 누적 시 가장 오래된 항목을 잘라내라 prompt
// 했지만 안전망으로 슬라이스도 적용.
function tail<T>(arr: T[], cap: number): T[] {
  if (arr.length <= cap) return arr
  return arr.slice(arr.length - cap)
}

function coerceIntent(v: unknown): IrIntent {
  if (!v || typeof v !== 'object') return { goal: '' }
  const o = v as Record<string, unknown>
  const intent: IrIntent = { goal: asString(o.goal) }
  const role = asString(o.role, '')
  if (role) intent.role = role
  const constraints = asStringArray(o.constraints)
  if (constraints) intent.constraints = constraints
  return intent
}

function coerceDecisions(v: unknown): IrDecision[] {
  const out = asArray(v).flatMap((x): IrDecision[] => {
    if (!x || typeof x !== 'object') return []
    const o = x as Record<string, unknown>
    const topic = asString(o.topic).trim()
    const choice = asString(o.choice).trim()
    if (!topic && !choice) return []
    const out: IrDecision = { topic, choice }
    const rationale = asString(o.rationale, '')
    if (rationale) out.rationale = rationale
    const ts = asString(o.ts, '')
    if (ts) out.ts = ts
    return [out]
  })
  return tail(out, IR_CAP.decisions)
}

function coerceFiles(v: unknown): IrFile[] {
  const out = asArray(v).flatMap((x): IrFile[] => {
    if (!x || typeof x !== 'object') return []
    const o = x as Record<string, unknown>
    const p = asString(o.path).trim()
    if (!p) return []
    const status = asEnum<IrFileStatus>(o.status, FILE_STATUSES, 'read')
    const out: IrFile = { path: p, status }
    const lastReadAt = asString(o.lastReadAt, '')
    if (lastReadAt) out.lastReadAt = lastReadAt
    const summary = asString(o.summary, '')
    if (summary) out.summary = summary
    return [out]
  })
  return tail(out, IR_CAP.files)
}

function coerceCommands(v: unknown): IrCommand[] {
  const out = asArray(v).flatMap((x): IrCommand[] => {
    if (!x || typeof x !== 'object') return []
    const o = x as Record<string, unknown>
    const cmd = asString(o.cmd).trim()
    if (!cmd) return []
    const out: IrCommand = { cmd }
    const exitCode = asNumber(o.exitCode)
    if (exitCode !== undefined) out.exitCode = exitCode
    const summary = asString(o.summary, '')
    if (summary) out.summary = summary
    const ref = asString(o.fullOutputRef, '')
    if (ref) out.fullOutputRef = ref
    return [out]
  })
  return tail(out, IR_CAP.commands)
}

function coerceTests(v: unknown): IrTest[] {
  const out = asArray(v).flatMap((x): IrTest[] => {
    if (!x || typeof x !== 'object') return []
    const o = x as Record<string, unknown>
    const name = asString(o.name).trim()
    if (!name) return []
    const status = asEnum<IrTestStatus>(o.status, TEST_STATUSES, 'pending')
    const out: IrTest = { name, status }
    const failure = asString(o.failureSummary, '')
    if (failure) out.failureSummary = failure
    return [out]
  })
  return tail(out, IR_CAP.tests)
}

function coercePending(v: unknown): IrPending[] {
  const out = asArray(v).flatMap((x): IrPending[] => {
    if (!x || typeof x !== 'object') return []
    const o = x as Record<string, unknown>
    const task = asString(o.task).trim()
    if (!task) return []
    const out: IrPending = { task }
    const blockers = asStringArray(o.blockers)
    if (blockers) out.blockers = blockers
    const next = asString(o.nextStep, '')
    if (next) out.nextStep = next
    return [out]
  })
  return tail(out, IR_CAP.pending)
}

export function parseRefineOutput(assistantText: string): ParseRefineResult {
  const text = (assistantText ?? '').trim()
  if (text.length === 0) {
    return { ok: false, error: 'refine 응답이 비어있음 — 정제 호출이 본문을 생성하지 못함' }
  }
  // 1. fence 안 본문 우선 시도, 없으면 원본.
  const candidate = stripCodeFence(text)
  // 2. 첫 balanced JSON 객체 추출.
  const jsonStr = extractFirstBalancedObject(candidate) ?? candidate
  let raw: unknown
  try {
    raw = JSON.parse(jsonStr)
  } catch (err) {
    return {
      ok: false,
      error: `JSON 파싱 실패: ${(err as Error).message}. 응답 첫 200자: ${text.slice(0, 200)}`
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'IR 본문이 객체가 아님' }
  }
  const obj = raw as Record<string, unknown>
  const warnings: string[] = []

  const intent = coerceIntent(obj.intent)
  if (!intent.goal)
    warnings.push('intent.goal이 비어있음 — refine 모델이 의도 추출에 실패했을 수 있음')

  const body: ParsedIRBody = {
    intent,
    decisions: coerceDecisions(obj.decisions),
    files: coerceFiles(obj.files),
    commands: coerceCommands(obj.commands),
    tests: coerceTests(obj.tests),
    pending: coercePending(obj.pending)
  }
  return { ok: true, body, warnings }
}

// 본문 + 호출자 메타를 합쳐 IR 완성. createdAt은 currentIR이 있으면 보존.
export function assembleIR(args: {
  contextId: string
  body: ParsedIRBody
  fromModel: CliKind
  workspacePath: string
  previousIR: IR | null
}): IR {
  const now = new Date().toISOString()
  const createdAt = args.previousIR?.meta.createdAt ?? now
  return {
    contextId: args.contextId,
    meta: {
      createdAt,
      updatedAt: now,
      lastModel: args.fromModel,
      workspacePath: args.workspacePath,
      gitBranch: args.previousIR?.meta.gitBranch,
      gitHead: args.previousIR?.meta.gitHead
    },
    intent: args.body.intent,
    decisions: args.body.decisions,
    files: args.body.files,
    commands: args.body.commands,
    tests: args.body.tests,
    pending: args.body.pending
  }
}
