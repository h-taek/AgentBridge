// 하니스별 모델·effort 조회 실행기와 `agent models` 호스트 요청 처리기 (0.8.0 spec/06 §1·§2).
//
// CLI는 메인 하니스의 셸 샌드박스를 물려받으므로, 실제 하니스 실행은 호스트(익스텐션)에서 한다.
// 실행 파일은 envProbe.probe()의 resolvedPath를, 환경은 getShellEnv()를 쓴다.

import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import {
  CLI_KINDS,
  buildModelTable,
  renderModelTable,
  type CliKind,
  type EnvProbe,
  type HarnessRunner,
  type HostRequest,
} from '@agentbridge/core';
import { getCoreEnvProbe } from './coreInstances';

export type SpawnFn = typeof spawn;

const KILL_GRACE_MS = 1_000;
const CODEX_EOF_GRACE_MS = 300;

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function escalateKill(child: ChildProcess): void {
  if (child.exitCode != null || child.signalCode != null) return;
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
}

type LineSessionHandlers<T> = {
  onStart?: (child: ChildProcess) => void;
  onLine: (line: string, child: ChildProcess, finish: (val: T) => void, fail: (err: Error) => void) => void;
  onCloseBeforeFinish: (exitCode: number | null, stderr: string) => Error | T;
};

// refineHeadless.ts runRefineSpawn의 줄 단위 stdout 파싱·SIGTERM→SIGKILL·abort 처리 패턴을 따른다.
function runLineSession<T>(
  spawnFn: SpawnFn,
  command: string,
  args: string[],
  env: Record<string, string>,
  signal: AbortSignal,
  handlers: LineSessionHandlers<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('조회가 취소되었다'));
      return;
    }

    const child = spawnFn(command, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin?.on('error', () => {
      /* 자식이 먼저 닫힌 뒤의 EPIPE 무시 */
    });

    let settled = false;
    let stderrBuf = '';
    let stdoutCarry = '';

    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
    };

    const finish = (val: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(val);
    };

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      escalateKill(child);
      reject(err);
    };

    const onAbort = (): void => {
      fail(new Error('조회가 중단되었다'));
    };
    signal.addEventListener('abort', onAbort, { once: true });

    const deliverLine = (raw: string): void => {
      if (settled) return;
      const trimmed = raw.trim();
      if (!trimmed) return;
      handlers.onLine(trimmed, child, finish, fail);
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      const combined = stdoutCarry + chunk;
      const lines = combined.split('\n');
      stdoutCarry = lines.pop() ?? '';
      for (const line of lines) {
        deliverLine(line);
      }
    });
    child.stdout?.on('end', () => {
      if (stdoutCarry) {
        deliverLine(stdoutCarry);
        stdoutCarry = '';
      }
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrBuf += chunk;
    });

    child.on('error', (err) => {
      fail(err instanceof Error ? err : new Error(String(err)));
    });

    child.on('close', (exitCode) => {
      if (settled) return;
      if (stdoutCarry) {
        deliverLine(stdoutCarry);
        stdoutCarry = '';
      }
      if (settled) return;
      try {
        const outcome = handlers.onCloseBeforeFinish(exitCode, stderrBuf);
        if (outcome instanceof Error) fail(outcome);
        else finish(outcome);
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    });

    try {
      handlers.onStart?.(child);
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function runClaudeModels(
  spawnFn: SpawnFn,
  command: string,
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<unknown> {
  const requestId = randomUUID();
  const payload = JSON.stringify({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'list_models' },
  });

  return runLineSession<unknown>(
    spawnFn,
    command,
    ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
    env,
    signal,
    {
      onStart: (child) => {
        child.stdin?.write(`${payload}\n`);
      },
      onLine: (line, child, finish) => {
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        const rec = asRecord(msg);
        const resp = asRecord(rec?.response);
        if (rec?.type === 'control_response' && resp?.request_id === requestId) {
          child.stdin?.end();
          escalateKill(child);
          finish(msg);
        }
      },
      onCloseBeforeFinish: (exitCode, stderr) =>
        new Error(stderr.trim() || `claude가 모델 목록 응답 없이 끝났다 (exit ${String(exitCode)})`),
    },
  );
}

function runCodexModels(
  spawnFn: SpawnFn,
  command: string,
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<unknown[]> {
  let stage: 'init' | 'list' | 'done' = 'init';
  let nextReqId = 2;
  let activeReqId = 1;
  const pages: unknown[] = [];

  const sendJson = (child: ChildProcess, msg: Record<string, unknown>): void => {
    child.stdin?.write(`${JSON.stringify(msg)}\n`);
  };

  return runLineSession<unknown[]>(spawnFn, command, ['app-server'], env, signal, {
    onStart: (child) => {
      sendJson(child, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: { name: 'agentbridge', title: null, version: '0.8.0' },
          capabilities: null,
        },
      });
    },
    onLine: (line, child, _finish, fail) => {
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const rec = asRecord(msg);
      if (!rec) return;

      if (stage === 'init' && rec.id === 1) {
        if (rec.error !== undefined) {
          const errRec = asRecord(rec.error);
          fail(new Error(typeof errRec?.message === 'string' ? errRec.message : 'codex initialize 실패'));
          return;
        }
        sendJson(child, { jsonrpc: '2.0', method: 'initialized', params: {} });
        activeReqId = nextReqId++;
        stage = 'list';
        sendJson(child, { jsonrpc: '2.0', id: activeReqId, method: 'model/list', params: {} });
        return;
      }

      if (stage === 'list' && rec.id === activeReqId) {
        if (rec.error !== undefined) {
          const errRec = asRecord(rec.error);
          fail(new Error(typeof errRec?.message === 'string' ? errRec.message : 'codex model/list 실패'));
          return;
        }
        pages.push(msg);
        const result = asRecord(rec.result);
        const nextCursor =
          typeof result?.nextCursor === 'string' && result.nextCursor.length > 0
            ? result.nextCursor
            : null;
        if (nextCursor) {
          activeReqId = nextReqId++;
          sendJson(child, {
            jsonrpc: '2.0',
            id: activeReqId,
            method: 'model/list',
            params: { cursor: nextCursor },
          });
        } else {
          stage = 'done';
          child.stdin?.end();
          // app-server가 stdin EOF로 즉시 닫히지 않으면 짧게 기다린 뒤 종료한다.
          setTimeout(() => escalateKill(child), CODEX_EOF_GRACE_MS).unref();
        }
      }
    },
    onCloseBeforeFinish: (exitCode, stderr) => {
      if (stage === 'done') return pages;
      return new Error(
        stderr.trim() || `codex app-server가 모델 목록을 주기 전에 끝났다 (exit ${String(exitCode)})`,
      );
    },
  });
}

function runAgyModels(
  spawnFn: SpawnFn,
  command: string,
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('조회가 취소되었다'));
      return;
    }

    const child = spawnFn(command, ['models'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let stdoutBuf = '';
    let stderrBuf = '';

    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
    };

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      escalateKill(child);
      reject(new Error('조회가 중단되었다'));
    };
    signal.addEventListener('abort', onAbort, { once: true });

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdoutBuf += chunk;
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrBuf += chunk;
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    });

    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (exitCode !== 0) {
        reject(new Error(stderrBuf.trim() || `agy models 실패 (exit ${String(exitCode)})`));
        return;
      }
      resolve(stdoutBuf);
    });
  });
}

