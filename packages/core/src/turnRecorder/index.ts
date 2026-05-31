// TurnRecorder — pty:write hook + ptySession onData hook chain으로 한 turn(사용자 입력 → 모델 응답)을
// 캡처해 turns.jsonl append.
//
// state machine:
//   idle              — 사용자 입력 buffer. 모델 응답 미수집.
//   awaiting          — 사용자 Enter 직후. 첫 모델 byte 도착 대기.
//   assistant_active  — 모델 응답 수집 중. idle timer reset.
//
// flush trigger:
//   - assistant_active에서 IDLE_FLUSH_MS 동안 새 byte 없음 → turn flush.
//   - assistant_active에서 사용자가 새 Enter → 직전 turn flush + 새 turn 시작.
//
// 호스트 차이 흡수: workspace 경로·세션 레지스트리·스케줄러·assistant detail 설정 등은 모두
// 호스트가 인스턴스/콜백으로 주입.

import { randomUUID } from 'crypto';
import { appendTurn, rotateIfNeeded } from '../turnsStore';
import { sliceAssistant } from './sliceAssistant';
import type { CliKind } from '../shared/cli';
import type { TurnRecord, TurnsAssistantDetail } from '../shared/turns';
import { TURN_CAP } from '../shared/turns';
import type { Logger } from '../interfaces';
import { noopLogger } from '../interfaces';
import type { CompactionScheduler } from '../compactionScheduler';

// SessionRegistry는 옛 Phase 6.B에서 폐기됨. 호환 위해 minimal 인터페이스 유지.
// 새 코드는 onTurnFlushed 콜백 사용.
interface SessionRegistry {
  updateActivity(workspaceId: string, workspaceRoot: string, sessionId: string): Promise<void>;
}

const IDLE_FLUSH_MS = 1_500;
const ASSISTANT_BUFFER_HARD_CAP = 1_000_000; // 1MB

type State = 'idle' | 'awaiting' | 'assistant_active';

export type TurnRecorderOptions = {
  workspaceId: string;
  workspaceRoot: string;
  workspacePath: string;
  sessionId: string;
  model: CliKind;
  // assistantDetail은 사용자 설정 — 매 flush 시 현재값을 읽기 위해 콜백.
  getAssistantDetail: () => TurnsAssistantDetail;
  scheduler: CompactionScheduler;
  // sessionRegistry는 옵션 — 익스텐션은 코어 sessionRegistry로 updateActivity 호출.
  // 데스크탑은 자체 명부(workspace.json sessions[]) 사용. 둘 다 미사용 시 onTurnFlushed로 처리.
  sessionRegistry?: SessionRegistry;
  // 매 turn flush 직후 호출. 호스트가 자기 명부에 lastChattedAt 등 갱신용.
  onTurnFlushed?: (info: { workspaceId: string; sessionId: string; flushedAt: string }) => void | Promise<void>;
  logger?: Logger;
};

export class TurnRecorder {
  private state: State = 'idle';
  private userBuffer = '';
  // assistant_active 진입 시점에 snapshot. 모델 응답 끝나면 turn record로 flush.
  private pendingUserText: string | null = null;
  private pendingUserStartedAt: string | null = null;

  private assistantBuffer = '';

  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  // chunk 경계에서 partial ANSI sequence 보존용.
  private inputCarry = '';

  private readonly log: Logger;

  constructor(private readonly opts: TurnRecorderOptions) {
    this.log = opts.logger ?? noopLogger;
    this.log.log(`turnRecorder: initialized (workspace=${opts.workspaceId}, model=${opts.model})`);
  }

  onUserInput(data: string): void {
    const combined = this.inputCarry + data;
    this.inputCarry = '';

    const lastEsc = combined.lastIndexOf('\x1b');
    let toProcess = combined;
    if (lastEsc >= 0) {
      const tail = combined.slice(lastEsc);
      const adv = skipAnsiSequence(tail, 0);
      if (!isCompleteAnsiSequence(tail, adv)) {
        this.inputCarry = tail;
        toProcess = combined.slice(0, lastEsc);
      }
    }

    const body = toProcess.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    let i = 0;
    while (i < body.length) {
      const code = body.charCodeAt(i);

      if (code === 0x1b) {
        const advance = skipAnsiSequence(body, i);
        i += advance;
        continue;
      }

      const ch = body[i];
      if (ch === '\n') {
        const text = this.userBuffer.trim();
        this.userBuffer = '';
        if (text.length === 0) {
          i++;
          continue;
        }
        // 진행 중인 turn flush + 새 turn 시작. awaiting 상태에서도 flush 필요(메시지 손실 방지).
        if (this.pendingUserText !== null && (this.state === 'awaiting' || this.state === 'assistant_active')) {
          void this.flushTurn().catch((err) => {
            this.log.warn(`turnRecorder mid-turn flush 실패: ${String(err)}`);
          });
        }
        this.startNewTurn(applyUserCap(text));
        i++;
        continue;
      }
      if (code === 0x03) {
        // Ctrl-C
        this.userBuffer = '';
        if (this.state === 'assistant_active') {
          void this.flushTurn().catch((err) => {
            this.log.warn(`turnRecorder Ctrl-C flush 실패: ${String(err)}`);
          });
        } else if (this.state === 'awaiting') {
          this.resetState();
        }
        i++;
        continue;
      }
      if (code === 0x7f || code === 0x08) {
        // DEL / BS
        if (this.userBuffer.length > 0) {
          this.userBuffer = this.userBuffer.slice(0, -1);
        }
        i++;
        continue;
      }
      if (code < 0x20) {
        i++;
        continue;
      }
      this.userBuffer += ch;
      if (this.userBuffer.length > TURN_CAP.userBytes * 2) {
        this.userBuffer = this.userBuffer.slice(0, TURN_CAP.userBytes * 2);
      }
      i++;
    }
  }

