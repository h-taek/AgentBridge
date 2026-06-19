// SdkCapture — adapter onTurn을 turnsStore 하류에 잇는 sink. transcript를 읽는 CaptureSession 대신
// SDK 어댑터가 push하는 단일 TurnRecord를 받는다. 하류는 CaptureSession.emit과 동형:
//   dedup(결정적 id) → appendTurn → turns:updated emit → rotateIfNeeded → scheduler.checkAndRun(compaction→IR).
// scheduler 인터페이스는 CaptureSchedulerLike를 그대로 재사용(기존 CompactionScheduler가 만족).
import { appendTurn, readAllTurns, rotateIfNeeded } from '../turnsStore.js';
import type { CaptureSchedulerLike } from '../transcriptReader/manager.js';
import type { CliKind } from '../shared/cli.js';
import type { TurnRecord } from '../shared/turns.js';
import type { Logger } from '../interfaces.js';
import { noopLogger } from '../interfaces.js';

export interface SdkCaptureOptions {
  workspaceId: string;
  workspaceRoot: string;
  workspacePath: string; // 사용자의 프로젝트 cwd (compaction에 전달)
  model: CliKind;
  scheduler: CaptureSchedulerLike;
  logger?: Logger;
}

export class SdkCapture {
  private seenIds: Set<string> | null = null; // lazy: 기존 turns.jsonl id (재시작 멱등성)
  private readonly log: Logger;

  constructor(private readonly opts: SdkCaptureOptions) {
    this.log = opts.logger ?? noopLogger;
  }

  // adapter onTurn 핸들러 — 단일 완료 턴을 하류에 흘린다.
  async accept(turn: TurnRecord): Promise<void> {
    if (this.seenIds === null) {
      try {
        this.seenIds = new Set((await readAllTurns(this.opts.workspaceRoot)).map((t) => t.id));
      } catch {
        this.seenIds = new Set();
      }
    }
    if (this.seenIds.has(turn.id)) return; // 결정적 id dedup

    try {
      await appendTurn(this.opts.workspaceRoot, turn);
      this.seenIds.add(turn.id);
    } catch (err) {
      this.log.warn(`SdkCapture appendTurn 실패: ${String(err)}`);
      return;
    }

    this.opts.scheduler.events.emit('turns:updated', this.opts.workspaceId);
    try {
      await rotateIfNeeded(this.opts.workspaceRoot, { logger: this.log });
    } catch (err) {
      this.log.warn(`SdkCapture rotate 실패 (non-fatal): ${String(err)}`);
    }
    void this.opts.scheduler
      .checkAndRun({
        workspaceId: this.opts.workspaceId,
        workspaceRoot: this.opts.workspaceRoot,
        workspacePath: this.opts.workspacePath,
        activeModel: this.opts.model,
      })
      .catch((err) => this.log.warn(`SdkCapture scheduler 실패 (non-fatal): ${String(err)}`));
  }
}
