// CaptureSession — 한 세션의 transcript를 읽어 turnsStore 하류에 잇는 엔진.
// IO/스케줄링(파일 위치 해석·fs.watch·폴링)은 호스트 배선이 주입/구동한다. 이 클래스는
// "증분 읽기 → reader.consume → dedup → appendTurn → scheduler"의 코어 로직 + cursor/carry 상태만 담당.
//
// 하류는 기존 flushTurn과 동일: appendTurn → turns:updated emit → checkAndRun → rotateIfNeeded.
// 멱등성: cursor(.transcriptCursors.json) + 결정적 turn id 2중 방어(design §D).
import { promises as fs } from 'fs';
import { join } from 'path';
import { appendTurn, readAllTurns, rotateIfNeeded } from '../turnsStore';
import type { CliKind } from '../shared/cli';
import type { TurnRecord, TurnsAssistantDetail } from '../shared/turns';
import type { Logger } from '../interfaces';
import { noopLogger } from '../interfaces';
import { EMPTY_CARRY, type Carry, type ReaderCtx } from './types';
import { claudeConsume } from './claudeReader';
import { codexConsume } from './codexReader';
import { agyConsume, type AgyStepRow } from './agyReader';
import { readJsonlIncrement } from './watcher';
import { readAgySteps } from './agySteps';
import { finalizeCarry } from './util';

// scheduler 최소 인터페이스 — 기존 CompactionScheduler가 만족(테스트는 fake 주입).
export interface CaptureSchedulerLike {
  events: { emit(event: 'turns:updated', workspaceId: string): void };
  checkAndRun(args: {
    workspaceId: string;
    workspaceRoot: string;
    workspacePath: string;
    activeModel: CliKind;
  }): Promise<void>;
}

export interface CaptureSessionOptions {
  workspaceId: string;
  workspaceRoot: string;
  workspacePath: string;
  sessionId: string;
  model: CliKind;
  transcriptPath: string; // 호스트가 해석해서 주입 (claude enc-cwd / codex glob / agy .db)
  getDetail: () => TurnsAssistantDetail;
  scheduler: CaptureSchedulerLike;
  onTurnFlushed?: (info: { workspaceId: string; sessionId: string; flushedAt: string }) => void | Promise<void>;
  logger?: Logger;
}

const CURSORS_FILE = '.transcriptCursors.json';

function cursorsPath(workspaceRoot: string): string {
  return join(workspaceRoot, CURSORS_FILE);
}

async function loadCursors(workspaceRoot: string): Promise<Record<string, number>> {
  try {
    return JSON.parse(await fs.readFile(cursorsPath(workspaceRoot), 'utf8')) as Record<string, number>;
  } catch {
    return {};
  }
}

