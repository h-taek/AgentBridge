// turns.jsonl append-only 저장소 + 아카이브 관리.
//
// 호스트 차이 흡수: workspace 경로 계산은 호스트가 책임지고, 코어는 받은 절대경로에 대해서만
// 동작한다. 로깅도 Logger 주입.
//
// 쓰기 직렬화 (V-03): turns.jsonl의 모든 쓰기(append/rewrite/rotate)는 workspaceRoot별
// in-process mutex(withTurnsLock)를 거친다. compaction은 정제(최대 60초)는 락 밖에서 하고,
// 끝나면 dropProcessedTurns로 *현재* turns를 다시 읽어 정제한 id만 빼고 rewrite한다. 그래서
// 정제 도중 append된 turn이 옛 스냅샷 기준 rewrite에 덮어써지지 않는다. (같은 프로세스 안의
// turnRecorder append ↔ compaction rewrite 경합 차단. 두 앱 다 이 core 함수 하나를 공유.)

import { promises as fs } from 'fs';
import { join } from 'path';
import type { TurnRecord } from './shared/turns';
import { TURNS_ROTATE } from './shared/turns';
import type { Logger } from './interfaces';
import { noopLogger } from './interfaces';

// workspaceRoot별 직렬화 큐 — 이전 작업이 끝난 뒤 다음 작업을 실행. 이전 작업의 성공/실패와
// 무관하게 진행하고, 저장된 tail은 reject되지 않게 해 다음 락이 막히지 않도록 한다.
const writeChains = new Map<string, Promise<unknown>>();
function withTurnsLock<T>(workspaceRoot: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(workspaceRoot) ?? Promise.resolve();
  const result = prev.then(fn, fn);
  writeChains.set(
    workspaceRoot,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

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
  return withTurnsLock(workspaceRoot, async () => {
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.appendFile(turnsPath(workspaceRoot), serialize(turn), 'utf8');
  });
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

async function writeTurnsRaw(workspaceRoot: string, turns: TurnRecord[]): Promise<void> {
  const p = turnsPath(workspaceRoot);
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  const body = turns.map(serialize).join('');
  await fs.writeFile(tmp, body, 'utf8');
  await fs.rename(tmp, p);
}

export async function rewriteTurns(workspaceRoot: string, turns: TurnRecord[]): Promise<void> {
  return withTurnsLock(workspaceRoot, () => writeTurnsRaw(workspaceRoot, turns));
}

// 메모리 초기화(reset) 전용 — turns.jsonl 비우기. append/rotate와 같은 락을 거쳐, 마침 기록
// 중인 turn과 안 부딪히게 한다. (V-06)
export async function clearTurns(workspaceRoot: string): Promise<void> {
  return withTurnsLock(workspaceRoot, () => writeTurnsRaw(workspaceRoot, []));
}

// 메모리 초기화(reset) 전용 — archive 디렉토리 안 파일 전부 삭제(디렉토리는 유지). rotate가
// archive에 쓰는 것과 같은 락을 거쳐 직렬화. (V-06)
export async function clearArchive(workspaceRoot: string): Promise<void> {
  return withTurnsLock(workspaceRoot, async () => {
    const dir = archiveDir(workspaceRoot);
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      return; // 디렉토리 없으면 할 일 없음
    }
    await Promise.all(
      files.map(async (name) => {
        try {
          await fs.unlink(join(dir, name));
        } catch {
          /* 이미 없으면 skip */
        }
      }),
    );
  });
}

// compaction 전용 — 정제 끝난 뒤 호출. 옛 스냅샷의 `remaining`으로 통째 덮어쓰지 않고,
// 락 안에서 *현재* turns를 다시 읽어 processed id만 빼고 rewrite. 정제(락 밖, 최대 60초)
// 도중 append된 turn이 보존된다 (V-03 — turns 유실 방지).
export async function dropProcessedTurns(
  workspaceRoot: string,
  processedIds: ReadonlySet<string>,
): Promise<void> {
  return withTurnsLock(workspaceRoot, async () => {
    const current = await readAllTurns(workspaceRoot);
    const remaining = current.filter((t) => !processedIds.has(t.id));
    await writeTurnsRaw(workspaceRoot, remaining);
  });
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

  // rename+truncate는 append와 같은 락에서 — 회전 도중 append 유실 방지 (V-03 동일 경합).
  return withTurnsLock(workspaceRoot, async () => {
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
  });
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
