import { spawn, IPty } from '@homebridge/node-pty-prebuilt-multiarch'
import { randomUUID } from 'crypto'
import { createWriteStream, type WriteStream } from 'fs'
import type { WebContents } from 'electron'
import log from 'electron-log/main'
import type { PtyDataEvent, PtyExitEvent, PtyStartRequest, PtyStartResult } from '@shared/ipc'
import { IpcChannel } from '@shared/ipc'
import { filterDisplayData } from './ptyDisplayFilter'

// onExit info에 ptySessionId를 포함 — 같은 contextId에 새 PTY로 교체된 후 직전 PTY의 onExit가
// 늦게 도착해도 매핑을 헷갈리지 않게(handoff:commit race 방지).
export type PtyExitInfo = {
  exitCode: number | null
  signal: number | null
  ptySessionId: string
}

type Session = {
  id: string
  pty: IPty
  webContentsId: number
  replayStream: WriteStream | null
  onExit: ((info: PtyExitInfo) => void) | null
}

const sessions = new Map<string, Session>()

const DEFAULT_COLS = 100
const DEFAULT_ROWS = 30

export type StartPtyHooks = {
  // 절대 경로. 있으면 PTY raw bytes를 append-only로 기록 (thread replay.log).
  replayLogPath?: string
  // 매 chunk 도착 시 호출 — 외부 사이드 효과(예: thread updatedAt touch).
  onData?: (data: string) => void
  // 자연 종료 또는 kill 시 호출 — replay stream은 ptySession이 자체 close.
  // ptySessionId 포함 — handoff:commit이 새 PTY로 교체한 뒤 직전 onExit의 race를 회피하려면
  // 호출자가 이 PTY id가 *지금 등록된 active*인지 확인하고 clear해야 한다.
  onExit?: (info: PtyExitInfo) => void
}

// 어댑터(CLIAdapter)는 sessionId를 사전 결정해 주입할 수 있다.
// req.env가 명시되면 그대로 사용 (이미 PTY 환경 키가 포함됐다고 간주). 없으면 process.env + PTY 기본을 합친다.
// hooks는 *main 내부 호출* 전용 — IPC 직렬화 불가. CliSpawnInteractive IPC는 hooks 없이 호출되고,
// threads:* IPC handler가 thread context를 hooks로 묶는다.
export function startPty(
  req: PtyStartRequest & { sessionId?: string },
  sender: WebContents,
  hooks: StartPtyHooks = {}
): PtyStartResult {
  const id = req.sessionId ?? randomUUID()
  // 같은 sessionId로 잔존 세션이 있으면 *의도된 재spawn*으로 간주하고 강제 정리 후 진행.
  // 사용자 흐름: "닫기"의 pty:kill IPC와 "이어가기"의 cli:spawn-interactive IPC가 별도 채널이라
  // race window가 존재한다. 또 pty.onExit 도착 전에는 sessions 맵에 키가 남아있다.
  // 어댑터가 같은 UUID로 두 번 발급한 *진짜 버그* 케이스도 여기서 silently 흡수되지만
  // 그 경우 로그로 추적 가능하게 한다.
  const existing = sessions.get(id)
  if (existing) {
    log.warn(`PTY sessionId 잔존 — 강제 정리 후 재spawn: ${id}`)
    sessions.delete(id)
    try {
      existing.pty.kill('SIGKILL')
    } catch {
      // 이미 종료됨 — 무시
    }
  }
  const env: Record<string, string> = req.env ?? {
    ...(Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => typeof v === 'string')
    ) as Record<string, string>),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor'
  }
  const cwd = req.cwd ?? process.env.HOME ?? process.cwd()
  log.info('ptySession.startPty', {
    sessionId: id,
    command: req.command,
    args: req.args,
    cwd,
    cols: req.cols ?? DEFAULT_COLS,
    rows: req.rows ?? DEFAULT_ROWS,
    replayLogPath: hooks.replayLogPath
  })
  const pty = spawn(req.command, req.args, {
    cols: req.cols ?? DEFAULT_COLS,
    rows: req.rows ?? DEFAULT_ROWS,
    cwd,
    env,
    name: 'xterm-256color'
  })

  const replayStream = hooks.replayLogPath
    ? createWriteStream(hooks.replayLogPath, { flags: 'a', encoding: 'utf8' })
    : null
  if (replayStream) {
    replayStream.on('error', (err) => {
      log.warn(`replay.log write error (${id})`, err)
    })
  }

  // 디버깅용 — 비정상 exit 시 마지막 출력 일부를 로그에 남기기 위한 ring buffer.
  let dataByteCount = 0
  let dataTail = ''
  const TAIL_MAX = 2048

  const session: Session = {
    id,
    pty,
    webContentsId: sender.id,
    replayStream,
    onExit: hooks.onExit ?? null
  }
  sessions.set(id, session)

  pty.onData((data) => {
    dataByteCount += data.length
    if (data.length >= TAIL_MAX) {
      dataTail = data.slice(-TAIL_MAX)
    } else {
      dataTail = (dataTail + data).slice(-TAIL_MAX)
    }
    // replay.log: RAW (forensics/디버그 목적)
    if (replayStream && !replayStream.destroyed) {
      replayStream.write(data)
    }
    // turnRecorder + xterm renderer: hook context block 제거된 filtered 데이터.
    // codex 0.130.0 / gemini가 `<agentbridge-context>...</agentbridge-context>`를 visible developer
    // message로 렌더링하는 이슈(openai/codex#15497, #16933) 워크어라운드.
    // claude는 hook 출력을 TUI에 안 보여줘 no-op (안전).
    const filtered = filterDisplayData(id, data)
    hooks.onData?.(filtered)
    if (sender.isDestroyed()) return
    const evt: PtyDataEvent = { sessionId: id, data: filtered }
    sender.send(IpcChannel.PtyData, evt)
  })

  pty.onExit(({ exitCode, signal }) => {
    const sig = signal ?? null
    // 세션 정리는 한 번만 — kill 경로에서 이미 처리된 경우 onExit는 hooks만 통지.
    const stillRegistered = sessions.delete(id)
    if (replayStream && !replayStream.destroyed) {
      replayStream.end()
    }
    log.info('ptySession exit', {
      sessionId: id,
      exitCode,
      signal: sig,
      bytesEmitted: dataByteCount,
      tail: dataTail.length > 0 ? dataTail : '(no output)'
    })
    const exitInfo: PtyExitInfo = { exitCode, signal: sig, ptySessionId: id }
    if (stillRegistered || hooks.onExit) {
      hooks.onExit?.(exitInfo)
    }
    if (sender.isDestroyed()) return
    const evt: PtyExitEvent = { sessionId: id, exitCode, signal: sig }
    sender.send(IpcChannel.PtyExit, evt)
  })

  return { sessionId: id, pid: pty.pid }
}

