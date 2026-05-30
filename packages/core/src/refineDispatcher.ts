// 여러 CLI를 순서대로 시도해 IR refine을 수행한다. quota/empty/parse-fail은 다음 후보로 fallback.
// 호스트는 EnvProbe 인스턴스와 refine 순서(refinePolicy 해석 결과)를 인자로 전달한다.

import { runRefineSpawn, type SpawnRefineResult } from './refineHeadless';
import { parseRefineOutput } from './irModule/parse';
import type { CliKind } from './shared/cli';
import type { EnvProbe } from './envProbe';
import type { Logger } from './interfaces';
import { noopLogger } from './interfaces';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync } from 'fs';

export type RefineModelChoice = {
  spawnedModel: CliKind;
  result: SpawnRefineResult;
  fallback: boolean;
  fallbackReason?: 'unavailable' | 'quota' | 'spawn-error';
  triedCli: CliKind[];
};

export class RefineOffError extends Error {
  constructor() {
    super('refine disabled');
    this.name = 'RefineOffError';
  }
}

export class RefineFailedError extends Error {
  constructor(
    public readonly cli: CliKind,
    public readonly cause: unknown,
  ) {
    super(`refine failed (${cli}): ${String(cause)}`);
    this.name = 'RefineFailedError';
  }
}

const REFINE_MODEL_HINT: Record<CliKind, string | null> = {
  agy: null,
  codex: 'gpt-5.4-mini',
  claude: 'claude-haiku-4-5',
};

const QUOTA_RE = /\b(quota|rate[\s-]?limit|usage limit|too many requests|429|insufficient[_\s]quota)\b/i;
function looksLikeQuotaError(stderr: string, body: string, exitCode: number | null): boolean {
  if (exitCode === 0) return false;
  return QUOTA_RE.test(stderr) || QUOTA_RE.test(body);
}

export type RunRefineArgs = {
  // 사용자 설정의 refinePolicy 해석 결과 — 코어는 정책을 모름. 호스트가 계산해서 넘김.
  // 빈 배열이면 RefineOffError throw.
  order: CliKind[];
  // singleCandidate면 첫 실패에 RefineFailedError, 아니면 다음 후보 시도.
  singleCandidate: boolean;
  prompt: string;
  cwd?: string;
  timeoutMs?: number;
  envProbe: EnvProbe;
  logger?: Logger;
};

async function tryRefine(
  cli: CliKind,
  args: RunRefineArgs,
  timeoutMs: number,
): Promise<SpawnRefineResult> {
  const probe = args.envProbe.probe(cli);
  if (!probe.found || !probe.resolvedPath) throw new Error(`${cli} CLI not found`);
  const command = probe.resolvedPath;
  const env = args.envProbe.getShellEnv();
  const log = args.logger ?? noopLogger;
  let assistantText = '';

  if (cli === 'claude') {
    const modelArgs = REFINE_MODEL_HINT.claude ? ['--model', REFINE_MODEL_HINT.claude] : [];
    const base = await runRefineSpawn({
      command,
      args: [
        '-p',
        args.prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'acceptEdits',
        ...modelArgs,
      ],
      cwd: args.cwd,
      env,
      onLine: (line) => {
        let evt: unknown;
        try {
          evt = JSON.parse(line);
        } catch {
          return;
        }
        const o = evt as {
          type?: string;
          message?: { content?: Array<{ type?: string; text?: string }> };
          usage?: unknown;
        };
        if (o.type === 'assistant' && o.message?.content) {
          for (const c of o.message.content) {
            if (c.type === 'text' && typeof c.text === 'string') {
              assistantText += c.text;
            }
          }
        }
      },
      timeoutMs,
      logger: log,
    });
    return { assistantText, ...base };
  }

  if (cli === 'codex') {
    const modelArgs = REFINE_MODEL_HINT.codex ? ['-c', `model="${REFINE_MODEL_HINT.codex}"`] : [];
    const base = await runRefineSpawn({
      command,
      args: [...modelArgs, 'exec', '--json', '--skip-git-repo-check', '-s', 'read-only', '-'],
      cwd: args.cwd,
      env,
      stdinPayload: args.prompt,
      onLine: (line) => {
        try {
          const o = JSON.parse(line) as {
            type?: string;
            item?: { text?: string };
            usage?: Record<string, number>;
          };
          if (o.type === 'item.completed' && o.item?.text) assistantText += o.item.text;
        } catch {
          /* skip */
        }
      },
      timeoutMs,
      logger: log,
    });
    return { assistantText, ...base };
  }

  // agy — isolated cwd to avoid conversation join
  const isolatedCwd = join(tmpdir(), `agentbridge-refine-${Date.now()}-${process.pid}`);
  mkdirSync(isolatedCwd, { recursive: true });
  const base = await runRefineSpawn({
    command,
    args: ['-p', args.prompt, '--dangerously-skip-permissions'],
    cwd: isolatedCwd,
    env,
    onLine: (line) => {
      assistantText += (assistantText ? '\n' : '') + line;
    },
    timeoutMs,
    logger: log,
  });
  return { assistantText, ...base };
}

export async function runRefine(args: RunRefineArgs): Promise<RefineModelChoice> {
  const log = args.logger ?? noopLogger;
  if (args.order.length === 0) throw new RefineOffError();

  const timeout = args.timeoutMs ?? 60_000;
  const tried: CliKind[] = [];
  let lastError: unknown = null;
  let lastReason: 'unavailable' | 'quota' | 'spawn-error' | undefined;

  for (let i = 0; i < args.order.length; i++) {
    const cli = args.order[i];
    tried.push(cli);
    try {
      const result = await tryRefine(cli, args, timeout);
      const quota = looksLikeQuotaError(result.stderr ?? '', result.assistantText, result.exitCode);
      if (quota) {
        log.warn(`refineDispatcher: ${cli} quota error, trying next`);
        lastError = new Error(`${cli} quota error`);
        lastReason = 'quota';
        if (args.singleCandidate) throw new RefineFailedError(cli, lastError);
        continue;
      }
      if (result.assistantText.length === 0) {
        log.warn(`refineDispatcher: ${cli} empty response, trying next`);
        lastError = new Error(`${cli} empty response`);
        lastReason = 'spawn-error';
        if (args.singleCandidate) throw new RefineFailedError(cli, lastError);
        continue;
      }
      const parsed = parseRefineOutput(result.assistantText);
      if (!parsed.ok) {
        log.warn(`refineDispatcher: ${cli} response not valid IR JSON — ${parsed.error}`);
        lastError = new Error(`${cli} invalid IR`);
        lastReason = 'spawn-error';
        if (args.singleCandidate) throw new RefineFailedError(cli, lastError);
        continue;
      }
      log.log(`refineDispatcher: ${cli} succeeded (${result.durationMs}ms)`);
      return {
        spawnedModel: cli,
        result,
        fallback: tried.length > 1,
        fallbackReason: tried.length > 1 ? lastReason : undefined,
        triedCli: tried,
      };
    } catch (err) {
      if (err instanceof RefineFailedError) throw err;
      log.warn(
        `refineDispatcher: ${cli} failed — ${err instanceof Error ? err.message : String(err)}`,
      );
      lastError = err;
      lastReason = 'unavailable';
      if (args.singleCandidate) throw new RefineFailedError(cli, err);
    }
  }

  throw new RefineFailedError(tried[tried.length - 1] ?? args.order[0], lastError);
}
