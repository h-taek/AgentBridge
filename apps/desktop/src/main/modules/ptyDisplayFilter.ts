// PTY display filter — M3 O 청크 후속 (2026-05-11).
//
// codex 0.130.0 + gemini는 hook `additionalContext`를 TUI에 *visible developer message*로
// 렌더링. `suppressOutput: true`는 no-op (openai/codex#15497, #16933 확정).
//
// → 워크어라운드: **PTY output stripping**. helper binary가 emit한
//   `<agentbridge-context>…</agentbridge-context>` 블록을 PTY → renderer/turnRecorder 경로에서 제거.
//   replay.log엔 raw 그대로 (포렌식/디버그 목적).
//
// v0.0.5 (2026-05-26) — 매칭 알고리즘 재설계 (extension v0.1.6 포팅).
// 이전 버전(raw input에 indexOf)은 codex TUI redraw 시 OPEN/CLOSE 사이에 \r/\b/ANSI 같은
// 제어문자가 끼면 매칭 실패 → in-block 무한 갇힘 → watchdog으로만 풀려나는 패턴이 있었다.
// 이번 버전은 입력에서 ANSI/C0를 걷어낸 plain 문자열을 만들고, plain 위에서 indexOf로
// OPEN/CLOSE를 찾는다. plainToOrig 매핑으로 원본 인덱스를 복원해 emit/drop 경계를 결정.

import log from 'electron-log/main'

const OPEN_TAG = '<agentbridge-context>'
const CLOSE_TAG = '</agentbridge-context>'
const HIDDEN_MARKER = '[hook context hidden]'

// in-block watchdog 안전망 — close tag 자체가 stream에서 누락된 catastrophic case 대비.
// 매칭 알고리즘 강화 후에도 안전망으로 유지. 발동 시 사용자 체감 freeze가 길지 않도록 짧게.
const BLOCK_TIMEOUT_MS = 1_000
const STUCK_WARN_MS = 500

// 반환값:
//   >0 — input[i..i+len]이 완전한 ANSI sequence (len 바이트)
//   0  — input[i]가 ESC인데 미완성 (carry 필요). 호출 전 ESC 확인 필수.
function ansiSequenceLength(input: string, i: number): number {
  const n = input.length
  if (i + 1 >= n) return 0
  const c1 = input.charCodeAt(i + 1)
  if (c1 === 0x5b /* [ */) {
    // CSI: ESC [ params(0x20-0x3f) final(0x40-0x7e)
    let j = i + 2
    while (j < n) {
      const cc = input.charCodeAt(j)
      if (cc >= 0x40 && cc <= 0x7e) return j - i + 1
      j++
    }
    return 0
  }
  if (c1 === 0x5d /* ] */) {
    // OSC: ESC ] ... (BEL | ESC \)
    let j = i + 2
    while (j < n) {
      const cc = input.charCodeAt(j)
      if (cc === 0x07) return j - i + 1
      if (cc === 0x1b) {
        if (j + 1 >= n) return 0
        if (input.charCodeAt(j + 1) === 0x5c) return j - i + 2
        return 2
      }
      j++
    }
    return 0
  }
  // Two-byte ESC sequence (ESC + final char like M, =, 7, 8, ...)
  return 2
}

// 입력에서 ANSI/C0 제어를 걷어낸 plain 문자열 + 원본 인덱스 매핑 생성.
// truncatedAt: 미완성 ANSI 발견 시 그 위치 (그 이후는 다음 청크와 합쳐 재처리). -1이면 입력 전체 소비.
function buildPlainProjection(input: string): {
  plain: string
  plainToOrig: number[]
  truncatedAt: number
} {
  let plain = ''
  const plainToOrig: number[] = []
  let i = 0
  const n = input.length
  while (i < n) {
    const cc = input.charCodeAt(i)
    if (cc === 0x1b) {
      const len = ansiSequenceLength(input, i)
      if (len === 0) {
        return { plain, plainToOrig, truncatedAt: i }
      }
      i += len
      continue
    }
    if (cc < 0x20 || cc === 0x7f) {
      // C0 제어문자(0x00-0x1f) 및 DEL(0x7f) — plain에서 제외 (매칭 무관).
      // 원본에는 그대로 남으므로 xterm은 정상 처리.
      i++
      continue
    }
    plain += input.charAt(i)
    plainToOrig.push(i)
    i++
  }
  return { plain, plainToOrig, truncatedAt: -1 }
}

// plain 끝이 tag의 prefix와 부분 매치되는 최대 길이 반환 (chunk 경계 carry용).
function longestSuffixPrefix(plain: string, tag: string): number {
  const maxLen = Math.min(plain.length, tag.length - 1)
  for (let len = maxLen; len > 0; len--) {
    if (plain.endsWith(tag.slice(0, len))) return len
  }
  return 0
}

type FilterState = {
  inBlock: boolean
  carry: string
  blockEnteredAt: number
  warnedStuck: boolean
  watchdog: NodeJS.Timeout | null
}

const states = new Map<string, FilterState>()

