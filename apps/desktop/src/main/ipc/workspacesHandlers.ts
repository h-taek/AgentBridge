import { app, ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { promises as fs } from 'fs'
import * as path from 'path'
import log from 'electron-log/main'
import {
  IpcChannel,
  type HomeSubmitRequest,
  type HomeSubmitResult,
  type HookTrustEntry,
  type HookTrustSetRequest,
  type SessionActivateResult,
  type SessionCloseRequest,
  type SessionCreateRequest,
  type SessionMeta,
  type SessionModelSessionCapturedEvent,
  type SessionOpenRequest,
  type SessionRenameRequest,
  type WorkspaceCreateRequest,
  type WorkspaceCreateResult,
  type WorkspaceListEntry,
  type WorkspaceMeta,
  type WorkspaceRenameRequest,
  type WorkspacesChangedEvent
} from '@shared/ipc'
import {
  broadcastToAll,
  closeWindowByWorkspaceId,
  refreshWindowTitle
} from '../modules/windowManager'
import { getAdapter } from '../modules/cliAdapter'
import { killPty, killPtyAsync, startPty, writePty } from '../modules/ptySession'
import { loadSettings, resolveDefaultBasePath } from '../modules/settings'
import {
  addSessionToWorkspace,
  createWorkspace,
  deleteLegacyThreadBackup,
  deleteSession,
  deleteWorkspace,
  getSessionPaths,
  getWorkspacePaths,
  listWorkspaces,
  loadSession,
  loadWorkspace,
  readSessionReplay,
  touchWorkspace,
  updateSessionMeta,
  updateWorkspaceMeta
} from '../modules/workspaceStore'
import { installHooksForSession } from '../modules/hookInstaller'
import { onAssistantData, registerRecorder, unregisterRecorder } from '../modules/turnRecorder'
import { registerDisplayFilter, unregisterDisplayFilter } from '../modules/ptyDisplayFilter'
import { ensureConversationDirs } from '../modules/conversationStore'
import {
  clearActiveSession,
  clearActiveSessionIfMatches,
  getActiveSession,
  setActiveSession,
  updateActiveSessionModelId,
  listActiveSessionsInWorkspace
} from '../modules/sessionActive'

// M3 K + L1 청크 — workspaces:* / sessions:* IPC 핸들러.
// L1: sessions:create/open이 PTY spawn까지 통합. 다중 active session 지원.
// 기존 threads/handoff 핸들러는 그대로 — L 청크가 UI 전환 후 deprecate.

async function handleWorkspacesList(): Promise<WorkspaceListEntry[]> {
  const list = await listWorkspaces()
  // activeSessionCount는 메모리 derive — sessionActive 모듈에서 카운트.
  return list.map((w) => ({
    ...w,
    activeSessionCount: listActiveSessionsInWorkspace(w.workspaceId).length
  }))
}

async function handleWorkspacesGet(_e: unknown, workspaceId: string): Promise<WorkspaceMeta> {
  return loadWorkspace(workspaceId)
}

// M3.6 C — 워크스페이스 create/rename/delete가 모든 윈도우 좌 사이드바 list에 반영되도록 전역 broadcast.
function broadcastWorkspacesChanged(removedWorkspaceId: string | null = null): void {
  const evt: WorkspacesChangedEvent = { removedWorkspaceId }
  broadcastToAll(IpcChannel.WorkspacesChanged, evt)
}

async function handleWorkspacesCreate(
  _e: unknown,
  req: WorkspaceCreateRequest
): Promise<WorkspaceCreateResult> {
  log.info('workspaces:create', {
    initialModel: req.initialModel,
    workspacePath: req.workspacePath
  })
  const created = await createWorkspace(req)
  broadcastWorkspacesChanged()
  return { workspace: created.workspace, firstSession: created.firstSession }
}

async function handleWorkspacesOpen(_e: unknown, workspaceId: string): Promise<WorkspaceMeta> {
  // L1: 메타만 반환. UI는 sessions:open으로 개별 탭 활성화.
  // Phase 2: quota probe는 더 이상 workspaces:open에서 trigger하지 않음.
  // refine이 실행될 때 RefineDispatcher가 *해당 CLI*만 probe하며, 사용자는 RefineSettingsPanel에서
  // 명시 trigger로 임의 CLI를 즉시 probe 가능.
  return loadWorkspace(workspaceId)
}

async function handleWorkspacesDelete(_e: unknown, workspaceId: string): Promise<void> {
  log.info('workspaces:delete', { workspaceId })
  // 활성 PTY 모두 정리 — *exit까지 await*. claude처럼 SIGTERM 후 마지막 flush로 native
  // jsonl을 다시 쓰는 CLI가 있어, deleteNativeSession 전에 PTY 종료를 보장해야 race가 없음.
  await Promise.all(
    listActiveSessionsInWorkspace(workspaceId).map(async (s) => {
      try {
        await killPtyAsync(s.ptySessionId)
      } catch {
        /* noop */
      }
      clearActiveSession(workspaceId, s.sessionId)
    })
  )
  // 정책 (1) — 워크스페이스 안 *모든 세션의 native CLI 파일*도 함께 hard delete.
  // 안 하면 외부 agent(`claude --resume`, `codex resume`, `gemini --resume`)에서 그 세션이
  // 그대로 보임. 워크스페이스 디스크 삭제 *전*에 메타에서 modelSessionId들을 수집해야 함.
  try {
    const ws = await loadWorkspace(workspaceId)
    for (const s of ws.sessions) {
      // shell 세션은 native 흔적이 없어 어댑터 dispatch 자체가 부적합.
      if ((s.kind ?? 'cli') === 'shell') continue
      if (!s.modelSessionId) continue
      try {
        await getAdapter(s.model).deleteNativeSession(s.modelSessionId, ws.workspacePath)
      } catch (err) {
        log.warn('native session 삭제 실패 (cascade)', {
          workspaceId,
          sessionId: s.sessionId,
          model: s.model,
          err: String(err)
        })
      }
    }
  } catch (err) {
    log.warn('워크스페이스 메타 로드 실패 — native session cascade 삭제 skip', {
      workspaceId,
      err: String(err)
    })
  }
  await deleteWorkspace(workspaceId)
  // L3 fix — 원본 legacy thread 백업도 cascade 삭제. 이렇게 안 하면 다음 부팅 시
  // migrateThreadsToWorkspaces가 *워크스페이스 없는 thread*를 다시 마이그레이션해 사용자가
  // 삭제한 워크스페이스가 재출현. workspaceId == legacy contextId이므로 매칭됨.
  try {
    const dirs = await ensureConversationDirs()
    await deleteLegacyThreadBackup(dirs.threads, workspaceId)
  } catch (err) {
    log.warn('legacy thread backup cascade 삭제 실패 (non-fatal)', {
      workspaceId,
      err: String(err)
    })
  }
  // M3.6 C — 그 워크스페이스 윈도우(있다면) 즉시 닫기 + 다른 윈도우는 list refetch.
  closeWindowByWorkspaceId(workspaceId)
  broadcastWorkspacesChanged(workspaceId)
}

// L1: sessions:create — 새 세션 record + 즉시 PTY spawn.
// kind='shell'이면 어댑터 없이 zsh/bash 직접 spawn (hook/turnRecorder/IR 전부 bypass).
async function handleSessionsCreate(
  event: IpcMainInvokeEvent,
  req: SessionCreateRequest
): Promise<SessionActivateResult> {
  const kind = req.kind ?? 'cli'
  log.info('sessions:create', { workspaceId: req.workspaceId, model: req.model, kind })
  const session = await addSessionToWorkspace(req.workspaceId, req.model, kind)
  if (kind === 'shell') {
    return spawnAndAttachShellSession(event, req.workspaceId, session, {
      cols: req.cols,
      rows: req.rows
    })
  }
  return spawnAndAttachSession(event, req.workspaceId, session, {
    cols: req.cols,
    rows: req.rows
  })
}

// L1: sessions:open — 기존 세션 재활성화 (closedAt → null) + PTY 재spawn (modelSessionId로 --resume).
async function handleSessionsOpen(
  event: IpcMainInvokeEvent,
  req: SessionOpenRequest
): Promise<SessionActivateResult> {
  log.info('sessions:open', { workspaceId: req.workspaceId, sessionId: req.sessionId })
  const ws = await loadWorkspace(req.workspaceId)
  const session = ws.sessions.find((s) => s.sessionId === req.sessionId)
  if (!session) {
    throw new Error(`session not found: ${req.workspaceId}/${req.sessionId}`)
  }
  // 이미 active면 새 spawn 하지 않고 그대로 반환 (race + 중복 방지)
  const existingActive = getActiveSession(req.workspaceId, req.sessionId)
  if (existingActive) {
    const replay = await readSessionReplay(req.workspaceId, req.sessionId)
    return {
      workspace: ws,
      session,
      pty: {
        sessionId: existingActive.ptySessionId,
        pid: 0, // pid는 PTY 내부에서만 사용 — 외부에서 0 표기 OK
        modelSessionId: existingActive.modelSessionId
      },
      replay
    }
  }
  // closedAt mark null
  const reopened =
    session.closedAt === null
      ? session
      : await updateSessionMeta(req.workspaceId, req.sessionId, { closedAt: null })
  // shell 세션은 어댑터 없이 새 zsh spawn — orphan 처리도 불필요.
  if ((reopened.kind ?? 'cli') === 'shell') {
    return spawnAndAttachShellSession(event, req.workspaceId, reopened, {
      cols: req.cols,
      rows: req.rows
    })
  }
  try {
    return await spawnAndAttachSession(event, req.workspaceId, reopened, {
      cols: req.cols,
      rows: req.rows
    })
  } catch (err) {
    // 어댑터가 "native 세션 미영속화" 사유로 spawn 실패한 경우 — 강제종료/충돌 등으로
    // 빈 세션이 다음 부팅에 남았을 때 발생. 우리 측 sessions[] 메타도 자동 정리해
    // 다음 sessions:list 결과에서 사라지게 한다.
    const msg = String(err)
    if (msg.includes('영속화하지 않습니다')) {
      log.warn('sessions:open — orphan native session, auto-cleaning meta', {
        workspaceId: req.workspaceId,
        sessionId: req.sessionId
      })
      try {
        await deleteSession(req.workspaceId, req.sessionId)
      } catch (delErr) {
        log.warn('orphan 정리 실패 (non-fatal)', { err: String(delErr) })
      }
      throw new Error(`ORPHAN_SESSION: ${req.sessionId}`)
    }
    throw err
  }
}

// sessions:close — PTY kill 후 다음 둘 중 하나:
//   (a) hard delete — 사용자 탭 x close(permanent=true) OR 어댑터 hasNativeSession()=false
//       (= CLI가 사용자 메시지를 받은 적이 없어 native 파일이 디스크에 안 만들어진 빈 세션).
//       우리 sessions/<sid>/ + workspace.json sessions[] + 어댑터 native 파일 모두 삭제.
//   (b) closedAt 마킹 — 작업 이력 있는 세션이 워크스페이스 "닫기"로 close될 때.
//       다음 sessions:open 시 closedAt → null로 reopen.
//
// 정책 (1) 외부 agent 노출 차단 — hard delete가 우리 디스크뿐 아니라 *각 CLI native 세션
// 파일까지 삭제*해 외부 `claude --resume`/`codex resume`/`gemini --resume`에서도 사라짐.
async function handleSessionsClose(_e: unknown, req: SessionCloseRequest): Promise<SessionMeta> {
  log.info('sessions:close', {
    workspaceId: req.workspaceId,
    sessionId: req.sessionId,
    permanent: !!req.permanent,
    source: req.source ?? 'unknown'
  })
  const activeS = getActiveSession(req.workspaceId, req.sessionId)
  if (activeS) {
    // PTY가 *완전히 exit*할 때까지 await — claude는 SIGTERM 처리 중 마지막 flush로 native
    // jsonl을 다시 쓰므로, deleteNativeSession을 그 이후에 해야 race 없이 unlink 유지됨.
    try {
      await killPtyAsync(activeS.ptySessionId)
    } catch {
      /* noop */
    }
    clearActiveSession(req.workspaceId, req.sessionId)
  }

  // 세션 메타 + workspace 메타 로드 — 어댑터 dispatch에 model/modelSessionId/cwd 필요.
  let session: SessionMeta | null = null
  let workspacePath: string | undefined
  try {
    const ws = await loadWorkspace(req.workspaceId)
    workspacePath = ws.workspacePath
    session = ws.sessions.find((s) => s.sessionId === req.sessionId) ?? null
  } catch {
    /* 메타 못 읽으면 hard delete 결정만 보수적으로 처리 */
  }

  // hard delete 사유:
  //   - permanent=true (사용자 명시 hard delete — 사이드바 휴지통)만 hard delete.
  //
  // 정책 변경 (2026-05-21): "빈 세션 자동 정리" 흐름 폐기.
  // 이유:
  //   (1) 사용자가 탭 X 또는 워크스페이스 닫기로 닫은 세션은 "다시 열고 싶을 수도 있는" 상태 —
  //       다음 reopen 시 soft close에서 복원되어야 함.
  //   (2) modelSessionId 캡처가 spawn 후 비동기(agy 등)인 경우, 캡처 전에 닫히면 항상
  //       modelSessionId=null → hasNativeSession=false → hard delete로 잘못 삭제되는 race 다발.
  //   (3) 빈 세션 disk 잔재가 누적되더라도 사용자가 사이드바 휴지통으로 명시 정리 가능.
  //       자동 판정의 부정확성보다 명시성이 우선.
  const isShell = session ? (session.kind ?? 'cli') === 'shell' : false
  const shouldHardDelete = req.permanent === true
  if (shouldHardDelete) {
    log.info('sessions:close — hard delete', {
      workspaceId: req.workspaceId,
      sessionId: req.sessionId,
      reason: 'user-permanent'
    })
    // 어댑터 native 파일 먼저 삭제(외부 agent 노출 차단). shell은 skip — 흔적 없음.
    if (!isShell && session?.modelSessionId) {
      try {
        await getAdapter(session.model).deleteNativeSession(session.modelSessionId, workspacePath)
      } catch (err) {
        log.warn('native session 삭제 실패 (계속 진행)', {
          workspaceId: req.workspaceId,
          sessionId: req.sessionId,
          err: String(err)
        })
      }
    }
    try {
      await deleteSession(req.workspaceId, req.sessionId)
      return {
        sessionId: req.sessionId,
        model: session?.model ?? 'claude',
        modelSessionId: null,
        createdAt: new Date().toISOString(),
        closedAt: new Date().toISOString()
      }
    } catch (err) {
      log.warn('세션 hard delete 실패 — closedAt 마킹으로 fallback', {
        workspaceId: req.workspaceId,
        sessionId: req.sessionId,
        err: String(err)
      })
      // fallthrough → 일반 closedAt 마킹
    }
  }

  return updateSessionMeta(req.workspaceId, req.sessionId, {
    closedAt: new Date().toISOString()
  })
}

async function handleSessionsList(_e: unknown, workspaceId: string): Promise<SessionMeta[]> {
  const ws = await loadWorkspace(workspaceId)
  return ws.sessions
}

// ─── PTY spawn + sessionActive 등록 공통 흐름 ──────────────────────────
//
// handoff:commit 패턴과 거의 동일 — 단지 thread 단위 → workspace+session 단위로 키 확장.
// sessionId는 우리 세션 메타 ID(랜덤 UUID), modelSessionId는 CLI native (claude UUID/codex thread_id/gemini index).
//
// 새 spawn 시 modelSessionId가 null이면 (= 첫 spawn 또는 미캡처) 어댑터에 sessionId=null 전달해
// CLI native UUID 발급. 캡처 콜백 도착 시 sessions/<sid>/meta.json + workspace.json + sessionActive
// 갱신 + IPC 이벤트 발사.
async function spawnAndAttachSession(
  event: IpcMainInvokeEvent,
  workspaceId: string,
  session: SessionMeta,
  opts: { cols?: number; rows?: number }
): Promise<SessionActivateResult> {
  const ws = await loadWorkspace(workspaceId)
  const adapter = getAdapter(session.model)
  const sessionPaths = getSessionPaths(workspaceId, session.sessionId)
  const workspacePaths = getWorkspacePaths(workspaceId)

  // 직전 active가 *동일 workspace+session*에 등록돼 있으면 — 새 spawn 들어가기 전 정리.
  // 정상적으로는 sessions:close가 먼저 와야 하나, 사용자 더블클릭 등 race 방어.
  const old = getActiveSession(workspaceId, session.sessionId)
  if (old) {
    log.info('sessions:open — 기존 active PTY 정리 (race 방어)', {
      workspaceId,
      sessionId: session.sessionId,
      ptySessionId: old.ptySessionId
    })
    try {
      killPty(old.ptySessionId)
    } catch {
      /* noop */
    }
    clearActiveSession(workspaceId, session.sessionId)
  }

  // M3 M 청크 — hook config install. spawn 직전에 매번 install해 helper binary 경로 변경
  // (dev/prod 전환, electron 재빌드 등)에도 항상 최신 경로 반영. 마커 블록 merge라 사용자 콘텐츠 보존.
  // 실패 시: spawn은 진행하되 hookDisabledReason을 결과에 포함해 UI가 "메모리 비활성" 배지 표시.
  // (이전엔 silent로 IR 주입 비활성 상태가 됐는데 사용자가 핵심 기능 동작 중이라 오해할 위험.)
  let claudeSettingsPath: string | undefined
  let hookDisabledReason: string | undefined
  try {
    const hooks = await installHooksForSession({
      model: session.model,
      workspaceId,
      workspaceCwd: ws.workspacePath,
      workspaceSettingsDir: workspacePaths.settingsDir,
      userDataPath: app.getPath('userData')
    })
    claudeSettingsPath = hooks.claudeSettingsPath
    // codex 첫 spawn 시 trust 상태 미설정이면 'pending' 마킹 — UI가 안내 배너 표시.
    if (session.model === 'codex' && ws.codexHookTrust == null) {
      await updateWorkspaceMeta(workspaceId, { codexHookTrust: 'pending' })
    }
  } catch (err) {
    hookDisabledReason = String(err)
    log.error('HookInstaller 실패 — IR 주입 비활성 상태로 spawn (UI에 배지 표시)', {
      workspaceId,
      sessionId: session.sessionId,
      model: session.model,
      err: hookDisabledReason
    })
  }

  // IR 주입은 hook 시스템 — argv 기반 spawn-time 주입은 폐기됨.
  // TurnRecorder는 spawn 직후 ptySessionId가 결정되면 등록 — onData 콜백 closure가 ptyIdRef로 lookup.
  const ptyIdRef: { current: string | null } = { current: null }
  const pty = await adapter.spawnInteractive(
    {
      sessionId: session.modelSessionId,
      cwd: ws.workspacePath,
      cols: opts.cols,
      rows: opts.rows,
      claudeSettingsPath
    },
    event.sender,
    {
      replayLogPath: sessionPaths.replayLog,
      onData: (data): void => {
        void touchWorkspace(workspaceId)
        if (ptyIdRef.current) onAssistantData(ptyIdRef.current, data)
      },
      onExit: (info): void => {
        // 같은 (workspace, session)에 이후 새 spawn이 등록됐으면 race 방지로 match일 때만 clear.
        clearActiveSessionIfMatches(workspaceId, session.sessionId, info.ptySessionId)
        unregisterRecorder(info.ptySessionId)
        unregisterDisplayFilter(info.ptySessionId)
      },
      onModelSessionIdCaptured: (modelSessionId): void => {
        void (async (): Promise<void> => {
          try {
            log.info('sessions — modelSessionId captured', {
              workspaceId,
              sessionId: session.sessionId,
              model: session.model,
              modelSessionId
            })
            await updateSessionMeta(workspaceId, session.sessionId, { modelSessionId })
            updateActiveSessionModelId(workspaceId, session.sessionId, modelSessionId)
            if (!event.sender.isDestroyed()) {
              const evt: SessionModelSessionCapturedEvent = {
                workspaceId,
                sessionId: session.sessionId,
                modelSessionId
              }
              event.sender.send(IpcChannel.SessionsModelSessionCaptured, evt)
            }
          } catch (err) {
            log.warn('sessions modelSessionId 후처리 실패', {
              workspaceId,
              sessionId: session.sessionId,
              err: String(err)
            })
          }
        })()
      }
    }
  )

  // claude/gemini는 즉시 modelSessionId 캡처. codex는 null이라 캡처 콜백이 나중에.
  if (pty.modelSessionId != null && pty.modelSessionId !== session.modelSessionId) {
    await updateSessionMeta(workspaceId, session.sessionId, {
      modelSessionId: pty.modelSessionId
    })
  }

  setActiveSession({
    workspaceId,
    sessionId: session.sessionId,
    ptySessionId: pty.sessionId,
    modelSessionId: pty.modelSessionId,
    model: session.model
  })
  // TurnRecorder + DisplayFilter 등록 — ptySessionId가 spawn 후 결정. onData 콜백은 ptyIdRef로 lookup.
  // DisplayFilter는 ptySession이 직접 호출(같은 ptySessionId)하므로 별도 ref 불필요.
  ptyIdRef.current = pty.sessionId
  registerDisplayFilter(pty.sessionId)
  registerRecorder({
    workspaceId,
    sessionId: session.sessionId,
    ptySessionId: pty.sessionId,
    model: session.model
  })

  // primarySessionId가 null인 워크스페이스(손상 마이그레이션 잔재)는 첫 활성 세션으로 채움.
  if (ws.primarySessionId === null) {
    await updateWorkspaceMeta(workspaceId, { primarySessionId: session.sessionId })
  }

  const updatedWs = await loadWorkspace(workspaceId)
  const updatedSession = await loadSession(workspaceId, session.sessionId)
  const replay = await readSessionReplay(workspaceId, session.sessionId)

  return {
    workspace: updatedWs,
    session: updatedSession,
    pty,
    replay,
    hookDisabledReason
  }
}

// ─── 내장 터미널 세션 spawn ─────────────────────────────────────────────
//
// `kind === 'shell'` 세션 — 사용자 cwd에서 일반 zsh/bash PTY를 spawn한다.
// AgentBridge hook 주입, IR refine, TurnRecorder, quota probe 모두 *bypass* — 그저 터미널.
//   - 어댑터 없음 (CLIAdapter 인터페이스는 cli 세션 전용)
//   - hookInstaller 호출 안 함 (cwd 안 AI 지시 파일 / settings 격리 모두 불필요)
//   - registerRecorder / registerDisplayFilter 호출 안 함 (모델 응답이 없어 의미 없음)
//   - modelSessionId는 항상 null (외부 `claude --resume` 등에 노출되지 않음 — 정책 1 자동 만족)
//   - sessionActive 등록은 함 (workspace activeSessionCount, before-quit killAllForce 대상에 포함)
async function spawnAndAttachShellSession(
  event: IpcMainInvokeEvent,
  workspaceId: string,
  session: SessionMeta,
  opts: { cols?: number; rows?: number }
): Promise<SessionActivateResult> {
  const ws = await loadWorkspace(workspaceId)
  const sessionPaths = getSessionPaths(workspaceId, session.sessionId)

  // race 방어 — 직전 active가 같은 (workspace, session)에 등록돼 있으면 정리.
  const old = getActiveSession(workspaceId, session.sessionId)
  if (old) {
    log.info('shell — 기존 active PTY 정리 (race 방어)', {
      workspaceId,
      sessionId: session.sessionId,
      ptySessionId: old.ptySessionId
    })
    try {
      killPty(old.ptySessionId)
    } catch {
      /* noop */
    }
    clearActiveSession(workspaceId, session.sessionId)
  }

  // 사용자 기본 shell(zsh) — 없으면 /bin/zsh, 그것도 없으면 /bin/sh로 OS가 폴백 보장.
  // -l (login) 플래그로 사용자 .zshrc/.zprofile을 로드 — PATH/alias 정상 작동.
  const command = process.env.SHELL || '/bin/zsh'
  log.info('shell — spawn', {
    workspaceId,
    sessionId: session.sessionId,
    command,
    cwd: ws.workspacePath
  })

  const pty = startPty(
    {
      command,
      args: ['-l'],
      cwd: ws.workspacePath,
      cols: opts.cols,
      rows: opts.rows
    },
    event.sender,
    {
      replayLogPath: sessionPaths.replayLog,
      onData: (): void => {
        void touchWorkspace(workspaceId)
      },
      onExit: (info): void => {
        clearActiveSessionIfMatches(workspaceId, session.sessionId, info.ptySessionId)
      }
    }
  )

  setActiveSession({
    workspaceId,
    sessionId: session.sessionId,
    ptySessionId: pty.sessionId,
    modelSessionId: null,
    model: session.model
  })

  if (ws.primarySessionId === null) {
    await updateWorkspaceMeta(workspaceId, { primarySessionId: session.sessionId })
  }

  const updatedWs = await loadWorkspace(workspaceId)
  const updatedSession = await loadSession(workspaceId, session.sessionId)
  const replay = await readSessionReplay(workspaceId, session.sessionId)

  return {
    workspace: updatedWs,
    session: updatedSession,
    pty: { sessionId: pty.sessionId, pid: pty.pid, modelSessionId: null },
    replay
  }
}

// 워크스페이스 이름 변경 — 인라인 편집에서 호출. 빈 문자열은 디스크 폴더명 fallback.
async function handleWorkspacesRename(
  _e: unknown,
  req: WorkspaceRenameRequest
): Promise<WorkspaceMeta> {
  const trimmed = req.title.trim()
  const ws = await loadWorkspace(req.workspaceId)
  const fallback = path.basename(ws.workspacePath) || 'workspace'
  const nextTitle = trimmed.length > 0 ? trimmed : fallback
  log.info('workspaces:rename', { workspaceId: req.workspaceId, title: nextTitle })
  const updated = await updateWorkspaceMeta(req.workspaceId, { title: nextTitle })
  refreshWindowTitle(req.workspaceId)
  broadcastWorkspacesChanged()
  return updated
}

// 세션 이름 변경 — 빈 문자열은 title undefined로 reset (UI는 모델명 fallback).
async function handleSessionsRename(_e: unknown, req: SessionRenameRequest): Promise<SessionMeta> {
  const trimmed = req.title.trim()
  log.info('sessions:rename', {
    workspaceId: req.workspaceId,
    sessionId: req.sessionId,
    title: trimmed.length > 0 ? trimmed : '(reset)'
  })
  return updateSessionMeta(req.workspaceId, req.sessionId, {
    title: trimmed.length > 0 ? trimmed : undefined
  })
}

// 홈 화면 첫 제출 — defaultBasePath 하위에 폴더 자동 생성 + 워크스페이스 + 세션 + 첫 메시지 일괄.
// 폴더명 형식 `chat-YYYYMMDD-HHMMSS` (충돌 시 `-<n>` suffix). 워크스페이스 title도 동일.
//
// 첫 메시지 submit은 PTY ready를 1.2초 sleep으로 추정. 모델별 TUI 초기화 시간(claude/codex/gemini
// 모두 1초 이내 prompt 그려짐 — M2 검증)을 고려. 그 후 어댑터 formatChatSubmit으로 모델별
// 정확한 step 시퀀스를 PTY에 write.
async function handleHomeSubmit(
  event: IpcMainInvokeEvent,
  req: HomeSubmitRequest
): Promise<HomeSubmitResult> {
  log.info('home:submit', { model: req.model, messageLength: req.message.length })
  const settings = await loadSettings()
  const baseDir = resolveDefaultBasePath(settings)
  await fs.mkdir(baseDir, { recursive: true })

  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  // Chat-YYMMDD-HHMM 형식 — 예: Chat-260512-1430. 같은 분 내 충돌은 아래 EEXIST 루프에서 `-N` suffix로 처리.
  const yy = String(now.getFullYear()).slice(-2)
  const stem = `Chat-${yy}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  let folderName = stem
  let suffix = 1
  // 동일 초에 두 개 생성되는 충돌만 방어 (보통 2번 안 돈다)
  while (true) {
    const candidate = path.join(baseDir, folderName)
    try {
      await fs.mkdir(candidate, { recursive: false })
      break
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw err
      folderName = `${stem}-${suffix++}`
    }
  }
  const workspacePath = path.join(baseDir, folderName)

  const created = await createWorkspace({
    initialModel: req.model,
    workspacePath,
    title: folderName
  })

  const activated = await spawnAndAttachSession(
    event,
    created.workspace.workspaceId,
    created.firstSession,
    {
      cols: req.cols,
      rows: req.rows
    }
  )

  // 메시지 제출 — PTY ready 짐작 후 어댑터별 submit step 실행
  const adapter = getAdapter(req.model)
  const trimmed = req.message.trim()
  if (trimmed.length > 0) {
    void (async (): Promise<void> => {
      await new Promise<void>((resolve) => setTimeout(resolve, 1200))
      try {
        const steps = adapter.formatChatSubmit(trimmed)
        for (const step of steps) {
          writePty(activated.pty.sessionId, step.write)
          if (step.delayMs && step.delayMs > 0) {
            await new Promise<void>((r) => setTimeout(r, step.delayMs))
          }
        }
      } catch (err) {
        log.warn('home:submit 첫 메시지 전송 실패 (non-fatal)', {
          workspaceId: created.workspace.workspaceId,
          err: String(err)
        })
      }
    })()
  }

  return {
    workspace: activated.workspace,
    session: activated.session,
    pty: activated.pty,
    hookDisabledReason: activated.hookDisabledReason
  }
}

// hooks:trustGet — workspaceId 단위로 codex `/hooks` 사용자 trust 상태 조회. claude/gemini는
// 항상 'not-required'. UI는 codex 탭이 active일 때만 'pending' 배너를 띄운다.
async function handleHooksTrustGet(_e: unknown, workspaceId: string): Promise<HookTrustEntry> {
  try {
    const ws = await loadWorkspace(workspaceId)
    const codex = ws.codexHookTrust === 'trusted' ? 'trusted' : 'pending'
    return { workspaceId, codex }
  } catch {
    return { workspaceId, codex: 'pending' }
  }
}

// hooks:trustSet — 사용자가 codex 안에서 `/hooks` 명령 후 UI "승인 완료" 버튼 클릭 시.
// trusted=false면 'pending'으로 되돌림 (revoke 또는 재안내 케이스).
async function handleHooksTrustSet(_e: unknown, req: HookTrustSetRequest): Promise<HookTrustEntry> {
  const next = req.trusted ? 'trusted' : 'pending'
  await updateWorkspaceMeta(req.workspaceId, { codexHookTrust: next })
  log.info('hooks:trustSet', { workspaceId: req.workspaceId, codex: next })
  return { workspaceId: req.workspaceId, codex: next }
}

export function registerWorkspacesHandlers(): void {
  ipcMain.handle(IpcChannel.WorkspacesList, handleWorkspacesList)
  ipcMain.handle(IpcChannel.WorkspacesGet, handleWorkspacesGet)
  ipcMain.handle(IpcChannel.WorkspacesCreate, handleWorkspacesCreate)
  ipcMain.handle(IpcChannel.WorkspacesOpen, handleWorkspacesOpen)
  ipcMain.handle(IpcChannel.WorkspacesDelete, handleWorkspacesDelete)
  ipcMain.handle(IpcChannel.WorkspacesRename, handleWorkspacesRename)
  ipcMain.handle(IpcChannel.HomeSubmit, handleHomeSubmit)
  ipcMain.handle(IpcChannel.SessionsCreate, handleSessionsCreate)
  ipcMain.handle(IpcChannel.SessionsOpen, handleSessionsOpen)
  ipcMain.handle(IpcChannel.SessionsClose, handleSessionsClose)
  ipcMain.handle(IpcChannel.SessionsList, handleSessionsList)
  ipcMain.handle(IpcChannel.SessionsRename, handleSessionsRename)
  ipcMain.handle(IpcChannel.HooksTrustGet, handleHooksTrustGet)
  ipcMain.handle(IpcChannel.HooksTrustSet, handleHooksTrustSet)
}