/** 실제 하니스 CLI를 띄워 원문 응답을 받는 실행기를 만든다. */
export function createHarnessRunner(deps?: { envProbe?: EnvProbe; spawn?: SpawnFn }): HarnessRunner {
  const spawnFn = deps?.spawn ?? spawn;
  return async (harness: CliKind, signal: AbortSignal): Promise<unknown> => {
    const probeEnv = deps?.envProbe ?? getCoreEnvProbe();
    const probed = probeEnv.probe(harness);
    if (!probed.found || !probed.resolvedPath) {
      throw new Error(`${harness} CLI를 찾을 수 없다`);
    }
    const env = probeEnv.getShellEnv();
    switch (harness) {
      case 'claude':
        return runClaudeModels(spawnFn, probed.resolvedPath, env, signal);
      case 'codex':
        return runCodexModels(spawnFn, probed.resolvedPath, env, signal);
      case 'agy':
        return runAgyModels(spawnFn, probed.resolvedPath, env, signal);
    }
  };
}

function parseHarnessesPayload(payload: unknown): CliKind[] {
  const p = asRecord(payload) ?? {};
  const raw = Array.isArray(p.harnesses)
    ? p.harnesses.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    : [];
  if (raw.length === 0) return [...CLI_KINDS];
  return raw.map((h) => {
    if (!CLI_KINDS.includes(h as CliKind)) {
      throw new Error(`모르는 하니스다: ${h}`);
    }
    return h as CliKind;
  });
}

/** `agent models` 호스트 요청 처리기 팩토리 (테스트에서는 가짜 runner를 주입한다). */
export function createModelsHandler(deps?: { run?: HarnessRunner; timeoutMs?: number }) {
  return async function handleModels(req: HostRequest, _sessionDir?: string): Promise<string> {
    const harnesses = parseHarnessesPayload(req.payload);
    const run = deps?.run ?? createHarnessRunner();
    const tables = await buildModelTable(harnesses, run, { timeoutMs: deps?.timeoutMs });
    return renderModelTable(tables);
  };
}

export const handleAgentModels = createModelsHandler();
