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

// @agentbridge-cli-version 0.5.0
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

const DEFAULT_TURNS = 3

const COMMANDS = [
  ['context', '현재 프로젝트의 압축된 작업 상태'],
  ['turns [--last N]', '최근 대화 원문 (기본 ' + DEFAULT_TURNS + '턴)'],
  ['memory user [--full]', '사용자 지식. 기본은 요약, --full이 전문'],
  ['memory project [--full]', '이 저장소의 프로젝트 지식'],
  ['memory search <질의>', '두 지식을 질의로 검색'],
  ['memory add', '새 사실을 제안 큐에 넣는다 (--scope --category --title --summary --body)'],
  ['memory update <식별자>', '이미 있는 항목을 고치는 제안 (같은 인자, 안 준 것은 그대로)']
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
