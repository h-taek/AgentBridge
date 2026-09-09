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
 * Hook command 형식 (0.5.0 A-3에서 동결):
 *   `<런타임> <abs-path> inject --agent <claude|codex|agy> --event <name>`
 *
 * 커맨드에 저장소 구조가 들어가지 않는다. 신원은 spawn 때 심는 AGENTBRIDGE_WS_DIR이 나르고,
 * 장기 메모리 폴더는 이 파일의 위치(<루트>/bin/)에서 계산한다. 그래서 폴더를 옮기거나 이름을
 * 바꿔도 커맨드가 그대로이고, codex 훅 신뢰가 다시 뜨지 않는다.
 *
 * 변수가 없으면 우리 앱 밖에서 켠 세션이므로 빈 컨텍스트로 조용히 끝낸다.
 */

'use strict'

// @agentbridge-helper-version 0.6.1
// (단일 설치 버전 비교용 — 이 파일을 수정하면 반드시 버전을 올릴 것)

const fs = require('fs')
const path = require('path')

// 미읽음 판정은 코어 단일 소스를 쓴다. esbuild가 빌드 때 이 require를 인라인한다.
const { isUnread } = require('../src/agent/reportState')
const { computeSessionActivity, readSessionActivityInputs } = require('../src/sessionStatus')

// 코어 단일 소스. esbuild가 빌드 때 이 require를 인라인한다(옵션 나) — 런타임 헬퍼 옆엔
// node_modules가 없어 require('@agentbridge/core')가 불가하다.
//
// 검색·IR 렌더는 더 이상 여기서 안 쓴다(0.5.0 B-4). 그 자리는 에이전트용 CLI로 옮겼다.
const {
  extractSessionIdFromStdin,
  extractPromptFromStdin,
  extractInvocationNum,
  extractLastUserInput
} = require('../src/globalInject')
// 장기 기억 매칭 (0.6.0 spec/03 §1). 훅이 매 턴 프롬프트를 쿼리로 점수화한다.
const { resolveInjection } = require('../src/globalSearch')
const { getGlobalDir } = require('../src/globalPaths')
const { resolveProfile } = require('../src/globalStore')
const { resolveProjectProfileId } = require('../src/gitRemote')
// 다섯 턴 제안 (§2). 카운터는 세션 폴더에 있다 — 병렬 세션이 서로 턴을 훔치지 않게.
const { bumpTurnCount, readTurnCount, isProposalTurn } = require('../src/turnCounter')
const { wrapInjectedContext } = require('../src/contextTag')
// 모델에게 가르치는 실행 문자열은 스킬과 같은 출처에서 나온다 — 어긋나면 승인 창이 뜬다.
const { renderRunPrefix } = require('../src/skillTemplate')

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

// 턴 종료 이벤트 (0.5.0 A-2). 이 이벤트에서는 컨텍스트를 싣지 않고 종료 신호 파일만 쓴다.
// 호스트가 그 신호를 받아 transcript를 읽는다 — 폴링으로 파일이 자랐는지 훔쳐보지 않는다.
const TERMINATION_EVENTS = new Set(['Stop', 'StopFailure'])

// 턴 시작 이벤트 (0.5.0 W1). hookInstaller가 실제로 컨텍스트 주입용으로 등록하는 이벤트만
// 담는다 — claude·codex는 UserPromptSubmit, agy는 PreInvocation. 종료 이벤트가 아닌 전부를
// 대상으로 하면 향후 등록될 다른 이벤트(PostInvocation 등)가 조용히 시작 신호로 새기 쉽다.
const INJECTION_EVENTS = new Set(['UserPromptSubmit', 'PreInvocation'])

// 종료 페이로드를 하니스 차이 없는 한 모양으로 정규화한다.
// claude/codex: session_id·transcript_path·agent_id (research 04 §1·§2)
// agy: conversationId·transcriptPath·fullyIdle·terminationReason (§3)
// 우리 훅이 제 일을 못 했다는 사실을 호스트가 볼 수 있는 자리에 남긴다.
// stderr는 CLI가 삼키므로 파일이 유일한 통로다 (0.5.0 A-2).
function writeHookError(wsDir, agent, event, message) {
  try {
    const token = process.env.AGENTBRIDGE_WS_SESSION || ''
    if (!wsDir || !token || token !== path.basename(token)) return
    const dir = path.join(wsDir, 'sessions', token)
    fs.mkdirSync(dir, { recursive: true })
    const out = path.join(dir, 'hook-error.json')
    const tmp = out + '.' + process.pid + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ agent, event, message: String(message), at: Date.now() }))
    fs.renameSync(tmp, out)
  } catch {
    /* 여기서 더 할 수 있는 게 없다 */
  }
}

