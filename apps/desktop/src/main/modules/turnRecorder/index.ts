import { randomUUID } from 'crypto'
import log from 'electron-log/main'
import { IpcChannel, type CliKind, type TurnsUpdatedEvent } from '@shared/ipc'
import type { TurnRecord } from '@shared/turns'
import { TURN_CAP } from '@shared/turns'
import { appendTurn, rotateIfNeeded } from '../turnsStore'
import { sendToWorkspaceWindow } from '../windowManager'
import { sliceAssistant } from './sliceAssistant'
import { checkAndRunCompaction } from '../compactionScheduler'
import { loadSettings } from '../settings'
import { updateSessionMeta } from '../workspaceStore'

// M3.6 C — workspaceId 매칭 윈도우에만 전송. 다른 워크스페이스 윈도우엔 의미 없음.
export function broadcastTurnsUpdated(workspaceId: string): void {
  const evt: TurnsUpdatedEvent = { workspaceId }
  sendToWorkspaceWindow(workspaceId, IpcChannel.TurnsUpdated, evt)
}

// TurnRecorder — M3 O 청크. architecture §15.3 / §15.9.
//
// pty:write IPC hook + ptySession onData hook chain으로 한 turn(사용자 입력 → 모델 응답)을
// 캡처해 turns.jsonl append.
//
// state machine (per ptySessionId):
//   idle              — 사용자 입력 buffer. 모델 응답 미수집.
//   awaiting          — 사용자 Enter 직후. 첫 모델 byte 도착 대기.
//   assistant_active  — 모델 응답 수집 중. idle timer reset.
//
// flush trigger:
//   - assistant_active에서 IDLE_FLUSH_MS 동안 새 byte 없음 → turn flush.
//   - assistant_active에서 사용자가 새 Enter → 직전 turn flush + 새 turn 시작.
//
// 입력 정제:
//   - DEL/BS: 마지막 1 char 제거 (bracketed paste 안에선 무시 — 단순 cut)
//   - Ctrl-C (0x03): user buffer clear + state → idle (turn 폐기)
//   - bracketed paste markers `\x1b[200~` / `\x1b[201~`: marker만 제거, 본문 유지
//   - 그 외 ANSI escape: 사용자 입력에서 strip (cursor key 등)
//   - \r / \n: Enter — buffer flush + state 전환
//
// 캡:
//   - userBytes 8K — 초과 시 truncate 표시
//   - assistantBuffer 1MB — 초과 시 메모리 보호용 truncate (turns.jsonl에는 sliceAssistant cap이 추가 적용)

const IDLE_FLUSH_MS = 1_500
const ASSISTANT_BUFFER_HARD_CAP = 1_000_000 // 1MB

type RecorderState = {
  workspaceId: string
  sessionId: string
  ptySessionId: string
  model: CliKind

  userBuffer: string
  // assistant_active 진입 시점에 snapshot. 모델 응답 끝나면 turn record로 flush.
  pendingUserText: string | null
  pendingUserStartedAt: string | null

  assistantBuffer: string
  assistantStartedAt: string | null

  idleTimer: NodeJS.Timeout | null
  state: 'idle' | 'awaiting' | 'assistant_active'
}

// key = ptySessionId (writePty/onData가 모두 ptySessionId 기준).
const recorders = new Map<string, RecorderState>()

// 사용자 입력 처리는 ANSI escape를 *통째로 skip*하는 skipAnsiSequence를 사용한다.
// (ESC 바이트만 드롭하면 `[O`/`[I` 같은 cursor key/focus event 잔재가 user buffer에 남음.)
// bracketed paste markers (`[200~` / `[201~`)도 CSI 패턴이라 같은 함수가 흡수.

export function registerRecorder(args: {
  workspaceId: string
  sessionId: string
  ptySessionId: string
  model: CliKind
}): void {
  recorders.set(args.ptySessionId, {
    workspaceId: args.workspaceId,
    sessionId: args.sessionId,
    ptySessionId: args.ptySessionId,
    model: args.model,
    userBuffer: '',
    pendingUserText: null,
    pendingUserStartedAt: null,
    assistantBuffer: '',
    assistantStartedAt: null,
    idleTimer: null,
    state: 'idle'
  })
  log.info('TurnRecorder registered', {
    workspaceId: args.workspaceId,
    sessionId: args.sessionId,
    ptySessionId: args.ptySessionId,
    model: args.model
  })
}

