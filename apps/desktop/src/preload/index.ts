import { contextBridge, ipcRenderer, webUtils } from 'electron'
// renderer log → main.log 통합. preload 진입 시 IPC 브릿지 등록 (electron-log v5 표준).
// renderer 측은 `import log from 'electron-log/renderer'`로 사용.
import 'electron-log/preload'
import { IpcChannel } from '@shared/ipc'
import type {
  AppHealth,
  AppSettings,
  AppUpdaterCheckResult,
  AppUpdaterStatus,
  AttachFilesRequest,
  AttachFilesResult,
  EnvProbeResult,
  HomeSubmitRequest,
  HomeSubmitResult,
  HookTrustEntry,
  HookTrustSetRequest,
  ArchiveDeleteRequest,
  ArchiveDeleteResult,
  ArchiveListRequest,
  ArchiveListResult,
  ArchiveLoadRequest,
  ArchiveLoadResult,
  InstructionsCreateRequest,
  InstructionsCreateResult,
  InstructionsListRequest,
  InstructionsListResult,
  MemoryPromoteArchiveRequest,
  MemoryPromoteArchiveResult,
  MemoryResetRequest,
  MemoryResetResult,
  IrLoadRequest,
  IrLoadResult,
  IrRefineRequest,
  IrRefineResult,
  IrUpdatedEvent,
  TurnsSummaryRequest,
  TurnsSummaryResult,
  TurnsUpdatedEvent,
  PtyDataEvent,
  PtyExitEvent,
  QuotaProbeRequest,
  QuotaProbeResult,
  QuotaSnapshotsByCli,
  QuotaUpdatedEvent,
  SessionActivateResult,
  SessionCloseRequest,
  SessionCreateRequest,
  SessionMeta,
  SessionModelSessionCapturedEvent,
  SessionOpenRequest,
  SessionRenameRequest,
  WorkspaceCreateRequest,
  WorkspaceCreateResult,
  WindowBootstrap,
  WindowClaimWorkspaceRequest,
  WindowClaimWorkspaceResult,
  WindowOpenWorkspaceRequest,
  WorkspaceListEntry,
  WorkspaceMeta,
  WorkspaceRenameRequest,
  WorkspacesChangedEvent
} from '@shared/ipc'

type Unsubscribe = () => void
type ExitInfo = { exitCode: number | null; signal: number | null }

// PTY data/exit 이벤트는 main에서 spawn 직후부터 발사되는데, renderer가 await로
// spawn 결과를 받기 전에 첫 chunk가 도착해 listener 없이 버려지는 race가 있다.
// preload에서 sessionId별 buffer를 두고, 구독자가 등록되는 순간 flush한다.
const dataBuffers = new Map<string, string[]>()
const dataListeners = new Map<string, Set<(data: string) => void>>()
const exitListeners = new Map<string, Set<(info: ExitInfo) => void>>()
const exitCache = new Map<string, ExitInfo>()

ipcRenderer.on(IpcChannel.PtyData, (_e, evt: PtyDataEvent) => {
  const listeners = dataListeners.get(evt.sessionId)
  if (listeners && listeners.size > 0) {
    for (const l of listeners) l(evt.data)
  } else {
    let buf = dataBuffers.get(evt.sessionId)
    if (!buf) {
      buf = []
      dataBuffers.set(evt.sessionId, buf)
    }
    buf.push(evt.data)
  }
})

ipcRenderer.on(IpcChannel.PtyExit, (_e, evt: PtyExitEvent) => {
  const info: ExitInfo = { exitCode: evt.exitCode, signal: evt.signal }
  const listeners = exitListeners.get(evt.sessionId)
  if (listeners && listeners.size > 0) {
    for (const l of listeners) l(info)
  } else {
    // listener 없으면 캐시 — 늦게 등록되는 onExit가 즉시 받을 수 있게.
    exitCache.set(evt.sessionId, info)
  }
  // PTY 종료 후 어차피 새 data 안 옴 — buffer/listener는 적당 시간 후 청소.
  // 즉시 지우면 늦게 마운트한 XtermView가 종료 정보를 못 받으므로 짧게 유지.
  setTimeout(() => {
    dataBuffers.delete(evt.sessionId)
    dataListeners.delete(evt.sessionId)
    exitListeners.delete(evt.sessionId)
    exitCache.delete(evt.sessionId)
  }, 5_000)
})

