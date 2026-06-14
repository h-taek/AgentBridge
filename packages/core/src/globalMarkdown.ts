import { GLOBAL_CATEGORIES } from './shared/global';

// gc-tree markdown.ts 이식(MIT). profiles 모델 + 한국어 slug로 변경.
// 문서 포맷: # 제목 / ## Summary / [## Tags] / [## Index Entries] / ## Details.

// gc-tree 원본 slugify는 [^a-z0-9]+ → 한글이 통째로 사라짐. 한국어 코퍼스라 한글 보존.
export function slugify(value: string): string {
  const s = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s || 'doc';
}

function normalizeBody(raw: string, title: string): string {
  let s = raw.trim();
  const titleLine = `# ${title.trim()}`;
  if (s.startsWith(titleLine)) s = s.slice(titleLine.length).trimStart();
  if (s.startsWith('## Summary')) {
    const next = s.match(/\n(?=## )/);
    s = next ? s.slice(next.index!).trimStart() : '';
  }
  return s;
}

export function renderDocMarkdown(doc: {
  title: string;
  summary: string;
  body: string;
  indexEntries: string[];
  tags?: string[];
}): string {
  const summary = String(doc.summary || '').trim();
  if (!summary) throw new Error('summary is required for every durable doc');
  const body = normalizeBody(String(doc.body || ''), doc.title);
  const entries = [...new Set(doc.indexEntries.map((e) => String(e || '').trim()).filter(Boolean))];
  return [
    `# ${doc.title.trim()}`,
    '',
    '## Summary',
    '',
    summary,
    '',
    ...(doc.tags && doc.tags.length > 0 ? ['## Tags', '', ...doc.tags.map((t) => `- ${t}`), ''] : []),
    ...(entries.length > 0 ? ['## Index Entries', '', ...entries.map((e) => `- ${e}`), ''] : []),
    '## Details',
    '',
    body || '(no details yet)',
    '',
  ].join('\n');
}

export function extractTitle(markdown: string): string {
  return String(markdown || '').match(/^#\s+(.+)$/m)?.[1]?.trim() || '';
}
export function extractSummary(markdown: string): string {
  return String(markdown || '').match(/## Summary\s+([\s\S]*?)(?:\n## |$)/)?.[1]?.trim() || '';
}
export function extractIndexEntries(markdown: string): string[] {
  const m = String(markdown || '').match(/## Index Entries\s+([\s\S]*?)(?:\n## |$)/);
  if (!m?.[1]) return [];
  return m[1]
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim())
    .filter(Boolean);
}

const CATEGORY_LABELS: Record<string, string> = {
  role: 'Role', repos: 'Repos', domain: 'Domain', workflows: 'Workflows',
  conventions: 'Conventions', infra: 'Infra', verification: 'Verification', general: 'General',
};
const CATEGORY_ORDER = [...GLOBAL_CATEGORIES, 'general'];

// gc-tree renderIndexMarkdown 이식 — gc-branch 헤더 제거, profile 모델로.
export function renderIndexMarkdown(input: {
  profileId: string;
  docs: Array<{ category: string; label: string; path: string }>;
}): string {
  const lines = ['# gc-tree global context index', '', `- profile: ${input.profileId}`, ''];
  if (input.docs.length === 0) {
    lines.push('- No durable docs yet.', '');
    return lines.join('\n');
  }
  const byCategory = new Map<string, Map<string, string[]>>();
  for (const doc of input.docs) {
    const cat = doc.category || 'general';
    if (!byCategory.has(cat)) byCategory.set(cat, new Map());
    const byPath = byCategory.get(cat)!;
    if (!byPath.has(doc.path)) byPath.set(doc.path, []);
    const label = doc.label.trim();
    if (label && !byPath.get(doc.path)!.includes(label)) byPath.get(doc.path)!.push(label);
  }
  const cats = [...byCategory.keys()].sort((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a);
    const bi = CATEGORY_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  for (const cat of cats) {
    lines.push(`## ${CATEGORY_LABELS[cat] || cat}`, '');
    const byPath = byCategory.get(cat)!;
    for (const [path, labels] of [...byPath.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`- ${path}`);
      for (const label of labels) lines.push(`  - ${label}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
