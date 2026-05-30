// turns.jsonl append-only 저장소 + 아카이브 관리.
//
// 호스트 차이 흡수: workspace 경로 계산은 호스트가 책임지고, 코어는 받은 절대경로에 대해서만
// 동작한다. 로깅도 Logger 주입.
//
// 알려진 이슈 (CODE_REVIEW_2026-05-29):
//   - appendTurn은 락이 없음. compaction의 rewriteTurns와 경합 가능 — 호출자가 직렬화 필요.
//   - rotateIfNeeded와 appendTurn 간에도 경합 — 동일.

import { promises as fs } from 'fs';
import { join } from 'path';
import type { TurnRecord } from './shared/turns';
import { TURNS_ROTATE } from './shared/turns';
import type { Logger } from './interfaces';
import { noopLogger } from './interfaces';

export type TurnsStoreOptions = {
  // 압축된 아카이브(`compressed_*.jsonl`) 최대 개수. 초과분은 오래된 것부터 unlink.
  maxArchiveSnapshots: number;
  logger?: Logger;
};

function turnsPath(workspaceRoot: string): string {
  return join(workspaceRoot, 'turns.jsonl');
}

function archiveDir(workspaceRoot: string): string {
  return join(workspaceRoot, 'archive');
}

function serialize(turn: TurnRecord): string {
  return JSON.stringify(turn) + '\n';
}

function deserialize(line: string): TurnRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (!obj || typeof obj !== 'object' || typeof obj.id !== 'string') return null;
    return obj as TurnRecord;
  } catch {
    return null;
  }
}

export async function appendTurn(workspaceRoot: string, turn: TurnRecord): Promise<void> {
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.appendFile(turnsPath(workspaceRoot), serialize(turn), 'utf8');
}

