import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import log from 'electron-log/renderer'
import type { CliKind, SessionKind } from '@shared/ipc'
import { ClaudeLogo, CodexLogo, AgyLogo } from './modelLogos'
import { TerminalIcon } from './icons'

const MODEL_LABEL: Record<CliKind, string> = {
  claude: 'Claude',
  codex: 'Codex',
  agy: 'Antigravity'
}

const MODEL_LOGO: Record<CliKind, (p: { className?: string }) => React.JSX.Element> = {
  claude: ClaudeLogo,
  codex: CodexLogo,
  agy: AgyLogo
}

// XtermView는 외부에서 spawn된 PTY 핸들에 *attach*만 한다.
// PTY lifecycle(create/kill)은 호출자(App)가 책임 — race 회피 + 단방향 데이터 흐름.
// attach.sessionId가 바뀌면 effect가 재실행되어 새 PTY로 전환된다.
type AttachInfo = {
  sessionId: string
  pid: number
  // codex처럼 spawn 직후 thread_id가 비동기 캡처되는 경우 null. 캡처 후 갱신.
  modelSessionId?: string | null
  // 이전 PTY가 출력한 raw bytes 스냅샷 — mount 직후 1회 term.write으로 화면 복원.
  // ANSI 시퀀스(특히 alt-screen)가 부분 replay 시 깨질 수 있음 — architecture §4.4 명시 risk.
  // 첫 시도 단순 append-only. claude --resume 시 새 alt-screen 진입으로 일부 가려질 수 있으나
  // scrollback에는 남아 사용자가 직전 대화를 거슬러 볼 수 있다.
  replay?: string
}

type Props = {
  attach: AttachInfo
  model: CliKind
  // shell 세션이면 모델 로고 대신 TerminalIcon으로 로딩 오버레이 표시. 미지정 시 'cli'.
  kind?: SessionKind
  // 드래그 앤 드롭 첨부에 사용. 두 ID 모두 없으면 dnd overlay 비활성.
  workspaceId?: string
  sessionId?: string
  // L3 — multi-tab 시 활성 여부. visibility 토글로 숨겨진 비활성 xterm은 fit/resize를
  // 호출해도 PTY에 잘못된 cols/rows 전달할 수 있어 active 시점에만 fit 재호출.
  isActive?: boolean
  onExit?: (info: { exitCode: number | null; signal: number | null }) => void
}