export function unregisterRecorder(ptySessionId: string): void {
  const r = recorders.get(ptySessionId)
  if (!r) return
  if (r.idleTimer) clearTimeout(r.idleTimer)
  // 진행 중 turn flush 시도 — 사용자 응답 받고 종료한 경우도 보존.
  if (r.state === 'assistant_active' && r.pendingUserText !== null) {
    void flushTurn(r).catch((err) => {
      log.warn('TurnRecorder unregister flush 실패', {
        ptySessionId,
        err: String(err)
      })
    })
  }
  recorders.delete(ptySessionId)
}

// pty:write IPC에서 호출. 사용자가 PTY에 보낸 raw data를 분석해 buffer/flush.
//
// ANSI escape sequence는 *통째로 skip* — 단순 ESC 드롭만 하면 `[O`/`[I` 같은 cursor focus
// in/out 리포트 또는 cursor key 잔재가 user buffer에 남음 (실데이터에서 `하[O[I던` 형태로 누수).
export function onUserInput(ptySessionId: string, data: string): void {
  const r = recorders.get(ptySessionId)
  if (!r) {
    log.debug('TurnRecorder.onUserInput — recorder 미등록 (drop)', {
      ptySessionId,
      dataLen: data.length
    })
    return
  }

  // \r\n 정규화 — \r\n / \r / \n 모두 단일 \n 토큰으로 (각각이 Enter 1회).
  const body = data.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  let i = 0
  while (i < body.length) {
    const code = body.charCodeAt(i)

    // ANSI escape sequence — 통째로 skip. CSI / OSC / single-shift 등 알려진 형식 모두 커버.
    if (code === 0x1b) {
      const advance = skipAnsiSequence(body, i)
      i += advance
      continue
    }

    const ch = body[i]
    if (ch === '\n') {
      // Enter — 사용자 입력 1 line submit
      const text = r.userBuffer.trim()
      r.userBuffer = ''
      if (text.length === 0) {
        // 빈 Enter — turn 시작 안 함. 단 진행 중인 assistant_active는 그대로 둠.
        i++
        continue
      }
      // 진행 중인 turn이 있으면 — *직전 turn flush* 후 새 turn 시작.
      if (r.state === 'assistant_active' && r.pendingUserText !== null) {
        void flushTurn(r).catch((err) => {
          log.warn('TurnRecorder mid-turn flush 실패', {
            ptySessionId,
            err: String(err)
          })
        })
        // flushTurn은 r 상태를 reset. 아래 코드에서 새 turn 시작.
      }
      startNewTurn(r, applyUserCap(text))
      i++
      continue
    }
    if (code === 0x03) {
      // Ctrl-C — 사용자가 입력 취소 OR 응답 중단. 진행 중 turn은 buffer만 비우고 turn 폐기.
      r.userBuffer = ''
      if (r.state === 'assistant_active') {
        // 응답 중단 — 직전 사용자 입력은 남지만 응답이 부분일 가능성. 첫 cut에선 그대로 flush.
        void flushTurn(r).catch((err) => {
          log.warn('TurnRecorder Ctrl-C flush 실패', {
            ptySessionId,
            err: String(err)
          })
        })
      } else if (r.state === 'awaiting') {
        // 응답 시작 전 취소 — turn 폐기
        resetRecorderState(r)
      }
      i++
      continue
    }
    if (code === 0x7f || code === 0x08) {
      // DEL / BS — 마지막 1 char 제거
      if (r.userBuffer.length > 0) {
        r.userBuffer = r.userBuffer.slice(0, -1)
      }
      i++
      continue
    }
    if (code < 0x20) {
      // 그 외 제어 문자 — 사용자 입력 buffer엔 추가 안 함 (Tab=0x09는 제외하지 않으나, 첫 cut엔 skip)
      i++
      continue
    }
    r.userBuffer += ch
    if (r.userBuffer.length > TURN_CAP.userBytes * 2) {
      // 메모리 보호용 hard cap (paste를 너무 크게 받은 경우)
      r.userBuffer = r.userBuffer.slice(0, TURN_CAP.userBytes * 2)
    }
    i++
  }
}

