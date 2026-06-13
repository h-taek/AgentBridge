// 자동제안 커서/카운터 + 커서 기반 raw 턴 수집(A안 §D.1).
// 상태 파일: <workspaceRoot>/proposal-state.json = { lastCompletedAt, compactionCount }.
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

import { readAllTurns } from './turnsStore';
import type { TurnRecord } from './shared/turns';

const CONTEXT_TURNS = 2; // 새 턴 직전 읽기전용 맥락 턴 수

type ProposalState = { lastCompletedAt: string | null; compactionCount: number };

function statePath(workspaceRoot: string): string {
  return join(workspaceRoot, 'proposal-state.json');
}

export async function readProposalState(workspaceRoot: string): Promise<ProposalState> {
  try {
    const raw = await fsp.readFile(statePath(workspaceRoot), 'utf8');
    const o = JSON.parse(raw) as Partial<ProposalState>;
    return {
      lastCompletedAt: typeof o.lastCompletedAt === 'string' ? o.lastCompletedAt : null,
      compactionCount: typeof o.compactionCount === 'number' ? o.compactionCount : 0,
    };
  } catch {
    return { lastCompletedAt: null, compactionCount: 0 };
  }
}

async function writeState(workspaceRoot: string, state: ProposalState): Promise<void> {
  await fsp.mkdir(workspaceRoot, { recursive: true });
  await fsp.writeFile(statePath(workspaceRoot), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

// 성공한 패스 후에만 호출 — 커서 전진. (compactionCount는 보존.)
export async function writeProposalCursor(workspaceRoot: string, lastCompletedAt: string): Promise<void> {
  const cur = await readProposalState(workspaceRoot);
  await writeState(workspaceRoot, { ...cur, lastCompletedAt });
}

// compaction마다 1 증가. 반환 = 증가 후 값.
export async function bumpCompactionCount(workspaceRoot: string): Promise<number> {
  const cur = await readProposalState(workspaceRoot);
  const next = cur.compactionCount + 1;
  await writeState(workspaceRoot, { ...cur, compactionCount: next });
  return next;
}

// 현재 카운터가 everyN의 배수면 true (≥1 기준). everyN<=0이면 항상 false(비활성).
export async function shouldRunProposalPass(workspaceRoot: string, everyN: number): Promise<boolean> {
  if (everyN <= 0) return false;
  const { compactionCount } = await readProposalState(workspaceRoot);
  return compactionCount > 0 && compactionCount % everyN === 0;
}

// archive의 compressed_*.jsonl에서 raw 턴만(ir_snapshot 줄 제외) 모은다.
async function readArchivedTurns(workspaceRoot: string): Promise<TurnRecord[]> {
  const dir = join(workspaceRoot, 'archive');
  let files: string[];
  try {
    files = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const out: TurnRecord[] = [];
  for (const f of files.filter((f) => f.startsWith('compressed_') && f.endsWith('.jsonl'))) {
    let raw: string;
    try {
      raw = await fsp.readFile(join(dir, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t);
        if (obj && obj.type === 'ir_snapshot') continue;       // 스냅샷 메타 줄 스킵
        if (obj && typeof obj.id === 'string') out.push(obj as TurnRecord);
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

export type CollectResult = { turns: TurnRecord[]; newCount: number; newCursor: string | null };

// 커서 이후 새 턴 + 직전 CONTEXT_TURNS개(맥락). turns.jsonl + archive 합쳐 id dedup, completedAt 정렬.
export async function collectProposalTurns(workspaceRoot: string): Promise<CollectResult> {
  const { lastCompletedAt } = await readProposalState(workspaceRoot);
  const merged = [...(await readArchivedTurns(workspaceRoot)), ...(await readAllTurns(workspaceRoot))];
  const byId = new Map<string, TurnRecord>();
  for (const t of merged) if (!byId.has(t.id)) byId.set(t.id, t);
  const all = [...byId.values()].sort((a, b) => (a.completedAt < b.completedAt ? -1 : a.completedAt > b.completedAt ? 1 : 0));

  const firstNewIdx = lastCompletedAt == null
    ? 0
    : all.findIndex((t) => t.completedAt > lastCompletedAt);
  if (firstNewIdx < 0) return { turns: [], newCount: 0, newCursor: lastCompletedAt };

  const newTurns = all.slice(firstNewIdx);
  if (newTurns.length === 0) return { turns: [], newCount: 0, newCursor: lastCompletedAt };
  const ctxStart = Math.max(0, firstNewIdx - CONTEXT_TURNS);
  const window = all.slice(ctxStart);
  return { turns: window, newCount: newTurns.length, newCursor: newTurns[newTurns.length - 1].completedAt };
}