function clearWatchdog(state: FilterState): void {
  if (state.watchdog) {
    clearTimeout(state.watchdog)
    state.watchdog = null
  }
  state.blockEnteredAt = 0
  state.warnedStuck = false
}

function armWatchdog(ptySessionId: string, state: FilterState): void {
  if (state.watchdog) clearTimeout(state.watchdog)
  state.watchdog = setTimeout(() => {
    const s = states.get(ptySessionId)
    if (!s) return
    if (s.inBlock) {
      const elapsed = Date.now() - s.blockEnteredAt
      log.warn(`ptyDisplayFilter: watchdog timer fired (${elapsed}ms) — force unblock`, {
        ptySessionId
      })
      s.inBlock = false
      s.carry = ''
      s.blockEnteredAt = 0
      s.warnedStuck = false
    }
    s.watchdog = null
  }, BLOCK_TIMEOUT_MS)
}

export function registerDisplayFilter(ptySessionId: string): void {
  states.set(ptySessionId, {
    inBlock: false,
    carry: '',
    blockEnteredAt: 0,
    warnedStuck: false,
    watchdog: null
  })
}

export function unregisterDisplayFilter(ptySessionId: string): void {
  const s = states.get(ptySessionId)
  if (s) clearWatchdog(s)
  states.delete(ptySessionId)
}

// 등록 안 된 세션은 pass-through. 호출자는 항상 returned value를 사용.
export function filterDisplayData(ptySessionId: string, data: string): string {
  const state = states.get(ptySessionId)
  if (!state) return data

  // 인-블록 timeout 이중 체크 (setTimeout 지연 환경 대비).
  if (state.inBlock && state.blockEnteredAt > 0) {
    const elapsed = Date.now() - state.blockEnteredAt
    if (elapsed > BLOCK_TIMEOUT_MS) {
      log.warn(`ptyDisplayFilter: block timeout (${elapsed}ms) — force unblock`, { ptySessionId })
      state.inBlock = false
      state.carry = ''
      clearWatchdog(state)
    } else if (elapsed > STUCK_WARN_MS && !state.warnedStuck) {
      log.warn(
        `ptyDisplayFilter: in-block ${elapsed}ms with no close tag — possible stuck state`,
        { ptySessionId }
      )
      state.warnedStuck = true
    }
  }

  const input = state.carry + data
  state.carry = ''
  if (input.length === 0) return ''

  const { plain, plainToOrig, truncatedAt } = buildPlainProjection(input)
  const origEnd = truncatedAt >= 0 ? truncatedAt : input.length
  const trailingTail = truncatedAt >= 0 ? input.slice(truncatedAt) : ''

  let result = ''
  let plainPos = 0
  let origPos = 0

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (state.inBlock) {
      const idx = plain.indexOf(CLOSE_TAG, plainPos)
      if (idx === -1) {
        const tail = longestSuffixPrefix(plain.slice(plainPos), CLOSE_TAG)
        if (tail > 0) {
          const carryStartPlain = plain.length - tail
          const carryStartOrig = plainToOrig[carryStartPlain]
          state.carry = input.slice(carryStartOrig)
        } else {
          state.carry = trailingTail
        }
        return result
      }
      // close 발견 — open ~ close 구간 drop. 다음 char부터 origPos 재시작.
      const lastPlainIdx = idx + CLOSE_TAG.length - 1
      const origAtLastClose = plainToOrig[lastPlainIdx]
      origPos = origAtLastClose + 1
      plainPos = idx + CLOSE_TAG.length
      state.inBlock = false
      clearWatchdog(state)
      continue
    }

    const idx = plain.indexOf(OPEN_TAG, plainPos)
    if (idx === -1) {
      const tail = longestSuffixPrefix(plain.slice(plainPos), OPEN_TAG)
      if (tail > 0) {
        const carryStartPlain = plain.length - tail
        const carryStartOrig = plainToOrig[carryStartPlain]
        result += input.slice(origPos, carryStartOrig)
        state.carry = input.slice(carryStartOrig)
      } else {
        result += input.slice(origPos, origEnd)
        state.carry = trailingTail
      }
      return result
    }
    // OPEN 발견 — origAtOpen 직전까지 emit + marker + in-block 진입.
    const origAtOpen = plainToOrig[idx]
    result += input.slice(origPos, origAtOpen)
    result += HIDDEN_MARKER
    const lastPlainIdx = idx + OPEN_TAG.length - 1
    const origAtLastOpen = plainToOrig[lastPlainIdx]
    origPos = origAtLastOpen + 1
    plainPos = idx + OPEN_TAG.length
    state.inBlock = true
    state.blockEnteredAt = Date.now()
    state.warnedStuck = false
    armWatchdog(ptySessionId, state)
    continue
  }
}

// 디버깅용 — 현재 상태 조회.
export function getFilterState(
  ptySessionId: string
): { inBlock: boolean; carryLen: number } | null {
  const s = states.get(ptySessionId)
  if (!s) return null
  return { inBlock: s.inBlock, carryLen: s.carry.length }
}
