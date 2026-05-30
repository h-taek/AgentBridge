import log from 'electron-log/main'
import type { CliKind } from '@shared/ipc'
import { REFINE_DEFAULT_MODEL } from '@shared/ipc'
import { getAdapter } from './cliAdapter'
import { getCliPath } from './envProbe'
import type { SpawnRefineResult } from './cliAdapter/types'
import {
  looksLikeQuotaError,
  markForcedFallback,
  probeQuotaInBackground,
  type CliQuotaSnapshot
} from './cliQuotaTracker'
import { loadSettings, type RefineModelPolicy } from './settings'

// RefineDispatcher — 2026 재설계.
//
// 4단계 정책:
//   priority : refinePriorityOrder list 순서대로 try. 각 단계에서 spawn 실패 또는 quota 에러면 다음 CLI.
//   fixed    : refineFixedCli만 try. 실패 시 정제 스킵 (RefineFailedError).
//   active   : 마지막 채팅 CLI(args.activeModel)만 try. 실패 시 정제 스킵.
//   off      : RefineOffError throw.
//
// 모델 선택 — CLI마다 자동:
//   agy:    CLI flag로 지정 불가. modelHint=null. 사용자 default 따름.
//   codex:  modelHint=REFINE_DEFAULT_MODEL.codex (gpt-5.4-mini)
//   claude: modelHint=REFINE_DEFAULT_MODEL.claude (claude-haiku-4-5)
//
// quota 추적 (Phase 2):
//   응답 stderr/text의 quota 키워드 감지 (looksLikeQuotaError) — priority 정책에서 quota
//   에러 시 markForcedFallback + 다음 CLI로 이동.
//   spawn 성공/실패와 무관하게 refine 끝에 *실제 spawn된 CLI*만 background probe trigger
//   (fire-and-forget) — 슬래시 명령으로 최신 % used 캡처.

export type RefineModelChoice = {
  // 실제 spawn된 CLI 종류.
  spawnedModel: CliKind
  // refine 결과 + dispatcher 메타.
  result: SpawnRefineResult
  // 우선순위 list 중 첫 후보가 실패해 다음 CLI로 넘어갔는지.
  fallback: boolean
  fallbackReason?: 'unavailable' | 'quota' | 'spawn-error'
  policy: RefineModelPolicy
  // 우선순위 정책에서 시도한 CLI 순서 (실패 추적용).
  triedCli: CliKind[]
  // spawn된 CLI의 quota snapshot (probe 완료 시).
  quotaAfter?: CliQuotaSnapshot
}

export type RefineDispatchArgs = {
  // 활성 모델 — 'active' 정책 시 단일 후보로 사용.
  activeModel: CliKind
  prompt: string
  cwd?: string
  abortSignal?: AbortSignal
  timeoutMs?: number
}

export class RefineOffError extends Error {
  constructor() {
    super("refine 비활성 (settings.refineModel='off')")
    this.name = 'RefineOffError'
  }
}

export class RefineFailedError extends Error {
  constructor(
    public readonly cli: CliKind,
    public readonly cause: unknown
  ) {
    super(`refine 실패 (${cli}): ${String(cause)}`)
    this.name = 'RefineFailedError'
  }
}

function isQuotaFailure(result: SpawnRefineResult): boolean {
  return looksLikeQuotaError(result.stderr, result.assistantText, result.exitCode)
}

async function runWith(cli: CliKind, args: RefineDispatchArgs): Promise<SpawnRefineResult> {
  const adapter = getAdapter(cli)
  return adapter.spawnRefineIR({
    prompt: args.prompt,
    cwd: args.cwd,
    abortSignal: args.abortSignal,
    timeoutMs: args.timeoutMs,
    modelHint: REFINE_DEFAULT_MODEL[cli]
  })
}

// CLI 1개로 정제 시도. 결과 + quota 에러 여부 반환. spawn 실패는 throw.
type SingleAttempt = {
  ok: boolean
  result: SpawnRefineResult
  quotaError: boolean
}

