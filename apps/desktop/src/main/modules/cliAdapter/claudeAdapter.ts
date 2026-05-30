import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { WebContents } from 'electron'
import log from 'electron-log/main'
import { getCliPath, getShellPath } from '../envProbe'
import { killPty, resizePty, startPty, writePty } from '../ptySession'
import { buildAdapterEnv } from './env'
import { runRefineSpawn } from './refineHeadless'
import type {
  CLIAdapter,
  RefineUsage,
  SpawnInteractiveHooks,
  SpawnInteractiveRequest,
  SpawnInteractiveResult,
  SpawnRefineRequest,
  SpawnRefineResult
} from './types'

// claude는 메시지 교환 *전*까지 ~/.claude/projects/<cwd-encoded>/<UUID>.jsonl을 만들지 않는다
// (HANDOFF별건). 그래서 trust 응답만 하고 닫은 thread를 --resume하면 "No conversation found"로
// 즉시 exit 1. 사용자에게 친절한 에러를 주려면 spawn 전에 jsonl 존재를 확인한다.
// 인코딩(슬래시·점·언더스코어·공백·틸드 → 대시) 알고리즘이 정확히 문서화돼있지 않아 인코딩
// 직접 흉내내지 않고 모든 project 디렉토리를 순회해 jsonl 존재 여부만 확인한다(보수적).
async function claudeSessionFileExists(uuid: string): Promise<boolean> {
  const root = path.join(os.homedir(), '.claude', 'projects')
  let projects: string[]
  try {
    projects = await fs.readdir(root)
  } catch {
    return false
  }
  for (const p of projects) {
    try {
      await fs.access(path.join(root, p, `${uuid}.jsonl`))
      return true
    } catch {
      // 다음 디렉토리
    }
  }
  return false
}

// Claude 어댑터.
// - 새 세션: `claude --session-id <UUID> --settings <claude-settings.json>`
// - 이어가기: `claude --resume <UUID> --settings <claude-settings.json>`
//
// IR 주입은 hook 시스템(M 청크 — claude-settings.json의 SessionStart/UserPromptSubmit hook)이 담당.
// M2의 argv 기반 `--append-system-prompt-file` 흐름은 폐기됨.

async function spawnInteractive(
  req: SpawnInteractiveRequest,
  sender: WebContents,
  hooks: SpawnInteractiveHooks = {}
): Promise<SpawnInteractiveResult> {
  const cliPath = getCliPath('claude')
  if (!cliPath) {
    throw new Error('claude CLI not found in PATH (EnvProbe 결과 미발견)')
  }

  const isNewSession = req.sessionId == null
  const claudeSessionId = req.sessionId ?? randomUUID()
  const args: string[] = []

  // hook config 격리 settings.json을 항상 --settings로 가리킨다. HookInstaller가 미호출 상태면
  // 누락되어 hook 없이 spawn (테스트/오류 fallback).
  const settingsArgs: string[] = []
  if (req.claudeSettingsPath) {
    settingsArgs.push('--settings', req.claudeSettingsPath)
  }

  if (isNewSession) {
    args.push('--session-id', claudeSessionId, ...settingsArgs)
  } else {
    // resume — claude는 메시지 교환 전 닫힌 빈 세션 jsonl을 영속화하지 않는다. resume 시 jsonl 없으면
    // 즉시 exit 1. 빈 세션 reopen 케이스 fallback: 기존 sessionId 유지하면서 새 세션처럼 spawn.
    // 사용자가 첫 메시지 보내면 jsonl이 만들어지고, 다음 reopen은 정상 resume.
    const exists = await claudeSessionFileExists(claudeSessionId)
    if (!exists) {
      log.warn('claude resume 불가 — 새 세션으로 fallback (sessionId 유지)', { claudeSessionId })
      args.push('--session-id', claudeSessionId, ...settingsArgs)
    } else {
      args.push('--resume', claudeSessionId, ...settingsArgs)
    }
  }

  const env = buildAdapterEnv({ shellPath: getShellPath() })
  log.info('claude spawnInteractive', {
    claudeSessionId,
    isNewSession,
    hasSettings: !!req.claudeSettingsPath,
    cwd: req.cwd
  })

  // PTY sessionId는 ptySession이 자체 UUID로 발급(미주입). 같은 claudeSessionId로 빠른 재spawn 시
  // 이전 PTY 인스턴스의 kill IPC가 새 PTY를 잘못 죽이는 race를 회피한다.
  const result = startPty(
    {
      command: cliPath,
      args,
      cwd: req.cwd,
      cols: req.cols,
      rows: req.rows,
      env
    },
    sender,
    hooks
  )
  return { ...result, modelSessionId: claudeSessionId }
}

