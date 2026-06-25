// §G3 주입 측 헬퍼 — hook 입력에서 쿼리 추출 + 검색결과 teaser 렌더.
// esbuild로 agentbridge-memory.js에 번들된다(옵션 나). 검색 원본은 core 단일 소스 유지.
import type { SearchMatch } from './globalSearch';

// hook stdin(JSON)에서 현재 프롬프트 추출. claude는 `prompt`, 다른 host는 필드명이 달라
// 알려진 후보를 순서대로 시도. JSON이 아니거나 후보 없으면 '' (호출자가 turns로 폴백).
const PROMPT_FIELDS = ['prompt', 'user_prompt', 'userPrompt', 'input', 'message', 'text'];

export function extractPromptFromStdin(stdinRaw: string): string {
  if (!stdinRaw || !stdinRaw.trim()) return '';
  let obj: unknown;
  try {
    obj = JSON.parse(stdinRaw);
  } catch {
    return '';
  }
  if (!obj || typeof obj !== 'object') return '';
  const rec = obj as Record<string, unknown>;
  for (const k of PROMPT_FIELDS) {
    const v = rec[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

// 검색 쿼리 = stdin 프롬프트 우선, 없으면 마지막 사용자 턴(폴백). 둘 다 없으면 ''.
export function resolveQuery(stdinRaw: string, lastUserTurn: string): string {
  const fromStdin = extractPromptFromStdin(stdinRaw);
  if (fromStdin) return fromStdin;
  return lastUserTurn || '';
}

function truncate(s: string, n: number): string {
  if (typeof s !== 'string') return '';
  return s.length <= n ? s : s.slice(0, n) + '…';
}

// 검색 매치 → context 블록 내 '## Global memory' 섹션. 매치 없으면 '' (섹션 생략).
export function renderGlobalMatches(matches: SearchMatch[]): string {
  if (!Array.isArray(matches) || matches.length === 0) return '';
  const lines = ['## Global memory (long-term — relevant to this prompt)', ''];
  for (const m of matches) {
    const summary = m.summary ? ' — ' + truncate(m.summary, 200) : '';
    lines.push('- **' + m.title + '** (' + m.category + ')' + summary);
  }
  return lines.join('\n');
}

// hook stdin(JSON)에서 native 세션 id 추출. agy=conversationId(폴백 conversation_id),
// codex=session_id. claude(우리가 발급)·미지원 agent·JSON 아님·필드 없음 → ''.
export function extractSessionIdFromStdin(stdinRaw: string, agent: string): string {
  if (!stdinRaw || !stdinRaw.trim()) return '';
  let obj: unknown;
  try {
    obj = JSON.parse(stdinRaw);
  } catch {
    return '';
  }
  if (!obj || typeof obj !== 'object') return '';
  const rec = obj as Record<string, unknown>;
  const keys =
    agent === 'agy' ? ['conversationId', 'conversation_id'] : agent === 'codex' ? ['session_id'] : [];
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}
