import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import { promises as fs } from 'fs'
import * as path from 'path'
import log from 'electron-log/main'
import type { CliKind } from '@shared/ipc'

// HookInstaller — M3 M 청크. architecture §14.8/§14.11.
//
// 책임:
//   1) agentbridge-memory 헬퍼 binary 절대경로 해석 (dev/prod 분기)
//   2) CLI별 hook config 생성 — claude는 우리 Application Support 안 격리 파일,
//      codex/gemini는 사용자 워크스페이스 cwd에 마커 블록 merge
//   3) 마커 블록 merge 정책 — 사용자 콘텐츠 보존, 우리 entry만 식별·갱신·제거 가능
//
// 마커 정책:
//   - JSON 파일: 우리 entry에 `_agentbridge_managed: true` 플래그
//   - markdown/TOML: `<!-- AgentBridge:start --> ... <!-- AgentBridge:end -->` 또는
//     `# AgentBridge:start` ... `# AgentBridge:end` (TOML 주석은 # 기반)
//
// Cwd 침범 정책 — architecture §15.2 (2026 agy 리브랜드 시점에 갱신):
//   - 사용자 워크스페이스 cwd엔 3 파일만 생성:
//     .codex/hooks.json / .codex/config.toml / .agents/hooks.json
//   - claude는 우리 Application Support 안 격리 settings.json만 (cwd 무침범)
//   - 사용자가 직접 만든 cwd/AGENTS.md / CLAUDE.md / GEMINI.md는 절대 건드리지 않음
//     (memory.instructionsCreate는 사용자 명시 액션으로만 빈 파일 생성)
//   - legacy `.gemini/settings.json`(이전 버전 hook 설치 잔재)은 agy hook 설치 시 자동 정리

const TOML_MARKER_START = '# AgentBridge:start'
const TOML_MARKER_END = '# AgentBridge:end'

// dev/prod 모두에서 resources/bin/agentbridge-memory.js 절대경로를 반환.
// dev: <repo>/resources/bin/... (app.getAppPath()가 repo root)
// prod: <.app>/Contents/Resources/app.asar.unpacked/resources/bin/... — electron-builder가
//       asarUnpack 패턴(`resources/**`)에 매칭된 파일을 app.asar 옆 `app.asar.unpacked/<원경로>`에
//       풀어두므로, 호스트 셸 hook(외부 프로세스 spawn)이 실제 디스크 파일로 접근하려면 이 경로 사용.
export function getHelperBinaryPath(): string {
  if (is.dev) {
    return path.join(app.getAppPath(), 'resources', 'bin', 'agentbridge-memory.js')
  }
  return path.join(
    process.resourcesPath,
    'app.asar.unpacked',
    'resources',
    'bin',
    'agentbridge-memory.js'
  )
}

// node CLI 절대경로 — 현재는 user의 PATH 안 node 가정. M4 패키징 단계에서 Electron 자체를
// ELECTRON_RUN_AS_NODE=1로 실행하는 launcher script 도입 검토. M3에서는 dev 환경 검증 우선.
function getNodeCommand(): string {
  return 'node'
}

// hook command 직렬화 — 셸이 해석할 단일 문자열. 공백 포함 경로는 따옴표 처리.
// CLI hook spec은 single command string을 받는다 (object form은 별도 args 배열이지만 우리는
// command form 단일 문자열로 통일).
function quoteArg(s: string): string {
  if (s.length === 0) return "''"
  if (/^[A-Za-z0-9_./:@%+-]+$/.test(s)) return s
  // single-quote escape: ' → '"'"'
  return "'" + s.replace(/'/g, "'\"'\"'") + "'"
}

// hook 이벤트 이름 — helper binary가 stdout JSON의 hookEventName으로 *정확히 일치하는 값*을 emit해야
// 한다. 그렇지 않으면 CLI host가 "expected X but got Y" 에러로 hook을 거부 (claude는 warning, codex
// 는 fatal로 자발 종료 가능성). 따라서 hook command에 --event 인자로 박는다.
//
// agy(Antigravity) 이벤트:
//   - PreInvocation: 모델 호출 직전 (= 매 turn 시작점, 메모리 inject용)
//   - PostInvocation: 도구 호출 후 모델 다음 turn 직전
//   - Stop: execution loop 종료 시
//   - PreToolUse / PostToolUse: 도구 호출 전후
// agy schema는 구 gemini의 SessionStart/BeforeAgent와 *완전 다르다*. 라이브 검증 후 보완 가능.
export type HookEventName =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'BeforeAgent'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Stop'
  | 'PreInvocation'
  | 'PostInvocation'

