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

// @agentbridge-helper-version 0.6.0
// (단일 설치 버전 비교용 — 이 파일을 수정하면 반드시 버전을 올릴 것)

const fs = require('fs')
const path = require('path')

// 미읽음 판정은 코어 단일 소스를 쓴다. esbuild가 빌드 때 이 require를 인라인한다.
const { isUnread } = require('../src/agent/reportState')

// 코어 단일 소스. esbuild가 빌드 때 이 require를 인라인한다(옵션 나) — 런타임 헬퍼 옆엔
// node_modules가 없어 require('@agentbridge/core')가 불가하다.
//
// 검색·IR 렌더는 더 이상 여기서 안 쓴다(0.5.0 B-4). 그 자리는 에이전트용 CLI로 옮겼다.
const { extractSessionIdFromStdin } = require('../src/globalInject')
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


// 훅이 나르는 것은 지시문 하나다 (0.5.0 B-4). IR도 최근 턴도 사용자 지식도 프로젝트 지식도
// 모델이 도구를 불러야 온다. 미리 밀어넣는 내용은 없다.
//
// 왜 우리가 고르지 않는가 — 첫 턴에 무엇이 필요한지는 상황이 아니라 질문이 정한다. 우리가 쓸 수
// 있는 신호는 마지막 턴으로부터 지난 시간 정도이고, 모델은 질문을 읽는다. 정보가 많은 쪽이
// 고르는 것이 맞다.
//
// 그래서 이 문장들이 제품의 전부가 된다. 매 턴 들어가는 유일한 것이므로 작아야 하고 동시에
// 언제 무엇을 부를지를 정확히 말해야 한다. "필요하면 불러라"가 아니라 조건을 열거한다.
//
// 실행 경로는 훅과 같은 규칙으로 만든다 — 이 헬퍼를 돌린 런타임과 저장소의 canonical CLI.
// 사용자 PATH의 node에 기대지 않는다(A-3).
// 안 읽은 서브 보고 한 줄 (0.5.0 4단계 W5, B-6).
//
// 메인이 기다리지 않았거나 대기가 상한에 걸려 돌아왔으면, 다음 턴에 이 줄이 붙는다. 수와 읽는
// 방법만 적고 보고 본문은 넣지 않는다 — 본문은 `agent read`가 낸다.
//
// 우리가 메인의 PTY에 타이핑하지 않는 이유가 이 줄이다. 통로가 이미 있으므로 사용자 입력과
// 경합하는 타이핑을 붙일 이유가 없다.
async function buildSubagentLine(wsDir, sessionToken, run) {
  if (!sessionToken || sessionToken !== path.basename(sessionToken)) return ''
  let sessions = []
  try {
    sessions = JSON.parse(fs.readFileSync(path.join(wsDir, 'workspace.json'), 'utf8')).sessions || []
  } catch {
    return ''
  }
  const mine = sessions.filter((s) => s.parentSessionId === sessionToken && s.agentName)
  if (mine.length === 0) return ''
  const unread = []
  for (const s of mine) {
    if (await isUnread(wsDir, s.sessionId)) unread.push(s.agentName)
  }
  if (unread.length === 0) return ''
  return (
    '\n\n' +
    unread.length +
    ' subagent report(s) finished and unread (' +
    unread.join(', ') +
    '). Read with `' +
    run +
    ' agent read <name>`.'
  )
}

function buildInstructions(storageRoot) {
  const run = renderRunPrefix({
    execPath: process.execPath,
    cliPath: path.join(storageRoot, 'bin', 'agentbridge.js')
  })
  return [
    'AgentBridge carries working context across sessions and across coding agents.',
    'None of it is in this prompt. Run a command to see it:',
    '',
    '    ' + run + ' <command>',
    '',
    'Run these when the condition holds, not "if it seems useful":',
    '',
    '- Starting work on this project this session — `context`',
    '- The user refers to something from before ("아까 그거", "what we decided",',
    '  "continue where we left off") — `turns --last 5`',
    '- A question about a past decision\'s rationale, or how this user wants things done',
    '  (style, tooling, workflow, conventions) — `memory search "<query>"`',
    '- A question about this repository\'s own rules or history — `memory project`',
    '- The user states something durable (a preference, a convention, a decision that should',
    '  outlive this session) — read that side in full first, then `memory add` or',
    '  `memory update <id>`. Both go to a queue the user approves.',
    '',
    'Run `status` if a command fails and you need to know whether the wiring is alive.',
    '',
    'Respond in the language the user writes in. Mixed sessions follow the most recent turn.'
  ].join('\n')
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
    process.stdout.write(JSON.stringify(buildTerminationOutput(parsed.agent)))
    process.exit(0)
  }

  // §G3 글로벌 메모리 검색 — additive·best-effort. 어떤 실패도 IR/turns 주입을 막지 않는다.
  const run = renderRunPrefix({
    execPath: process.execPath,
    cliPath: path.join(storageRoot, 'bin', 'agentbridge.js')
  })
  let subagentLine = ''
  try {
    subagentLine = await buildSubagentLine(wsDir, process.env.AGENTBRIDGE_WS_SESSION || '', run)
  } catch {
    /* best-effort — 이 줄이 없다고 지시문을 막지 않는다 */
  }
  process.stdout.write(
    JSON.stringify(
      buildHookOutput(
        parsed.agent,
        parsed.event,
        wrapInjectedContext(buildInstructions(storageRoot) + subagentLine)
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
