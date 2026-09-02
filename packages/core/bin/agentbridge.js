#!/usr/bin/env node
/*
 * agentbridge — 에이전트가 맥락을 가져오는 CLI (0.5.0 B-5).
 *
 * 모델이 자기 셸로 이 명령을 돌리고 출력을 읽는다. 훅이 미는 것은 지시문뿐이고(B-4),
 * IR·최근 턴·장기 기억은 전부 여기로 온다.
 *
 * 훅 헬퍼(agentbridge-memory.js)와 파일을 나눈다. 훅 커맨드 문자열은 A-3에서 영구 동결됐고
 * 이 CLI는 사이클마다 자라므로, 한 파일에 두면 CLI를 고칠 때마다 codex가 훅 신뢰를 다시 묻는다.
 *
 * 호출 형태:  <런타임 절대경로> <루트>/bin/agentbridge.js <명령>
 *
 * `node`로 시작하지 않는다 — 사용자 PATH에 node가 없으면 모델이 명령을 부르고 조용히 실패하고,
 * 맥락이 전부 pull인 뒤라 그 세션은 맥락이 0이 된다(A-3이 고친 것과 같은 고장).
 *
 * 신원은 인자가 아니라 세션을 띄울 때 심은 AGENTBRIDGE_WS_DIR이다. 변수가 없으면 우리 앱 밖에서
 * 켠 세션이므로 아무것도 내지 않고 끝난다.
 */

'use strict'

// @agentbridge-cli-version 0.5.3
// (단일 설치 버전 비교용 — 이 파일을 수정하면 반드시 버전을 올릴 것)

const fs = require('fs')
const path = require('path')

// 명령 본체는 코어 단일 소스. esbuild가 빌드 때 이 require를 인라인한다 — CLI 옆엔 node_modules가 없다.
const {
  readContext,
  readTurns,
  readMemory,
  searchMemory,
  resolveProfileIdForScope
} = require('../src/agentCli/read')
const { addMemory, updateMemory, WriteError } = require('../src/agentCli/write')
const { readStatus } = require('../src/agentCli/status')
const {
  agentList,
  agentRead,
  agentDiff,
  agentCheck,
  agentStart,
  agentSend,
  agentStop,
  agentClose,
  agentCloseRound,
  agentMerge,
  DEFAULT_WAIT_SEC
} = require('../src/agentCli/agent')
const { uninstallGlobal } = require('../src/agentCli/uninstall')

const DEFAULT_TURNS = 3

const COMMANDS = [
  ['context', '현재 프로젝트의 압축된 작업 상태'],
  ['turns [--last N]', '최근 대화 원문 (기본 ' + DEFAULT_TURNS + '턴)'],
  ['memory user [--full]', '사용자 지식. 기본은 요약, --full이 전문'],
  ['memory project [--full]', '이 저장소의 프로젝트 지식'],
  ['memory search <질의>', '두 지식을 질의로 검색'],
  ['memory add', '새 사실을 제안 큐에 넣는다 (--scope --category --title --summary --body)'],
  ['memory update <식별자>', '이미 있는 항목을 고치는 제안 (같은 인자, 안 준 것은 그대로)'],
  ['status', '어디에 무엇이 깔려 있는지와 배선 자가 진단'],
  ['agent start', '서브에이전트를 띄운다 (--prompt "..." [--harness claude,codex,agy] [--isolate])'],
  ['agent list', '띄운 서브의 목록과 상태'],
  ['agent check', '끝난 서브가 있는지 본다 (--wait면 생길 때까지, --for <초>로 상한 조정)'],
  ['agent read <이름>', '그 서브의 기록 전문 (--last N으로 자름)'],
  ['agent diff <이름>', '그 서브가 실제로 바꾼 것 (--stat이면 요약만)'],
  ['agent send <이름>', '도는 서브에 지침을 더 보낸다 (--prompt "...")'],
  ['agent merge <이름>', '그 서브의 변경을 원본에 얹는다 (전부 아니면 아무것도)'],
  ['agent stop <이름>', '서브를 끝낸다'],
  ['agent close <이름>', '서브를 정리한다 (격리였으면 폴더와 브랜치도 지운다)'],
  ['agent close --round', '라운드를 정리한다 (머지된 하나만 남기고 전부)']
]