// 이 세션의 폴더. 토큰이 없거나 단일 세그먼트가 아니면 자리를 못 정한다(다른 쓰기와 같은 가드).
function sessionDirOf(wsDir) {
  const token = process.env.AGENTBRIDGE_WS_SESSION || ''
  if (!wsDir || !token || token !== path.basename(token)) return ''
  return path.join(wsDir, 'sessions', token)
}

function buildTurnSignal(agent, event, payload) {
  const p = payload && typeof payload === 'object' ? payload : {}
  const str = (v) => (typeof v === 'string' && v.trim() ? v : '')
  if (agent === 'agy') {
    return {
      agent,
      event,
      sessionId: str(p.conversationId) || str(p.conversation_id),
      transcriptPath: str(p.transcriptPath) || str(p.transcript_path),
      // 배경 작업이 남아 있으면 턴이 아직 안 끝났다.
      complete: p.fullyIdle === true,
      terminationReason: str(p.terminationReason),
      error: str(p.error),
      at: Date.now()
    }
  }
  return {
    agent,
    event,
    sessionId: str(p.session_id),
    transcriptPath: str(p.transcript_path),
    // 자식(서브에이전트) 신호는 부모 턴이 아니다. Stop 스키마엔 원래 없지만 방어로 싣는다.
    agentId: str(p.agent_id),
    // claude는 API·모델 오류로 끊기면 Stop 대신 StopFailure가 온다 (research 04 §1).
    complete: event !== 'StopFailure',
    error: str(p.error),
    at: Date.now()
  }
}

const ALLOWED_EVENTS = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'BeforeAgent',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'StopFailure',
  'PreInvocation',
  'PostInvocation'
])