  onAssistantData(data: string): void {
    if (this.state === 'awaiting') {
      this.state = 'assistant_active';
      this.log.log(`turnRecorder: awaiting → assistant_active (firstChunk=${data.length}B)`);
    }
    if (this.state !== 'assistant_active') {
      return;
    }
    this.assistantBuffer += data;
    if (this.assistantBuffer.length > ASSISTANT_BUFFER_HARD_CAP) {
      const head = this.assistantBuffer.slice(0, ASSISTANT_BUFFER_HARD_CAP / 2);
      const tail = this.assistantBuffer.slice(-ASSISTANT_BUFFER_HARD_CAP / 2);
      this.assistantBuffer = head + '\n…[truncated]…\n' + tail;
    }
    this.scheduleIdleFlush();
  }

  // dispose는 진행 중 turn flush 시도. flush는 fire-and-forget이지만 호스트가 await 필요하면
  // disposeAndFlush()를 사용한다.
  dispose(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.pendingUserText !== null && (this.state === 'assistant_active' || this.state === 'awaiting')) {
      void this.flushTurn().catch((err) => {
        this.log.warn(`turnRecorder dispose flush 실패: ${String(err)}`);
      });
    }
  }

  // 종료 시 flush 완료까지 await할 수 있는 비동기 dispose. 호스트의 deactivate에서 사용.
  async disposeAndFlush(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.pendingUserText !== null && (this.state === 'assistant_active' || this.state === 'awaiting')) {
      try {
        await this.flushTurn();
      } catch (err) {
        this.log.warn(`turnRecorder disposeAndFlush 실패: ${String(err)}`);
      }
    }
  }

  private startNewTurn(userText: string): void {
    this.pendingUserText = userText;
    this.pendingUserStartedAt = new Date().toISOString();
    this.assistantBuffer = '';
    this.state = 'awaiting';
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.log.log(
      `turnRecorder.startNewTurn (userLen=${userText.length}, preview="${userText.slice(0, 60)}")`,
    );
  }

  private scheduleIdleFlush(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.flushTurn().catch((err) => {
        this.log.warn(`turnRecorder idle flush 실패: ${String(err)}`);
      });
    }, IDLE_FLUSH_MS);
  }

  private async flushTurn(): Promise<void> {
    this.log.log(
      `turnRecorder.flushTurn entry (state=${this.state}, pendingUser=${this.pendingUserText !== null}, asstBuf=${this.assistantBuffer.length}B)`,
    );
    if (this.state !== 'assistant_active' && this.state !== 'awaiting') return;
    if (this.pendingUserText === null || this.pendingUserStartedAt === null) {
      this.resetState();
      return;
    }
    const userText = this.pendingUserText;
    const startedAt = this.pendingUserStartedAt;
    const assistantRaw = this.assistantBuffer;
    const model = this.opts.model;
    const workspaceId = this.opts.workspaceId;
    const sessionId = this.opts.sessionId;
    // 상태 reset 먼저 — flush 도중 새 입력 도착에 대비. 동기 구간 안에서 수행.
    this.resetState();

    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    const detail = this.opts.getAssistantDetail();
    const slice = sliceAssistant({ raw: assistantRaw, model, detail });

    const turn: TurnRecord = {
      id: randomUUID(),
      workspaceId,
      sessionId,
      model,
      startedAt,
      completedAt: new Date().toISOString(),
      user: userText,
      userBytes: utf8ByteLength(userText),
      assistantBody: slice.assistantBody,
      assistantBodyBytes: slice.assistantBodyBytes,
      toolCalls: slice.toolCalls,
    };

    try {
      await appendTurn(this.opts.workspaceRoot, turn);
      this.log.log(
        `turnRecorder: flush turn (userBytes=${turn.userBytes}, bodyBytes=${turn.assistantBodyBytes}, toolCalls=${turn.toolCalls.length})`,
      );
      this.opts.scheduler.events.emit('turns:updated', workspaceId);
      // 세션 활성 갱신 — 호스트 선택:
      //   1) sessionRegistry (옛 패턴, 익스텐션이 코어 sessionRegistry 사용 시)
      //   2) onTurnFlushed 콜백 (호스트가 직접 명부 갱신, 데스크탑 패턴)
      const flushedAt = new Date().toISOString();
      if (this.opts.sessionRegistry) {
        void this.opts.sessionRegistry
          .updateActivity(workspaceId, this.opts.workspaceRoot, sessionId)
          .catch((err: unknown) =>
            this.log.warn(`turnRecorder updateActivity 실패: ${String(err)}`),
          );
      }
      if (this.opts.onTurnFlushed) {
        void Promise.resolve(this.opts.onTurnFlushed({ workspaceId, sessionId, flushedAt })).catch((err) =>
          this.log.warn(`turnRecorder onTurnFlushed 실패: ${String(err)}`),
        );
      }
    } catch (err) {
      this.log.warn(`turnRecorder appendTurn 실패: ${String(err)}`);
      return;
    }

    try {
      await rotateIfNeeded(this.opts.workspaceRoot, { logger: this.log });
    } catch (err) {
      this.log.warn(`turnRecorder rotate check 실패 (non-fatal): ${String(err)}`);
    }

    void this.opts.scheduler
      .checkAndRun({
        workspaceId,
        workspaceRoot: this.opts.workspaceRoot,
        workspacePath: this.opts.workspacePath,
        activeModel: model,
      })
      .catch((err) => {
        this.log.warn(`CompactionScheduler trigger 실패 (non-fatal): ${String(err)}`);
      });
  }

  private resetState(): void {
    this.pendingUserText = null;
    this.pendingUserStartedAt = null;
    this.assistantBuffer = '';
    this.state = 'idle';
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

// ─── ANSI helpers (sliceAssistant과 별개 — 사용자 입력 stream 처리 전용) ──

function isCompleteAnsiSequence(tail: string, adv: number): boolean {
  if (tail.length === 0 || tail.charCodeAt(0) !== 0x1b) return true;
  if (tail.length < 2) return false;
  const next = tail[1];
  const last = tail.charCodeAt(adv - 1);
  if (next === '[') {
    return adv >= 3 && last >= 0x40 && last <= 0x7e;
  }
  if (next === ']' || next === 'P' || next === 'X' || next === '^' || next === '_') {
    if (adv < 3) return false;
    if (last === 0x07) return true;
    if (adv >= 4 && tail.charCodeAt(adv - 2) === 0x1b && tail[adv - 1] === '\\') return true;
    return false;
  }
  if (next === 'O') {
    return tail.length >= 3;
  }
  return tail.length >= 2;
}

function skipAnsiSequence(s: string, i: number): number {
  if (s.charCodeAt(i) !== 0x1b) return 1;
  if (i + 1 >= s.length) return 1;
  const next = s[i + 1];
  if (next === '[') {
    let j = i + 2;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c >= 0x20 && c <= 0x3f) {
        j++;
        continue;
      }
      if (c >= 0x40 && c <= 0x7e) {
        return j - i + 1;
      }
      return j - i;
    }
    return s.length - i;
  }
  if (next === ']') {
    let j = i + 2;
    while (j < s.length) {
      if (s.charCodeAt(j) === 0x07) return j - i + 1;
      if (s.charCodeAt(j) === 0x1b && j + 1 < s.length && s[j + 1] === '\\') {
        return j - i + 2;
      }
      j++;
    }
    return s.length - i;
  }
  if (next === 'P' || next === 'X' || next === '^' || next === '_') {
    let j = i + 2;
    while (j < s.length) {
      if (s.charCodeAt(j) === 0x1b && j + 1 < s.length && s[j + 1] === '\\') {
        return j - i + 2;
      }
      j++;
    }
    return s.length - i;
  }
  if (next === 'O') {
    return i + 2 < s.length ? 3 : 2;
  }
  return 2;
}

function applyUserCap(text: string): string {
  const bytes = utf8ByteLength(text);
  if (bytes <= TURN_CAP.userBytes) return text;
  // 바이트 단위 자르기: charCodeAt 기반으로 누적해 cap에 도달하면 stop.
  let n = 0;
  let cut = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let add: number;
    if (c < 0x80) add = 1;
    else if (c < 0x800) add = 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      add = 4;
    } else add = 3;
    if (n + add > TURN_CAP.userBytes) break;
    n += add;
    cut = i + (c >= 0xd800 && c <= 0xdbff ? 2 : 1);
    if (c >= 0xd800 && c <= 0xdbff) i++;
  }
  return text.slice(0, cut) + '…[truncated]';
}

function utf8ByteLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}