async function tryOne(cli: CliKind, args: RefineDispatchArgs): Promise<SingleAttempt> {
  const cliPath = getCliPath(cli)
  if (!cliPath) {
    throw new Error(`${cli} CLI not found in PATH`)
  }
  const result = await runWith(cli, args)
  const quotaError = isQuotaFailure(result)
  return {
    ok: !quotaError && result.exitCode === 0 && result.assistantText.length > 0,
    result,
    quotaError
  }
}

// refine 직후 *실제 spawn된 CLI*만 background probe — fire-and-forget. 결과는 quota:updated
// broadcast로 UI 동기화. probe 실패는 무시(다음 refine에서 재시도).
function triggerProbeAsync(cli: CliKind): void {
  void probeQuotaInBackground(cli).catch((err) => {
    log.warn('RefineDispatcher — quota probe 실패, 무시', { cli, err: String(err) })
  })
}

export async function runRefine(args: RefineDispatchArgs): Promise<RefineModelChoice> {
  const settings = await loadSettings()
  const policy = settings.refineModel

  if (policy === 'off') {
    throw new RefineOffError()
  }

  // 단일 후보 정책 (fixed / active) — 실패 시 fallback 없음, 그대로 throw.
  if (policy === 'fixed' || policy === 'active') {
    const cli = policy === 'fixed' ? settings.refineFixedCli : args.activeModel
    log.info(`RefineDispatcher — ${policy} 정책`, { cli })
    try {
      const attempt = await tryOne(cli, args)
      if (attempt.quotaError) {
        await markForcedFallback(cli)
        log.warn('RefineDispatcher — quota 에러 (단일 후보 — fallback 없음)', { cli })
      }
      triggerProbeAsync(cli)
      return {
        spawnedModel: cli,
        result: attempt.result,
        fallback: false,
        policy,
        triedCli: [cli]
      }
    } catch (err) {
      log.warn(`RefineDispatcher — ${policy} spawn 실패`, { cli, err: String(err) })
      throw new RefineFailedError(cli, err)
    }
  }

  // priority 정책 — order 순서대로 try. 실패/quota 에러면 다음.
  const order =
    settings.refinePriorityOrder && settings.refinePriorityOrder.length > 0
      ? settings.refinePriorityOrder
      : (['agy', 'codex', 'claude'] as CliKind[])
  log.info('RefineDispatcher — priority 정책', { order })

  const tried: CliKind[] = []
  let lastError: unknown = null
  for (let i = 0; i < order.length; i++) {
    const cli = order[i]
    tried.push(cli)
    const cliPath = getCliPath(cli)
    if (!cliPath) {
      log.info('RefineDispatcher — CLI 미설치, next', { cli, remaining: order.length - i - 1 })
      lastError = new Error(`${cli} CLI not found`)
      continue
    }
    try {
      const attempt = await tryOne(cli, args)
      if (attempt.ok) {
        triggerProbeAsync(cli)
        return {
          spawnedModel: cli,
          result: attempt.result,
          fallback: tried.length > 1,
          fallbackReason: tried.length > 1 ? 'spawn-error' : undefined,
          policy,
          triedCli: tried
        }
      }
      if (attempt.quotaError) {
        await markForcedFallback(cli)
        log.warn('RefineDispatcher — priority quota 에러, next', {
          cli,
          exitCode: attempt.result.exitCode
        })
        lastError = new Error(`${cli} quota error`)
        continue
      }
      // 빈 응답 또는 exitCode != 0 — assistantText 없음. fallback.
      log.warn('RefineDispatcher — priority 빈/실패 응답, next', {
        cli,
        exitCode: attempt.result.exitCode,
        bodyLen: attempt.result.assistantText.length
      })
      lastError = new Error(`${cli} empty/failed response`)
    } catch (err) {
      log.warn('RefineDispatcher — priority spawn 실패, next', { cli, err: String(err) })
      lastError = err
    }
  }

  // 모든 후보 실패.
  log.warn('RefineDispatcher — priority 전체 실패', { tried })
  throw new RefineFailedError(tried[tried.length - 1], lastError)
}
