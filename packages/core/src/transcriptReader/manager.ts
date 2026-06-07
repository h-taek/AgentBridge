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
import { EMPTY_CARRY, type ConsumeResult, type ReaderCtx } from './types';
import { claudeConsume } from './claudeReader';
import { codexConsume } from './codexReader';
import { agyConsume } from './agyReader';
import { readJsonlIncrement } from './watcher';
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
  // 3 CLI 모두 jsonl transcript(claude/codex/agy transcript.jsonl) → byte-offset 증분 읽기로 통일.
  // atomic-read(cursor-hold): cursor는 "완료로 확정된 마지막 턴의 끝"에만 머문다. 미완(완료 태그 없는)
  // 꼬리 턴은 cursor를 안 옮기고 다음 tick에 그 위치부터 통째로 다시 읽는다 → 메모리 carry 비의존,
  // 앱이 턴 도중 꺼져도 재시작 후 그 턴을 처음부터 온전히 잡는다.
  private cursor: number | null = null; // lazy (byte offset; 미완 꼬리 시작에 머묾)
  private lastEof = -1; // 마지막으로 처리한 완전-라인 EOF. 파일이 안 자랐으면 재처리 skip.
  private seenIds: Set<string> | null = null; // lazy: 기존 turns.jsonl id (dedup)
  private readonly log: Logger;

  constructor(private readonly opts: CaptureSessionOptions) {
    this.log = opts.logger ?? noopLogger;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.cursor === null) {
      const all = await loadCursors(this.opts.workspaceRoot);
      this.cursor = all[this.opts.sessionId] ?? 0;
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

  // 매 tick EMPTY_CARRY로 호출(atomic-read는 cursor부터 통째로 다시 읽으므로 메모리 carry 불필요).
  private runReader(input: unknown[]): ConsumeResult {
    const ctx = this.ctx();
    switch (this.opts.model) {
      case 'codex':
        return codexConsume(input, EMPTY_CARRY, ctx);
      case 'agy':
        return agyConsume(input, EMPTY_CARRY, ctx);
      default:
        return claudeConsume(input, EMPTY_CARRY, ctx);
    }
  }

  // 증분 1회 처리(atomic-read): cursor(미완 꼬리 시작)부터 EOF까지 읽어, 완료로 확정된 턴만 append하고
  // cursor를 그 끝까지만 전진한다. 완료 태그 없는 꼬리는 cursor 유지 → 다음 tick에 다시 읽는다.
  async tick(): Promise<void> {
    await this.ensureLoaded();
    const cursor = this.cursor as number;

    let inc;
    try {
      inc = await readJsonlIncrement(this.opts.transcriptPath, cursor);
    } catch (err) {
      this.log.warn(`CaptureSession tick read 실패 (${this.opts.model}): ${String(err)}`);
      return;
    }

    if (inc.records.length === 0) return; // 완전한 새 라인 없음 — cursor 유지
    if (inc.offset === this.lastEof) return; // 파일이 안 자람 — 같은 미완 꼬리 재처리 방지
    this.lastEof = inc.offset;

    const { turns, consumed } = this.runReader(inc.records);
    await this.emit(turns);

    // 완료된 턴 끝까지만 cursor 전진. 미완 꼬리(consumed..)는 다음 tick에 그 시작부터 다시 읽는다.
    const newCursor = consumed < inc.records.length ? inc.recordOffsets[consumed] : inc.offset;
    if (newCursor === cursor) return; // 전진 없음(전부 미완) — 저장 불필요
    this.cursor = newCursor;
    try {
      await saveCursor(this.opts.workspaceRoot, this.opts.sessionId, newCursor);
    } catch (err) {
      this.log.warn(`CaptureSession cursor 저장 실패: ${String(err)}`);
    }
  }

  // 세션 종료 신호 시(규칙 3): cursor부터 다시 읽어 완료 턴 + 남은 미완 꼬리(내용 있으면)를 모두 flush.
  async finalize(): Promise<void> {
    await this.ensureLoaded();
    let inc;
    try {
      inc = await readJsonlIncrement(this.opts.transcriptPath, this.cursor as number);
    } catch (err) {
      this.log.warn(`CaptureSession finalize read 실패 (${this.opts.model}): ${String(err)}`);
      return;
    }
    const { turns, carry } = this.runReader(inc.records);
    const tail = finalizeCarry(carry, this.opts.model, this.ctx()); // 내용 없으면 null(빈-턴 skip)
    const all = tail ? [...turns, tail] : turns;
    if (all.length) await this.emit(all);
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