// read-modify-write. 같은 워크스페이스의 동시 세션이 서로의 cursor를 덮지 않도록 현재값을 다시 읽어 병합.
// (드문 경쟁의 stale cursor는 결정적 id dedup이 보정 — design §D 2중 방어.)
async function saveCursor(workspaceRoot: string, sessionId: string, cursor: number): Promise<void> {
  const all = await loadCursors(workspaceRoot);
  all[sessionId] = cursor;
  const tmp = `${cursorsPath(workspaceRoot)}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(all), 'utf8');
  await fs.rename(tmp, cursorsPath(workspaceRoot));
}

export class CaptureSession {
  private readonly sourceKind: 'jsonl' | 'sqlite';
  private cursor: number | null = null; // lazy
  private carry: Carry = EMPTY_CARRY;
  private seenIds: Set<string> | null = null; // lazy: 기존 turns.jsonl id (dedup)
  private readonly log: Logger;

  constructor(private readonly opts: CaptureSessionOptions) {
    this.sourceKind = opts.model === 'agy' ? 'sqlite' : 'jsonl';
    this.log = opts.logger ?? noopLogger;
  }

  private get defaultCursor(): number {
    return this.sourceKind === 'sqlite' ? -1 : 0;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.cursor === null) {
      const all = await loadCursors(this.opts.workspaceRoot);
      this.cursor = all[this.opts.sessionId] ?? this.defaultCursor;
    }
    if (this.seenIds === null) {
      try {
        this.seenIds = new Set((await readAllTurns(this.opts.workspaceRoot)).map((t) => t.id));
      } catch {
        this.seenIds = new Set();
      }
    }
  }

  private ctx(): ReaderCtx {
    return { workspaceId: this.opts.workspaceId, sessionId: this.opts.sessionId, detail: this.opts.getDetail() };
  }

  private runReader(input: unknown[] | AgyStepRow[], carry: Carry): { turns: TurnRecord[]; carry: Carry } {
    const ctx = this.ctx();
    switch (this.opts.model) {
      case 'codex':
        return codexConsume(input as unknown[], carry, ctx);
      case 'agy':
        return agyConsume(input as AgyStepRow[], carry, ctx);
      default:
        return claudeConsume(input as unknown[], carry, ctx);
    }
  }

  // 증분 1회 처리: 새 transcript 내용을 읽어 닫힌 턴을 append.
  async tick(): Promise<void> {
    await this.ensureLoaded();
    const cursor = this.cursor as number;

    let input: unknown[] | AgyStepRow[];
    let newCursor = cursor;
    try {
      if (this.sourceKind === 'jsonl') {
        const inc = await readJsonlIncrement(this.opts.transcriptPath, cursor);
        input = inc.records;
        newCursor = inc.offset;
      } else {
        const rows = readAgySteps(this.opts.transcriptPath, cursor);
        input = rows;
        newCursor = rows.length ? rows[rows.length - 1].idx : cursor;
      }
    } catch (err) {
      this.log.warn(`CaptureSession tick read 실패 (${this.opts.model}): ${String(err)}`);
      return;
    }

    if (newCursor === cursor && input.length === 0) return;

    const { turns, carry } = this.runReader(input, this.carry);
    this.carry = carry;
    await this.emit(turns);

    this.cursor = newCursor;
    try {
      await saveCursor(this.opts.workspaceRoot, this.opts.sessionId, newCursor);
    } catch (err) {
      this.log.warn(`CaptureSession cursor 저장 실패: ${String(err)}`);
    }
  }

  // 세션 종료/완료 신호 시: carry에 남은 마지막 열린 턴을 flush.
  async finalize(): Promise<void> {
    await this.ensureLoaded();
    const last = finalizeCarry(this.carry, this.opts.model, this.ctx());
    this.carry = EMPTY_CARRY;
    if (last) await this.emit([last]);
  }

  // 턴 배열을 dedup 후 append + 하류 트리거.
  private async emit(turns: TurnRecord[]): Promise<void> {
    const seen = this.seenIds as Set<string>;
    let appended = 0;
    for (const turn of turns) {
      if (seen.has(turn.id)) continue; // 결정적 id dedup
      try {
        await appendTurn(this.opts.workspaceRoot, turn);
        seen.add(turn.id);
        appended++;
      } catch (err) {
        this.log.warn(`CaptureSession appendTurn 실패: ${String(err)}`);
      }
    }
    if (appended === 0) return;

    this.opts.scheduler.events.emit('turns:updated', this.opts.workspaceId);
    const flushedAt = new Date().toISOString();
    if (this.opts.onTurnFlushed) {
      void Promise.resolve(
        this.opts.onTurnFlushed({ workspaceId: this.opts.workspaceId, sessionId: this.opts.sessionId, flushedAt }),
      ).catch((err) => this.log.warn(`CaptureSession onTurnFlushed 실패: ${String(err)}`));
    }
    try {
      await rotateIfNeeded(this.opts.workspaceRoot, { logger: this.log });
    } catch (err) {
      this.log.warn(`CaptureSession rotate 실패 (non-fatal): ${String(err)}`);
    }
    void this.opts.scheduler
      .checkAndRun({
        workspaceId: this.opts.workspaceId,
        workspaceRoot: this.opts.workspaceRoot,
        workspacePath: this.opts.workspacePath,
        activeModel: this.opts.model,
      })
      .catch((err) => this.log.warn(`CaptureSession scheduler 실패 (non-fatal): ${String(err)}`));
  }
}