export function buildHookCommand(opts: {
  helperPath: string
  agent: CliKind
  workspaceId: string
  userDataPath: string
  event: HookEventName
}): string {
  return [
    quoteArg(getNodeCommand()),
    quoteArg(opts.helperPath),
    'inject',
    '--agent',
    opts.agent,
    '--workspace',
    quoteArg(opts.workspaceId),
    '--user-data',
    quoteArg(opts.userDataPath),
    '--event',
    opts.event
  ].join(' ')
}

// atomic write — tmp + rename. 사용자가 동시에 같은 파일 수동 편집 중일 때 partial write 방지.
async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(tmp, content, 'utf8')
  await fs.rename(tmp, filePath)
}

async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    throw err
  }
}

// ─── claude — Application Support 안 격리 settings.json ────────────────
//
// claude는 cwd 안 .claude/ 디렉토리 생성 안 함 (architecture §14.2). spawn 시 `--settings <path>`로
// 우리 격리 파일을 지정. 마커 블록 merge 불필요 — 통째로 우리 소유.

export function getClaudeSettingsPath(workspaceSettingsDir: string): string {
  return path.join(workspaceSettingsDir, 'claude-settings.json')
}

export async function writeClaudeSettings(opts: {
  settingsPath: string
  helperPath: string
  workspaceId: string
  userDataPath: string
}): Promise<void> {
  // architecture §14.8 — SessionStart + UserPromptSubmit 두 이벤트 모두 inject.
  // SessionStart는 spawn 직후 1회, UserPromptSubmit은 매 사용자 메시지마다 (alive 탭 freshness).
  //
  // 각 이벤트는 helper를 *해당 이벤트 이름으로* 호출 — hookEventName mismatch 방지.
  const commandFor = (event: HookEventName): string =>
    buildHookCommand({
      helperPath: opts.helperPath,
      agent: 'claude',
      workspaceId: opts.workspaceId,
      userDataPath: opts.userDataPath,
      event
    })
  const settings = {
    hooks: {
      SessionStart: [
        {
          matcher: '*',
          hooks: [{ type: 'command', command: commandFor('SessionStart') }]
        }
      ],
      UserPromptSubmit: [
        {
          hooks: [{ type: 'command', command: commandFor('UserPromptSubmit') }]
        }
      ]
    }
  }
  await atomicWriteFile(opts.settingsPath, JSON.stringify(settings, null, 2))
}

// ─── 마커 블록 merge — JSON ─────────────────────────────────────────────
//
// .codex/hooks.json / .gemini/settings.json 모두 hooks 객체 기반. 우리 entry는
// `_agentbridge_managed: true` 플래그로 식별. 사용자 다른 entry는 그대로 보존.
//
// 사용자가 동일 hook 이름(SessionStart/UserPromptSubmit/BeforeAgent)에 자기 entry를 추가한
// 경우 — 우리 entry는 *추가*되고 식별 가능 (사용자 entry는 _agentbridge_managed 없음).

type HookEntry = {
  matcher?: string
  hooks: Array<{ type: 'command'; command: string }>
  _agentbridge_managed?: true
}

type HooksRoot = {
  hooks?: Record<string, HookEntry[]>
} & Record<string, unknown>

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function mergeHooksJson(existing: HooksRoot, ourEntries: Record<string, HookEntry>): HooksRoot {
  const merged: HooksRoot = { ...existing }
  const hooksMap = isObject(existing.hooks)
    ? ({ ...(existing.hooks as Record<string, HookEntry[]>) } as Record<string, HookEntry[]>)
    : ({} as Record<string, HookEntry[]>)

  for (const [eventName, ourEntry] of Object.entries(ourEntries)) {
    const current = Array.isArray(hooksMap[eventName]) ? hooksMap[eventName] : []
    // 기존 우리 entry 식별 + 제거 (재install 시 갱신)
    const userEntries = current.filter((e) => !(isObject(e) && e._agentbridge_managed === true))
    hooksMap[eventName] = [...userEntries, { ...ourEntry, _agentbridge_managed: true }]
  }

  merged.hooks = hooksMap
  return merged
}