function parseArgs(argv) {
  // 형식: inject --agent <kind> --event <name>
  const out = {
    cmd: argv[0] || null,
    agent: null,
    event: null
  }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    const next = argv[i + 1]
    if (a === '--agent' && next) {
      out.agent = next
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


// 훅이 나르는 것 (0.5.0 B-4, 0.6.0 spec/03).
//
// 0.5.0에서 훅은 지시문 하나로 줄었다. 조건 목록을 주고 모델이 부르게 하는 방식인데, 조건에
// 안 걸리면 아무것도 안 불렀다 — 장기 기억이 거의 안 읽혔다. 그래서 이 사이클에서 훅이 매 턴
// 프롬프트를 쿼리로 매칭해 "무엇이 있는지"를 알리고, 다섯 턴마다 기록을 명령한다.
//
// 그래도 본문은 밀지 않는다. 나가는 것은 식별자와 제목이고 본문은 `memory read`가 낸다.
// 매 턴 들어가는 유일한 것이라 작아야 하고, 무엇이 걸렸는지는 제목만으로 충분하다.
//
// 실행 경로는 훅과 같은 규칙으로 만든다 — 이 헬퍼를 돌린 런타임과 저장소의 canonical CLI.
// 사용자 PATH의 node에 기대지 않는다(A-3).

// 안 읽은·멈춘 서브 (0.5.0 4단계 W5, B-6). 수와 읽는 방법만 적고 보고 본문은 넣지 않는다.
//
// 우리가 메인의 PTY에 타이핑하지 않는 이유가 이 블록이다. 통로가 이미 있으므로 사용자 입력과
// 경합하는 타이핑을 붙일 이유가 없다.
async function buildSubagentBlocks(wsDir, sessionToken) {
  const none = { unread: '', stuck: '' }
  if (!sessionToken || sessionToken !== path.basename(sessionToken)) return none
  let sessions = []
  try {
    sessions = JSON.parse(fs.readFileSync(path.join(wsDir, 'workspace.json'), 'utf8')).sessions || []
  } catch {
    return none
  }
  const mine = sessions.filter(
    (s) => s.parentSessionId === sessionToken && s.agentName && !s.cleanedAt
  )
  if (mine.length === 0) return none

  const unread = []
  const stuck = []
  for (const s of mine) {
    if (await isUnread(wsDir, s.sessionId)) {
      unread.push(s.agentName)
      continue
    }
    // 완료 신호가 없는데 출력이 한참 멈춘 서브. 사용자가 턴을 끊었으면 어떤 신호도 오지 않으므로
    // 미읽음으로는 절대 안 잡힌다 — 메인이 묻지 않으면 영영 모르는 자리가 여기다.
    if (s.closedAt !== null) continue
    try {
      const inputs = await readSessionActivityInputs(wsDir, s.sessionId)
      if (computeSessionActivity(inputs, Date.now()) === 'unknown') stuck.push(s.agentName)
    } catch {
      /* 판정할 수 없으면 세지 않는다 */
    }
  }

  return {
    unread:
      unread.length === 0
        ? ''
        : 'Read the subagent reports with `agent read <name>`. ' +
          unread.length +
          ' finished and ' +
          (unread.length === 1 ? 'is' : 'are') +
          ' unread (' +
          unread.join(', ') +
          ').',
    stuck:
      stuck.length === 0
        ? ''
        : 'Check the stalled subagents with `agent read <name>`, then send more instructions ' +
          '(`agent send <name> --prompt "..."`) ' +
          'or close them (`agent close <name>`). ' +
          stuck.length +
          ' went quiet without finishing (' +
          stuck.join(', ') +
          '). The user may have interrupted them, or they may be stuck.'
  }
}

// 이번 턴 프롬프트에 걸린 장기 기억 (spec §1). 식별자와 제목만 싣는다.
function buildMatchBlock(matches) {
  if (!matches || matches.length === 0) return ''
  const one = matches.length === 1
  const lines = [
    'Read these before you answer, with `memory read <id>`. ' +
      matches.length +
      (one ? ' piece of long-term memory overlaps' : ' pieces of long-term memory overlap') +
      ' this prompt. Only the titles are here — the bodies are not.',
    ''
  ]
  for (const m of matches) lines.push('- ' + m.category + '/' + m.slug + ' — ' + m.title)
  return lines.join('\n')
}

// 다섯 턴마다 기록을 명령한다 (spec §2-2). 조건이 걸리기를 기다리지 않는다.
function buildProposalBlock() {
  return [
    'Look back over the last five turns. If something came up that outlives this session,',
    'do these three in order.',
    '',
    '1. Is it worth recording? Would writing it down make whoever works here next do',
    '   better? If not, do nothing. In particular, do not record options that were not',
    '   adopted, or proposals you made yourself — only what the user accepted.',
    '',
    '2. What counts as signal? What the user repeated, what they corrected (scope, order,',
    '   wording), what they interrupted, what they told you to redo. Read preferences far',
    '   more from what the user said than from what you said. Your own turns are a record',
    '   of what you tried, not evidence of what the user wants.',
    '',
    '3. Record it. Check with `memory search "<query>"` first, and only when nothing covers',
    '   it, `memory add`.'
  ].join('\n')
}

// 절 조립. 이번 턴 소절은 붙일 블록이 없으면 제목째 빠진다 (spec §4).
function buildInstructions(storageRoot, blocks) {
  const run = renderRunPrefix({
    execPath: process.execPath,
    cliPath: path.join(storageRoot, 'bin', 'agentbridge.js')
  })
  const b = blocks || {}
  const out = []
  const push = (...lines) => out.push(...lines)

  push(
    'AgentBridge does two things: it carries working context across sessions and across',
    'coding agents, and it runs other coding agents as subagents for you. Neither is in this',
    'prompt. You have to run a command.',
    '',
    '    ' + run + ' <command>',
    '',
    'The commands are in section 3.',
    '',
    '',
    '## 1. Context — `context` and `memory`',
    ''
  )

  const thisTurn = [b.matchBlock, b.proposalBlock].filter(Boolean)
  if (thisTurn.length > 0) {
    push('### 1-1. Do this turn', '')
    push(thisTurn.join('\n\n'), '')
  }

  push(
    '### 1-2. When to look',
    '',
    'Look by default. Skip only these three:',
    '',
    '- Questions needing no fact from outside this conversation, like the current time or date',
    '- A one-line translation, a wording fix, a one-line shell command, plain reformatting',
    '- Questions fully answered by what was already said in this conversation',
    '',
    'Everything else, look. In particular, always look when:',
    '',
    '- You are starting work on this project this session — `context`',
    '- The user asks about the IR, the working state, or the compacted context — `context`',
    '- The user points at something from before ("아까 그거", "what we decided",',
    '  "continue where we left off") — `turns --last 5`',
    '- The user tells you to check what was said in another session, another tab, or another',
    '  agent ("agy에서 뭐라고 했어", "아까 그 세션", "코덱스 쪽 확인해") — `turns --last <N>`,',
    '  with N generous',
    '- The answer turns on the rationale of a past decision, or on how this user wants things',
    '  done (style, tooling, workflow, conventions) — `memory search "<query>"`',
    '- The question is about this repository\'s own rules or history — `memory project`',
    '- It is ambiguous and might depend on an earlier decision — look once, cheaply',
    '',
    'When the user tells you to check the conversation record, run the command first. Do not',
    'answer from a guess, do not work around it, do not ask back which one to look at.',
    '',
    'Once at the start of the turn is not the rule. If the same error keeps coming back',
    'mid-task, or the direction feels wrong, look again then.',
    '',
    '### 1-3. What you are looking at',
    '',
    'Every conversation in this project lands in one place. Not just the window you are in:',
    'other tabs, other CLIs (claude, codex, agy) and earlier sessions all go into the same',
    'record, in time order. `turns` is that raw record; `context` is the compacted working',
    'state (the IR) built from it.',
    '',
    'So `turns` is not you re-reading your own context. Conversations you have never seen are',
    'in there. Each turn is labeled with the CLI it came from.',
    '',
    '',
    '## 2. Other agent sessions',
    ''
  )

  const subTurn = [b.subUnread, b.subStuck].filter(Boolean)
  if (subTurn.length > 0) {
    push('### 2-1. Do this turn', '')
    push(subTurn.join('\n\n'), '')
  }

  push(
    '### 2-2. What they are',
    '',
    'You can run other coding agents as subagents. Each gets its own session and tab, takes',
    'the work you give it, and leaves a report. You pick the harness — claude, codex, agy.',
    '',
    '**These are not your own built-in subagent tool. Do not use that tool.**',
    '',
    'This is what the user means by: "서브에이전트 띄워", run it in another harness, a second',
    'opinion, run several in parallel, ask another model too.',
    '',
    'A subagent does not tell you when it is done. Ask with `agent check`, or the next turn\'s',
    '2-1 says how many are unread. Reading one with `agent read` is what clears it.',
    '',
    '### 2-3. After a report',
    '',
    'A review is the report and the actual changes side by side. One without the other is not',
    'a review. How to see the changes, how to take them, how to run several in isolation, and',
    'how to clean up a round are in the `agentbridge` skill.',
    '',
    '',
    '## 3. Commands',
    '',
    'Reading and recording.',
    '',
    '    context                    the working state (IR) — every session, compacted',
    '    turns --last <N>           the raw conversation, every session and CLI, in order',
    '    memory search "<query>"    search user knowledge and project knowledge together',
    '    memory read <id>           one entry in full. The id is <category>/<slug>',
    '    memory project             what is durable about this repository',
    '    memory add                 propose a new fact',
    '    memory update <id>         propose a change to an entry that already exists',
    '    status                     whether the wiring is alive, when a command fails',
    '',
    '`memory add` and `memory update` go to a queue the user approves.',
    '',
    'Subagents.',
    '',
    '    agent start --prompt "..." [--harness claude,codex,agy]',
    '    agent check                how they are doing',
    '    agent read <name>          that subagent\'s conversation',
    '    agent send <name> --prompt "..."',
    '    agent close <name>         end it and clean up what it left',
    '',
    '`turns` and `agent read` are not the same. `turns` is every conversation in this project;',
    '`agent read <name>` is one subagent you started. When the user says to check the session',
    'conversation, that is `turns`.',
    '',
    'This is not the whole list. Arguments and procedures are in the `agentbridge` skill. Open',
    'it when you pick a scope to record into, when you check for duplicates, and for anything',
    'in 2-3.',
    '',
    '',
    '## 4. When you answer',
    '',
    'When a fact comes from long-term memory and you did not verify it this turn, say so. It',
    'is a record from an earlier time — do not state it as though it is still true today.',
    '',
    'Answer in the language the user writes in. Mixed sessions follow the most recent turn.'
  )

  return out.join('\n')
}

// 이번 턴의 쿼리 (spec §1-1). claude·codex는 stdin의 prompt, agy는 transcript의 마지막 발화다.
// agy stdin에는 사용자 발화가 없다 (research 03 §1-2).
const TRANSCRIPT_TAIL_BYTES = 256 * 1024

function readTranscriptTail(filePath) {
  if (!filePath) return ''
  let fd = null
  try {
    const size = fs.statSync(filePath).size
    const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES)
    const len = size - start
    if (len <= 0) return ''
    const buf = Buffer.alloc(len)
    fd = fs.openSync(filePath, 'r')
    fs.readSync(fd, buf, 0, len, start)
    return buf.toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd) } catch { /* noop */ }
    }
  }
}

