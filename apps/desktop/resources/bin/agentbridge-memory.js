#!/usr/bin/env node
/*
 * agentbridge-memory — hook 호출 시 ir.json을 markdown으로 렌더해 stdout JSON 출력.
 *
 * M3 M 청크 — architecture §14.8/§14.9. claude/codex/agy(Antigravity) 세 CLI의 hook 시스템이
 * 호출하는 헬퍼 binary. CLI host에 따라 출력 protocol이 다르다:
 *
 *   claude/codex: `{ hookSpecificOutput: { hookEventName, additionalContext }, suppressOutput: true }`
 *   agy:          (agy 1.0.0 — 검증 필요) 동일 protocol 가정. 미동작 시 라이브 테스트 후 갱신.
 *
 * Node CJS plain script — 빌드 X, ASAR unpack X. electron-builder `asarUnpack: resources/**`로
 * 패키지 안 .app/Contents/Resources/bin/agentbridge-memory.js로 들어간다 (M4 패키징 단계 검증).
 * dev에서는 <repo>/resources/bin/agentbridge-memory.js 그대로 실행.
 *
 * Hook command 형식: `node <abs-path> inject --agent <claude|codex|agy> --workspace <id>`
 *
 * 사용자 글로벌 데이터 위치: ~/Library/Application Support/AgentBridge/workspaces/<id>/ir.json
 * (Electron app.getPath('userData')와 동일 경로 — macOS 한정. M4 멀티 플랫폼 시 분기).
 */

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

// claude/codex/agy 모두 stdout JSON의 `hookEventName`이 *호출된 hook event 이름과 정확히 일치*
// 해야 한다. 일치 안 하면 CLI host가 "expected X but got Y" 에러로 hook을 거부 (claude는 warning,
// codex는 fatal일 수 있음 — spawn 후 자발 종료 가능성).
//
// 따라서 helper는 *고정값 emit 금지* — hookInstaller가 등록한 hook command에 `--event <name>`을
// 박아 helper가 그 값을 그대로 emit하도록 한다.
//
// agent별 *허용 가능한 이벤트* 화이트리스트는 hookInstaller가 관리. helper는 받은 값을 그대로 emit.
//
// agy 추가 이벤트(PreInvocation/PostInvocation)는 매 모델 호출 직전·직후에 fire. SessionStart/
// BeforeAgent 대신 agy는 PreInvocation으로 컨텍스트 inject. PostInvocation/Stop은 향후 활용.

const ALLOWED_EVENTS = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'BeforeAgent',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'PreInvocation',
  'PostInvocation'
])

function parseArgs(argv) {
  // 형식: inject --agent <kind> --workspace <id> --event <name> [--user-data <path>]
  const out = {
    cmd: argv[0] || null,
    agent: null,
    workspace: null,
    userData: null,
    event: null
  }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    const next = argv[i + 1]
    if (a === '--agent' && next) {
      out.agent = next
      i++
    } else if (a === '--workspace' && next) {
      out.workspace = next
      i++
    } else if (a === '--user-data' && next) {
      out.userData = next
      i++
    } else if (a === '--event' && next) {
      out.event = next
      i++
    }
  }
  return out
}

function getUserDataDir(override) {
  if (override) return override
  // macOS 표준 위치. M4에서 process.platform 분기 추가 시 갱신.
  return path.join(os.homedir(), 'Library', 'Application Support', 'AgentBridge')
}

function readJsonSafe(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8')
    if (!raw.trim()) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// turns.jsonl 끝 N record 읽기 — append-only NDJSON. 빈 파일 / 깨진 줄은 silent skip.
// O 청크 §15.5 — hook 본문에 최근 3개 raw turn을 prepend.
function readRecentTurns(p, n) {
  let raw
  try {
    raw = fs.readFileSync(p, 'utf8')
  } catch {
    return []
  }
  const lines = raw.split('\n')
  const out = []
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    try {
      const obj = JSON.parse(t)
      if (obj && typeof obj === 'object' && typeof obj.id === 'string') out.push(obj)
    } catch {
      /* skip */
    }
  }
  if (n <= 0 || out.length <= n) return out
  return out.slice(out.length - n)
}