// ptySession.onData에서 호출. 모델 응답을 buffer + idle timer reset.
export function onAssistantData(ptySessionId: string, data: string): void {
  const r = recorders.get(ptySessionId)
  if (!r) return
  // awaiting → assistant_active 전환
  if (r.state === 'awaiting') {
    r.state = 'assistant_active'
    r.assistantStartedAt = new Date().toISOString()
    log.info('TurnRecorder awaiting → assistant_active', {
      ptySessionId,
      firstChunkLen: data.length
    })
  }
  if (r.state !== 'assistant_active') {
    // idle 상태에서 도착하는 data는 무시 (welcome banner / prompt redraw 등)
    return
  }
  r.assistantBuffer += data
  if (r.assistantBuffer.length > ASSISTANT_BUFFER_HARD_CAP) {
    // 메모리 보호 — 첫 부분 + 끝 부분 보존
    const head = r.assistantBuffer.slice(0, ASSISTANT_BUFFER_HARD_CAP / 2)
    const tail = r.assistantBuffer.slice(-ASSISTANT_BUFFER_HARD_CAP / 2)
    r.assistantBuffer = head + '\n…[truncated]…\n' + tail
  }
  scheduleIdleFlush(r)
}

function startNewTurn(r: RecorderState, userText: string): void {
  r.pendingUserText = userText
  r.pendingUserStartedAt = new Date().toISOString()
  r.assistantBuffer = ''
  r.assistantStartedAt = null
  r.state = 'awaiting'
  if (r.idleTimer) {
    clearTimeout(r.idleTimer)
    r.idleTimer = null
  }
  log.info('TurnRecorder.startNewTurn', {
    ptySessionId: r.ptySessionId,
    userTextLen: userText.length,
    userTextPreview: userText.slice(0, 60)
  })
}

function scheduleIdleFlush(r: RecorderState): void {
  if (r.idleTimer) clearTimeout(r.idleTimer)
  r.idleTimer = setTimeout(() => {
    r.idleTimer = null
    void flushTurn(r).catch((err) => {
      log.warn('TurnRecorder idle flush 실패', {
        ptySessionId: r.ptySessionId,
        err: String(err)
      })
    })
  }, IDLE_FLUSH_MS)
}

async function flushTurn(r: RecorderState): Promise<void> {
  log.info('TurnRecorder.flushTurn entry', {
    ptySessionId: r.ptySessionId,
    state: r.state,
    hasPendingUser: r.pendingUserText !== null,
    assistantBufferLen: r.assistantBuffer.length
  })
  if (r.state !== 'assistant_active' && r.state !== 'awaiting') return
  if (r.pendingUserText === null || r.pendingUserStartedAt === null) {
    resetRecorderState(r)
    return
  }
  const userText = r.pendingUserText
  const startedAt = r.pendingUserStartedAt
  const assistantRaw = r.assistantBuffer
  const model = r.model
  const workspaceId = r.workspaceId
  const sessionId = r.sessionId
  // 상태 reset *먼저* — flush 도중 새 입력 도착에 대비.
  resetRecorderState(r)

  if (r.idleTimer) {
    clearTimeout(r.idleTimer)
    r.idleTimer = null
  }

  // 사용자 설정 turnsAssistantDetail에 따라 assistantBody cap 크기 분기 (full/compact/minimal).
  const settings = await loadSettings()
  const slice = sliceAssistant({
    raw: assistantRaw,
    model,
    detail: settings.turnsAssistantDetail
  })
  const turn: TurnRecord = {
    id: randomUUID(),
    workspaceId,
    sessionId,
    model,
    startedAt,
    completedAt: new Date().toISOString(),
    user: userText,
    userBytes: Buffer.byteLength(userText, 'utf8'),
    assistantBody: slice.assistantBody,
    assistantBodyBytes: slice.assistantBodyBytes,
    toolCalls: slice.toolCalls
  }

  try {
    await appendTurn(workspaceId, turn)
    log.info('TurnRecorder turn flush', {
      workspaceId,
      sessionId,
      model,
      userBytes: turn.userBytes,
      assistantBodyBytes: turn.assistantBodyBytes,
      toolCalls: turn.toolCalls.length
    })
    // 세션 lastChattedAt + workspace updatedAt 동시 갱신 (UI 정렬 즉시 반영용).
    // updateSessionMeta가 workspace.json도 atomic write — touchWorkspace의 5초 throttle 우회.
    try {
      await updateSessionMeta(workspaceId, sessionId, {
        lastChattedAt: turn.completedAt
      })
    } catch (err) {
      log.warn('TurnRecorder lastChattedAt 갱신 실패 (non-fatal)', {
        workspaceId,
        sessionId,
        err: String(err)
      })
    }
    broadcastTurnsUpdated(workspaceId)
  } catch (err) {
    log.warn('TurnRecorder appendTurn 실패', {
      workspaceId,
      sessionId,
      err: String(err)
    })
    return
  }

  // rotate cheap check (실패해도 다음 append 계속)
  try {
    await rotateIfNeeded(workspaceId)
  } catch (err) {
    log.warn('TurnRecorder rotate check 실패 (non-fatal)', {
      workspaceId,
      err: String(err)
    })
  }

  // compaction trigger — fire-and-forget. 실제 spawn은 RefineDispatcher가 제어.
  void checkAndRunCompaction(workspaceId).catch((err) => {
    log.warn('CompactionScheduler trigger 실패 (non-fatal)', {
      workspaceId,
      err: String(err)
    })
  })
}