export function writePty(sessionId: string, data: string): void {
  const s = sessions.get(sessionId)
  if (!s) return
  s.pty.write(data)
}

export function resizePty(sessionId: string, cols: number, rows: number): void {
  const s = sessions.get(sessionId)
  if (!s) return
  s.pty.resize(Math.max(1, cols), Math.max(1, rows))
}

// architecture §7.4 — SIGTERM(grace 1초) → SIGKILL.
// CLI가 SIGTERM에 응답해 정리할 시간을 주되, 응답 안 하면 강제 종료.
const KILL_GRACE_MS = 1_000

export function killPty(sessionId: string): void {
  const s = sessions.get(sessionId)
  if (!s) return
  // 즉시 맵에서 제거 — 같은 sessionId로 재spawn(예: claude --resume)이 onExit 도착 전에 들어와도 안전.
  // 실제 자식 종료는 SIGTERM 후 비동기로 진행되고 onExit 핸들러는 sessions에 없어도 무탈.
  sessions.delete(sessionId)
  if (s.replayStream && !s.replayStream.destroyed) {
    s.replayStream.end()
  }
  try {
    s.pty.kill('SIGTERM')
  } catch {
    // 이미 종료됨 — escalate 불필요
    return
  }
  // grace 후에도 살아있으면 SIGKILL. pid가 없거나 이미 죽었으면 kill(0)이 throw → catch에서 종료.
  setTimeout(() => {
    try {
      // process.kill(pid, 0)은 시그널 안 보내고 존재 확인만 한다.
      process.kill(s.pty.pid, 0)
      log.warn(`PTY SIGTERM grace 만료 — SIGKILL escalate: ${sessionId} pid=${s.pty.pid}`)
      try {
        s.pty.kill('SIGKILL')
      } catch {
        // race로 죽음 — 무시
      }
    } catch {
      // 이미 종료됨 — 정상
    }
  }, KILL_GRACE_MS).unref()
}

// killPty + PTY가 실제로 exit할 때까지 await. claude처럼 SIGTERM 후 마지막 flush로
// native session 파일을 다시 쓰는 CLI가 있어, deleteNativeSession을 PTY 종료 후로
// 미루기 위한 헬퍼.
//
// timeoutMs = 3000 — KILL_GRACE_MS(1000) + SIGKILL escalate + 약간의 buffer. 그래도
// exit 안 오면 resolve해 호출자 막지 않음 (best-effort).
export function killPtyAsync(sessionId: string, timeoutMs = 3000): Promise<void> {
  const s = sessions.get(sessionId)
  if (!s) return Promise.resolve()
  return new Promise<void>((resolve) => {
    // onExit는 IDisposable을 반환. timeout이 먼저 발화하면 리스너가 dispose되지 않은 채 남는다.
    // PTY 객체가 곧 GC되긴 하나, 양쪽 분기에서 명시 dispose해 timeline 명확화.
    // timer는 null 초기화 후 setTimeout 결과로 할당 — onExit 콜백이 timer를 참조할 때
    // use-before-define 회피.
    let timer: ReturnType<typeof setTimeout> | null = null
    const disposable = s.pty.onExit(() => {
      try {
        disposable.dispose()
      } catch {
        /* noop */
      }
      if (timer) clearTimeout(timer)
      resolve()
    })
    timer = setTimeout(() => {
      log.warn(`killPtyAsync timeout — exit 미도착, 계속 진행: ${sessionId}`)
      try {
        disposable.dispose()
      } catch {
        /* noop */
      }
      resolve()
    }, timeoutMs)
    killPty(sessionId)
  })
}

// before-quit 전용 — 모든 PTY에 즉시 SIGKILL 발사. grace 생략.
// 종료 단계에선 SIGTERM grace 의미 없고(데이터는 이미 atomic write 통과), 자식이 SIGTERM
// 무시할 경우 main process가 stdio pipe 해제를 못 해 hang하는 시나리오를 차단한다.
// 특히 login shell(zsh -l) 같은 자식은 SIGTERM 응답이 늦거나 무시한다.
export function killAllForce(): void {
  for (const id of [...sessions.keys()]) {
    const s = sessions.get(id)
    if (!s) continue
    sessions.delete(id)
    // replayStream은 destroy로 즉시 file descriptor 해제 — end()의 flush 대기 없이.
    if (s.replayStream && !s.replayStream.destroyed) {
      try {
        s.replayStream.destroy()
      } catch {
        /* noop */
      }
    }
    try {
      s.pty.kill('SIGKILL')
    } catch {
      /* 이미 종료 — 무시 */
    }
  }
}