function fmtList(items, indent) {
  indent = indent || ''
  if (!Array.isArray(items) || items.length === 0) return indent + '(none)'
  return items.map((s) => indent + '- ' + s).join('\n')
}

function renderIntent(ir) {
  const intent = (ir && ir.intent) || {}
  const lines = ['goal: ' + (intent.goal || '(unset)')]
  if (intent.role) lines.push('role: ' + intent.role)
  if (Array.isArray(intent.constraints) && intent.constraints.length > 0) {
    lines.push('constraints:')
    lines.push(fmtList(intent.constraints, '  '))
  }
  return lines.join('\n')
}

function renderDecisions(ir) {
  const ds = (ir && ir.decisions) || []
  if (ds.length === 0) return '(no decisions)'
  return ds
    .slice(-10)
    .map((d) => {
      const head = d.topic ? d.topic + ' → ' + d.choice : d.choice
      const lines = ['- ' + head]
      if (d.rationale) lines.push('  rationale: ' + d.rationale)
      return lines.join('\n')
    })
    .join('\n')
}

function renderFiles(ir) {
  const fs2 = (ir && ir.files) || []
  if (fs2.length === 0) return '(no file changes)'
  return fs2
    .slice(-15)
    .map((f) => '- [' + f.status + '] ' + f.path + (f.summary ? ' — ' + f.summary : ''))
    .join('\n')
}

function renderCommands(ir) {
  const cs = (ir && ir.commands) || []
  if (cs.length === 0) return '(no commands run)'
  return cs
    .slice(-10)
    .map((c) => {
      const head = '- `' + c.cmd + '`'
      const ec = c.exitCode != null ? ' (exit ' + c.exitCode + ')' : ''
      const sum = c.summary ? ' — ' + c.summary : ''
      return head + ec + sum
    })
    .join('\n')
}

function renderTests(ir) {
  const ts = (ir && ir.tests) || []
  if (ts.length === 0) return '(no test results)'
  return ts
    .slice(-5)
    .map(
      (t) => '- [' + t.status + '] ' + t.name + (t.failureSummary ? ' — ' + t.failureSummary : '')
    )
    .join('\n')
}

function renderPending(ir) {
  const ps = (ir && ir.pending) || []
  if (ps.length === 0) return '(no pending items)'
  return ps
    .slice(-5)
    .map((p) => {
      const lines = ['- ' + p.task]
      if (Array.isArray(p.blockers) && p.blockers.length > 0) {
        lines.push('  blockers: ' + p.blockers.join(', '))
      }
      if (p.nextStep) lines.push('  next: ' + p.nextStep)
      return lines.join('\n')
    })
    .join('\n')
}

// 모델에 inject되는 컨텍스트의 처리 규칙 — 본문 상단에 prepend해 모델 행태 가이드.
// 과거 IR_SENTINEL_INSTRUCTIONS(legacy argv inject 경로, dead)에 있던 내용을 hook payload로 이전.
// 모델이 IR을 *별개 산출물*로 다루지 않게(예: "the IR" 호칭, 재요약) 하고 자연스러운 대화 연속성으로
// 사용하도록 안내한다.
//
// 본문은 영어로 작성한다 — LLM 일관성을 위해 모델 prompt language는 English로 통일. 단 응답 자체는
// (4)항에 따라 사용자가 사용한 언어로 답변해야 한다.
const HOOK_INSTRUCTIONS = [
  'The following block is working context maintained and compacted by AgentBridge.',
  '',
  'Handling rules:',
  '1. Do NOT refer to this block as a separate artifact (no "the IR", "you provided", "the context above", etc.). Treat it as natural conversation continuity — the user is already aware of its contents.',
  '2. Do NOT summarize or re-quote the IR unless the user asks. You may draw on it naturally when needed for accuracy.',
  '3. Project memory files (AGENTS.md / GEMINI.md / CLAUDE.md) keep their normal authority. On conflict with the IR, prefer the most recent user intent; if unsure, ask the user to confirm.',
  '4. **Respond in the same language the user uses in their question.** If the user writes Korean, reply in Korean. If English, reply in English. Mixed sessions follow the most recent user turn. This applies to the model reply only — IR data and structural enum values stay as recorded.'
].join('\n')

