// 여러 CLI를 순서대로 시도해 IR refine을 수행한다. quota/empty/parse-fail은 다음 후보로 fallback.
// 호스트는 EnvProbe 인스턴스와 refine 순서(refinePolicy 해석 결과)를 인자로 전달한다.

import { runRefineSpawn, type SpawnRefineResult } from './refineHeadless';
import { parseRefineOutput } from './irModule/parse';
import type { CliKind } from './shared/cli';
import type { EnvProbe } from './envProbe';
import type { Logger } from './interfaces';
import { noopLogger } from './interfaces';
import { buildRefineSpawnRequest } from './refineCliArgs';
import { looksLikeQuotaError } from './quotaTracker';
import { cleanupAgyArtifactsForCwd, rmIsolatedCwd } from './cliAdapter/agyResume';

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

// 호스트가 자기 settings에서 읽어 코어에 넘기는 정책 결정.
export type RefineDecision =
  | { policy: 'off' }
  | { policy: 'fixed' | 'active'; cli: CliKind }
  | { policy: 'priority'; order: CliKind[] };

// 호스트 설정값 → RefineDecision 변환의 공통 입력. 호스트는 자기 설정 키를 이 모양으로 매핑만 한다.
export type RefinePolicyConfig = {
  policy: 'off' | 'fixed' | 'active' | 'priority';
  fixedCli: CliKind;
  priorityOrder: CliKind[];
};

// 설정값 → RefineDecision 변환 — desktop/extension에 중복돼 있던 switch의 단일 구현 (V-11).
// priority 목록이 비어 있으면 기본 순서로 폴백해 빈 순서로 인한 정제 실패를 막는다.
export function resolveRefineDecisionFromConfig(
  cfg: RefinePolicyConfig,
  activeModel: CliKind,
): RefineDecision {
  switch (cfg.policy) {
    case 'off':
      return { policy: 'off' };
    case 'fixed':
      return { policy: 'fixed', cli: cfg.fixedCli };
    case 'active':
      return { policy: 'active', cli: activeModel };
    case 'priority': {
      const order =
        cfg.priorityOrder.length > 0
          ? Array.from(new Set(cfg.priorityOrder))
          : (['agy', 'codex', 'claude'] as CliKind[]);
      return { policy: 'priority', order };
    }
  }
}

// 호스트가 각 CLI 시도 결과를 관찰해 부가 효과(예: quota 추적, probe 트리거)를
// 실행할 수 있게 콜백을 노출. 코어는 콜백 실패를 swallow — 부가 효과 오류로 정제 흐름을 막지 않음.
// agy 격리 tmpdir 잔재(9종)는 코어가 attempt 종료 시점에 직접 청소 — 호스트 책임 아님 (tryRefine 참조).
export type RefineAttemptEvent =
  | { cli: CliKind; status: 'success'; result: SpawnRefineResult }
  | { cli: CliKind; status: 'quota'; result: SpawnRefineResult }
  | { cli: CliKind; status: 'empty' | 'invalid-ir'; result: SpawnRefineResult }
  | { cli: CliKind; status: 'unavailable' | 'spawn-error'; error: unknown };

export type RunRefineArgs = {
  // 사용자 설정의 refinePolicy 해석 결과 — 코어는 정책 출처를 모름. 호스트가 계산해서 넘김.
  decision: RefineDecision;
  prompt: string;
  cwd?: string;
  timeoutMs?: number;
  envProbe: EnvProbe;
  logger?: Logger;
  onAttempt?: (event: RefineAttemptEvent) => void | Promise<void>;
};

function resolveDecisionToOrder(decision: RefineDecision): { order: CliKind[]; singleCandidate: boolean } {
  switch (decision.policy) {
    case 'off':
      return { order: [], singleCandidate: false };
    case 'fixed':
    case 'active':
      return { order: [decision.cli], singleCandidate: true };
    case 'priority':
      return { order: decision.order, singleCandidate: false };
  }
}

