// 자동제안 저장소 — profiles/<id>/proposals/<id>.json. 중복 제거(기존 제안·기존 문서 대비).
// 승인 게이트(§D.5): 여기 쌓인 pending 제안을 GUI가 [승인]/[버림]. 파일 존재 = pending.
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

import { proposalsDir } from './globalPaths';
import { slugify } from './globalMarkdown';
import { PROPOSAL_CAPS, type ProposalInput, type StoredProposal } from './shared/global';

// (카테고리, 제목) 정규화 키 — 중복 판정 단일 규칙.
function dedupKey(category: string, title: string): string {
  return `${category}::${title.trim().toLowerCase()}`;
}

function proposalId(category: string, title: string): string {
  return `${category}__${slugify(title) || 'untitled'}`;
}

function clampLen(s: string, cap: number): string {
  return typeof s === 'string' && s.length > cap ? s.slice(0, cap) : (s || '');
}

export async function readProposals(globalDir: string, profileId: string): Promise<StoredProposal[]> {
  const dir = proposalsDir(globalDir, profileId);
  let files: string[];
  try {
    files = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const out: StoredProposal[] = [];
  for (const f of files.filter((f) => f.endsWith('.json')).sort()) {
    try {
      const raw = await fsp.readFile(join(dir, f), 'utf8');
      const obj = JSON.parse(raw) as StoredProposal;
      if (obj && typeof obj.title === 'string' && typeof obj.category === 'string') out.push(obj);
    } catch {
      /* skip corrupt */
    }
  }
  return out;
}

export type WriteProposalsResult = { written: StoredProposal[]; skipped: ProposalInput[] };

// 입력 제안들을 중복 제거 후 저장. existingDocTitles = 이미 프로필 문서로 존재하는 (category,title).
export async function writeProposals(
  globalDir: string,
  profileId: string,
  inputs: ProposalInput[],
  opts: { existingDocTitles: { category: string; title: string }[] },
): Promise<WriteProposalsResult> {
  const dir = proposalsDir(globalDir, profileId);
  await fsp.mkdir(dir, { recursive: true });

  const seen = new Set<string>();
  for (const p of await readProposals(globalDir, profileId)) seen.add(dedupKey(p.category, p.title));
  for (const d of opts.existingDocTitles) seen.add(dedupKey(d.category, d.title));

  const written: StoredProposal[] = [];
  const skipped: ProposalInput[] = [];
  let n = 0;
  for (const inp of inputs) {
    if (n >= PROPOSAL_CAPS.maxPerPass) { skipped.push(inp); continue; }
    const key = dedupKey(inp.category, inp.title);
    if (seen.has(key)) { skipped.push(inp); continue; }
    seen.add(key);
    const rec: StoredProposal = {
      id: proposalId(inp.category, inp.title),
      createdAt: new Date().toISOString(),
      category: inp.category,
      title: clampLen(inp.title, PROPOSAL_CAPS.title),
      summary: clampLen(inp.summary, PROPOSAL_CAPS.summary),
      body: clampLen(inp.body, PROPOSAL_CAPS.body),
      confidence: typeof inp.confidence === 'number' ? Math.max(0, Math.min(1, inp.confidence)) : 0.5,
    };
    await fsp.writeFile(join(dir, `${rec.id}.json`), JSON.stringify(rec, null, 2) + '\n', 'utf8');
    written.push(rec);
    n++;
  }
  return { written, skipped };
}