function truncate(s, n) {
  if (typeof s !== 'string') return ''
  if (s.length <= n) return s
  return s.slice(0, n) + '…'
}

function renderRecentTurns(turns) {
  if (!Array.isArray(turns) || turns.length === 0) return '(no recent turns)'
  const lines = []
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]
    const idx = turns.length - turns.length + i + 1 // 1..N
    lines.push('[Turn ' + idx + ' · ' + (t.model || '?') + ' · ' + (t.completedAt || '') + ']')
    lines.push('user: ' + truncate(t.user || '', 1200))
    lines.push('assistant: ' + truncate(t.assistantBody || '', 1200))
    if (Array.isArray(t.toolCalls) && t.toolCalls.length > 0) {
      const tc = t.toolCalls
        .slice(0, 5)
        .map((c) => '  - ' + (c.tool || '?') + '(' + truncate(c.arg || '', 80) + ')')
        .join('\n')
      lines.push('tools:')
      lines.push(tc)
    }
    if (i < turns.length - 1) lines.push('')
  }
  return lines.join('\n')
}

function buildAdditionalContext(ir, recentTurns, workspaceId) {
  // architecture §15.5 본문 — IR 압축 메모리 + 최근 3개 raw turn.
  // 빈 IR + 빈 turns여도 명시적으로 "AgentBridge 컨텍스트"임을 모델이 식별할 수 있게 sentinel 태그로 감싼다.
  if (!ir && (!recentTurns || recentTurns.length === 0)) {
    return [
      '<agentbridge-context>',
      HOOK_INSTRUCTIONS,
      '',
      '## AgentBridge context (memory uninitialized)',
      'Workspace ' + workspaceId + ' has no compacted memory (IR) or turn history yet.',
      'This hook will accumulate from the next turn onward and compact into an IR.',
      '</agentbridge-context>'
    ].join('\n')
  }
  const parts = ['<agentbridge-context>', HOOK_INSTRUCTIONS, '']
  if (ir) {
    parts.push('## Memory (compacted — IR)')
    parts.push('')
    parts.push('### Intent')
    parts.push(renderIntent(ir))
    parts.push('')
    parts.push('### Decisions')
    parts.push(renderDecisions(ir))
    parts.push('')
    parts.push('### Files')
    parts.push(renderFiles(ir))
    parts.push('')
    parts.push('### Commands')
    parts.push(renderCommands(ir))
    parts.push('')
    parts.push('### Tests')
    parts.push(renderTests(ir))
    parts.push('')
    parts.push('### Pending')
    parts.push(renderPending(ir))
    parts.push('')
  } else {
    parts.push('## Memory (IR uninitialized — only recent turns available)')
    parts.push('')
  }
  parts.push(
    '## Recent conversation (raw, last ' + (recentTurns ? recentTurns.length : 0) + ' turns)'
  )
  parts.push(renderRecentTurns(recentTurns))
  parts.push('</agentbridge-context>')
  return parts.join('\n')
}

