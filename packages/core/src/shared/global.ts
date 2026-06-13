// 글로벌 컨텍스트(gc-tree) 공유 타입 — v1 단일 default 프로필.
// gc-tree 7카테고리 그대로. 'general'은 fallback일 뿐 유효 카테고리 아님.
export const GLOBAL_CATEGORIES = [
  'role', 'repos', 'domain', 'workflows', 'conventions', 'infra', 'verification',
] as const;
export type GlobalCategory = (typeof GLOBAL_CATEGORIES)[number];

// 자동제안·수동편집·승인이 쓰는 문서 입력 단위.
export type ProfileDocInput = {
  category: GlobalCategory;
  slug: string;            // 카테고리 내 leaf slug — '/'·'..'·'\\'·'.md' 금지
  title: string;
  summary: string;
  body: string;
  indexEntries: string[];  // 검색 키워드(한↔영, §C 이중언어) — 비어있으면 안 됨
  tags?: string[];
};

export type GlobalUpdateInput = { docs: ProfileDocInput[] };

// 길이 캡 — gc-tree 원본 validate엔 없던 신규(§D.4). 주입 폭주·악성 입력 방지.
export const DOC_CAPS = {
  title: 200,
  summary: 2_000,
  body: 20_000,
  indexEntries: 50,
} as const;