const USAGE = [
  'agentbridge — AgentBridge 맥락 읽기',
  '',
  '사용법: agentbridge <명령>',
  '',
  ...COMMANDS.map(([name, desc]) => '  ' + name.padEnd(26) + desc)
].join('\n')

function usageAndExit() {
  process.stderr.write(USAGE + '\n')
  process.exit(2)
}

function fail(msg) {
  process.stderr.write('agentbridge: ' + msg + '\n')
  process.exit(2)
}

// 양쪽을 실경로로 맞춘다: node는 __filename을 심링크 해소해서 주는데(macOS /var → /private/var)
// 환경변수로 오는 경로는 해소 전일 수 있어, 그대로 비교하면 같은 자리를 다른 곳으로 본다.
function realpath(v) {
  try {
    return fs.realpathSync(v)
  } catch {
    return path.resolve(v)
  }
}

// 저장소 루트는 이 파일의 자리에서 계산한다 — <루트>/bin/agentbridge.js.
// 커맨드에 저장소 구조가 들어가지 않으므로 폴더를 옮겨도 스킬과 지시문이 그대로다.
function resolveWorkspaceDir() {
  const raw = process.env.AGENTBRIDGE_WS_DIR || ''
  if (!raw) return null
  const storageRoot = realpath(path.dirname(path.dirname(__filename)))
  const wsDir = realpath(raw)
  const rel = path.relative(storageRoot, wsDir)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    fail('AGENTBRIDGE_WS_DIR가 저장소 루트 밖을 가리킨다')
  }
  return wsDir
}

// `--last 5` 형태만 받는다. 값이 숫자가 아니거나 0 이하면 거절한다 — 조용히 기본값으로
// 떨어지면 모델은 자기가 시킨 만큼 받았다고 믿는다.
function intOption(args, name, fallback) {
  const i = args.indexOf(name)
  if (i === -1) return fallback
  const n = Number(args[i + 1])
  if (!Number.isInteger(n) || n <= 0) fail(name + '에는 1 이상의 정수가 온다')
  return n
}

function strOption(args, name) {
  const i = args.indexOf(name)
  if (i === -1) return undefined
  const v = args[i + 1]
  if (v === undefined || v.startsWith('--')) fail(name + '에 값이 없다')
  return v
}

function scopeOption(args) {
  const v = strOption(args, '--scope') || 'user'
  if (v !== 'user' && v !== 'project') fail('--scope는 user 또는 project다')
  return v
}

function writeFields(args) {
  return {
    title: strOption(args, '--title'),
    summary: strOption(args, '--summary'),
    body: strOption(args, '--body')
  }
}

// 호스트 왕복은 이 세션 폴더에 요청을 놓는다. 토큰은 세션을 띄울 때 심은 값이고, 폴더 이름이
// 되므로 단일 세그먼트여야 한다(훅 헬퍼와 같은 가드).
function sessionDir(wsDir) {
  const token = process.env.AGENTBRIDGE_WS_SESSION || ''
  if (!token || token !== path.basename(token)) return undefined
  return path.join(wsDir, 'sessions', token)
}

