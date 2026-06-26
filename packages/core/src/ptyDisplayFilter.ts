// PTY stream에서 <agentbridge-context>…</agentbridge-context> 블록을 [hook context hidden]으로
// 치환한다. 코덱스/클로드/agy CLI가 hook 응답을 raw text로 PTY에 그대로 토하는 환경에서,
// 사용자가 보는 터미널에 context payload가 노출되지 않도록 하기 위함.
//
// v0.1.6 알고리즘:
//   - 입력에서 ANSI/C0 제어를 걷어낸 plain 문자열을 만들고, plain 위에서 indexOf로 OPEN/CLOSE를 찾는다.
//   - plainToOrig 매핑으로 원본 인덱스를 복원해 emit/drop 경계를 결정.
//   - 미완성 ANSI tail은 carry로 보관, 다음 청크와 결합.
//   - in-block watchdog (1초 BLOCK_TIMEOUT_MS) — close tag가 stream에서 누락된 경우 자동 unblock.

import type { Logger } from './interfaces';
import { noopLogger } from './interfaces';
import { CONTEXT_OPEN_TAG, CONTEXT_CLOSE_TAG } from './contextTag';

const OPEN_TAG = CONTEXT_OPEN_TAG;
const CLOSE_TAG = CONTEXT_CLOSE_TAG;
const HIDDEN_MARKER = '[hook context hidden]';

const BLOCK_TIMEOUT_MS = 1_000;
const STUCK_WARN_MS = 500;

// 반환값:
//   >0 — input[i..i+len]이 완전한 ANSI sequence (len 바이트)
//   0  — input[i]가 ESC인데 미완성 (carry 필요). 호출 전 ESC 확인 필수.
function ansiSequenceLength(input: string, i: number): number {
  const n = input.length;
  if (i + 1 >= n) return 0;
  const c1 = input.charCodeAt(i + 1);
  if (c1 === 0x5b /* [ */) {
    let j = i + 2;
    while (j < n) {
      const cc = input.charCodeAt(j);
      if (cc >= 0x40 && cc <= 0x7e) return j - i + 1;
      j++;
    }
    return 0;
  }
  if (c1 === 0x5d /* ] */) {
    let j = i + 2;
    while (j < n) {
      const cc = input.charCodeAt(j);
      if (cc === 0x07) return j - i + 1;
      if (cc === 0x1b) {
        if (j + 1 >= n) return 0;
        if (input.charCodeAt(j + 1) === 0x5c) return j - i + 2;
        return 2;
      }
      j++;
    }
    return 0;
  }
  return 2;
}

function buildPlainProjection(input: string): {
  plain: string;
  plainToOrig: number[];
  truncatedAt: number;
} {
  let plain = '';
  const plainToOrig: number[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const cc = input.charCodeAt(i);
    if (cc === 0x1b) {
      const len = ansiSequenceLength(input, i);
      if (len === 0) {
        return { plain, plainToOrig, truncatedAt: i };
      }
      i += len;
      continue;
    }
    if (cc < 0x20 || cc === 0x7f) {
      i++;
      continue;
    }
    plain += input.charAt(i);
    plainToOrig.push(i);
    i++;
  }
  return { plain, plainToOrig, truncatedAt: -1 };
}

function longestSuffixPrefix(plain: string, tag: string): number {
  const maxLen = Math.min(plain.length, tag.length - 1);
  for (let len = maxLen; len > 0; len--) {
    if (plain.endsWith(tag.slice(0, len))) return len;
  }
  return 0;
}

export type PtyDisplayFilterOptions = {
  logger?: Logger;
};

export class PtyDisplayFilter {
  private carry = '';
  private inBlock = false;
  private blockEnteredAt = 0;
  private warnedStuck = false;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private onForceUnblock: (() => void) | null = null;
  private readonly log: Logger;

  constructor(opts: PtyDisplayFilterOptions = {}) {
    this.log = opts.logger ?? noopLogger;
  }

  setForceUnblockHandler(fn: () => void): void {
    this.onForceUnblock = fn;
  }

  private armWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      if (this.inBlock) {
        const elapsed = Date.now() - this.blockEnteredAt;
        this.log.warn(`ptyDisplayFilter: watchdog timer fired (${elapsed}ms) — force unblock`);
        this.inBlock = false;
        this.carry = '';
        this.blockEnteredAt = 0;
        this.warnedStuck = false;
        this.onForceUnblock?.();
      }
      this.watchdog = null;
    }, BLOCK_TIMEOUT_MS);
  }

  private clearWatchdog(): void {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
    this.blockEnteredAt = 0;
    this.warnedStuck = false;
  }

  dispose(): void {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
    this.onForceUnblock = null;
  }

  filter(data: string): string {
    if (this.inBlock && this.blockEnteredAt > 0) {
      const elapsed = Date.now() - this.blockEnteredAt;
      if (elapsed > BLOCK_TIMEOUT_MS) {
        this.log.warn(`ptyDisplayFilter: block timeout (${elapsed}ms) — force unblock`);
        this.inBlock = false;
        this.carry = '';
        this.clearWatchdog();
      } else if (elapsed > STUCK_WARN_MS && !this.warnedStuck) {
        this.log.warn(
          `ptyDisplayFilter: in-block ${elapsed}ms with no close tag — possible stuck state`,
        );
        this.warnedStuck = true;
      }
    }

    const input = this.carry + data;
    this.carry = '';
    if (input.length === 0) return '';

    const { plain, plainToOrig, truncatedAt } = buildPlainProjection(input);
    const origEnd = truncatedAt >= 0 ? truncatedAt : input.length;
    const trailingTail = truncatedAt >= 0 ? input.slice(truncatedAt) : '';

    let result = '';
    let plainPos = 0;
    let origPos = 0;

    while (true) {
      if (this.inBlock) {
        const idx = plain.indexOf(CLOSE_TAG, plainPos);
        if (idx === -1) {
          const tail = longestSuffixPrefix(plain.slice(plainPos), CLOSE_TAG);
          if (tail > 0) {
            const carryStartPlain = plain.length - tail;
            const carryStartOrig = plainToOrig[carryStartPlain];
            this.carry = input.slice(carryStartOrig);
          } else {
            this.carry = trailingTail;
          }
          return result;
        }
        const lastPlainIdx = idx + CLOSE_TAG.length - 1;
        const origAtLastClose = plainToOrig[lastPlainIdx];
        origPos = origAtLastClose + 1;
        plainPos = idx + CLOSE_TAG.length;
        this.inBlock = false;
        this.clearWatchdog();
        continue;
      }

      const idx = plain.indexOf(OPEN_TAG, plainPos);
      if (idx === -1) {
        const tail = longestSuffixPrefix(plain.slice(plainPos), OPEN_TAG);
        if (tail > 0) {
          const carryStartPlain = plain.length - tail;
          const carryStartOrig = plainToOrig[carryStartPlain];
          result += input.slice(origPos, carryStartOrig);
          this.carry = input.slice(carryStartOrig);
        } else {
          result += input.slice(origPos, origEnd);
          this.carry = trailingTail;
        }
        return result;
      }
      const origAtOpen = plainToOrig[idx];
      result += input.slice(origPos, origAtOpen);
      result += HIDDEN_MARKER;
      const lastPlainIdx = idx + OPEN_TAG.length - 1;
      const origAtLastOpen = plainToOrig[lastPlainIdx];
      origPos = origAtLastOpen + 1;
      plainPos = idx + OPEN_TAG.length;
      this.inBlock = true;
      this.blockEnteredAt = Date.now();
      this.warnedStuck = false;
      this.armWatchdog();
      continue;
    }
  }
}