// ─── codex — cwd/.codex/hooks.json 마커 블록 merge ──────────────────────
//
// architecture §14.8:
//   - SessionStart matcher = "^(start|startup|clear|resume)$" — codex가 spawn 초기에 fire
//   - UserPromptSubmit — 매 메시지마다
//
// codex `/hooks` trust 게이트: 첫 spawn 시 사용자가 codex 안에서 `/hooks` 슬래시 명령으로
// 수동 승인 필요 (probe 08 결정). HookInstaller는 파일만 쓰고 trust는 UI 안내.

export async function installCodexHooks(opts: {
  cwd: string
  helperPath: string
  workspaceId: string
  userDataPath: string
}): Promise<{ hooksJsonPath: string; configTomlPath: string }> {
  const codexDir = path.join(opts.cwd, '.codex')
  const hooksJsonPath = path.join(codexDir, 'hooks.json')
  const configTomlPath = path.join(codexDir, 'config.toml')
  const commandFor = (event: HookEventName): string =>
    buildHookCommand({
      helperPath: opts.helperPath,
      agent: 'codex',
      workspaceId: opts.workspaceId,
      userDataPath: opts.userDataPath,
      event
    })

  // hooks.json — 사용자 콘텐츠 보존 + 우리 entry 마킹
  const raw = await readFileIfExists(hooksJsonPath)
  let existing: HooksRoot = {}
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (isObject(parsed)) existing = parsed
    } catch {
      // 깨진 사용자 JSON — 백업하고 fresh로 시작 (사용자 데이터 손상 방지)
      const backup = `${hooksJsonPath}.broken.${Date.now()}.bak`
      try {
        await fs.writeFile(backup, raw, 'utf8')
        log.warn('codex hooks.json 파싱 실패 — 백업 후 fresh 작성', { hooksJsonPath, backup })
      } catch {
        /* noop */
      }
    }
  }
  const merged = mergeHooksJson(existing, {
    SessionStart: {
      matcher: '^(start|startup|clear|resume)$',
      hooks: [{ type: 'command', command: commandFor('SessionStart') }]
    },
    UserPromptSubmit: {
      hooks: [{ type: 'command', command: commandFor('UserPromptSubmit') }]
    }
  })
  await atomicWriteFile(hooksJsonPath, JSON.stringify(merged, null, 2))

  // config.toml — [features].hooks = true 마커 블록. TOML 파싱 라이브러리 의존 회피 위해
  // 마커 블록 단순 append/replace 패턴 사용.
  //
  // codex 신버전이 `[features].codex_hooks` → `[features].hooks`로 rename. deprecated 키를
  // *명시*하면 신버전이 매 spawn마다 deprecation 경고를 출력하므로 신버전 키만 emit.
  // 구버전 사용자는 codex CLI 업데이트 후 hook 동작 — 워크스페이스 reopen 시 재install로 갱신.
  await mergeTomlMarkerBlock(configTomlPath, ['[features]', 'hooks = true'].join('\n'))

  return { hooksJsonPath, configTomlPath }
}

// ─── agy(Antigravity) — cwd/.agents/hooks.json 마커 블록 merge ─────────
//
// agy hook schema (agy 1.0.0 — `agy /hooks` 슬래시 명령 + binary string 분석 기반):
//   {
//     "<unique-hook-name>": {
//       "enabled": true,
//       "PreInvocation": [ { "type": "command", "command": "..." } ],
//       "PostInvocation": [...],
//       "Stop": [...]
//     }
//   }
// 구 gemini의 hooks: { SessionStart, BeforeAgent } 객체와 *완전 다름*. agy는 top-level이
// "hooks" 래퍼 없이 각 hook 이름이 root key가 된다.
//
// 이벤트 매핑:
//   - 메모리 inject = PreInvocation (매 모델 호출 직전 = 매 turn 시작점)
//   - PostInvocation/Stop은 향후 turn 기록 trigger 등에 활용 가능 (현재는 미사용)
//
// 파일 위치: <cwd>/.agents/hooks.json (project-level). agy global hooks는 `~/.gemini/config/hooks.json`.

