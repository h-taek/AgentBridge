// 헤드리스 제안 출력(JSON 배열) 추출·검증. parse.ts의 IR 파서와 같은 방어 전략:
// fence/산문 제거 → 첫 balanced 배열 추출 → 항목별 강제 변환 + 유효 카테고리·제목 필수.
import { GLOBAL_CATEGORIES, type GlobalCategory, type ProposalInput } from './shared/global';

const CATEGORY_SET = new Set<string>(GLOBAL_CATEGORIES);

function stripCodeFence(s: string): string {
  const m = s.match(/```(?:json|javascript|js)?\s*\n?([\s\S]*?)\n?```/i);
  return m ? m[1].trim() : s.trim();
}

// 첫 번째 balanced [ ... ] 배열 추출(문자열 안 괄호 무시). 없으면 null.
function extractFirstBalancedArray(s: string): string | null {
  const start = s.indexOf('[');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}

function asStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function asConfidence(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5;
}

export type ParseProposalResult =
  | { ok: true; proposals: ProposalInput[]; warnings: string[] }
  | { ok: false; error: string };

export function parseProposalOutput(assistantText: string): ParseProposalResult {
  const text = (assistantText ?? '').trim();
  if (text.length === 0) return { ok: false, error: 'proposal response empty' };
  const candidate = stripCodeFence(text);
  const arrStr = extractFirstBalancedArray(candidate) ?? candidate;
  let raw: unknown;
  try {
    raw = JSON.parse(arrStr);
  } catch (err) {
    return { ok: false, error: `JSON parse failed: ${(err as Error).message}` };
  }
  if (!Array.isArray(raw)) return { ok: false, error: 'proposal output is not an array' };

  const warnings: string[] = [];
  const proposals: ProposalInput[] = [];
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const category = asStr(o.category).trim();
    const title = asStr(o.title).trim();
    const body = asStr(o.body).trim();
    let summary = asStr(o.summary).trim();
    if (!CATEGORY_SET.has(category)) { warnings.push(`dropped: bad category "${category}"`); continue; }
    if (!title) { warnings.push('dropped: empty title'); continue; }
    // 빈 summary 처리: body까지 비면 내용 없는 껍데기라 버리고, body가 있으면 title로 summary를 채워 살린다.
    // (summary는 승인 검증에서 필수라, 빈 채로 저장하면 [승인]이 조용히 막힌다.)
    if (!summary) {
      if (!body) { warnings.push('dropped: empty summary and body'); continue; }
      summary = title;
    }
    proposals.push({
      category: category as GlobalCategory,
      title,
      summary,
      body,
      confidence: asConfidence(o.confidence),
    });
  }
  return { ok: true, proposals, warnings };
}
