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
