import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import * as path from 'path'
import type { CliKind, CliPresence, EnvProbeResult } from '@shared/ipc'

const TIMEOUT_MS = 5000
const CLI_KINDS: CliKind[] = ['claude', 'codex', 'agy']

// 사용자 login shell의 PATH 캡처. Electron이 GUI에서 launch될 때 PATH가 빈약하기 때문에
// brew/asdf/nvm 등 사용자 개별 설치 경로를 잡으려면 login interactive zsh를 한 번 거쳐야 한다.
async function captureShellPath(): Promise<{ value?: string; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn('/bin/zsh', ['-ilc', 'echo -n $PATH'], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      resolve({ error: `PATH 캡처 timeout (${TIMEOUT_MS}ms)` })
    }, TIMEOUT_MS)

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      resolve({ error: `zsh spawn 실패: ${err.message}` })
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0 && stdout.length > 0) {
        resolve({ value: stdout.trim() })
      } else {
        resolve({ error: `zsh exit=${code} stderr=${stderr.trim()}` })
      }
    })
  })
}

async function findInPath(name: CliKind, pathValue: string): Promise<string | undefined> {
  const dirs = pathValue.split(':').filter((d) => d.length > 0)
  for (const dir of dirs) {
    const candidate = path.join(dir, name)
    try {
      const stat = await fs.stat(candidate)
      if (stat.isFile()) {
        // X_OK 비트 체크 — symlink 통과
        await fs.access(candidate, fs.constants.X_OK)
        return candidate
      }
    } catch {
      // not found / not executable — 다음 dir
    }
  }
  return undefined
}

async function runVersion(
  name: CliKind,
  binPath: string,
  shellPath: string
): Promise<{ version?: string; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn(binPath, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: shellPath }
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      resolve({ error: `${name} --version timeout` })
    }, TIMEOUT_MS)
    proc.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8')
    })
    proc.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8')
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      resolve({ error: `${name} spawn 실패: ${err.message}` })
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      const firstLine = stdout.split('\n')[0]?.trim()
      if (code === 0 && firstLine) {
        resolve({ version: firstLine })
      } else {
        resolve({ error: `exit=${code} ${(stderr || stdout).trim().slice(0, 200)}` })
      }
    })
  })
}

export async function probeEnv(): Promise<EnvProbeResult> {
  const capturedAt = new Date().toISOString()
  const pathResult = await captureShellPath()
  const shellPath = pathResult.value ?? process.env.PATH ?? ''

  const clis: CliPresence[] = await Promise.all(
    CLI_KINDS.map(async (kind): Promise<CliPresence> => {
      const binPath = await findInPath(kind, shellPath)
      if (!binPath) {
        return { kind, found: false }
      }
      const ver = await runVersion(kind, binPath, shellPath)
      return {
        kind,
        found: true,
        path: binPath,
        version: ver.version,
        error: ver.error
      }
    })
  )

  return {
    shellPath,
    shellPathError: pathResult.error,
    clis,
    capturedAt
  }
}

// 캐시 — main 부팅 시 1회 채워지고 어댑터/IPC 핸들러가 동기 조회.
// 사용자가 CLI를 새로 설치해 강제 갱신이 필요하면 forceRefresh=true 전달.
let cached: EnvProbeResult | null = null
let inflight: Promise<EnvProbeResult> | null = null

export async function probeEnvOnce(forceRefresh = false): Promise<EnvProbeResult> {
  if (!forceRefresh && cached) return cached
  if (!forceRefresh && inflight) return inflight
  inflight = probeEnv().then((r) => {
    cached = r
    inflight = null
    return r
  })
  return inflight
}

export function getCachedEnv(): EnvProbeResult | null {
  return cached
}

export function getCliPath(kind: CliKind): string | undefined {
  return cached?.clis.find((c) => c.kind === kind && c.found)?.path
}

export function getShellPath(): string {
  return cached?.shellPath ?? process.env.PATH ?? ''
}