function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.cmd !== 'inject') {
    process.stderr.write(
      'agentbridge-memory: usage: inject --agent <kind> --workspace <id> --event <name>\n'
    )
    process.exit(2)
  }
  if (parsed.agent !== 'claude' && parsed.agent !== 'codex' && parsed.agent !== 'agy') {
    process.stderr.write('agentbridge-memory: --agent must be claude|codex|agy\n')
    process.exit(2)
  }
  if (!parsed.workspace) {
    process.stderr.write('agentbridge-memory: --workspace required\n')
    process.exit(2)
  }
  if (!parsed.event || !ALLOWED_EVENTS.has(parsed.event)) {
    process.stderr.write(
      'agentbridge-memory: --event required, one of: ' + Array.from(ALLOWED_EVENTS).join('|') + '\n'
    )
    process.exit(2)
  }
  const userData = getUserDataDir(parsed.userData)
  const wsDir = path.join(userData, 'workspaces', parsed.workspace)
  const irPath = path.join(wsDir, 'ir.json')
  const turnsPath = path.join(wsDir, 'turns.jsonl')
  const ir = readJsonSafe(irPath)
  // 최근 N개 raw turn — compaction keepRecent와 동일(현재 3). 사용자가 임계 변경 시 동기화 필요.
  const recentTurns = readRecentTurns(turnsPath, 3)
  const additionalContext = buildAdditionalContext(ir, recentTurns, parsed.workspace)
  // hook protocol — stdout JSON. agent마다 schema가 다르다 (CLI host의 hook output unmarshaller가 다르므로).
  //
  //   claude/codex: `{ hookSpecificOutput: { hookEventName, additionalContext }, suppressOutput: true }`
  //   agy:          `{ injectSteps: [{ ephemeralMessage: { content: "..." } }] }` (protojson — agy 1.0.0)
  //                 hooks_go_proto.HookInjectedStep_EphemeralMessage + CortexStepEphemeralMessage.content
  //                 (binary string 검증: protobuf:"bytes,103,opt,name=ephemeral_message,...,oneof" /
  //                  (*CortexStepEphemeralMessage).GetContent)
  process.stdout.write(
    JSON.stringify(buildHookOutput(parsed.agent, parsed.event, additionalContext))
  )
  process.exit(0)
}

function buildHookOutput(agent, event, additionalContext) {
  if (agent === 'agy') {
    // protojson: HookInjectedStep.ephemeral_message는 string field (object 아님).
    // 라이브 검증: agy 1.0.0이 `invalid value for string field ephemeralMessage: {` 에러를 던짐.
    // 같은 binary에 CortexStepEphemeralMessage.content가 있지만 그건 별개 컨텍스트의 동명 타입 —
    // HookInjectedStep 안에서는 직접 string으로 받는다.
    return {
      injectSteps: [{ ephemeralMessage: additionalContext }]
    }
  }
  // claude / codex — hookEventName은 *받은 값 그대로* emit. CLI host가 "expected X but got Y" 에러를
  // 피하려면 정확히 일치해야 한다.
  return {
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext
    },
    suppressOutput: true
  }
}

try {
  main()
} catch (err) {
  // 에러여도 CLI 흐름을 깨지 않게 stdout은 안전한 빈 컨텍스트로 출력하고 stderr만 진단 메시지.
  // 단 --event를 알 수 없는 catastrophic 케이스에서는 안전한 default 'UserPromptSubmit' 사용.
  process.stderr.write('agentbridge-memory: ' + String(err && err.stack ? err.stack : err) + '\n')
  let fallbackEvent = 'UserPromptSubmit'
  try {
    const parsed = parseArgs(process.argv.slice(2))
    if (parsed.event && ALLOWED_EVENTS.has(parsed.event)) fallbackEvent = parsed.event
  } catch {
    /* noop */
  }
  // fallback agent도 마지막 args에서 추출(있으면) — agy 응답 schema mismatch 방지.
  let fallbackAgent = 'claude'
  try {
    const parsed = parseArgs(process.argv.slice(2))
    if (parsed.agent === 'claude' || parsed.agent === 'codex' || parsed.agent === 'agy') {
      fallbackAgent = parsed.agent
    }
  } catch {
    /* noop */
  }
  process.stdout.write(JSON.stringify(buildHookOutput(fallbackAgent, fallbackEvent, '')))
  process.exit(0)
}