type AgyHookAction = {
  type: 'command'
  command: string
}

type AgyHookGroup = {
  enabled?: boolean
  PreInvocation?: AgyHookAction[]
  PostInvocation?: AgyHookAction[]
  Stop?: AgyHookAction[]
  PreToolUse?: AgyHookAction[]
  PostToolUse?: AgyHookAction[]
  // AgentBridge 식별용 — 우리 entry만 골라 갱신/제거할 수 있게.
  _agentbridge_managed?: true
}

type AgyHooksRoot = Record<string, AgyHookGroup>

const AGENTBRIDGE_HOOK_NAME = 'agentbridge-memory'

export async function installAgyHooks(opts: {
  cwd: string
  helperPath: string
  workspaceId: string
  userDataPath: string
}): Promise<{ hooksJsonPath: string; legacyCleaned: boolean }> {
  const agentsDir = path.join(opts.cwd, '.agents')
  const hooksJsonPath = path.join(agentsDir, 'hooks.json')
  const commandFor = (event: HookEventName): string =>
    buildHookCommand({
      helperPath: opts.helperPath,
      agent: 'agy',
      workspaceId: opts.workspaceId,
      userDataPath: opts.userDataPath,
      event
    })

  const raw = await readFileIfExists(hooksJsonPath)
  let existing: AgyHooksRoot = {}
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (isObject(parsed)) existing = parsed as AgyHooksRoot
    } catch {
      const backup = `${hooksJsonPath}.broken.${Date.now()}.bak`
      try {
        await fs.writeFile(backup, raw, 'utf8')
        log.warn('agy .agents/hooks.json 파싱 실패 — 백업 후 fresh 작성', {
          hooksJsonPath,
          backup
        })
      } catch {
        /* noop */
      }
    }
  }

  // 우리 entry 식별·갱신 — _agentbridge_managed 플래그 또는 이름 기반.
  // 사용자가 만든 다른 hook entry는 그대로 보존.
  const merged: AgyHooksRoot = { ...existing }
  merged[AGENTBRIDGE_HOOK_NAME] = {
    enabled: true,
    PreInvocation: [{ type: 'command', command: commandFor('PreInvocation') }],
    _agentbridge_managed: true
  }

  await atomicWriteFile(hooksJsonPath, JSON.stringify(merged, null, 2))

  // legacy cleanup — 이전 버전 hook 설치 잔재인 cwd/.gemini/settings.json의 우리 entry 제거.
  const legacyCleaned = await cleanupLegacyGeminiSettings(opts.cwd)

  return { hooksJsonPath, legacyCleaned }
}

// 구버전(M3 N 이전)에서 `installGeminiHooks`가 만든 cwd/.gemini/settings.json의
// `_agentbridge_managed` entry를 제거. 다른 사용자 콘텐츠는 보존.
async function cleanupLegacyGeminiSettings(cwd: string): Promise<boolean> {
  const legacyPath = path.join(cwd, '.gemini', 'settings.json')
  const raw = await readFileIfExists(legacyPath)
  if (!raw) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return false
  }
  if (!isObject(parsed)) return false
  const root = parsed as HooksRoot
  if (!isObject(root.hooks)) return false
  const hooksMap = root.hooks as Record<string, HookEntry[]>
  let touched = false
  for (const [name, entries] of Object.entries(hooksMap)) {
    if (!Array.isArray(entries)) continue
    const filtered = entries.filter((e) => !(isObject(e) && e._agentbridge_managed === true))
    if (filtered.length !== entries.length) {
      touched = true
      if (filtered.length === 0) {
        delete hooksMap[name]
      } else {
        hooksMap[name] = filtered
      }
    }
  }
  if (!touched) return false
  // hooks가 비어있으면 hooks 키 자체 제거, root가 비어있으면 파일 삭제.
  if (Object.keys(hooksMap).length === 0) {
    delete root.hooks
  } else {
    root.hooks = hooksMap
  }
  if (Object.keys(root).length === 0) {
    try {
      await fs.unlink(legacyPath)
      log.info('legacy .gemini/settings.json 제거', { legacyPath })
    } catch {
      /* noop */
    }
    return true
  }
  await atomicWriteFile(legacyPath, JSON.stringify(root, null, 2))
  log.info('legacy .gemini/settings.json _agentbridge_managed entry 정리', { legacyPath })
  return true
}