async function tryRefine(
  cli: CliKind,
  args: RunRefineArgs,
  timeoutMs: number,
): Promise<{ result: SpawnRefineResult }> {
  const probe = args.envProbe.probe(cli);
  if (!probe.found || !probe.resolvedPath) throw new Error(`${cli} CLI not found`);
  const command = probe.resolvedPath;
  const env = args.envProbe.getShellEnv();
  const log = args.logger ?? noopLogger;

  const req = buildRefineSpawnRequest(cli, args.prompt, args.cwd);
  let assistantText = '';
  // agy의 경우 라인을 줄바꿈으로 연결하는 누적 패턴 유지.
  const accumulate = cli === 'agy'
    ? (text: string) => { assistantText += (assistantText ? '\n' : '') + text; }
    : (text: string) => { assistantText += text; };

  try {
    const base = await runRefineSpawn({
      command,
      args: req.args,
      cwd: req.cwd,
      env,
      stdinPayload: req.stdinPayload,
      onLine: (line) => req.onLine(line, accumulate),
      timeoutMs,
      logger: log,
    });
    return { result: { assistantText, ...base } };
  } finally {
    // agy는 격리 tmpdir에서 실행됨 — spawn 종료(성공/실패 무관) 후 코어가 직접 잔재 청소.
    // 만든 쪽(buildAgyRefineSpawn)이 치우는 걸로 일원화. 이전엔 호스트 onAttempt hook 책임이었으나
    // 익스텐션/compaction 경로 누락으로 잔재가 누수됐음 (2026-06-01).
    // 청소 함수가 last_conversations.json 등을 atomic rewrite하므로 await 직렬 처리.
    if (req.isolatedCwd) {
      try {
        await cleanupAgyArtifactsForCwd(req.isolatedCwd, log);
        await rmIsolatedCwd(req.isolatedCwd, log);
      } catch (err) {
        log.warn(`refineDispatcher: agy 잔재 청소 실패 — ${String(err)}`);
      }
    }
  }
}

export async function runRefine(args: RunRefineArgs): Promise<RefineModelChoice> {
  const log = args.logger ?? noopLogger;
  const { order, singleCandidate } = resolveDecisionToOrder(args.decision);
  if (order.length === 0) throw new RefineOffError();

  const timeout = args.timeoutMs ?? 60_000;
  const tried: CliKind[] = [];
  let lastError: unknown = null;
  let lastReason: 'unavailable' | 'quota' | 'spawn-error' | undefined;

  const emit = async (event: RefineAttemptEvent) => {
    if (!args.onAttempt) return;
    try {
      await args.onAttempt(event);
    } catch (hookErr) {
      log.warn(`refineDispatcher: onAttempt hook failed — ${String(hookErr)}`);
    }
  };

  for (let i = 0; i < order.length; i++) {
    const cli = order[i];
    tried.push(cli);
    try {
      const { result } = await tryRefine(cli, args, timeout);
      const quota = looksLikeQuotaError(result.stderr ?? '', result.assistantText, result.exitCode);
      if (quota) {
        log.warn(`refineDispatcher: ${cli} quota error, trying next`);
        await emit({ cli, status: 'quota', result });
        lastError = new Error(`${cli} quota error`);
        lastReason = 'quota';
        if (singleCandidate) throw new RefineFailedError(cli, lastError);
        continue;
      }
      if (result.assistantText.length === 0) {
        log.warn(`refineDispatcher: ${cli} empty response, trying next`);
        await emit({ cli, status: 'empty', result });
        lastError = new Error(`${cli} empty response`);
        lastReason = 'spawn-error';
        if (singleCandidate) throw new RefineFailedError(cli, lastError);
        continue;
      }
      const parsed = parseRefineOutput(result.assistantText);
      if (!parsed.ok) {
        log.warn(`refineDispatcher: ${cli} response not valid IR JSON — ${parsed.error}`);
        await emit({ cli, status: 'invalid-ir', result });
        lastError = new Error(`${cli} invalid IR`);
        lastReason = 'spawn-error';
        if (singleCandidate) throw new RefineFailedError(cli, lastError);
        continue;
      }
      log.log(`refineDispatcher: ${cli} succeeded (${result.durationMs}ms)`);
      await emit({ cli, status: 'success', result });
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
      await emit({ cli, status: 'unavailable', error: err });
      lastError = err;
      lastReason = 'unavailable';
      if (singleCandidate) throw new RefineFailedError(cli, err);
    }
  }

  throw new RefineFailedError(tried[tried.length - 1] ?? order[0], lastError);
}
