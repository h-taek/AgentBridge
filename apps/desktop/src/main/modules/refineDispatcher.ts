import log from 'electron-log/main'
import type { CliKind } from '@shared/ipc'
import {
  runRefine as coreRunRefine,
  RefineOffError as CoreRefineOffError,
  RefineFailedError as CoreRefineFailedError,
  type RefineDecision,
  type RefineModelChoice as CoreRefineModelChoice
} from '@agentbridge/core'
import { getCoreEnvProbe } from './envProbe'
import {
  markForcedFallback,
  probeQuotaInBackground,
  type CliQuotaSnapshot
} from './cliQuotaTracker'
import { cleanupAgyArtifactsForCwd, rmIsolatedCwd } from './cliAdapter/agyResume'
import { loadSettings, type RefineModelPolicy } from './settings'

// 데스크탑 refineDispatcher — 코어 runRefine 래퍼.
//   1) settings.refineModel → core RefineDecision으로 번역.
//   2) core onAttempt hook으로 quotaTracker 부가효과(markForcedFallback, probe) 연결.
//   3) 결과에 policy 필드를 더해 호스트 호환 유지.

export type RefineModelChoice = CoreRefineModelChoice & {
  policy: RefineModelPolicy
  quotaAfter?: CliQuotaSnapshot
}

export type RefineDispatchArgs = {
  activeModel: CliKind
  prompt: string
  cwd?: string
  abortSignal?: AbortSignal
  timeoutMs?: number
}

export class RefineOffError extends CoreRefineOffError {
  constructor() {
    super()
    this.name = 'RefineOffError'
    this.message = "refine 비활성 (settings.refineModel='off')"
  }
}

export class RefineFailedError extends CoreRefineFailedError {
  constructor(cli: CliKind, cause: unknown) {
    super(cli, cause)
    this.name = 'RefineFailedError'
    this.message = `refine 실패 (${cli}): ${String(cause)}`
  }
}

function buildDecision(
  policy: RefineModelPolicy,
  args: {
    fixedCli: CliKind
    priorityOrder: CliKind[]
    activeModel: CliKind
  }
): RefineDecision {
  switch (policy) {
    case 'off':
      return { policy: 'off' }
    case 'fixed':
      return { policy: 'fixed', cli: args.fixedCli }
    case 'active':
      return { policy: 'active', cli: args.activeModel }
    case 'priority': {
      const order =
        args.priorityOrder && args.priorityOrder.length > 0
          ? Array.from(new Set(args.priorityOrder))
          : (['agy', 'codex', 'claude'] as CliKind[])
      return { policy: 'priority', order }
    }
  }
}

export async function runRefine(args: RefineDispatchArgs): Promise<RefineModelChoice> {
  const settings = await loadSettings()
  const policy = settings.refineModel

  if (policy === 'off') {
    throw new RefineOffError()
  }

  const decision = buildDecision(policy, {
    fixedCli: settings.refineFixedCli,
    priorityOrder: settings.refinePriorityOrder,
    activeModel: args.activeModel
  })

  log.info('RefineDispatcher — 정책 dispatch', {
    policy,
    decision
  })

  try {
    const choice = await coreRunRefine({
      decision,
      prompt: args.prompt,
      cwd: args.cwd,
      timeoutMs: args.timeoutMs,
      envProbe: getCoreEnvProbe(),
      logger: {
        log: (msg) => log.info(msg),
        warn: (msg) => log.warn(msg)
      },
      onAttempt: async (event) => {
        // agy refine은 격리 tmpdir 사용 → 어느 status든(성공/실패/quota) cwd가 있으면 9종 잔재 정리.
        // 호출 순서: 청소 함수가 last_conversations.json 등을 atomic rewrite하므로 await 직렬 처리.
        if (event.cli === 'agy' && event.isolatedCwd) {
          try {
            await cleanupAgyArtifactsForCwd(event.isolatedCwd)
            await rmIsolatedCwd(event.isolatedCwd)
          } catch (err) {
            log.warn('RefineDispatcher — agy 잔재 청소 실패', {
              cwd: event.isolatedCwd,
              err: String(err)
            })
          }
        }
        switch (event.status) {
          case 'quota':
            await markForcedFallback(event.cli)
            log.warn('RefineDispatcher — quota 에러', {
              cli: event.cli,
              exitCode: event.result.exitCode
            })
            break
          case 'success':
            // refine 직후 실제 spawn된 CLI만 background probe — fire-and-forget.
            void probeQuotaInBackground(event.cli).catch((err) => {
              log.warn('RefineDispatcher — quota probe 실패, 무시', {
                cli: event.cli,
                err: String(err)
              })
            })
            break
          default:
            break
        }
      }
    })
    return { ...choice, policy }
  } catch (err) {
    if (err instanceof CoreRefineFailedError) {
      throw new RefineFailedError(err.cli, err.cause)
    }
    throw err
  }
}
