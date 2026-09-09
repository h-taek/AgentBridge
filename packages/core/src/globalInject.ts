// 훅 입력을 읽는 자리. esbuild로 agentbridge-memory.js에 번들된다(옵션 나).
//
// 0.5.0 B-4에서 쿼리 추출이 여기서 빠졌다가 0.6.0 spec/03 §1-1에서 되살아났다. 훅이 매 턴
// 프롬프트를 쿼리로 삼아 장기 기억을 매칭하기 때문이다. 렌더는 돌아오지 않았다 — 훅이 싣는
// 것은 식별자와 제목뿐이고 본문은 모델이 `memory read`로 가져간다.
//
// 쿼리를 얻는 곳이 하니스마다 다르다. claude·codex는 stdin의 prompt고, agy는 stdin에 사용자
// 발화가 없어 transcript의 마지막 USER_INPUT을 읽어야 한다 (research 03 §2-3).

function parseStdin(stdinRaw: string): Record<string, unknown> | null {
  if (!stdinRaw || !stdinRaw.trim()) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(stdinRaw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  return obj as Record<string, unknown>;
}

export function extractSessionIdFromStdin(stdinRaw: string, agent: string): string {
  const rec = parseStdin(stdinRaw);
  if (!rec) return '';
  const keys =
    agent === 'agy' ? ['conversationId', 'conversation_id'] : agent === 'codex' ? ['session_id'] : [];
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

// claude·codex의 쿼리. agy는 stdin에 사용자 발화가 없으므로 여기서 빈 문자열이 나오고,
// 호출자가 transcript 쪽(extractLastUserInput)으로 간다.
export function extractPromptFromStdin(stdinRaw: string, agent: string): string {
  if (agent !== 'claude' && agent !== 'codex') return '';
  const rec = parseStdin(stdinRaw);
  const v = rec?.prompt;
  return typeof v === 'string' ? v : '';
}

// agy PreInvocation의 모델 호출 순번. 한 턴에 여러 번 뜨는 훅에서 첫 번째만 고르는 데 쓴다
// (research 03 §2-4 — 턴마다 0으로 돌아간다). 값을 못 읽으면 null이고, 그때는 게이트를
// 걸지 않는다 — 판정할 수 없다고 주입을 막으면 맥락이 통째로 사라진다.
export function extractInvocationNum(stdinRaw: string): number | null {
  const v = parseStdin(stdinRaw)?.invocationNum;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// agy transcript(jsonl)의 마지막 사용자 발화. 뒤에서부터 훑어 첫 번째로 걸리는 것을 낸다.
//
// 호출자는 파일 끝 일부만 읽어 넘긴다. 그래서 첫 줄이 중간에서 잘려 있을 수 있는데, 파싱
// 실패한 줄을 그냥 건너뛰므로 따로 다룰 것이 없다.
//
// transcriptReader/agyReader에 같은 모양의 추출이 있으나 그쪽은 턴 조립용이라 딸린 것이 많다.
// 훅 번들에 들일 무게가 아니라 여기에 작은 것을 따로 둔다.
export function extractLastUserInput(jsonlText: string): string {
  const lines = String(jsonlText || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let rec: Record<string, unknown> | null;
    try {
      const parsed: unknown = JSON.parse(line);
      rec = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      continue; // 꼬리만 읽어 잘린 줄
    }
    if (!rec || rec.type !== 'USER_INPUT' || rec.source !== 'USER_EXPLICIT') continue;
    const content = typeof rec.content === 'string' ? rec.content : '';
    const m = content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
    return (m ? m[1] : content).trim();
  }
  return '';
}