// claude refine 헤드리스 — `claude -p '<prompt>' --output-format stream-json --verbose
// --permission-mode acceptEdits` (architecture §7.2). stream-json 라인 형식:
//   {"type":"system","subtype":"init",...}
//   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}],...}}
//   {"type":"result","subtype":"success","usage":{...}}
async function spawnRefineIRClaude(req: SpawnRefineRequest): Promise<SpawnRefineResult> {
  const cliPath = getCliPath('claude')
  if (!cliPath) {
    throw new Error('claude CLI not found in PATH')
  }
  const env = buildAdapterEnv({ shellPath: getShellPath() })
  let assistantText = ''
  let usage: RefineUsage | undefined
  log.info('claude spawnRefineIR', {
    promptLen: req.prompt.length,
    cwd: req.cwd,
    modelHint: req.modelHint
  })
  const modelArgs = req.modelHint ? ['--model', req.modelHint] : []
  const base = await runRefineSpawn({
    command: cliPath,
    args: [
      '-p',
      req.prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
      ...modelArgs
    ],
    cwd: req.cwd,
    env,
    stdinPayload: null,
    abortSignal: req.abortSignal,
    timeoutMs: req.timeoutMs,
    onLine: (line) => {
      let evt: unknown
      try {
        evt = JSON.parse(line)
      } catch {
        return
      }
      const o = evt as { type?: string; message?: unknown; usage?: unknown }
      if (o.type === 'assistant' && o.message && typeof o.message === 'object') {
        const m = o.message as { content?: Array<{ type?: string; text?: string }> }
        if (Array.isArray(m.content)) {
          for (const c of m.content) {
            if (c.type === 'text' && typeof c.text === 'string') {
              assistantText += c.text
            }
          }
        }
      } else if (o.type === 'result' && o.usage && typeof o.usage === 'object') {
        const u = o.usage as Record<string, number>
        usage = {
          inputTokens: u.input_tokens,
          outputTokens: u.output_tokens,
          cacheReadTokens: u.cache_read_input_tokens,
          cacheCreationTokens: u.cache_creation_input_tokens
        }
      }
    }
  })
  return { assistantText, usage, ...base }
}

async function hasNativeSession(modelSessionId: string | null): Promise<boolean> {
  if (!modelSessionId) return false
  return claudeSessionFileExists(modelSessionId)
}

// 우리가 발급한 sessionId(UUID)를 가진 jsonl 파일을 모든 project 디렉토리에서 unlink.
// claude의 cwd-encoded 디렉토리명 알고리즘이 정확히 문서화돼있지 않아 각 project 디렉토리를
// 순회하며 매칭 파일 삭제(claudeSessionFileExists와 같은 패턴).
//
// macOS에서 readdir이 .DS_Store 같은 비-디렉토리 entry도 반환하므로 stat으로 isDirectory
// 체크 후 skip. 안 하면 path.join('.DS_Store', '<UUID>.jsonl').unlink가 ENOTDIR로 실패해
// 노이즈 warn 발생.
async function deleteNativeSession(modelSessionId: string | null): Promise<void> {
  if (!modelSessionId) return
  const root = path.join(os.homedir(), '.claude', 'projects')
  let entries: string[]
  try {
    entries = await fs.readdir(root)
  } catch {
    return
  }
  for (const p of entries) {
    const subDir = path.join(root, p)
    try {
      const stat = await fs.stat(subDir)
      if (!stat.isDirectory()) continue
    } catch {
      continue
    }
    const file = path.join(subDir, `${modelSessionId}.jsonl`)
    try {
      await fs.unlink(file)
      log.info('claude native session 삭제', { file })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        log.warn('claude native session 삭제 실패', { file, err: String(err) })
      }
    }
  }
}

export const claudeAdapter: CLIAdapter = {
  kind: 'claude',
  formatChatSubmit: (text) => [{ write: text + '\r' }],
  spawnInteractive,
  write: writePty,
  resize: resizePty,
  killInteractive: killPty,
  spawnRefineIR: spawnRefineIRClaude,
  hasNativeSession,
  deleteNativeSession
}