function subscribeData(sessionId: string, cb: (data: string) => void): Unsubscribe {
  let listeners = dataListeners.get(sessionId)
  if (!listeners) {
    listeners = new Set()
    dataListeners.set(sessionId, listeners)
  }
  listeners.add(cb)
  // buffer flush — 구독 시점까지 쌓인 chunk를 즉시 전달.
  const buf = dataBuffers.get(sessionId)
  if (buf && buf.length > 0) {
    dataBuffers.delete(sessionId)
    for (const d of buf) cb(d)
  }
  return () => {
    const set = dataListeners.get(sessionId)
    set?.delete(cb)
    if (set && set.size === 0) dataListeners.delete(sessionId)
  }
}

function subscribeExit(sessionId: string, cb: (info: ExitInfo) => void): Unsubscribe {
  let listeners = exitListeners.get(sessionId)
  if (!listeners) {
    listeners = new Set()
    exitListeners.set(sessionId, listeners)
  }
  listeners.add(cb)
  // 이미 종료된 PTY면 캐시된 정보를 즉시 통지.
  const cached = exitCache.get(sessionId)
  if (cached) cb(cached)
  return () => {
    const set = exitListeners.get(sessionId)
    set?.delete(cb)
    if (set && set.size === 0) exitListeners.delete(sessionId)
  }
}

