import log from 'electron-log/main'
import type { CliKind, SessionMeta } from '@shared/ipc'
import {
  createCompactionScheduler,
  type CompactionScheduler,
  type ManualCompactionResult as CoreManualCompactionResult,
  type RefineDecision
} from '@agentbridge/core'
import { loadWorkspace } from './workspaceStore'
import { getWorkspacePaths } from './workspaceStore'
import { getCoreEnvProbe } from './envProbe'
import { loadSettings } from './settings'
import { broadcastIrUpdated } from './irBroadcast'

// 데스크탑 CompactionScheduler facade — 코어 createCompactionScheduler 위임.
// 호스트 책임:
//   - workspaceRoot 계산 (workspaceStore.getWorkspacePaths(id).dir)
//   - activeModel 결정 (pickActiveModel: WorkspaceMeta.sessions 기반)
//   - RefineDecision 결정 (settings.refineModel 기반)
//   - 알림 — 현재는 no-op (메뉴/Toast 미설치, 추후 추가)
//   - events.on('ir:updated') → broadcastIrUpdated 변환

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

function resolveRefineDecision(activeModel: CliKind, settings: Awaited<ReturnType<typeof loadSettings>>): RefineDecision {
  switch (settings.refineModel) {
    case 'off':
      return { policy: 'off' }
    case 'fixed':
      return { policy: 'fixed', cli: settings.refineFixedCli }
    case 'active':
      return { policy: 'active', cli: activeModel }
    case 'priority': {
      const order =
        settings.refinePriorityOrder && settings.refinePriorityOrder.length > 0
          ? Array.from(new Set(settings.refinePriorityOrder))
          : (['agy', 'codex', 'claude'] as CliKind[])
      return { policy: 'priority', order }
    }
  }
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
    maxArchiveSnapshots: _maxArchive,
    notifications: {
      // TODO: Electron Notification 연결. 현재는 로그만.
      notifyRefineOff: () => log.info('Compaction: refine 비활성 — skip'),
      notifyRefineFailed: (msg) => log.warn('Compaction: refine 실패', { msg }),
      notifyRefineFallback: (tried, spawned, reason) =>
        log.info('Compaction: refine fallback', { tried, spawned, reason })
    },
    resolveRefineDecision: (activeModel) => {
      // 동기 함수라 settings cache 사용. 첫 진입 후엔 background에서 refresh.
      return resolveRefineDecision(activeModel, settings)
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
