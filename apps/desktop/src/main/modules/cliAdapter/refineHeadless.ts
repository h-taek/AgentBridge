import { spawn, type ChildProcess } from 'child_process'
import log from 'electron-log/main'
import type { SpawnRefineResult } from './types'

// refine 헤드리스 spawn 공통 헬퍼.
//
// 설계:
// - child_process.spawn (PTY 아님 — refine은 stream-json 출력만 받으면 충분, 인터랙티브 X).
// - stdout JSONL 라인별 누적. 모델별 parser는 호출자 측이 주입(LineHandler).
// - stderr는 통째로 수집 후 결과에 포함 (진단용).
// - AbortSignal: SIGTERM(grace 1초) → SIGKILL escalate (architecture §7.4).
// - timeout: 기본 60초 — refine 호출이 길어지면 사용자가 cancel하거나 timeout으로 종료.

export type LineHandler = (line: string) => void

export type RunRefineSpawnOptions = {
  command: string
  args: string[]
  cwd?: string
  env: Record<string, string>
  // codex처럼 stdin으로 prompt 보내는 모델용. null/undefined면 stdin close.
  stdinPayload?: string | null
  // 라인 단위 콜백 — 모델별 parser. 호출자가 assistantText/usage 누적.
  onLine: LineHandler
  abortSignal?: AbortSignal
  timeoutMs?: number
}

const KILL_GRACE_MS = 1_000
const DEFAULT_TIMEOUT_MS = 60_000

export async function runRefineSpawn(
  opts: RunRefineSpawnOptions
): Promise<Pick<SpawnRefineResult, 'rawLines' | 'exitCode' | 'stderr' | 'durationMs'>> {
  const start = Date.now()
  const rawLines: string[] = []
  let stderrBuf = ''

  const child: ChildProcess = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe']
  })

  // stdin 처리 — payload 있으면 write 후 close, 없으면 즉시 close.
  if (child.stdin) {
    if (opts.stdinPayload && opts.stdinPayload.length > 0) {
      child.stdin.write(opts.stdinPayload)
    }
    child.stdin.end()
  }

  // stdout 라인 누적 — 부분 라인 buffer 유지.
  let stdoutCarry = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    const combined = stdoutCarry + chunk
    const lines = combined.split('\n')
    stdoutCarry = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      rawLines.push(trimmed)
      try {
        opts.onLine(trimmed)
      } catch (err) {
        log.warn('refine onLine 콜백 실패', { err: String(err), line: trimmed.slice(0, 200) })
      }
    }
  })
  child.stdout?.on('end', () => {
    const tail = stdoutCarry.trim()
    if (tail.length > 0) {
      rawLines.push(tail)
      try {
        opts.onLine(tail)
      } catch (err) {
        log.warn('refine onLine 콜백 실패(tail)', { err: String(err) })
      }
    }
  })

  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    stderrBuf += chunk
  })

  // SIGTERM grace → SIGKILL escalate (architecture §7.4).
  const escalateKill = (): void => {
    try {
      child.kill('SIGTERM')
    } catch {
      // 이미 종료
      return
    }
    setTimeout(() => {
      if (child.exitCode == null && child.signalCode == null) {
        try {
          child.kill('SIGKILL')
        } catch {
          // race
        }
      }
    }, KILL_GRACE_MS).unref()
  }

  // abort signal — 사용자가 handoff:cancel 등으로 abort 트리거 시.
  const onAbort = (): void => {
    log.info('refine spawn abort 신호 수신', { command: opts.command })
    escalateKill()
  }
  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) {
      escalateKill()
    } else {
      opts.abortSignal.addEventListener('abort', onAbort, { once: true })
    }
  }

  // 전체 timeout — 너무 오래 걸리면 강제 종료.
  const timeoutHandle = setTimeout(() => {
    log.warn('refine spawn timeout — 강제 종료', {
      command: opts.command,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    })
    escalateKill()
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  timeoutHandle.unref()

  return new Promise((resolve, reject) => {
    child.on('error', (err) => {
      clearTimeout(timeoutHandle)
      if (opts.abortSignal) opts.abortSignal.removeEventListener('abort', onAbort)
      reject(err)
    })
    child.on('close', (exitCode) => {
      clearTimeout(timeoutHandle)
      if (opts.abortSignal) opts.abortSignal.removeEventListener('abort', onAbort)
      resolve({
        rawLines,
        exitCode,
        stderr: stderrBuf,
        durationMs: Date.now() - start
      })
    })
  })
}
