import type { CliKind } from '@shared/ipc'
import type { IR } from '@shared/ir'
import { IR_CAP } from '@shared/ir'
import type { TurnRecord } from '@shared/turns'

// buildCompactionPrompt — M3 O 청크. architecture §15.4 / §15.6.
//
// turns.jsonl의 oldest N record + 직전 IR을 입력으로, 슬림화된 IR JSON 출력을 요청.
// runIrRefine (사용자 명시) / CompactionScheduler (자동 trigger) 양쪽 모두 본 prompt 사용.
//
// 본문은 영어로 작성. LLM 일관성·재현성을 위해 모델 prompt language는 English로 통일하되,
// LANGUAGE_RULE에서 IR 본문 자체는 사용자가 사용한 언어를 따라가도록 명시한다.

export type CompactionPromptArgs = {
  fromModel: CliKind
  workspacePath: string
  // 처리할 turn record (oldest 순서).
  turns: TurnRecord[]
  // 직전 IR — 기존 정보를 누적하기 위한 baseline.
  currentIR: IR | null
}

const IR_SCHEMA_GUIDE = `IR JSON schema (slim):
{
  "intent": { "goal": string, "role"?: string, "constraints"?: string[] },
  "decisions": [{ "topic": string, "choice": string, "rationale"?: string, "ts"?: ISO8601 }],
  "files": [{ "path": string, "status": "modified"|"created"|"deleted"|"read", "lastReadAt"?: ISO8601, "summary"?: string }],
  "commands": [{ "cmd": string, "exitCode"?: number, "summary"?: string, "fullOutputRef"?: string }],
  "tests": [{ "name": string, "status": "passed"|"failed"|"pending"|"skipped", "failureSummary"?: string }],
  "pending": [{ "task": string, "blockers"?: string[], "nextStep"?: string }]
}`

const EVIDENCE_RULES = [
  '## Evidence rules (CRITICAL — anti-hallucination)',
  '',
  'The `files` / `commands` / `tests` fields must record only **work that actually happened**. Any *example / illustration / sample* text written inside the assistant body is NOT a fact.',
  '',
  '### Accepted as evidence (record as fact)',
  '- Entries explicitly listed in the `toolCalls[]` array — a tool call is evidence of real execution.',
  '- Commands or requests directly uttered by the user (e.g., `/hooks`, `run npm test`).',
  '- A first-person *completed* report from the assistant — but ONLY if the same action appears in `toolCalls`, or the user later acknowledged the result.',
  '',
  '### Reject (hallucination risk — do not record)',
  '- *Hypothetical work reports* the assistant wrote as examples inside its response body. For instance, a snippet like "Verification:\\n- npm run test:unit passed\\n- npm run build passed" written by the model in prose is a **scenario authored by the model**, not a real execution result.',
  '- *Sample data* in code fences (```), such as illustrative IR / JSON / TurnRecord shapes used for teaching.',
  '- "Remaining: verify browser screenshots" type pending items the assistant wrote as a *hypothetical scenario*. Reject unless the user explicitly asked for it.',
  '',
  'If `toolCalls` and explicit user statements give no evidence for `tests` / `commands` / `files`, **leave those arrays empty**. Never guess.'
].join('\n')

const LANGUAGE_RULE = [
  '## Language',
  '',
  'IR text fields (`intent.goal`, `intent.role`, `intent.constraints`, `decisions[].topic`, `decisions[].choice`, `decisions[].rationale`, `files[].summary`, `commands[].summary`, `tests[].failureSummary`, `pending[].task`, `pending[].nextStep`, etc.) must be written in **the same language the user is using in their messages**. If the user writes Korean, IR text is Korean. If the user writes English, IR text is English. Mixed-language sessions follow the *most recent* user turn.',
  '',
  'Structural / enum values (`status`, `exitCode`, `ts`, file paths, command strings, tool names) stay as-is — do not translate them.'
].join('\n')

const FORMAT_RULES = [
  '## Output format rules',
  '',
  '1. The response is *exactly one valid JSON object*. No code fences (```), no natural-language preamble, no headings — start with `{` and end with `}`.',
  '2. Do NOT emit the `contextId` or `meta` (createdAt/updatedAt/lastModel/workspacePath/gitBranch/gitHead) fields — the caller fills them in.',
  '3. Do NOT emit the `trajectory` or `artifacts` fields — they were removed from the schema.',
  `4. Per-section caps: decisions ${IR_CAP.decisions} / files ${IR_CAP.files} / commands ${IR_CAP.commands} / tests ${IR_CAP.tests} / pending ${IR_CAP.pending}. When accumulating, drop the oldest items first.`,
  '5. If unknown, use an empty array or omit the field. No guessing.',
  '6. Redact sensitive values (API keys, passwords) from user messages with `[REDACTED]`.',
  '7. **Keep the whole IR JSON under ~800 tokens.** When over budget, drop the lowest-value items first.'
].join('\n')

function formatCurrentIR(ir: IR | null): string {
  if (!ir) return '(no previous IR — first refine)'
  const body = {
    intent: ir.intent,
    decisions: ir.decisions,
    files: ir.files,
    commands: ir.commands,
    tests: ir.tests,
    pending: ir.pending
  }
  return '```json\n' + JSON.stringify(body, null, 2) + '\n```'
}

function formatTurn(turn: TurnRecord, index: number): string {
  const lines: string[] = [
    `### Turn ${index + 1} (${turn.model}, ${turn.completedAt})`,
    '',
    'user:',
    turn.user.length > 0 ? turn.user : '(empty input)',
    '',
    'assistant:',
    turn.assistantBody.length > 0 ? turn.assistantBody : '(no body)'
  ]
  if (turn.toolCalls.length > 0) {
    lines.push('')
    lines.push('toolCalls:')
    for (const tc of turn.toolCalls) {
      const sum = tc.summary ? ` — ${tc.summary}` : ''
      lines.push(`- ${tc.tool}(${tc.arg})${sum}`)
    }
  }
  return lines.join('\n')
}

export function buildCompactionPrompt(args: CompactionPromptArgs): string {
  const { fromModel, workspacePath, turns, currentIR } = args
  const turnsBody =
    turns.length > 0 ? turns.map((t, i) => formatTurn(t, i)).join('\n\n') : '(no turns to process)'
  return [
    '# Task: compact a coding-agent turn log into an IR JSON',
    '',
    `You are the ${fromModel} model summarizing the working context of an active workspace.`,
    'The compacted IR will be injected into the next turn via a hook to preserve work continuity.',
    `Workspace: ${workspacePath}`,
    '',
    `## Input 1 — turns to process (${turns.length}, oldest first)`,
    'Each turn is a raw record with user / assistant / toolCalls explicitly separated.',
    '',
    turnsBody,
    '',
    '## Input 2 — previous IR (update it to produce the new IR if present)',
    formatCurrentIR(currentIR),
    '',
    '## Output',
    IR_SCHEMA_GUIDE,
    '',
    EVIDENCE_RULES,
    '',
    LANGUAGE_RULE,
    '',
    FORMAT_RULES,
    '',
    'Now output exactly one IR JSON object.'
  ].join('\n')
}
