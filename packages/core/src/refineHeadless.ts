// headless refine subprocess 실행 — 주어진 명령을 spawn하고 stdout을 줄 단위로 onLine에 전달.
// timeout/abort/grace SIGTERM→SIGKILL 처리 포함.

import { spawn, type ChildProcess } from 'child_process';
import type { Logger } from './interfaces';
import { noopLogger } from './interfaces';

export type SpawnRefineResult = {
  assistantText: string;
  exitCode: number | null;
  stderr: string;
  durationMs: number;
  rawLines: string[];
};

export type RunRefineSpawnOptions = {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  stdinPayload?: string | null;
  onLine: (line: string) => void;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  logger?: Logger;
};

const KILL_GRACE_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 60_000;

export async function runRefineSpawn(
  opts: RunRefineSpawnOptions,
): Promise<Pick<SpawnRefineResult, 'rawLines' | 'exitCode' | 'stderr' | 'durationMs'>> {
  const log = opts.logger ?? noopLogger;
  const start = Date.now();
  const rawLines: string[] = [];
  let stderrBuf = '';

  const child: ChildProcess = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (child.stdin) {
    if (opts.stdinPayload && opts.stdinPayload.length > 0) child.stdin.write(opts.stdinPayload);
    child.stdin.end();
  }

  let stdoutCarry = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    const combined = stdoutCarry + chunk;
    const lines = combined.split('\n');
    stdoutCarry = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      rawLines.push(trimmed);
      try {
        opts.onLine(trimmed);
      } catch {
        /* skip */
      }
    }
  });
  child.stdout?.on('end', () => {
    const tail = stdoutCarry.trim();
    if (tail.length > 0) {
      rawLines.push(tail);
      try {
        opts.onLine(tail);
      } catch {
        /* skip */
      }
    }
  });

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrBuf += chunk;
  });

  const escalateKill = (): void => {
    try {
      child.kill('SIGTERM');
    } catch {
      return;
    }
    setTimeout(() => {
      if (child.exitCode == null && child.signalCode == null) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* race */
        }
      }
    }, KILL_GRACE_MS).unref();
  };

  const onAbort = (): void => {
    log.log('refine spawn abort signal received');
    escalateKill();
  };
  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) escalateKill();
    else opts.abortSignal.addEventListener('abort', onAbort, { once: true });
  }

  const timeoutHandle = setTimeout(() => {
    log.warn('refine spawn timeout — killing');
    escalateKill();
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timeoutHandle.unref();

  return new Promise((resolve, reject) => {
    child.on('error', (err) => {
      clearTimeout(timeoutHandle);
      opts.abortSignal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (exitCode) => {
      clearTimeout(timeoutHandle);
      opts.abortSignal?.removeEventListener('abort', onAbort);
      resolve({ rawLines, exitCode, stderr: stderrBuf, durationMs: Date.now() - start });
    });
  });
}