function resolveQuery(agent, stdinRaw) {
  if (agent !== 'agy') return extractPromptFromStdin(stdinRaw, agent)
  let transcriptPath = ''
  try {
    const p = JSON.parse(stdinRaw)
    transcriptPath = (p && (p.transcriptPath || p.transcript_path)) || ''
  } catch {
    return ''
  }
  return extractLastUserInput(readTranscriptTail(transcriptPath))
}

// 이번 턴 프롬프트에 걸리는 장기 기억. 사용자 지식과 프로젝트 지식을 함께 돌린다.
//
// 프로젝트 지식의 자리는 정규화한 git remote로 정해지므로 매 턴 `git`을 한 번 부른다. 캐시를
// 두면 remote가 바뀌었을 때의 무효화가 새 문제가 되므로, 실측에서 훅 소요가 눈에 띌 때 다시 본다.
async function matchesForQuery(storageRoot, wsDir, query) {
  if (!query || !query.trim()) return []
  let projectId = null
  try {
    const workspacePath = JSON.parse(
      fs.readFileSync(path.join(wsDir, 'workspace.json'), 'utf8')
    ).workspacePath
    if (typeof workspacePath === 'string' && workspacePath) {
      projectId = await resolveProjectProfileId(workspacePath)
    }
  } catch {
    /* 프로젝트 지식 자리를 모르면 사용자 지식만 돌린다 */
  }
  return resolveInjection(
    getGlobalDir(storageRoot),
    { user: resolveProfile(path.basename(wsDir)), project: projectId },
    query
  )
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.cmd !== 'inject') {
    process.stderr.write(
      'agentbridge-memory: usage: inject --agent <claude|codex|agy> --event <name>\n'
    )
    process.exit(2)
  }
  if (parsed.agent !== 'claude' && parsed.agent !== 'codex' && parsed.agent !== 'agy') {
    process.stderr.write('agentbridge-memory: --agent must be claude|codex|agy\n')
    process.exit(2)
  }
  if (!parsed.event || !ALLOWED_EVENTS.has(parsed.event)) {
    process.stderr.write(
      'agentbridge-memory: --event required, one of: ' + Array.from(ALLOWED_EVENTS).join('|') + '\n'
    )
    process.exit(2)
  }
  // 저장소 루트는 이 파일의 자리에서 계산한다 — <루트>/bin/agentbridge-memory.js.
  // 양쪽을 실경로로 맞춘다: node는 __filename을 심링크 해소해서 주는데(macOS /var → /private/var)
  // 환경변수로 오는 경로는 해소 전일 수 있어, 그대로 비교하면 같은 자리를 다른 곳으로 본다.
  const realpath = (v) => {
    try {
      return fs.realpathSync(v)
    } catch {
      return path.resolve(v)
    }
  }
  const storageRoot = realpath(path.dirname(path.dirname(__filename)))
  const wsDir = process.env.AGENTBRIDGE_WS_DIR ? realpath(process.env.AGENTBRIDGE_WS_DIR) : ''
  if (!wsDir) {
    // 우리 앱 밖에서 켠 세션이다. 전역 설치라 훅은 돌지만 여기서 할 일은 없다.
    process.stdout.write(JSON.stringify(buildHookOutput(parsed.agent, parsed.event, '')))
    process.exit(0)
  }
  const rel = path.relative(storageRoot, wsDir)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    process.stderr.write('agentbridge-memory: AGENTBRIDGE_WS_DIR must live under the storage root\n')
    writeHookError(wsDir, parsed.agent, parsed.event, 'AGENTBRIDGE_WS_DIR가 저장소 루트 밖을 가리킨다')
    process.stdout.write(JSON.stringify(buildHookOutput(parsed.agent, parsed.event, '')))
    process.exit(0)
  }
  const stdinRaw = await readStdin(200)

  // 세션 id 결정적 캡처 — spawn 때 우리가 심은 env 토큰으로 키잉한 파일에 stdin의 native id를
  // 기록한다. best-effort: 어떤 실패도 컨텍스트 주입(아래)을 막지 않는다. claude는 우리가 id를
  // 발급하므로 대상 아님.
  try {
    const token = process.env.AGENTBRIDGE_WS_SESSION || ''
    let sid = extractSessionIdFromStdin(stdinRaw, parsed.agent)
    if (!sid) {
      if (parsed.agent === 'agy') sid = process.env.ANTIGRAVITY_CONVERSATION_ID || ''
      else if (parsed.agent === 'codex') sid = process.env.CODEX_THREAD_ID || ''
    }
    if (parsed.agent !== 'claude' && token && sid && token === path.basename(token)) {
      const dir = path.join(wsDir, 'sessions', token)
      // 폴더가 없으면 캡처가 통째로 유실된다. 폴백을 걷어낸 뒤로 여기가 유일한 유실 경로다.
      fs.mkdirSync(dir, { recursive: true })
      const out = path.join(dir, 'captured.json')
      const tmp = out + '.' + process.pid + '.tmp'
      fs.writeFileSync(
        tmp,
        JSON.stringify({
          agent: parsed.agent,
          modelSessionId: sid,
          ppid: process.ppid,
          capturedAt: Date.now()
        })
      )
      fs.renameSync(tmp, out)
    }
  } catch (e) {
    const msg = String(e && e.message ? e.message : e)
    process.stderr.write('agentbridge-memory: capture write skipped — ' + msg + '\n')
    writeHookError(wsDir, parsed.agent, parsed.event, '세션 id 캡처 실패 — ' + msg)
  }

  // 턴 시작 신호 (0.5.0 W1) — 주입 훅이 도는 시점을 파일로 남긴다. 종료 신호와 같은 폴더·
  // 같은 규약(tmp→rename, 매번 덮어쓰기, best-effort). 내용은 트리거가 아니라 시각이 전부다.
  // agy는 한 턴에 PreInvocation이 여러 번 올 수 있으나 시각만 갱신하므로 판정이 흔들리지 않는다.
  if (INJECTION_EVENTS.has(parsed.event)) {
    try {
      const token = process.env.AGENTBRIDGE_WS_SESSION || ''
      if (token && token === path.basename(token)) {
        const sid = extractSessionIdFromStdin(stdinRaw, parsed.agent)
        const dir = path.join(wsDir, 'sessions', token)
        fs.mkdirSync(dir, { recursive: true })
        const out = path.join(dir, 'turn-start.json')
        const tmp = out + '.' + process.pid + '.tmp'
        fs.writeFileSync(
          tmp,
          JSON.stringify({ agent: parsed.agent, event: parsed.event, sessionId: sid, at: Date.now() })
        )
        fs.renameSync(tmp, out)
      }
    } catch (e) {
      const msg = String(e && e.message ? e.message : e)
      process.stderr.write('agentbridge-memory: turn start write skipped — ' + msg + '\n')
      writeHookError(wsDir, parsed.agent, parsed.event, '턴 시작 신호 쓰기 실패 — ' + msg)
    }
  }

  // 턴 종료 신호 — 호스트가 이걸 받아 transcript를 읽는다 (0.5.0 A-2).
  // 캡처와 같은 폴더에 쓰고, 매번 덮어쓴다. 신호를 하나 놓쳐도 다음 신호에 증분으로 따라잡으므로
  // 누적할 필요가 없다.
  if (TERMINATION_EVENTS.has(parsed.event)) {
    try {
      const token = process.env.AGENTBRIDGE_WS_SESSION || ''
      if (token && token === path.basename(token)) {
        let payload = null
        try {
          payload = JSON.parse(stdinRaw)
        } catch {
          payload = null
        }
        const dir = path.join(wsDir, 'sessions', token)
        fs.mkdirSync(dir, { recursive: true })
        const out = path.join(dir, 'turn-signal.json')
        const tmp = out + '.' + process.pid + '.tmp'
        fs.writeFileSync(tmp, JSON.stringify(buildTurnSignal(parsed.agent, parsed.event, payload)))
        fs.renameSync(tmp, out)
      }
    } catch (e) {
      const msg = String(e && e.message ? e.message : e)
      process.stderr.write('agentbridge-memory: turn signal write skipped — ' + msg + '\n')
      writeHookError(wsDir, parsed.agent, parsed.event, '턴 종료 신호 쓰기 실패 — ' + msg)
    }
    // 턴 수를 여기서 센다 (0.6.0 spec/03 §2-1). 주입 이벤트에서 세지 않는 이유는 agy의
    // PreInvocation이 한 턴에 모델 호출 수만큼 뜨기 때문이다. StopFailure는 세지 않는다 —
    // 모델·API 오류로 끊긴 턴에는 돌아볼 것이 없다.
    if (parsed.event === 'Stop') {
      try {
        await bumpTurnCount(sessionDirOf(wsDir))
      } catch {
        /* best-effort — 카운터 때문에 종료 응답을 미루지 않는다 */
      }
    }
    process.stdout.write(JSON.stringify(buildTerminationOutput(parsed.agent)))
    process.exit(0)
  }

  // agy는 PreInvocation이 모델 호출마다 뜬다 — 도구를 n번 쓰면 한 턴에 n+1번이다
  // (research 03 §1-3). 사용자 입력 한 번에 주입 한 번이 되도록 첫 호출에서만 낸다.
  // 주입한 ephemeralMessage가 그 턴 내내 스텝으로 남으므로 되풀이할 이유도 없다.
  // 값을 못 읽으면(null) 게이트를 걸지 않는다 — 판정 불가로 맥락을 통째로 버리지 않는다.
  if (parsed.agent === 'agy') {
    const n = extractInvocationNum(stdinRaw)
    if (n !== null && n !== 0) {
      process.stdout.write(JSON.stringify(buildHookOutput(parsed.agent, parsed.event, '')))
      process.exit(0)
    }
  }

  // 이하 전부 best-effort다. 어떤 실패도 지시문 주입을 막지 않는다.
  let matchBlock = ''
  try {
    matchBlock = buildMatchBlock(
      await matchesForQuery(storageRoot, wsDir, resolveQuery(parsed.agent, stdinRaw))
    )
  } catch (e) {
    process.stderr.write('agentbridge-memory: match skipped — ' + String(e && e.message ? e.message : e) + '\n')
  }

  let proposalBlock = ''
  try {
    if (isProposalTurn(await readTurnCount(sessionDirOf(wsDir)))) proposalBlock = buildProposalBlock()
  } catch {
    /* 카운터를 못 읽으면 제안 블록만 빠진다 */
  }

  let subs = { unread: '', stuck: '' }
  try {
    subs = await buildSubagentBlocks(wsDir, process.env.AGENTBRIDGE_WS_SESSION || '')
  } catch {
    /* best-effort — 이 블록이 없다고 지시문을 막지 않는다 */
  }

  process.stdout.write(
    JSON.stringify(
      buildHookOutput(
        parsed.agent,
        parsed.event,
        wrapInjectedContext(
          buildInstructions(storageRoot, {
            matchBlock,
            proposalBlock,
            subUnread: subs.unread,
            subStuck: subs.stuck
          })
        )
      )
    )
  )
  process.exit(0)
}

// 종료 훅 출력. 종료를 막지 않는 최소 응답을 낸다.
// agy는 `decision`이 required이고 "continue"만 종료를 막는다 → 다른 값을 준다 (research 04 §3).
// claude/codex는 `decision`의 유일한 허용값이 "block"이라 아예 싣지 않는다 (§2).
function buildTerminationOutput(agent) {
  if (agent === 'agy') return { decision: 'stop' }
  return { suppressOutput: true }
}

function buildHookOutput(agent, event, additionalContext) {
  if (agent === 'agy') {
    // 낼 것이 없으면 스텝을 만들지 않는다. 빈 ephemeralMessage도 transcript에 한 줄로 남는다.
    if (!additionalContext) return {}
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