async function dispatch(cmd, args, wsDir, storageRoot) {
  switch (cmd) {
    case 'context':
      return readContext(wsDir)
    case 'turns':
      return readTurns(wsDir, intOption(args, '--last', DEFAULT_TURNS))
    case 'memory': {
      const sub = args[0]
      if (sub === 'user' || sub === 'project') {
        return readMemory(storageRoot, wsDir, sub, args.includes('--full'))
      }
      if (sub === 'search') {
        const query = args.slice(1).join(' ').trim()
        if (!query) fail('memory search에는 질의가 온다')
        return searchMemory(storageRoot, wsDir, query)
      }
      if (sub === 'add' || sub === 'update') {
        const scope = scopeOption(args)
        const profileId = await resolveProfileIdForScope(wsDir, scope)
        if (!profileId) fail('이 워크스페이스의 프로젝트 지식 자리를 찾을 수 없다')
        if (sub === 'add') {
          return addMemory(storageRoot, profileId, scope, strOption(args, '--category'), writeFields(args))
        }
        const id = args[1]
        if (!id || id.startsWith('--')) fail('memory update에는 식별자가 온다')
        return updateMemory(storageRoot, profileId, scope, id, writeFields(args))
      }
      return usageAndExit()
    }
    case 'agent': {
      const sub = args[0]
      const rest = args.slice(1)
      const caller = process.env.AGENTBRIDGE_WS_SESSION || ''
      // 서브를 다루는 명령은 부르는 세션이 누구인지 알아야 한다. 자기 자식만 대상이기 때문이다.
      if (!caller || caller !== path.basename(caller)) fail('이 세션의 신원을 알 수 없다')
      const nameArg = () => {
        const v = rest[0]
        if (!v || v.startsWith('--')) {
          // close만 이름 없이 부를 자리가 있다. 그 자리를 여기서 알린다 — 라운드 정리가 스펙의
          // 기본 정리 시점이라 모델이 이름 없이 부르는 것이 자연스럽다.
          const alt = sub === 'close' ? '거나 --round가 온다' : '온다'
          fail('agent ' + sub + '에는 서브 이름이 ' + alt)
        }
        return v
      }
      switch (sub) {
        case 'list':
          return agentList(wsDir, caller)
        case 'read': {
          const name = nameArg()
          const i = rest.indexOf('--last')
          return agentRead(wsDir, caller, name, i === -1 ? undefined : intOption(rest, '--last', 0))
        }
        case 'diff':
          return agentDiff(wsDir, caller, nameArg(), { statOnly: rest.includes('--stat') })
        case 'check':
          return agentCheck(wsDir, caller, {
            wait: rest.includes('--wait'),
            forSec: intOption(rest, '--for', DEFAULT_WAIT_SEC)
          })
        case 'start': {
          const prompt = strOption(rest, '--prompt')
          if (!prompt) fail('agent start에는 --prompt가 온다')
          const raw = strOption(rest, '--harness')
          const harnesses = raw ? raw.split(',').map((h) => h.trim()).filter(Boolean) : ['claude']
          return agentStart(sessionDir(wsDir), prompt, harnesses, rest.includes('--isolate'))
        }
        case 'send': {
          const name = nameArg()
          const prompt = strOption(rest, '--prompt')
          if (!prompt) fail('agent send에는 --prompt가 온다')
          return agentSend(sessionDir(wsDir), name, prompt)
        }
        case 'merge':
          return agentMerge(sessionDir(wsDir), nameArg())
        case 'stop':
          return agentStop(sessionDir(wsDir), nameArg())
        case 'close':
          return rest.includes('--round')
            ? agentCloseRound(sessionDir(wsDir))
            : agentClose(sessionDir(wsDir), nameArg())
        default:
          return usageAndExit()
      }
    }
    case 'status':
      return readStatus(storageRoot, wsDir, { sessionDir: sessionDir(wsDir) })
    // 사용자 명령이라 사용법과 스킬의 목록에는 없다. 전역 설정을 걷어내는 일을 모델의
    // 자발적 호출에 열어둘 이유가 없다.
    case 'uninstall':
      return uninstallGlobal()
    default:
      return usageAndExit()
  }
}

async function main() {
  const cmd = process.argv[2]
  const args = process.argv.slice(3)

  // 신원이 먼저다. 변수가 없는 자리(앱 밖 터미널)에서는 어떤 명령도 낼 것이 없다.
  const wsDir = resolveWorkspaceDir()
  if (!wsDir) {
    process.stdout.write(
      'AgentBridge: 이 세션은 AgentBridge 밖에서 열렸다. 낼 맥락이 없다.\n'
    )
    process.exit(0)
  }

  if (!cmd) usageAndExit()

  const storageRoot = realpath(path.dirname(path.dirname(__filename)))

  const out = await dispatch(cmd, args, wsDir, storageRoot)
  process.stdout.write(out + '\n')
}

main().catch((err) => {
  // 입력이 틀린 것과 우리가 깨진 것을 가른다. 앞은 모델이 고쳐 다시 부를 수 있다.
  fail(err instanceof WriteError ? err.message : String((err && err.message) || err))
})
