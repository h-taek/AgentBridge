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
 * Hook command 형식:
 *   `node <abs-path> inject --agent <claude|codex|agy> --workspace <id> --user-data <path> --event <name>`
 *
 * 사용자 글로벌 데이터 위치는 호스트 앱(데스크탑/extension)이 --user-data로 주입한다.
 * 헬퍼가 경로를 추측하지 않는다 — 호스트마다 저장소가 다르므로 (데스크탑: Application Support,
 * extension: IDE globalStorage) 추측은 엉뚱한 메모리 주입으로 이어진다.
 */

'use strict'

// @agentbridge-helper-version 0.3.0
// (단일 설치 버전 비교용 — 이 파일을 수정하면 반드시 버전을 올릴 것)

const fs = require('fs')
const path = require('path')

// §G3 — 검색·주입 로직은 core 단일 소스. esbuild가 빌드 때 이 require를 인라인한다(옵션 나).
// 런타임 헬퍼 옆엔 node_modules가 없어 require('@agentbridge/core') 불가 → 상대 경로로 엔트리 그래프에 포함.
const { resolveContext } = require('../src/globalSearch')
const { resolveQuery, renderGlobalMatches } = require('../src/globalInject')

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
  // 형식: inject --agent <kind> --workspace <id> --user-data <path> --event <name>
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

// hook 입력(stdin)을 best-effort로 읽는다. claude/codex는 UserPromptSubmit JSON을 stdin으로 pipe.
// TTY면 즉시 빈값(대화형 실행 — hang 금지). 비-TTY인데 close 안 하는 host(agy 등)는 짧은 타임아웃으로 포기.
function readStdin(timeoutMs) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('')
      return
    }
    let data = ''
    let done = false
    const finish = () => {
      if (done) return
      done = true
      try { process.stdin.pause() } catch { /* noop */ }
      resolve(data)
    }
    const timer = setTimeout(finish, timeoutMs)
    if (timer && typeof timer.unref === 'function') timer.unref()
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => { data += c })
    process.stdin.on('end', () => { clearTimeout(timer); finish() })
    process.stdin.on('error', () => { clearTimeout(timer); finish() })
  })
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

function buildAdditionalContext(ir, recentTurns, workspaceId, globalBlock) {
  // architecture §15.5 본문 — 글로벌 메모리(장기) + IR 압축 메모리 + 최근 raw turn.
  const hasTurns = Array.isArray(recentTurns) && recentTurns.length > 0
  const hasGlobal = !!(globalBlock && globalBlock.trim())
  // 셋 다 비면 명시적으로 "AgentBridge 컨텍스트(미초기화)"임을 모델이 식별하게 sentinel로 감싼다.
  if (!ir && !hasTurns && !hasGlobal) {
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
  // 장기(글로벌) 메모리를 가장 위에 — 안정적 배경 → 세션 작업기억(IR) → 최근 턴 순.
  if (hasGlobal) {
    parts.push(globalBlock)
    parts.push('')
  }
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
  } else if (hasTurns) {
    parts.push('## Memory (IR uninitialized — only recent turns available)')
    parts.push('')
  }
  if (hasTurns) {
    // 가장 최근 턴을 맨 위로 — 주입 블록이 한도 초과로 잘려도 최신 턴(연속성)이 살아남게.
    parts.push('## Recent conversation (raw, last ' + recentTurns.length + ' turns, newest first)')
    parts.push(renderRecentTurns(recentTurns.slice().reverse()))
  }
  parts.push('</agentbridge-context>')
  return parts.join('\n')
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.cmd !== 'inject') {
    process.stderr.write(
      'agentbridge-memory: usage: inject --agent <kind> --workspace <id> --user-data <path> --event <name>\n'
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
  if (!parsed.userData) {
    process.stderr.write(
      'agentbridge-memory: --user-data required (stale or broken hook command — reopen the session in the app to reinstall hooks)\n'
    )
    process.stdout.write(JSON.stringify(buildHookOutput(parsed.agent, parsed.event, '')))
    process.exit(0)
  }
  const userData = parsed.userData
  if (parsed.workspace !== path.basename(parsed.workspace) || parsed.workspace === '..') {
    process.stderr.write('agentbridge-memory: --workspace must be a single path segment\n')
    process.stdout.write(JSON.stringify(buildHookOutput(parsed.agent, parsed.event, '')))
    process.exit(0)
  }
  const wsDir = path.join(userData, 'workspaces', parsed.workspace)
  const irPath = path.join(wsDir, 'ir.json')
  const turnsPath = path.join(wsDir, 'turns.jsonl')
  const ir = readJsonSafe(irPath)
  const recentTurns = readRecentTurns(turnsPath, 3)

  // §G3 글로벌 메모리 검색 — additive·best-effort. 어떤 실패도 IR/turns 주입을 막지 않는다.
  let globalBlock = ''
  try {
    const stdinRaw = await readStdin(200)
    const lastTurn = recentTurns.length ? recentTurns[recentTurns.length - 1] : null
    const lastUserTurn = lastTurn && typeof lastTurn.user === 'string' ? lastTurn.user : ''
    const query = resolveQuery(stdinRaw, lastUserTurn)
    if (query && query.trim()) {
      const globalDir = path.join(userData, 'global')
      const matches = await resolveContext(globalDir, 'default', query, { topN: 5 })
      globalBlock = renderGlobalMatches(matches)
    }
  } catch (e) {
    process.stderr.write(
      'agentbridge-memory: global search skipped — ' + String(e && e.message ? e.message : e) + '\n'
    )
    globalBlock = ''
  }

  // 주입 블록을 9KB(UTF-8) 이하로 유지 — 초과하면 가장 오래된 turn부터 빼고 다시 만든다(최신 턴은 보존).
  // (codex 훅 바인딩 한도 ~10KB·claude ~10,000자 회피. turn만 줄이고 IR/장기메모리는 건드리지 않음.)
  const INJECT_BYTE_LIMIT = 9 * 1024
  let injTurns = recentTurns
  let additionalContext = buildAdditionalContext(ir, injTurns, parsed.workspace, globalBlock)
  while (Buffer.byteLength(additionalContext, 'utf8') > INJECT_BYTE_LIMIT && injTurns.length > 0) {
    injTurns = injTurns.slice(1) // 배열 앞 = 가장 오래된 턴 → 제거
    additionalContext = buildAdditionalContext(ir, injTurns, parsed.workspace, globalBlock)
  }
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

main().catch((err) => {
  // 에러여도 CLI 흐름을 깨지 않게 stdout은 안전한 빈 컨텍스트로 출력하고 stderr만 진단 메시지.
  process.stderr.write('agentbridge-memory: ' + String(err && err.stack ? err.stack : err) + '\n')
  let fallbackEvent = 'UserPromptSubmit'
  let fallbackAgent = 'claude'
  try {
    const parsed = parseArgs(process.argv.slice(2))
    if (parsed.event && ALLOWED_EVENTS.has(parsed.event)) fallbackEvent = parsed.event
    if (parsed.agent === 'claude' || parsed.agent === 'codex' || parsed.agent === 'agy') {
      fallbackAgent = parsed.agent
    }
  } catch {
    /* noop */
  }
  process.stdout.write(JSON.stringify(buildHookOutput(fallbackAgent, fallbackEvent, '')))
  process.exit(0)
})
