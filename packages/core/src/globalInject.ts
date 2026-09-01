// 훅 입력에서 세션 id를 뽑는다. esbuild로 agentbridge-memory.js에 번들된다(옵션 나).
//
// 0.5.0 B-4에서 쿼리 추출과 검색결과 렌더가 여기서 빠졌다. 훅이 나르는 것이 지시문 하나가
// 되면서 소비자가 사라졌고, 검색은 에이전트용 CLI의 `memory search`가 한다.

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