export async function readAllTurns(workspaceRoot: string): Promise<TurnRecord[]> {
  const p = turnsPath(workspaceRoot);
  let raw: string;
  try {
    raw = await fs.readFile(p, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: TurnRecord[] = [];
  for (const line of raw.split('\n')) {
    const t = deserialize(line);
    if (t) out.push(t);
  }
  return out;
}

export async function rewriteTurns(workspaceRoot: string, turns: TurnRecord[]): Promise<void> {
  const p = turnsPath(workspaceRoot);
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  const body = turns.map(serialize).join('');
  await fs.writeFile(tmp, body, 'utf8');
  await fs.rename(tmp, p);
}

// 2-phase commit: archive를 .tmp로 먼저 쓰고, turns.jsonl rewrite 성공 후 commitArchive() 호출.
// 실패 시 abortArchive()로 tmp 삭제. archive와 turns.jsonl 양쪽에 동일 데이터가 남는 실패 모드를
// 방지한다.
export type StagedArchive = { archivePath: string; tmpPath: string };

export async function stageCompactedTurns(
  workspaceRoot: string,
  processed: TurnRecord[],
  irSnapshot: unknown,
): Promise<StagedArchive> {
  const dir = archiveDir(workspaceRoot);
  await fs.mkdir(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const archivePath = join(dir, `compressed_${ts}.jsonl`);
  const tmpPath = `${archivePath}.${process.pid}.tmp`;
  const lines: string[] = [
    JSON.stringify({ type: 'ir_snapshot', archivedAt: new Date().toISOString(), ir: irSnapshot }),
  ];
  for (const t of processed) lines.push(JSON.stringify(t));
  await fs.writeFile(tmpPath, lines.join('\n') + '\n', 'utf8');
  return { archivePath, tmpPath };
}

export async function commitArchive(
  staged: StagedArchive,
  opts: TurnsStoreOptions,
): Promise<void> {
  await fs.rename(staged.tmpPath, staged.archivePath);
  await pruneOldArchives(staged.archivePath, opts);
}

async function pruneOldArchives(
  latestArchivePath: string,
  opts: TurnsStoreOptions,
): Promise<void> {
  const log = opts.logger ?? noopLogger;
  const dir = join(latestArchivePath, '..');
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return;
  }
  const snapshots = files
    .filter((f) => f.startsWith('compressed_') && f.endsWith('.jsonl'))
    .sort()
    .reverse();
  if (snapshots.length <= opts.maxArchiveSnapshots) return;
  const toDelete = snapshots.slice(opts.maxArchiveSnapshots);
  for (const name of toDelete) {
    try {
      await fs.unlink(join(dir, name));
    } catch (err) {
      log.warn(
        `turnsStore: prune archive failed for ${name} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (toDelete.length > 0) {
    log.log(
      `turnsStore: pruned ${toDelete.length} archive snapshot(s), keeping ${opts.maxArchiveSnapshots}`,
    );
  }
}

export async function abortArchive(staged: StagedArchive): Promise<void> {
  try {
    await fs.unlink(staged.tmpPath);
  } catch {
    /* already gone */
  }
}

export async function rotateIfNeeded(workspaceRoot: string, opts?: { logger?: Logger }): Promise<boolean> {
  const log = opts?.logger ?? noopLogger;
  const p = turnsPath(workspaceRoot);
  let stat: { size: number };
  try {
    stat = await fs.stat(p);
  } catch {
    return false;
  }
  let needsRotate = stat.size >= TURNS_ROTATE.maxBytes;
  if (!needsRotate && TURNS_ROTATE.maxRecords > 0) {
    try {
      const raw = await fs.readFile(p, 'utf8');
      let count = 0;
      for (const line of raw.split('\n')) {
        if (line.trim().length > 0) count++;
      }
      if (count >= TURNS_ROTATE.maxRecords) needsRotate = true;
    } catch {
      /* ignore */
    }
  }
  if (!needsRotate) return false;

  const dir = archiveDir(workspaceRoot);
  await fs.mkdir(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const archivePath = join(dir, `turns_${ts}.jsonl.archive`);
  try {
    await fs.rename(p, archivePath);
    await fs.writeFile(p, '', 'utf8');
    log.log(`turnsStore: rotated ${p} → ${archivePath}`);
    return true;
  } catch {
    return false;
  }
}

export type ArchiveSnapshotMeta = {
  archivePath: string;
  archivedAt: string;
  updatedAt: string;
  intentGoal: string;
  counts: { decisions: number; files: number; commands: number; tests: number; pending: number };
};

export async function listArchives(
  workspaceRoot: string,
  opts: TurnsStoreOptions,
): Promise<ArchiveSnapshotMeta[]> {
  const log = opts.logger ?? noopLogger;
  const dir = archiveDir(workspaceRoot);
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const snapshots = files
    .filter((f) => f.startsWith('compressed_') && f.endsWith('.jsonl'))
    .sort()
    .reverse();
  if (snapshots.length > opts.maxArchiveSnapshots) {
    for (const name of snapshots.slice(opts.maxArchiveSnapshots)) {
      try {
        await fs.unlink(join(dir, name));
      } catch {
        /* ignore */
      }
    }
    log.log(
      `turnsStore: listArchives pruned to ${opts.maxArchiveSnapshots} (was ${snapshots.length})`,
    );
  }
  const results: ArchiveSnapshotMeta[] = [];
  for (const f of snapshots.slice(0, opts.maxArchiveSnapshots)) {
    const filePath = join(dir, f);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const firstLine = raw.split('\n')[0];
      const meta = JSON.parse(firstLine) as {
        type?: string;
        archivedAt?: string;
        ir?: Record<string, unknown>;
      };
      if (meta.type !== 'ir_snapshot' || !meta.ir) continue;
      const ir = meta.ir as {
        meta?: { updatedAt?: string };
        intent?: { goal?: string };
        decisions?: unknown[];
        files?: unknown[];
        commands?: unknown[];
        tests?: unknown[];
        pending?: unknown[];
      };
      results.push({
        archivePath: filePath,
        archivedAt: meta.archivedAt ?? '',
        updatedAt: ir.meta?.updatedAt ?? meta.archivedAt ?? '',
        intentGoal: ir.intent?.goal ?? '',
        counts: {
          decisions: ir.decisions?.length ?? 0,
          files: ir.files?.length ?? 0,
          commands: ir.commands?.length ?? 0,
          tests: ir.tests?.length ?? 0,
          pending: ir.pending?.length ?? 0,
        },
      });
    } catch {
      /* skip corrupt */
    }
  }
  return results;
}

export function sumBytes(turns: TurnRecord[]): number {
  let total = 0;
  for (const t of turns) total += t.userBytes + t.assistantBodyBytes;
  return total;
}
