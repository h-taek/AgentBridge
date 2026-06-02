import log from 'electron-log/main'
import type { CliKind, SessionMeta } from '@shared/ipc'
import {
  createCompactionScheduler,
  resolveRefineDecisionFromConfig,
  type CompactionScheduler,
  type ManualCompactionResult as CoreManualCompactionResult,
  type MemoryResetOutcome
} from '@agentbridge/core'
import { loadWorkspace, getCoreWorkspaceStore } from './workspaceStore'
import { getWorkspacePaths } from './workspaceStore'
import { getCoreEnvProbe } from './envProbe'
import { loadSettings, getCachedSettings } from './settings'
import { broadcastIrUpdated } from './irBroadcast'
import { markForcedFallback, probeQuotaIfStale } from './cliQuotaTracker'

// 데스크탑 CompactionScheduler facade — 코어 createCompactionScheduler 위임.
// 호스트 책임:
//   - workspaceRoot 계산 (workspaceStore.getWorkspacePaths(id).dir)
//   - activeModel 결정 (pickActiveModel: WorkspaceMeta.sessions 기반)
//   - RefineDecision 결정 (settings.refineModel 기반)
//   - quota 부가효과 (onRefineAttempt: markForcedFallback / background probe)
//   - 알림 — 현재는 no-op (메뉴/Toast 미설치, 추후 추가)
//   - events.on('ir:updated') → broadcastIrUpdated 변환

// refine 성공 후 "spawn 안 된" CLI 재측정 주기 — 이보다 최근 측정이 있으면 probe 스킵.
// 실제 spawn된 CLI는 방금 quota를 소비했으므로 maxAge 0(무조건 재측정).
const QUOTA_PROBE_STALE_MS = 30 * 60_000

export type ManualCompactionResult = CoreManualCompactionResult

// active 모델 결정 — primarySession 우선. shell 세션은 어댑터 dispatch가 불가하므로 제외.
// 모든 세션이 shell이면 default 'claude'.
function pickActiveModel(ws: {
  sessions: SessionMeta[]
  primarySessionId: string | null
}): CliKind {
  const primary = ws.primarySessionId
    ? ws.sessions.find((s) => s.sessionId === ws.primarySessionId)
    : undefined
  if (primary && (primary.kind ?? 'cli') === 'cli') return primary.model
  const cliSession = ws.sessions.find((s) => (s.kind ?? 'cli') === 'cli')
  return cliSession?.model ?? 'claude'
}

let _scheduler: CompactionScheduler | null = null
let _maxArchive = 5 // 안전한 default; loadSettings 한 번 후 갱신

// turnRecorder 등이 코어 인스턴스를 직접 의존할 수 있도록 노출.
export async function getCoreCompactionScheduler(): Promise<CompactionScheduler> {
  return ensureScheduler()
}

async function ensureScheduler(): Promise<CompactionScheduler> {
  if (_scheduler) return _scheduler
  const settings = await loadSettings()
  _maxArchive = settings.maxArchiveSnapshots
  const sched = createCompactionScheduler({
    envProbe: getCoreEnvProbe(),
    workspaceStore: getCoreWorkspaceStore(),
    maxArchiveSnapshots: _maxArchive,
    notifications: {
      // TODO: Electron Notification 연결. 현재는 로그만.
      notifyRefineOff: () => log.info('Compaction: refine 비활성 — skip'),
      notifyRefineFailed: (msg) => log.warn('Compaction: refine 실패', { msg }),
      notifyRefineFallback: (tried, spawned, reason) =>
        log.info('Compaction: refine fallback', { tried, spawned, reason })
    },
    resolveRefineDecision: (activeModel) => {
      // 매 호출 시 현재 설정 cache를 읽는다 — 설정 변경이 재시작 없이 compaction에 반영 (V-11).
      // 변환 switch는 core resolveRefineDecisionFromConfig 단일 구현 사용.
      const s = getCachedSettings()
      return resolveRefineDecisionFromConfig(
        { policy: s.refineModel, fixedCli: s.refineFixedCli, priorityOrder: s.refinePriorityOrder },
        activeModel
      )
    },
    // refine attempt별 quota 부가효과. 5/31 core 일원화(531546a) 때 데스크탑 refineDispatcher가
    // dead code화되면서 끊겼던 배선 복원 — 이제 auto/manual compaction 모두 이 hook을 탄다.
    onRefineAttempt: async (event) => {
      switch (event.status) {
        case 'quota':
          await markForcedFallback(event.cli)
          log.warn('Compaction — refine quota 에러', {
            cli: event.cli,
            exitCode: event.result.exitCode
          })
          break
        case 'success':
          // 세 CLI 전부 background probe — spawn된 CLI는 무조건(방금 quota 소비), 나머지는
          // stale(30분)할 때만. fire-and-forget, in-flight 중복은 probeQuotaIfStale이 dedup.
          for (const cli of ['agy', 'codex', 'claude'] as CliKind[]) {
            void probeQuotaIfStale(cli, cli === event.cli ? 0 : QUOTA_PROBE_STALE_MS).catch(
              (err) => {
                log.warn('Compaction — quota probe 실패, 무시', { cli, err: String(err) })
              }
            )
          }
          break
        default:
          break
      }
    },
    logger: {
      log: (m) => log.info(m),
      warn: (m) => log.warn(m)
    }
  })
  // ir:updated 이벤트 → renderer broadcast
  sched.events.on('ir:updated', (workspaceId: string) => {
    broadcastIrUpdated({ workspaceId, source: 'auto' })
  })
  _scheduler = sched
  return sched
}

export async function checkAndRunCompaction(workspaceId: string): Promise<void> {
  const sched = await ensureScheduler()
  const ws = await loadWorkspace(workspaceId)
  const activeModel = pickActiveModel(ws)
  const workspaceRoot = getWorkspacePaths(workspaceId).dir
  await sched.checkAndRun({
    workspaceId,
    workspaceRoot,
    workspacePath: ws.workspacePath,
    activeModel
  })
}

export async function runManualCompaction(args: {
  workspaceId: string
  timeoutMs?: number
}): Promise<ManualCompactionResult> {
  const sched = await ensureScheduler()
  const ws = await loadWorkspace(args.workspaceId)
  const activeModel = pickActiveModel(ws)
  const workspaceRoot = getWorkspacePaths(args.workspaceId).dir
  const result = await sched.runManual({
    workspaceId: args.workspaceId,
    workspaceRoot,
    workspacePath: ws.workspacePath,
    activeModel,
    timeoutMs: args.timeoutMs
  })
  if (result.ok && result.ir) {
    broadcastIrUpdated({ workspaceId: args.workspaceId, source: 'manual' })
  }
  return result
}

// 메모리 초기화 — core resetMemory에 위임. compaction과 같은 락으로 직렬화되며(V-06), reset
// 쓰기 로직이 core 한 곳으로 통합된다(V-14). broadcast는 호출자(IPC 핸들러)가 담당.
export async function resetMemoryForWorkspace(args: {
  workspaceId: string
  alsoTurns: boolean
}): Promise<MemoryResetOutcome> {
  const sched = await ensureScheduler()
  const workspaceRoot = getWorkspacePaths(args.workspaceId).dir
  return sched.resetMemory({
    workspaceId: args.workspaceId,
    workspaceRoot,
    alsoTurns: args.alsoTurns
  })
}