// ─── TOML 마커 블록 merge ──────────────────────────────────────────────
//
// config.toml만 사용. 과거 AGENTS.override.md 채널은 폐기됨 (2026-05-11) — codex hook이 정상
// 동작하면 매 turn IR이 inject되어 1회 auto-load 백업이 잉여. trust 미승인 시도 첫 turn에만
// 작용해 차별점(매 메시지 freshness)이 어차피 깨짐. cwd 침범 최소화 정책 5에 따라 제거.

async function mergeTomlMarkerBlock(filePath: string, ourBlock: string): Promise<void> {
  const existing = (await readFileIfExists(filePath)) ?? ''
  const wrapped = `${TOML_MARKER_START}\n${ourBlock}\n${TOML_MARKER_END}`
  const escapedStart = TOML_MARKER_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const escapedEnd = TOML_MARKER_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`${escapedStart}[\\s\\S]*?${escapedEnd}`, 'm')
  let newContent: string
  if (pattern.test(existing)) {
    newContent = existing.replace(pattern, wrapped)
  } else if (existing.trim().length > 0) {
    newContent = existing + (existing.endsWith('\n') ? '\n' : '\n\n') + wrapped + '\n'
  } else {
    newContent = wrapped + '\n'
  }
  await atomicWriteFile(filePath, newContent)
}

// ─── 통합 install — 워크스페이스 + 모델별 dispatch ─────────────────────
//
// sessions:create/open 시점에 호출. 모델별로 cwd에 해당 hook config만 작성 (예: claude 탭이면
// codex/gemini cwd 파일은 안 건드림).

export type InstallHooksResult = {
  // claude --settings 인자로 전달할 절대경로 (claude일 때만)
  claudeSettingsPath?: string
  // codex hooks.json 위치 (codex일 때만)
  codexHooksJsonPath?: string
  // agy hooks.json 위치 (agy일 때만)
  agyHooksJsonPath?: string
  // legacy .gemini/settings.json _agentbridge_managed entry가 정리된 경우 true (agy 설치 시)
  legacyGeminiCleaned?: boolean
}

export async function installHooksForSession(opts: {
  model: CliKind
  workspaceId: string
  workspaceCwd: string
  workspaceSettingsDir: string
  userDataPath: string
}): Promise<InstallHooksResult> {
  const helperPath = getHelperBinaryPath()
  // helper binary 존재 가드 — 누락 시 spawn해도 hook이 silent fail함. 사용자에게 명확한 에러.
  try {
    await fs.access(helperPath)
  } catch {
    throw new Error(
      `agentbridge-memory helper binary not found at ${helperPath} — dev: resources/bin/agentbridge-memory.js 존재 확인`
    )
  }

  const result: InstallHooksResult = {}
  switch (opts.model) {
    case 'claude': {
      const settingsPath = getClaudeSettingsPath(opts.workspaceSettingsDir)
      await writeClaudeSettings({
        settingsPath,
        helperPath,
        workspaceId: opts.workspaceId,
        userDataPath: opts.userDataPath
      })
      result.claudeSettingsPath = settingsPath
      break
    }
    case 'codex': {
      const { hooksJsonPath } = await installCodexHooks({
        cwd: opts.workspaceCwd,
        helperPath,
        workspaceId: opts.workspaceId,
        userDataPath: opts.userDataPath
      })
      result.codexHooksJsonPath = hooksJsonPath
      break
    }
    case 'agy': {
      const { hooksJsonPath, legacyCleaned } = await installAgyHooks({
        cwd: opts.workspaceCwd,
        helperPath,
        workspaceId: opts.workspaceId,
        userDataPath: opts.userDataPath
      })
      result.agyHooksJsonPath = hooksJsonPath
      result.legacyGeminiCleaned = legacyCleaned
      break
    }
  }
  log.info('HookInstaller — session hook install', {
    model: opts.model,
    workspaceId: opts.workspaceId,
    result
  })
  return result
}
