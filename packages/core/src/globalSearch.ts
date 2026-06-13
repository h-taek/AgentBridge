// gc-tree resolve.ts 토큰 스코어러 이식 + 한국어 비파괴 처리(§C.2).
// 핵심: 파괴하지 말고 추가하라 — 조사 제거는 변이형으로만, 원형 보존.

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'be',
  'this', 'that', 'it', 'as', 'at', 'by', 'with',
]);

// 흔한 한국어 조사/어미 (꼬리). 화이트리스트 — 이것만 변이형 후보.
const KOREAN_PARTICLES = [
  '으로', '에서', '까지', '부터', '에게', '한테', '처럼', '보다', '마다', '조차', '밖에',
  '을', '를', '이', '가', '은', '는', '에', '의', '로', '도', '만', '과', '와', '랑', '며',
  '하다', '했다', '하는', '하고',
];

const HANGUL = /[가-힣]/;

// 유니코드 경계로 쪼갬(gc-tree). ASCII↔한글도 분리. 소문자화, 불용어/1글자 제거.
export function tokenizeRaw(text: string): string[] {
  return String(text || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .flatMap((t) => t.split(/(?<=[a-z0-9])(?=[가-힣])|(?<=[가-힣])(?=[a-z0-9])/u))
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

// 한글 토큰의 조사 변이형(원형은 별도 유지). 잔여 <2음절이면 변이형 안 만듦(단어 깨짐 방지).
function koreanVariant(token: string): string | null {
  if (!HANGUL.test(token)) return null;
  for (const p of KOREAN_PARTICLES) {
    if (token.length > p.length && token.endsWith(p)) {
      const stem = token.slice(0, token.length - p.length);
      if (stem.length >= 2) return stem; // 잔여 2음절 이상만
    }
  }
  return null;
}

// 쿼리 토큰 = 원형 + (한글 조사 변이형). 비파괴 — 원형은 항상 남는다.
export function tokenizeQuery(query: string): string[] {
  const out = new Set<string>();
  for (const tok of tokenizeRaw(query)) {
    out.add(tok);
    const v = koreanVariant(tok);
    if (v) out.add(v);
  }
  return [...out];
}
