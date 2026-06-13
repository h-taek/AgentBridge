// gc-tree update.ts validateContextUpdateInput 이식.
// 변경: category 필수(7중 하나), slug = 카테고리 내 leaf(슬래시 금지), 길이캡 신규.
import { GLOBAL_CATEGORIES, DOC_CAPS, type GlobalUpdateInput } from './shared/global';

const CATS = new Set<string>(GLOBAL_CATEGORIES);
const ROOT_KEYS = new Set(['docs']);
const DOC_KEYS = new Set(['category', 'slug', 'title', 'summary', 'body', 'indexEntries', 'tags']);
const LEGACY_HINTS: Record<string, string> = {
  content: 'use `body` + put search terms in `indexEntries`',
  path: 'use `category` + `slug`',
  id: 'use `category` + `slug`',
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function unknownKeys(rec: Record<string, unknown>, allowed: Set<string>): string[] {
  return Object.keys(rec).filter((k) => !allowed.has(k));
}
function reqStr(rec: Record<string, unknown>, key: string, subject: string, cap: number): string {
  const v = rec[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`Invalid global update: ${subject}.${key} must be a non-empty string.`);
  }
  if (v.length > cap) throw new Error(`Invalid global update: ${subject}.${key} exceeds ${cap} chars.`);
  return v.trim();
}

function validateSlug(slug: string, subject: string): void {
  if (slug.endsWith('.md')) throw new Error(`Invalid global update: ${subject}.slug must omit ".md".`);
  if (slug.startsWith('/') || slug.includes('\\') || slug.includes('/') || slug.split('/').includes('..') || slug.includes('..')) {
    throw new Error(`Invalid global update: ${subject}.slug must be a single leaf without "/", "\\", "..", or absolute path.`);
  }
}
function validateBody(body: string, subject: string): void {
  if (/^\s*#\s+/.test(body)) throw new Error(`Invalid global update: ${subject}.body must not include the top-level markdown title; use the title field.`);
  if (/^## Summary\b/m.test(body)) throw new Error(`Invalid global update: ${subject}.body must not include ## Summary; use the summary field.`);
  if (/^## Index Entries\b/m.test(body)) throw new Error(`Invalid global update: ${subject}.body must not include ## Index Entries; use the indexEntries array.`);
}

export function validateGlobalUpdateInput(input: unknown): asserts input is GlobalUpdateInput {
  if (!isRecord(input)) throw new Error('Invalid global update: root must be an object with docs[].');
  const extra = unknownKeys(input, ROOT_KEYS);
  if (extra.length) throw new Error(`Invalid global update: unsupported root field(s): ${extra.join(', ')}.`);
  if (!Array.isArray(input.docs) || input.docs.length === 0) {
    throw new Error('Invalid global update: docs must be a non-empty array.');
  }
  input.docs.forEach((doc, i) => {
    const subject = `docs[${i}]`;
    if (!isRecord(doc)) throw new Error(`Invalid global update: ${subject} must be an object.`);
    const extraKeys = unknownKeys(doc, DOC_KEYS);
    if (extraKeys.length) {
      const hints = extraKeys.map((k) => LEGACY_HINTS[k]).filter(Boolean);
      const suffix = hints.length ? ` ${[...new Set(hints)].join('; ')}.` : '';
      throw new Error(`Invalid global update: ${subject} has unsupported field(s): ${extraKeys.join(', ')}.${suffix}`);
    }
    reqStr(doc, 'title', subject, DOC_CAPS.title);
    const slug = reqStr(doc, 'slug', subject, 200);
    reqStr(doc, 'summary', subject, DOC_CAPS.summary);
    const body = reqStr(doc, 'body', subject, DOC_CAPS.body);
    const category = reqStr(doc, 'category', subject, 50);
    if (!CATS.has(category)) {
      throw new Error(`Invalid global update: ${subject}.category must be one of ${[...CATS].join(', ')}.`);
    }
    const entries = doc.indexEntries;
    if (!Array.isArray(entries) || entries.some((e) => typeof e !== 'string') || entries.map((e) => (e as string).trim()).filter(Boolean).length === 0) {
      throw new Error(`Invalid global update: ${subject}.indexEntries must be a non-empty array of search terms.`);
    }
    if (entries.length > DOC_CAPS.indexEntries) {
      throw new Error(`Invalid global update: ${subject}.indexEntries exceeds ${DOC_CAPS.indexEntries} entries.`);
    }
    if (doc.tags !== undefined && (!Array.isArray(doc.tags) || doc.tags.some((t) => typeof t !== 'string'))) {
      throw new Error(`Invalid global update: ${subject}.tags must be an array of strings when provided.`);
    }
    validateSlug(slug, subject);
    validateBody(body, subject);
  });
}