const agentbridge = {
  appHealth: (): Promise<AppHealth> => ipcRenderer.invoke(IpcChannel.AppHealth),
  envProbe: (): Promise<EnvProbeResult> => ipcRenderer.invoke(IpcChannel.EnvProbe),
  openPath: (target: string): Promise<void> => ipcRenderer.invoke(IpcChannel.AppOpenPath, target),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IpcChannel.AppOpenExternal, url),
  // PTY는 sessions.create/open이 main 내부에서 spawn한다. renderer는 write/resize/kill + 데이터 구독만.
  // (pty:start IPC는 임의 명령 실행 표면이라 v0.0.4에서 제거 — sessions API 경유.)
  pty: {
    write: (sessionId: string, data: string): Promise<void> =>
      ipcRenderer.invoke(IpcChannel.PtyWrite, sessionId, data),
    resize: (sessionId: string, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke(IpcChannel.PtyResize, sessionId, cols, rows),
    kill: (sessionId: string): Promise<void> => ipcRenderer.invoke(IpcChannel.PtyKill, sessionId),
    onData: subscribeData,
    onExit: subscribeExit
  },
  dialog: {
    pickWorkspace: (defaultPath?: string): Promise<string | null> =>
      ipcRenderer.invoke(IpcChannel.DialogPickWorkspace, defaultPath)
  },
  // 활성 workspace를 RefineDispatcher 경유로 정제해 IR JSON 영속화.
  ir: {
    load: (req: IrLoadRequest): Promise<IrLoadResult> => ipcRenderer.invoke(IpcChannel.IrLoad, req),
    refine: (req: IrRefineRequest): Promise<IrRefineResult> =>
      ipcRenderer.invoke(IpcChannel.IrRefine, req),
    onUpdated: (cb: (evt: IrUpdatedEvent) => void): Unsubscribe => {
      const handler = (_: unknown, evt: IrUpdatedEvent): void => cb(evt)
      ipcRenderer.on(IpcChannel.IrUpdated, handler)
      return () => {
        ipcRenderer.off(IpcChannel.IrUpdated, handler)
      }
    }
  },
  // 메모리 패널 — archive 히스토리 / turns 흐름 / cwd 안 AI 지시 파일.
  memory: {
    archiveList: (req: ArchiveListRequest): Promise<ArchiveListResult> =>
      ipcRenderer.invoke(IpcChannel.ArchiveList, req),
    archiveLoad: (req: ArchiveLoadRequest): Promise<ArchiveLoadResult> =>
      ipcRenderer.invoke(IpcChannel.ArchiveLoad, req),
    archiveDelete: (req: ArchiveDeleteRequest): Promise<ArchiveDeleteResult> =>
      ipcRenderer.invoke(IpcChannel.ArchiveDelete, req),
    turnsSummary: (req: TurnsSummaryRequest): Promise<TurnsSummaryResult> =>
      ipcRenderer.invoke(IpcChannel.TurnsSummary, req),
    onTurnsUpdated: (cb: (evt: TurnsUpdatedEvent) => void): Unsubscribe => {
      const handler = (_: unknown, evt: TurnsUpdatedEvent): void => cb(evt)
      ipcRenderer.on(IpcChannel.TurnsUpdated, handler)
      return () => {
        ipcRenderer.off(IpcChannel.TurnsUpdated, handler)
      }
    },
    instructionsList: (req: InstructionsListRequest): Promise<InstructionsListResult> =>
      ipcRenderer.invoke(IpcChannel.InstructionsList, req),
    instructionsCreate: (req: InstructionsCreateRequest): Promise<InstructionsCreateResult> =>
      ipcRenderer.invoke(IpcChannel.InstructionsCreate, req),
    // M3.6 D — IR(+옵션 turns.jsonl) 명시 초기화. archive 스냅샷 보존.
    reset: (req: MemoryResetRequest): Promise<MemoryResetResult> =>
      ipcRenderer.invoke(IpcChannel.MemoryReset, req),
    // M4 — CurrentIrCard 휴지통 동작. archive 최신 스냅샷을 ir.json으로 promote(restore)하고
    // 그 archive 파일은 소비(unlink). archive 비어있으면 빈 IR 동일 동작.
    promoteLatestArchive: (req: MemoryPromoteArchiveRequest): Promise<MemoryPromoteArchiveResult> =>
      ipcRenderer.invoke(IpcChannel.MemoryPromoteArchive, req)
  },
  // workspace + sessions. multi-tab 데이터 모델 (M3 K~L 청크).
  workspaces: {
    list: (): Promise<WorkspaceListEntry[]> => ipcRenderer.invoke(IpcChannel.WorkspacesList),
    get: (workspaceId: string): Promise<WorkspaceMeta> =>
      ipcRenderer.invoke(IpcChannel.WorkspacesGet, workspaceId),
    create: (req: WorkspaceCreateRequest): Promise<WorkspaceCreateResult> =>
      ipcRenderer.invoke(IpcChannel.WorkspacesCreate, req),
    open: (workspaceId: string): Promise<WorkspaceMeta> =>
      ipcRenderer.invoke(IpcChannel.WorkspacesOpen, workspaceId),
    delete: (workspaceId: string): Promise<void> =>
      ipcRenderer.invoke(IpcChannel.WorkspacesDelete, workspaceId),
    rename: (req: WorkspaceRenameRequest): Promise<WorkspaceMeta> =>
      ipcRenderer.invoke(IpcChannel.WorkspacesRename, req),
    // M3.6 C — 모든 윈도우가 list 변경을 동기화. removedWorkspaceId가 채워지면 그 워크스페이스가
    // hard delete된 것 → 자기 openWorkspaceId가 그 값이면 home으로 폴백.
    onChanged: (cb: (evt: WorkspacesChangedEvent) => void): Unsubscribe => {
      const handler = (_: unknown, evt: WorkspacesChangedEvent): void => cb(evt)
      ipcRenderer.on(IpcChannel.WorkspacesChanged, handler)
      return () => {
        ipcRenderer.off(IpcChannel.WorkspacesChanged, handler)
      }
    }
  },
  // 홈 화면 첫 제출 — workspace 생성 + 세션 spawn + 첫 메시지 submit 일괄.
  home: {
    submit: (req: HomeSubmitRequest): Promise<HomeSubmitResult> =>
      ipcRenderer.invoke(IpcChannel.HomeSubmit, req)
  },
  sessions: {
    create: (req: SessionCreateRequest): Promise<SessionActivateResult> =>
      ipcRenderer.invoke(IpcChannel.SessionsCreate, req),
    open: (req: SessionOpenRequest): Promise<SessionActivateResult> =>
      ipcRenderer.invoke(IpcChannel.SessionsOpen, req),
    close: (req: SessionCloseRequest): Promise<SessionMeta> =>
      ipcRenderer.invoke(IpcChannel.SessionsClose, req),
    list: (workspaceId: string): Promise<SessionMeta[]> =>
      ipcRenderer.invoke(IpcChannel.SessionsList, workspaceId),
    rename: (req: SessionRenameRequest): Promise<SessionMeta> =>
      ipcRenderer.invoke(IpcChannel.SessionsRename, req),
    onModelSessionCaptured: (cb: (evt: SessionModelSessionCapturedEvent) => void): Unsubscribe => {
      const handler = (_: unknown, evt: SessionModelSessionCapturedEvent): void => cb(evt)
      ipcRenderer.on(IpcChannel.SessionsModelSessionCaptured, handler)
      return () => {
        ipcRenderer.off(IpcChannel.SessionsModelSessionCaptured, handler)
      }
    }
  },
  // M3 M 청크 — codex `/hooks` 사용자 trust 상태. UI가 'pending'일 때 안내 배너 표시.
  hooks: {
    trustGet: (workspaceId: string): Promise<HookTrustEntry> =>
      ipcRenderer.invoke(IpcChannel.HooksTrustGet, workspaceId),
    trustSet: (req: HookTrustSetRequest): Promise<HookTrustEntry> =>
      ipcRenderer.invoke(IpcChannel.HooksTrustSet, req)
  },
  // M3 N 청크 — refine 모델 정책 + gemini quota 상태.
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke(IpcChannel.SettingsGet),
    set: (patch: Partial<AppSettings>): Promise<AppSettings> =>
      ipcRenderer.invoke(IpcChannel.SettingsSet, patch),
    // settings:set 직후 main이 broadcast — 다른 패널/윈도우 즉시 반영.
    onUpdated: (cb: (settings: AppSettings) => void): Unsubscribe => {
      const handler = (_: unknown, s: AppSettings): void => cb(s)
      ipcRenderer.on(IpcChannel.SettingsUpdated, handler)
      return () => {
        ipcRenderer.off(IpcChannel.SettingsUpdated, handler)
      }
    }
  },
  quota: {
    get: (): Promise<QuotaSnapshotsByCli> => ipcRenderer.invoke(IpcChannel.QuotaGet),
    probe: (req: QuotaProbeRequest): Promise<QuotaProbeResult> =>
      ipcRenderer.invoke(IpcChannel.QuotaProbe, req),
    onUpdated: (cb: (evt: QuotaUpdatedEvent) => void): Unsubscribe => {
      const handler = (_: unknown, evt: QuotaUpdatedEvent): void => cb(evt)
      ipcRenderer.on(IpcChannel.QuotaUpdated, handler)
      return () => {
        ipcRenderer.off(IpcChannel.QuotaUpdated, handler)
      }
    }
  },
  // M3.6 B — 드래그 앤 드롭 파일 첨부.
  // OS 파일을 xterm에 드롭 → renderer에서 webUtils.getPathForFile로 절대 경로 추출 →
  // 이 IPC로 stat 검증 + PTY inject.
  attach: {
    files: (req: AttachFilesRequest): Promise<AttachFilesResult> =>
      ipcRenderer.invoke(IpcChannel.AttachFiles, req),
    // Electron 32+ 이후 File.path가 사라져 webUtils.getPathForFile만이 안전한 경로.
    // contextIsolated 환경에서 renderer가 File 객체를 그대로 넘기면 preload가 native path 추출.
    getPathForFile: (file: File): string => webUtils.getPathForFile(file)
  },
  // 자동 업데이트 — in-app 수동 체크 + 진행 상태 구독.
  // checkForUpdates는 즉시 trigger(중복 차단), getStatus는 마지막 status 즉시 조회,
  // onStatus는 main이 broadcast하는 통합 payload 구독.
  appUpdater: {
    checkForUpdates: (): Promise<AppUpdaterCheckResult> =>
      ipcRenderer.invoke(IpcChannel.AppUpdaterCheck),
    getStatus: (): Promise<AppUpdaterStatus> => ipcRenderer.invoke(IpcChannel.AppUpdaterGet),
    onStatus: (cb: (status: AppUpdaterStatus) => void): Unsubscribe => {
      const handler = (_: unknown, status: AppUpdaterStatus): void => cb(status)
      ipcRenderer.on(IpcChannel.AppUpdaterStatus, handler)
      return () => {
        ipcRenderer.off(IpcChannel.AppUpdaterStatus, handler)
      }
    }
  },
  // M3.6 C — 멀티 윈도우. workspace를 새/기존 윈도우로 열기 + 부팅 시 자기 윈도우 식별.
  // claim/release는 한 워크스페이스 = 한 윈도우 정책 강화 — renderer가 ws attach 전에 호출.
  window: {
    openWorkspace: (req: WindowOpenWorkspaceRequest): Promise<void> =>
      ipcRenderer.invoke(IpcChannel.WindowOpenWorkspace, req),
    getBootstrap: (): Promise<WindowBootstrap> => ipcRenderer.invoke(IpcChannel.WindowGetBootstrap),
    claimWorkspace: (req: WindowClaimWorkspaceRequest): Promise<WindowClaimWorkspaceResult> =>
      ipcRenderer.invoke(IpcChannel.WindowClaimWorkspace, req),
    releaseWorkspace: (): Promise<void> => ipcRenderer.invoke(IpcChannel.WindowReleaseWorkspace)
  }
}

export type AgentBridgeApi = typeof agentbridge

// curated `window.agentbridge` API만 노출. 이전엔 `@electron-toolkit/preload`의 범용 electronAPI
// (`window.electron.ipcRenderer.invoke/...`)를 함께 노출해 모든 IPC 채널이 우회 가능했으나
// v0.0.4에서 제거 — renderer는 명시 메서드만 사용.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('agentbridge', agentbridge)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.agentbridge = agentbridge
}