function resetRecorderState(r: RecorderState): void {
  r.pendingUserText = null
  r.pendingUserStartedAt = null
  r.assistantBuffer = ''
  r.assistantStartedAt = null
  r.state = 'idle'
}

// ESC(0x1b) 위치 i부터 ANSI escape sequence 한 단위를 skip할 길이 반환.
// 형식 처리:
//   CSI: ESC '[' (params 0x20-0x3F)* (intermediates 0x20-0x2F)* (final 0x40-0x7E)
//   OSC: ESC ']' ... (BEL 0x07 or ST = ESC '\\')
//   DCS/PM/APC: ESC ('P'|'X'|'^'|'_') ... ST
//   single-shift 7-bit: ESC (0x40-0x5F)
//   그 외 ESC + 1 char: 안전하게 2 char skip
function skipAnsiSequence(s: string, i: number): number {
  if (s.charCodeAt(i) !== 0x1b) return 1
  if (i + 1 >= s.length) return 1
  const next = s[i + 1]
  // CSI
  if (next === '[') {
    let j = i + 2
    while (j < s.length) {
      const c = s.charCodeAt(j)
      if (c >= 0x20 && c <= 0x3f) {
        j++
        continue
      }
      if (c >= 0x40 && c <= 0x7e) {
        return j - i + 1
      }
      // 잘못된 sequence — 안전하게 그 직전까지만 skip
      return j - i
    }
    return s.length - i
  }
  // OSC
  if (next === ']') {
    let j = i + 2
    while (j < s.length) {
      if (s.charCodeAt(j) === 0x07) return j - i + 1 // BEL
      if (s.charCodeAt(j) === 0x1b && j + 1 < s.length && s[j + 1] === '\\') {
        return j - i + 2 // ST
      }
      j++
    }
    return s.length - i
  }
  // DCS/PM/APC
  if (next === 'P' || next === 'X' || next === '^' || next === '_') {
    let j = i + 2
    while (j < s.length) {
      if (s.charCodeAt(j) === 0x1b && j + 1 < s.length && s[j + 1] === '\\') {
        return j - i + 2
      }
      j++
    }
    return s.length - i
  }
  // single-shift / 7-bit ESC + final
  return 2
}

function applyUserCap(text: string): string {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= TURN_CAP.userBytes) return text
  // UTF-8 byte 기준 truncate. 멀티바이트 안전을 위해 Buffer slice + decode 시도.
  const buf = Buffer.from(text, 'utf8')
  return buf.subarray(0, TURN_CAP.userBytes).toString('utf8') + '…[truncated]'
}