export function XtermView({
  attach,
  model,
  kind = 'cli',
  workspaceId,
  sessionId,
  isActive = true,
  onExit
}: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const termRef = useRef<Terminal | null>(null)
  // onExit prop이 매 render마다 새 reference여도 메인 effect 재실행을 막기 위해 ref로 보관.
  const onExitRef = useRef(onExit)
  useEffect(() => {
    onExitRef.current = onExit
  }, [onExit])
  const [status, setStatus] = useState<'running' | 'exited' | 'error'>('running')
  // 마우스 호버 시 보여줄 전체 식별자 — 화면엔 상태 dot/줄 없음, 호버 title만 노출.
  const [statusTitle, setStatusTitle] = useState<string>('')
  // PTY 첫 data 도착 여부 — 로딩 오버레이 표시/숨김 토글.
  const [hasRendered, setHasRendered] = useState(false)
  // DnD 진입 카운터 — nested 요소 dragenter/dragleave 시퀀스 안정화용. > 0이면 overlay 표시.
  const [dragDepth, setDragDepth] = useState(0)
  // drop 처리 중 상태 — 같은 영역에 빠르게 두 번 드롭하는 race 방어.
  const [dropping, setDropping] = useState(false)
  const [dropError, setDropError] = useState<string | null>(null)
  const dndEnabled = !!(workspaceId && sessionId)

  // 의존성은 sessionId만 — attach 객체 reference나 replay/pid 변화로
  // Terminal을 재생성하면 안 됨. 부모(App.tsx)는 매 render마다 새 객체로 attach를
  // 전달할 수 있고, 그 때마다 dispose & new Terminal()이 일어나면 화면 buffer가
  // 매번 비어 검은 화면이 됨. PTY 자체는 sessionId-keyed로 식별되므로 sessionId만
  // 같으면 같은 Terminal 재사용이 옳다.
  // onExit/replay/pid는 mount 시점 closure로 capture — sessionId 안 바뀌면
  // 그대로 유효하다.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    log.info('XtermView mount', {
      sessionId: attach.sessionId,
      pid: attach.pid,
      model,
      kind,
      isActive
    })

    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      convertEol: false,
      scrollback: 5000,
      // 주변 패널과 일체화 — body 솔리드와 동일한 배경으로 xterm canvas를 칠해
      // .xterm-wrap의 경계가 보이지 않도록.
      theme: {
        background: '#0c0c10',
        foreground: '#f0f0f4',
        cursor: '#7aa2f7',
        cursorAccent: '#0c0c10',
        selectionBackground: 'rgba(122, 162, 247, 0.35)'
      }
    })
    const fit = new FitAddon()
    fitRef.current = fit
    termRef.current = term
    term.loadAddon(fit)
    term.open(container)
    fit.fit()

    const sid = attach.sessionId
    const replay = attach.replay
    // xterm canvas / PTY 구독(외부 시스템) → React state 동기화 effect. setState는 정당.
    setStatus('running')
    setHasRendered(false)

    // 이전 세션 replay 적용 정책 — kind로 분기.
    //
    // cli (claude/codex/gemini): **replay skip**. 이전 PTY viewport cols/rows와 새 viewport가
    //   mismatch면 wrap point 어긋남 + alt-screen ANSI sequence 부분 처리로 화면 깨짐.
    //   CLI native --resume/resume이 자체 화면 복원하므로 우리 replay는 오히려 충돌만 야기.
    //   합의 정책: cli는 CLI 자체 복원에 맡기고 우리는 빈 viewport로 시작.
    //
    // shell (zsh): replay 적용. shell은 resume 메커니즘 없음 — 우리 replay가 유일한 화면 복원.
    //   shell 출력은 alt-screen 미사용이라 cols mismatch만 영향 (wrap 어긋남, 깨짐은 적음).
    if (kind === 'shell' && replay && replay.length > 0) {
      term.write(replay)
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHasRendered(true)
    }

    // sessionId-keyed 구독 — preload buffer가 등록 직후 누락된 첫 chunk를 flush한다.
    // firstDataSeen은 shell에서 replay를 그렸을 때만 true로 시작 — cli는 PTY 첫 chunk
    // (CLI native resume 화면)이 도착해야 hasRendered true 전환.
    let firstDataSeen = kind === 'shell' && !!replay && replay.length > 0
    const offData = window.agentbridge.pty.onData(sid, (data) => {
      term.write(data)
      if (!firstDataSeen) {
        firstDataSeen = true
        setHasRendered(true)
      }
    })
    const offExit = window.agentbridge.pty.onExit(sid, (info) => {
      log.info('XtermView onExit', {
        sessionId: sid,
        exitCode: info.exitCode,
        signal: info.signal
      })
      setStatus('exited')
      setStatusTitle('')
      onExitRef.current?.(info)
    })

    // Shift+Enter → Option+Enter(\x1b\r) 매핑. 한글 IME race 회피 상태 머신 — 자세한 배경/시도
    // 이력은 docs/shift-enter-ime.md 참조.
    const SHIFT_ENTER_LOCK_MS = 50
    const SHIFT_ENTER_FALLBACK_MS = 200
    let isComposingState = false
    let pendingShiftEnter = false
    let lastShiftEnterAt = 0
    let pendingFallbackTimer: ReturnType<typeof setTimeout> | null = null
    const emitShiftEnterNewline = (): void => {
      if (pendingFallbackTimer) {
        clearTimeout(pendingFallbackTimer)
        pendingFallbackTimer = null
      }
      pendingShiftEnter = false
      void window.agentbridge.pty.write(sid, '\x1b\r')
    }

    const dataDisposable = term.onData((data) => {
      void window.agentbridge.pty.write(sid, data)
      // composition commit된 글자가 PTY로 흘러나간 직후 pending \x1b\r 처리.
      if (pendingShiftEnter) {
        emitShiftEnterNewline()
      }
    })

    const xtermTextarea =
      (term as unknown as { textarea?: HTMLTextAreaElement }).textarea ??
      container.querySelector<HTMLTextAreaElement>('textarea')
    const onCompStart = (): void => {
      isComposingState = true
    }
    const onCompEnd = (): void => {
      isComposingState = false
    }
    xtermTextarea?.addEventListener('compositionstart', onCompStart)
    xtermTextarea?.addEventListener('compositionend', onCompEnd)

    term.attachCustomKeyEventHandler((e: KeyboardEvent): boolean => {
      if (e.type !== 'keydown' || e.key !== 'Enter' || !e.shiftKey) return true
      e.preventDefault()
      const now = performance.now()
      if (now - lastShiftEnterAt < SHIFT_ENTER_LOCK_MS) {
        // IME가 한 번의 사용자 입력에 keydown을 두 번 발사 — 50ms 안 두 번째는 무시.
        return false
      }
      lastShiftEnterAt = now
      if (isComposingState) {
        pendingShiftEnter = true
        pendingFallbackTimer = setTimeout(() => {
          if (pendingShiftEnter) emitShiftEnterNewline()
        }, SHIFT_ENTER_FALLBACK_MS)
      } else {
        emitShiftEnterNewline()
      }
      return false
    })

    // 마운트 직후 PTY를 xterm 실측 크기로 resize (main spawn 시 default cols/rows 사용했으므로).
    void window.agentbridge.pty.resize(sid, term.cols, term.rows)

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        void window.agentbridge.pty.resize(sid, term.cols, term.rows)
      } catch {
        // dispose 직후 호출되면 무시
      }
    })
    ro.observe(container)

    return () => {
      log.info('XtermView unmount', { sessionId: sid })
      if (pendingFallbackTimer) clearTimeout(pendingFallbackTimer)
      dataDisposable.dispose()
      ro.disconnect()
      offData()
      offExit()
      xtermTextarea?.removeEventListener('compositionstart', onCompStart)
      xtermTextarea?.removeEventListener('compositionend', onCompEnd)
      term.dispose()
      fitRef.current = null
      termRef.current = null
      // PTY 자체는 죽이지 않는다 — App이 sessions.close로 lifecycle 관리.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attach.sessionId])

  // 호버 시 보여줄 식별자 — modelSessionId가 비동기 캡처(특히 codex)되므로 분리 effect.
  // attach metadata(외부 시스템) → React state 동기화 패턴.
  useEffect(() => {
    if (status !== 'running') return
    const sid = attach.sessionId
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatusTitle(
      `pid=${attach.pid}\npty=${sid}` +
        (attach.modelSessionId ? `\nmodel=${attach.modelSessionId}` : '')
    )
  }, [attach.sessionId, attach.pid, attach.modelSessionId, status])

  // active 전환 시점에 fit + xterm canvas refresh 강제.
  // visibility:hidden 상태 동안 xterm renderer가 buffer를 그리지 않아 visible 전환
  // 시점에 검은 화면으로 보임 → term.refresh()로 전체 viewport 재그리기.
  // ResizeObserver는 visibility 변화에 fire 안 하므로 fit/resize도 manual.
  useEffect(() => {
    log.info('XtermView isActive change', { sessionId: attach.sessionId, isActive })
    if (!isActive) return
    const fit = fitRef.current
    const term = termRef.current
    if (!fit || !term) return
    const id = requestAnimationFrame(() => {
      try {
        fit.fit()
        log.info('XtermView active-rAF — fit + resize + refresh', {
          sessionId: attach.sessionId,
          cols: term.cols,
          rows: term.rows
        })
        void window.agentbridge.pty.resize(attach.sessionId, term.cols, term.rows)
        // 핵심 — viewport 전체 재그리기. 검은 화면 회복.
        term.refresh(0, term.rows - 1)
      } catch (err) {
        // dispose 직후 호출되면 무시. 그 외엔 진단용으로 흘려둠.
        log.warn('XtermView active-rAF 실패 (dispose race일 가능성)', {
          sessionId: attach.sessionId,
          err: String(err)
        })
      }
    })
    return () => cancelAnimationFrame(id)
  }, [isActive, attach.sessionId])

  const onDragEnter = (e: React.DragEvent<HTMLDivElement>): void => {
    if (!dndEnabled) return
    if (!Array.from(e.dataTransfer.types).includes('Files')) return
    e.preventDefault()
    setDragDepth((d) => d + 1)
  }
  const onDragLeave = (e: React.DragEvent<HTMLDivElement>): void => {
    if (!dndEnabled) return
    if (!Array.from(e.dataTransfer.types).includes('Files')) return
    e.preventDefault()
    setDragDepth((d) => Math.max(0, d - 1))
  }
  const onDragOver = (e: React.DragEvent<HTMLDivElement>): void => {
    if (!dndEnabled) return
    if (!Array.from(e.dataTransfer.types).includes('Files')) return
    // dropEffect 안 정하면 OS가 기본 cursor를 회복(no-drop) — copy로 명시.
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  const onDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    if (!dndEnabled) return
    e.preventDefault()
    setDragDepth(0)
    if (dropping) return
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return
    const paths: string[] = []
    for (const f of files) {
      try {
        const p = window.agentbridge.attach.getPathForFile(f)
        if (p) paths.push(p)
      } catch {
        /* 경로 추출 실패한 항목은 그냥 skip */
      }
    }
    if (paths.length === 0) {
      setDropError('파일 경로 추출 실패')
      window.setTimeout(() => setDropError(null), 3000)
      return
    }
    setDropping(true)
    setDropError(null)
    void window.agentbridge.attach
      .files({ workspaceId: workspaceId!, sessionId: sessionId!, paths })
      .then((res) => {
        if (!res.ok) {
          setDropError(res.error ?? '첨부 실패')
          window.setTimeout(() => setDropError(null), 3500)
        } else if (res.rejected.length > 0) {
          // 일부 거부만 — 경고로 잠깐 표시.
          setDropError(`일부 거부: ${res.rejected.map((r) => r.reason).join(', ')}`)
          window.setTimeout(() => setDropError(null), 3500)
        }
      })
      .catch((err) => {
        setDropError(String(err))
        window.setTimeout(() => setDropError(null), 3500)
      })
      .finally(() => setDropping(false))
  }

  return (
    <div
      className="xterm-host"
      title={statusTitle || undefined}
      data-status={status}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="xterm-container" ref={containerRef} />
      {dndEnabled && dragDepth > 0 && (
        <div className="xterm-dropzone" aria-hidden="true">
          <div className="xterm-dropzone-inner">
            <div className="xterm-dropzone-title">+ 파일 첨부</div>
            <div className="xterm-dropzone-hint">
              {kind === 'shell' ? '절대 경로 paste' : '@절대경로 paste'}
            </div>
          </div>
        </div>
      )}
      {dropError && <div className="xterm-drop-error">{dropError}</div>}
      {status === 'running' &&
        (() => {
          const isShell = kind === 'shell'
          const Logo = MODEL_LOGO[model]
          const labelText = isShell ? '터미널' : MODEL_LABEL[model]
          const classModel = isShell ? 'shell' : model
          return (
            <div
              className={`xterm-loading model-${classModel}${hasRendered ? ' hidden' : ''}`}
              aria-hidden="true"
            >
              <div className="xterm-loading-mark">
                <div className="xterm-loading-pulse" />
                {isShell ? (
                  <TerminalIcon className="xterm-loading-logo" />
                ) : (
                  <Logo className="xterm-loading-logo" />
                )}
              </div>
              <div className="xterm-loading-label">{labelText}</div>
              <div className="xterm-loading-hint">starting…</div>
            </div>
          )
        })()}
    </div>
  )
}
