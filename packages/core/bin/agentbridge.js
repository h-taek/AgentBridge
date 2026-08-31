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

// 렌더는 코어 단일 소스. esbuild가 빌드 때 이 require를 인라인한다 — CLI 옆엔 node_modules가 없다.
const { renderIrSections } = require('../src/agentCli/irRender')

const COMMANDS = [['context', '현재 프로젝트의 압축된 작업 상태']]

const USAGE = [
  'agentbridge — AgentBridge 맥락 읽기',
  '',
  '사용법: agentbridge <명령>',
  '',
  ...COMMANDS.map(([name, desc]) => '  ' + name.padEnd(18) + desc)
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

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

function cmdContext(wsDir) {
  const ir = readJsonSafe(path.join(wsDir, 'ir.json'))
  if (!ir) {
    process.stdout.write('저장된 작업 상태가 없다. 아직 압축된 맥락이 쌓이지 않았다.\n')
    return
  }
  process.stdout.write('## 작업 상태 (압축된 맥락)\n\n' + renderIrSections(ir) + '\n')
}

function main() {
  const cmd = process.argv[2]

  // 신원이 먼저다. 변수가 없는 자리(앱 밖 터미널)에서는 어떤 명령도 낼 것이 없다.
  const wsDir = resolveWorkspaceDir()
  if (!wsDir) {
    process.stdout.write(
      'AgentBridge: 이 세션은 AgentBridge 밖에서 열렸다. 낼 맥락이 없다.\n'
    )
    process.exit(0)
  }

  if (!cmd) usageAndExit()

  switch (cmd) {
    case 'context':
      cmdContext(wsDir)
      break
    default:
      usageAndExit()
  }
}

main()
