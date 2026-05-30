import { useCallback, useEffect, useMemo, useState } from 'react'
import log from 'electron-log/renderer'
import type {
  AppHealth,
  CliKind,
  CliSpawnInteractiveResult,
  EnvProbeResult,
  SessionCloseSource,
  WorkspaceListEntry,
  WorkspaceMeta
} from '@shared/ipc'
import { AppShell } from './components/AppShell'
import { HomePane } from './components/HomePane'
import { LeftSidebar } from './components/LeftSidebar'
import { RightSidebar } from './components/RightSidebar'
import { SessionTabs } from './components/SessionTabs'
import { SettingsModal } from './components/SettingsModal'
import { XtermView } from './components/XtermView'

// AppShell — 좌 사이드바(workspace 트리) + 중앙(SessionTabs + xterm stack) + 우 사이드바(메모리).
// 설정은 좌 사이드바 하단 톱니바퀴에서 모달로 열림.
// state/handler는 기존 그대로 유지하고 JSX 구성만 갱신.

function App(): React.JSX.Element {
  const [health, setHealth] = useState<AppHealth | null>(null)
  const [env, setEnv] = useState<EnvProbeResult | null>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceListEntry[]>([])
  const [workspacesErr, setWorkspacesErr] = useState<string | null>(null)
  const [openWorkspaceId, setOpenWorkspaceId] = useState<string | null>(null)
  const [openSessionId, setOpenSessionId] = useState<string | null>(null)
  const [openWorkspace, setOpenWorkspace] = useState<WorkspaceMeta | null>(null)
  const [attachments, setAttachments] = useState<Map<string, CliSpawnInteractiveResult>>(new Map())
  // 세션 spawn 시 hook 설치가 실패해 IR 주입이 비활성 상태로 진입한 경우 sessionId→reason.
  // SessionTabs가 이 set을 보고 해당 탭에 "메모리 비활성" 배지를 표시한다.
  // 워크스페이스 전환/세션 close 시 정리.
  const [hookDisabledMap, setHookDisabledMap] = useState<Map<string, string>>(new Map())
  const [workspacePath, setWorkspacePath] = useState<string>('')
  const [workspaceNameDraft, setWorkspaceNameDraft] = useState<string>('')
  const [initialModel, setInitialModel] = useState<CliKind>('claude')
  const [busy, setBusy] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    window.agentbridge
      .appHealth()
      .then((h) => {
        setHealth(h)
        setWorkspacePath((prev) => (prev.length === 0 ? h.cwd : prev))
      })
      .catch((e) => console.error('appHealth 실패', e))
    window.agentbridge
      .envProbe()
      .then(setEnv)
      .catch((e) => console.error('envProbe 실패', e))
  }, [])

  const reloadWorkspaces = useCallback(async () => {
    try {
      const list = await window.agentbridge.workspaces.list()
      setWorkspaces(list)
      setWorkspacesErr(null)
    } catch (e) {
      setWorkspacesErr(String(e))
    }
  }, [])

  // 부팅 시 workspaces.list — bootstrap 처리는 handleOpenCard 정의 뒤의 별도 useEffect에서.
  useEffect(() => {
    let cancelled = false
    window.agentbridge.workspaces
      .list()
      .then((list) => {
        if (!cancelled) {
          setWorkspaces(list)
          setWorkspacesErr(null)
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setWorkspacesErr(String(e))
      })
    return () => {
      cancelled = true
    }
  }, [])

  // M3.6 C — 다른 윈도우의 워크스페이스 변경(create/rename/delete) 동기화. 자기 openWorkspaceId가
  // hard delete된 워크스페이스면 home으로 폴백. 자기 윈도우가 그 워크스페이스 윈도우면 main이
  // closeWindowByWorkspaceId로 이미 닫는 중 → 그 윈도우는 broadcast 도착 전에 종료될 수 있음.
  useEffect(() => {
    const off = window.agentbridge.workspaces.onChanged((evt) => {
      void reloadWorkspaces()
      if (evt.removedWorkspaceId && evt.removedWorkspaceId === openWorkspaceId) {
        log.info('App.workspaces.onChanged — removed (clearing local state)', {
          removedWorkspaceId: evt.removedWorkspaceId
        })
        setAttachments(new Map())
        setHookDisabledMap(new Map())
        setOpenWorkspaceId(null)
        setOpenSessionId(null)
        setOpenWorkspace(null)
      }
    })
    return off
  }, [openWorkspaceId, reloadWorkspaces])

  // 채팅(turn 완료) 시점에 현재 열린 워크스페이스의 sessions[lastChattedAt] 갱신 → 좌사이드바
  // 세션 정렬 + 탭 정렬 반영. (워크스페이스 자체 정렬은 갱신 안 함 — 사용자 요청)
  // View Transitions API — sessions 재정렬을 startViewTransition으로 감싸면 사이드바/탭의
  // 동일 viewTransitionName 항목이 자동으로 슬라이드 모션 (Chromium 111+, Electron 39 지원).
  // 미지원 환경(타 브라우저 빌드 등)에선 fallback으로 즉시 setState.
  useEffect(() => {
    const off = window.agentbridge.memory.onTurnsUpdated((evt) => {
      if (evt.workspaceId === openWorkspaceId) {
        void window.agentbridge.workspaces
          .get(evt.workspaceId)
          .then((ws) => {
            const apply = (): void => setOpenWorkspace(ws)
            const doc = document as Document & {
              startViewTransition?: (cb: () => void) => unknown
            }
            if (typeof doc.startViewTransition === 'function') {
              doc.startViewTransition(apply)
            } else {
              apply()
            }
          })
          .catch(() => undefined)
      }
    })
    return off
  }, [openWorkspaceId])

  // codex thread_id 비동기 캡처
  useEffect(() => {
    const off = window.agentbridge.sessions.onModelSessionCaptured((evt) => {
      void window.agentbridge.workspaces
        .list()
        .then((list) => setWorkspaces(list))
        .catch(() => undefined)
      setAttachments((prev) => {
        const cur = prev.get(evt.sessionId)
        if (!cur) return prev
        const next = new Map(prev)
        next.set(evt.sessionId, { ...cur, modelSessionId: evt.modelSessionId })
        return next
      })
      if (openWorkspaceId === evt.workspaceId) {
        void window.agentbridge.workspaces
          .get(evt.workspaceId)
          .then((ws) => setOpenWorkspace(ws))
          .catch(() => undefined)
      }
    })
    return off
  }, [openWorkspaceId])

  const trimmedWorkspace = workspacePath.trim()

  const initialModelReady = useMemo(() => {
    return env?.clis.find((c) => c.kind === initialModel)?.found === true
  }, [env, initialModel])

  const closeAllAttachments = useCallback(
    async (source: SessionCloseSource) => {
      if (!openWorkspaceId) return
      const sids = Array.from(attachments.keys())
      log.info('App.closeAllAttachments', {
        workspaceId: openWorkspaceId,
        sessionCount: sids.length,
        source
      })
      for (const sessionId of sids) {
        try {
          await window.agentbridge.sessions.close({
            workspaceId: openWorkspaceId,
            sessionId,
            source
          })
        } catch {
          /* noop */
        }
      }
    },
    [openWorkspaceId, attachments]
  )

  // sessions:create / sessions:open / home:submit 결과에 hookDisabledReason이 채워져 있으면
  // 해당 sessionId를 hookDisabledMap에 추가, 없으면 제거(재spawn이 정상 hook 설치한 케이스).
  const applyHookStatus = useCallback((sessionId: string, reason: string | undefined): void => {
    setHookDisabledMap((prev) => {
      const has = prev.has(sessionId)
      if (reason) {
        const next = new Map(prev)
        next.set(sessionId, reason)
        return next
      }
      if (!has) return prev
      const next = new Map(prev)
      next.delete(sessionId)
      return next
    })
  }, [])

  const handleCreateWorkspace = useCallback(async () => {
    if (!initialModelReady || !trimmedWorkspace || busy) return
    log.info('App.handleCreateWorkspace', {
      initialModel,
      workspacePath: trimmedWorkspace,
      hasName: workspaceNameDraft.trim().length > 0
    })
    setBusy(true)
    try {
      await closeAllAttachments('workspace-create')
      const created = await window.agentbridge.workspaces.create({
        initialModel,
        workspacePath: trimmedWorkspace,
        title: workspaceNameDraft.trim() || undefined
      })
      // 새 ws — 다른 윈도우가 잡고 있을 수 없으므로 'claimed' 보장. 자기 윈도우 매핑 등록.
      await window.agentbridge.window.claimWorkspace({
        workspaceId: created.workspace.workspaceId
      })
      const activated = await window.agentbridge.sessions.open({
        workspaceId: created.workspace.workspaceId,
        sessionId: created.firstSession.sessionId
      })
      const newAttachments = new Map<string, CliSpawnInteractiveResult>()
      newAttachments.set(activated.session.sessionId, activated.pty)
      setAttachments(newAttachments)
      applyHookStatus(activated.session.sessionId, activated.hookDisabledReason)
      setOpenWorkspaceId(created.workspace.workspaceId)
      setOpenSessionId(activated.session.sessionId)
      setOpenWorkspace(activated.workspace)
      setWorkspaceNameDraft('')
      void reloadWorkspaces()
    } catch (e) {
      setWorkspacesErr(String(e))
    } finally {
      setBusy(false)
    }
  }, [
    initialModel,
    initialModelReady,
    trimmedWorkspace,
    workspaceNameDraft,
    busy,
    closeAllAttachments,
    reloadWorkspaces,
    applyHookStatus
  ])

  const handleOpenCard = useCallback(
    async (w: WorkspaceListEntry, targetSessionId?: string) => {
      if (busy) return
      log.info('App.handleOpenCard', {
        workspaceId: w.workspaceId,
        targetSessionId: targetSessionId ?? null,
        sessionCount: w.sessions.length
      })
      // 한 워크스페이스 = 한 윈도우 정책 — 다른 윈도우가 이미 잡고 있으면 그쪽 focus 후 자기는 무동작.
      const claim = await window.agentbridge.window.claimWorkspace({ workspaceId: w.workspaceId })
      if (claim.outcome === 'focused-other') return
      const sessions = w.sessions
      if (sessions.length === 0) {
        // 빈 워크스페이스 — 자동 삭제하지 않고 (사용자가 + 로 세션 추가 가능),
        // 활성만 비워둠.
        if (openWorkspaceId && openWorkspaceId !== w.workspaceId) {
          await closeAllAttachments('workspace-switch')
          setAttachments(new Map())
          setHookDisabledMap(new Map())
        }
        setOpenWorkspaceId(w.workspaceId)
        setOpenSessionId(null)
        try {
          const ws = await window.agentbridge.workspaces.get(w.workspaceId)
          setOpenWorkspace(ws)
        } catch {
          /* noop */
        }
        return
      }
      // 사용자가 특정 세션을 명시했으면 그 세션을 활성으로, 아니면 primary
      const focusSession =
        (targetSessionId ? sessions.find((s) => s.sessionId === targetSessionId) : undefined) ??
        sessions.find((s) => s.sessionId === w.primarySessionId) ??
        sessions[0]
      setBusy(true)
      try {
        if (openWorkspaceId && openWorkspaceId !== w.workspaceId) {
          await closeAllAttachments('workspace-switch')
          setAttachments(new Map())
          setHookDisabledMap(new Map())
        }
        const newAttachments = new Map<string, CliSpawnInteractiveResult>()
        let lastWorkspace: WorkspaceMeta | null = null
        const orphanIds: string[] = []
        // 세션별 try/catch — 한 세션 spawn 실패해도(예: 강제종료로 native 영속 안 된
        // 빈 세션) 다른 세션은 계속 열기.
        for (const s of sessions) {
          try {
            const activated = await window.agentbridge.sessions.open({
              workspaceId: w.workspaceId,
              sessionId: s.sessionId
            })
            newAttachments.set(activated.session.sessionId, activated.pty)
            applyHookStatus(activated.session.sessionId, activated.hookDisabledReason)
            lastWorkspace = activated.workspace
          } catch (sessErr) {
            const msg = String(sessErr)
            if (msg.includes('ORPHAN_SESSION') || msg.includes('영속화하지 않습니다')) {
              orphanIds.push(s.sessionId)
              continue
            }
            throw sessErr
          }
        }
        setAttachments(newAttachments)
        setOpenWorkspaceId(w.workspaceId)
        // focusSession이 orphan이면 첫 성공 session으로 폴백
        const focusOk = newAttachments.has(focusSession.sessionId)
        setOpenSessionId(
          focusOk ? focusSession.sessionId : (Array.from(newAttachments.keys())[0] ?? null)
        )
        setOpenWorkspace(lastWorkspace)
        if (orphanIds.length > 0) {
          setWorkspacesErr(
            `빈 세션 ${orphanIds.length}개가 강제 종료로 native 영속화되지 않아 자동 정리되었습니다.`
          )
        }
        void reloadWorkspaces()
      } catch (e) {
        setWorkspacesErr(String(e))
      } finally {
        setBusy(false)
      }
    },
    [busy, openWorkspaceId, closeAllAttachments, reloadWorkspaces, applyHookStatus]
  )

  // M3.6 C — 부팅 직후 window:getBootstrap 조회. workspaceId가 있으면(= 이 윈도우가 특정
  // 워크스페이스용으로 열린 경우) 그 entry를 찾아 handleOpenCard로 자동 attach. null이면 HomePane.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const bootstrap = await window.agentbridge.window.getBootstrap()
        if (cancelled || !bootstrap.workspaceId) return
        const list = await window.agentbridge.workspaces.list()
        if (cancelled) return
        const match = list.find((w) => w.workspaceId === bootstrap.workspaceId)
        if (!match) return
        await handleOpenCard(match)
      } catch (e: unknown) {
        if (!cancelled) setWorkspacesErr(String(e))
      }
    })()
    return () => {
      cancelled = true
    }
    // 부팅 1회 실행 가드 — handleOpenCard 의존성 변동으로 재실행되면 안 됨.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleDeleteCard = useCallback(
    async (w: WorkspaceListEntry) => {
      if (busy) return
      if (
        !window.confirm(
          `"${w.title}" 워크스페이스 전체를 삭제합니다. 되돌릴 수 없습니다. 진행할까요?`
        )
      ) {
        return
      }
      setBusy(true)
      try {
        if (openWorkspaceId === w.workspaceId) {
          setAttachments(new Map())
          setHookDisabledMap(new Map())
          setOpenWorkspaceId(null)
          setOpenSessionId(null)
          setOpenWorkspace(null)
        }
        await window.agentbridge.workspaces.delete(w.workspaceId)
        void reloadWorkspaces()
      } catch (e) {
        setWorkspacesErr(String(e))
      } finally {
        setBusy(false)
      }
    },
    [busy, openWorkspaceId, reloadWorkspaces]
  )

  const handlePickWorkspace = useCallback(async () => {
    try {
      const picked = await window.agentbridge.dialog.pickWorkspace(workspacePath || undefined)
      if (picked) setWorkspacePath(picked)
    } catch (e) {
      setWorkspacesErr(String(e))
    }
  }, [workspacePath])

  // 'shell'은 내장 터미널(=일반 zsh) — 어댑터 bypass. 그 외는 CLI 모델.
  // sessions.create에 model+kind 양쪽 전달. shell이면 model은 placeholder.
  const handleAddTab = useCallback(
    async (target: CliKind | 'shell') => {
      if (!openWorkspaceId || busy) return
      setBusy(true)
      try {
        const activated = await window.agentbridge.sessions.create(
          target === 'shell'
            ? { workspaceId: openWorkspaceId, model: 'claude', kind: 'shell' }
            : { workspaceId: openWorkspaceId, model: target }
        )
        setAttachments((prev) => {
          const next = new Map(prev)
          next.set(activated.session.sessionId, activated.pty)
          return next
        })
        applyHookStatus(activated.session.sessionId, activated.hookDisabledReason)
        setOpenSessionId(activated.session.sessionId)
        setOpenWorkspace(activated.workspace)
        void reloadWorkspaces()
      } catch (e) {
        setWorkspacesErr(String(e))
      } finally {
        setBusy(false)
      }
    },
    [openWorkspaceId, busy, reloadWorkspaces, applyHookStatus]
  )

  // 좌 사이드바의 워크스페이스 row + 버튼 — 어떤 워크스페이스에든 새 세션 추가.
  // 활성이 아닌 워크스페이스면 먼저 그 워크스페이스를 열고 이어서 세션 생성.
  const handleAddSessionToWorkspace = useCallback(
    async (w: WorkspaceListEntry, target: CliKind | 'shell') => {
      if (busy) return
      // 한 워크스페이스 = 한 윈도우 — 다른 윈도우가 잡고 있으면 그쪽 focus 후 자기는 무동작.
      if (openWorkspaceId !== w.workspaceId) {
        const claim = await window.agentbridge.window.claimWorkspace({
          workspaceId: w.workspaceId
        })
        if (claim.outcome === 'focused-other') return
      }
      setBusy(true)
      try {
        // 다른 워크스페이스로 전환이 필요한 경우 — 기존 attach 정리 후 전체 reopen
        let nextAttachments: Map<string, CliSpawnInteractiveResult>
        if (openWorkspaceId !== w.workspaceId) {
          if (openWorkspaceId) await closeAllAttachments('workspace-add')
          nextAttachments = new Map<string, CliSpawnInteractiveResult>()
          for (const s of w.sessions) {
            try {
              const activated = await window.agentbridge.sessions.open({
                workspaceId: w.workspaceId,
                sessionId: s.sessionId
              })
              nextAttachments.set(activated.session.sessionId, activated.pty)
              applyHookStatus(activated.session.sessionId, activated.hookDisabledReason)
            } catch (sessErr) {
              const msg = String(sessErr)
              if (msg.includes('ORPHAN_SESSION') || msg.includes('영속화하지 않습니다')) {
                continue
              }
              throw sessErr
            }
          }
        } else {
          nextAttachments = new Map(attachments)
        }

        // 새 세션 생성 + 마운트
        const created = await window.agentbridge.sessions.create(
          target === 'shell'
            ? { workspaceId: w.workspaceId, model: 'claude', kind: 'shell' }
            : { workspaceId: w.workspaceId, model: target }
        )
        nextAttachments.set(created.session.sessionId, created.pty)
        setAttachments(nextAttachments)
        applyHookStatus(created.session.sessionId, created.hookDisabledReason)
        setOpenWorkspaceId(w.workspaceId)
        setOpenSessionId(created.session.sessionId)
        setOpenWorkspace(created.workspace)
        void reloadWorkspaces()
      } catch (e) {
        setWorkspacesErr(String(e))
      } finally {
        setBusy(false)
      }
    },
    [busy, openWorkspaceId, attachments, closeAllAttachments, reloadWorkspaces, applyHookStatus]
  )

  const handleSelectTab = useCallback(
    async (sessionId: string) => {
      // 이미 attach된 세션이면 그냥 활성 전환
      if (attachments.has(sessionId)) {
        log.info('App.handleSelectTab — switch (already attached)', {
          fromSessionId: openSessionId,
          toSessionId: sessionId
        })
        setOpenSessionId(sessionId)
        return
      }
      // 닫힌(soft-close된) 세션 — 재오픈 = sessions.open으로 PTY 재spawn
      if (!openWorkspaceId || busy) return
      log.info('App.handleSelectTab — reopen (soft-closed)', { sessionId })
      setBusy(true)
      try {
        const activated = await window.agentbridge.sessions.open({
          workspaceId: openWorkspaceId,
          sessionId
        })
        setAttachments((prev) => {
          const next = new Map(prev)
          next.set(activated.session.sessionId, activated.pty)
          return next
        })
        applyHookStatus(activated.session.sessionId, activated.hookDisabledReason)
        setOpenSessionId(sessionId)
        setOpenWorkspace(activated.workspace)
        void reloadWorkspaces()
      } catch (e) {
        setWorkspacesErr(String(e))
      } finally {
        setBusy(false)
      }
    },
    [attachments, openSessionId, openWorkspaceId, busy, reloadWorkspaces, applyHookStatus]
  )

  const handleRenameWorkspace = useCallback(
    async (workspaceId: string, title: string) => {
      try {
        const updated = await window.agentbridge.workspaces.rename({ workspaceId, title })
        if (openWorkspaceId === workspaceId) setOpenWorkspace(updated)
        void reloadWorkspaces()
      } catch (e) {
        setWorkspacesErr(String(e))
      }
    },
    [openWorkspaceId, reloadWorkspaces]
  )

  const handleRenameSession = useCallback(
    async (workspaceId: string, sessionId: string, title: string) => {
      try {
        await window.agentbridge.sessions.rename({ workspaceId, sessionId, title })
        if (openWorkspaceId === workspaceId) {
          const ws = await window.agentbridge.workspaces.get(workspaceId)
          setOpenWorkspace(ws)
        }
        void reloadWorkspaces()
      } catch (e) {
        setWorkspacesErr(String(e))
      }
    },
    [openWorkspaceId, reloadWorkspaces]
  )

  const handleGoHome = useCallback(async () => {
    if (busy) return
    log.info('App.handleGoHome')
    setBusy(true)
    try {
      await closeAllAttachments('home-go')
      // 자기 윈도우를 home 상태로 되돌림 — windowManager의 windowsByWorkspace 매핑 해제.
      await window.agentbridge.window.releaseWorkspace()
      setAttachments(new Map())
      setHookDisabledMap(new Map())
      setOpenWorkspaceId(null)
      setOpenSessionId(null)
      setOpenWorkspace(null)
      void reloadWorkspaces()
    } finally {
      setBusy(false)
    }
  }, [busy, closeAllAttachments, reloadWorkspaces])

  const handleHomeSubmit = useCallback(
    async (model: CliKind, message: string) => {
      if (busy) return
      log.info('App.handleHomeSubmit', { model, messageLen: message.length })
      setBusy(true)
      try {
        await closeAllAttachments('home-submit')
        const result = await window.agentbridge.home.submit({ model, message })
        // 새 ws — 'claimed' 보장. 자기 윈도우 매핑 등록.
        await window.agentbridge.window.claimWorkspace({
          workspaceId: result.workspace.workspaceId
        })
        const newAttachments = new Map<string, CliSpawnInteractiveResult>()
        newAttachments.set(result.session.sessionId, result.pty)
        setAttachments(newAttachments)
        applyHookStatus(result.session.sessionId, result.hookDisabledReason)
        setOpenWorkspaceId(result.workspace.workspaceId)
        setOpenSessionId(result.session.sessionId)
        setOpenWorkspace(result.workspace)
        void reloadWorkspaces()
      } catch (e) {
        setWorkspacesErr(String(e))
      } finally {
        setBusy(false)
      }
    },
    [busy, closeAllAttachments, reloadWorkspaces, applyHookStatus]
  )

  // 세션 close — 호출 위치별 permanent 분기.
  //   좌 사이드바 휴지통 → hard delete (sessions[] + native session cascade)
  //   상단 탭 X         → soft close (closedAt 마킹만, 사이드바 트리에서 클릭 시 PTY 재spawn 복원)
  const closeSession = useCallback(
    async (sessionId: string, permanent: boolean, source: SessionCloseSource) => {
      if (!openWorkspaceId || busy) return
      log.info('App.closeSession', {
        workspaceId: openWorkspaceId,
        sessionId,
        permanent,
        source
      })
      setBusy(true)
      try {
        await window.agentbridge.sessions.close({
          workspaceId: openWorkspaceId,
          sessionId,
          permanent,
          source
        })
        setAttachments((prev) => {
          const next = new Map(prev)
          next.delete(sessionId)
          return next
        })
        applyHookStatus(sessionId, undefined)
        if (openSessionId === sessionId) {
          const remaining = Array.from(attachments.keys()).filter((sid) => sid !== sessionId)
          setOpenSessionId(remaining[0] ?? null)
        }
        const ws = await window.agentbridge.workspaces.get(openWorkspaceId)
        setOpenWorkspace(ws)
        void reloadWorkspaces()
      } catch (e) {
        setWorkspacesErr(String(e))
      } finally {
        setBusy(false)
      }
    },
    [openWorkspaceId, openSessionId, busy, attachments, reloadWorkspaces, applyHookStatus]
  )

  const handleDeleteSession = useCallback(
    (sessionId: string) => closeSession(sessionId, true, 'sidebar-trash'),
    [closeSession]
  )

  const handleSoftCloseTab = useCallback(
    (sessionId: string) => closeSession(sessionId, false, 'tab-x'),
    [closeSession]
  )

  // M3.6 C — 워크스페이스를 새 윈도우로 열기. 이미 그 워크스페이스 윈도우가 있으면 main이 focus만 처리.
  const handleOpenWorkspaceInNewWindow = useCallback((w: WorkspaceListEntry) => {
    void window.agentbridge.window.openWorkspace({ workspaceId: w.workspaceId })
  }, [])

  return (
    <>
      <AppShell
        memoryActive={!!openWorkspaceId && attachments.size > 0}
        workspaceOpen={!!openWorkspaceId}
        left={({ onClose }) => (
          <LeftSidebar
            env={env}
            workspaces={workspaces}
            workspacesErr={workspacesErr}
            openWorkspaceId={openWorkspaceId}
            openWorkspace={openWorkspace}
            openSessionId={openSessionId}
            workspacePath={workspacePath}
            setWorkspacePath={setWorkspacePath}
            workspaceNameDraft={workspaceNameDraft}
            setWorkspaceNameDraft={setWorkspaceNameDraft}
            initialModel={initialModel}
            setInitialModel={setInitialModel}
            busy={busy}
            onCreateWorkspace={handleCreateWorkspace}
            onPickWorkspace={handlePickWorkspace}
            onGoHome={handleGoHome}
            onOpenWorkspace={handleOpenCard}
            onOpenWorkspaceInNewWindow={handleOpenWorkspaceInNewWindow}
            onDeleteWorkspace={handleDeleteCard}
            onRenameWorkspace={handleRenameWorkspace}
            onSelectSession={handleSelectTab}
            onCloseSession={handleDeleteSession}
            onAddSession={handleAddSessionToWorkspace}
            onRenameSession={handleRenameSession}
            onOpenSettings={() => setSettingsOpen(true)}
            onClose={onClose}
          />
        )}
        right={({ onClose }) => (
          <RightSidebar
            openWorkspaceId={openWorkspaceId}
            openWorkspace={openWorkspace}
            openSessionId={openSessionId}
            onClose={onClose}
          />
        )}
      >
        {openWorkspace && openWorkspaceId ? (
          <>
            <SessionTabs
              sessions={openWorkspace.sessions}
              activeSessionId={openSessionId}
              env={env}
              busy={busy}
              onSelectTab={handleSelectTab}
              onCloseTab={(sid) => void handleSoftCloseTab(sid)}
              onAddTab={(model) => void handleAddTab(model)}
              hookDisabledMap={hookDisabledMap}
            />
            <div className="xterm-host-stack">
              {Array.from(attachments.entries()).map(([sid, att]) => {
                const isActive = sid === openSessionId
                const sessionMeta = openWorkspace.sessions.find((s) => s.sessionId === sid)
                const model: CliKind = sessionMeta?.model ?? 'claude'
                const kind = sessionMeta?.kind ?? 'cli'
                return (
                  <div key={sid} className={`xterm-wrap${isActive ? ' xterm-host-active' : ''}`}>
                    <XtermView
                      attach={{ ...att, replay: '' }}
                      model={model}
                      kind={kind}
                      workspaceId={openWorkspaceId}
                      sessionId={sid}
                      isActive={isActive}
                    />
                  </div>
                )
              })}
              {attachments.size === 0 && (
                <div className="center-empty">
                  <h2>활성 세션 없음</h2>
                  <p>
                    좌 사이드바에서 워크스페이스를 열거나 &quot;+ 모델&quot;로 새 탭을 추가하세요
                  </p>
                </div>
              )}
            </div>
          </>
        ) : (
          <HomePane env={env} busy={busy} onSubmit={handleHomeSubmit} />
        )}
      </AppShell>
      {settingsOpen && (
        <SettingsModal health={health} env={env} onClose={() => setSettingsOpen(false)} />
      )}
    </>
  )
}

export default App
