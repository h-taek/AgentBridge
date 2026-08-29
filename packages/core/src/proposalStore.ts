// 자동제안 저장소 — profiles/<id>/proposals/<id>.json. 중복 제거(기존 제안·기존 문서 대비).
// 승인 게이트(§D.5): 여기 쌓인 pending 제안을 GUI가 [승인]/[버림]. 파일 존재 = pending.
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

import { proposalsDir } from './globalPaths';
import { slugify } from './globalMarkdown';
import { writeProfileDocs } from './globalStore';
import { DOC_CAPS, PROPOSAL_CAPS, type ProposalInput, type ProposalScope, type StoredProposal } from './shared/global';

// (카테고리, 제목) 정규화 키 — 중복 판정 단일 규칙.
function dedupKey(category: string, title: string): string {
  return `${category}::${title.trim().toLowerCase()}`;
}

// dedupKey의 짧은 결정적 지문(FNV-1a, 의존성 0). 같은 dedupKey면 항상 같은 값.
function shortHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).padStart(7, '0').slice(0, 7);
}

// slugify는 특수문자를 뭉개 충돌한다(예: 'C# tips'·'C++ tips' → 둘 다 'c-tips'). dedupKey 지문을
// 붙여 파일명 충돌을 막는다 — 같은 dedupKey면 같은 id(업데이트), 다른 dedupKey면 다른 id(공존).
function proposalId(category: string, title: string): string {
  return `${category}__${slugify(title)}__${shortHash(dedupKey(category, title))}`;
}

// 승인 문서 slug(docs/<category>/<slug>.md)도 같은 충돌을 겪으므로 동일하게 지문을 붙인다.
function docSlug(category: string, title: string): string {
  return `${slugify(title)}-${shortHash(dedupKey(category, title))}`;
}

function clampLen(s: string, cap: number): string {
  return typeof s === 'string' && s.length > cap ? s.slice(0, cap) : (s || '');
}

export async function readProposals(
  globalDir: string,
  profileId: string,
  scope: ProposalScope = 'user',
): Promise<StoredProposal[]> {
  const dir = proposalsDir(globalDir, profileId, scope);
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
  scope: ProposalScope = 'user',
): Promise<WriteProposalsResult> {
  const dir = proposalsDir(globalDir, profileId, scope);
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
      // 어느 프로필로 갈지는 이미 정해졌지만, 무엇으로 판단해 여기 왔는지를 함께 남긴다 —
      // 패널이 표시하고, 나중에 재분류가 필요할 때 근거가 된다.
      ...(inp.scope ? { scope: inp.scope } : {}),
      title: clampLen(inp.title, PROPOSAL_CAPS.title),
      summary: clampLen(inp.summary, PROPOSAL_CAPS.summary),
      body: clampLen(inp.body, PROPOSAL_CAPS.body),
      confidence: typeof inp.confidence === 'number' ? Math.max(0, Math.min(1, inp.confidence)) : 0.5,
      ...(inp.indexEntries?.length ? { indexEntries: inp.indexEntries.slice(0, DOC_CAPS.indexEntries) } : {}),
    };
    await fsp.writeFile(join(dir, `${rec.id}.json`), JSON.stringify(rec, null, 2) + '\n', 'utf8');
    written.push(rec);
    n++;
  }
  return { written, skipped };
}

// ─── 승인 게이트(§D.5) — GUI가 호출 ───

// 제안 승인 → 검증 통과 시 프로필 문서로 쓰고(writeProfileDocs) 제안 파일 제거. 없으면 null.
// indexEntries는 모델이 만든 한↔영 검색어를 그대로 쓰고, 없는(옛) 제안은 제목으로 폴백(사용자가 .md로 보강 — §D.3).
export async function approveProposal(
  globalDir: string,
  profileId: string,
  proposalId: string,
  scope: ProposalScope = 'user',
): Promise<{ written: string[] } | null> {
  const all = await readProposals(globalDir, profileId, scope);
  const p = all.find((x) => x.id === proposalId);
  if (!p) return null;
  const res = await writeProfileDocs(globalDir, profileId, {
    docs: [{
      category: p.category,
      slug: docSlug(p.category, p.title),
      title: p.title,
      summary: p.summary,
      body: p.body,
      indexEntries: p.indexEntries?.length ? p.indexEntries : [p.title],
    }],
  }, scope);
  await discardProposal(globalDir, profileId, proposalId, scope);
  return { written: res.written };
}

// 제안 버리기 — 제안 파일만 제거(문서는 안 만듦). 파일 없으면 false.
export async function discardProposal(
  globalDir: string,
  profileId: string,
  proposalId: string,
  scope: ProposalScope = 'user',
): Promise<boolean> {
  const file = join(proposalsDir(globalDir, profileId, scope), `${proposalId}.json`);
  try {
    await fsp.unlink(file);
    return true;
  } catch {
    return false;
  }
}
