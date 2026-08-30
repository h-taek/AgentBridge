// 헤드리스 세션 명명(B-2 W7). 첫 턴 원문 하나로 세션 표시 이름 한 줄을 뽑는다.
// buildSessionNamePrompt = 입력 프롬프트, parseSessionName = 출력 게이트 겸 파서
// (refineDispatcher의 HeadlessValidator 형태와 맞음 — parseProposalOutput과 같은 자리).
// 실패 시 폴백(deriveSessionTitle 절단)은 sessionTitle.ts 몫이라 여기서는 다루지 않는다.

const MAX_NAME_CODEPOINTS = 20;

export type SessionNamePromptArgs = {
  userText: string;
};

export function buildSessionNamePrompt(args: SessionNamePromptArgs): string {
  return [
    '# Task: name this coding-agent session',
    '',
    'Read the first user message below and produce a short display name for this session,',
    'like a chat/tab title. Capture what the user is asking for — do not just restate it verbatim.',
    '',
    '## First user message',
    args.userText,
    '',
    '## Output format',
    '1. Respond with EXACTLY one line: the name itself. No explanation, no surrounding quotes, no trailing period.',
    `2. Keep it to at most ${MAX_NAME_CODEPOINTS} characters.`,
    '3. Write it in the SAME language the message above uses — Korean input → Korean name, English → English.',
    '',
    'Now output the name.',
  ].join('\n');
}

// 모델이 지시를 어기고 앞에 붙이는 흔한 라벨("제목:"/"이름:"/"Title:"/"Name:") 제거용.
const LABEL_PREFIX = /^(제목|이름|title|name)\s*[:：]\s*/i;

function firstNonEmptyLine(s: string): string {
  for (const line of s.split(/\r?\n/)) {
    const t = line.trim();
    if (t) return t;
  }
  return '';
}

function stripWrappingQuotes(s: string): string {
  const pairs: [string, string][] = [
    ['"', '"'],
    ["'", "'"],
    ['“', '”'], // “ ”
    ['‘', '’'], // ‘ ’
  ];
  for (const [open, close] of pairs) {
    if (s.length >= 2 && s.startsWith(open) && s.endsWith(close)) return s.slice(1, -1).trim();
  }
  return s;
}

function stripTrailingPeriod(s: string): string {
  return s.replace(/[.。]+$/, '').trim();
}

// 마침표와 따옴표는 어느 쪽이 바깥에 있든(`"이름".` 또는 `"이름."`) 걷어내야 하므로
// 변화가 없어질 때까지 번갈아 벗긴다.
function unwrap(s: string): string {
  let prev: string;
  do {
    prev = s;
    s = stripTrailingPeriod(s);
    s = stripWrappingQuotes(s);
  } while (s !== prev);
  return s;
}

export type ParseSessionNameResult = { ok: true; name: string } | { ok: false; error: string };

// 게이트 겸 파서 — HeadlessValidator({ ok, error? })에 그대로 맞는다.
export function parseSessionName(raw: string): ParseSessionNameResult {
  let s = firstNonEmptyLine(raw ?? '');
  s = s.replace(LABEL_PREFIX, '');
  s = unwrap(s);
  s = s.replace(/\s+/g, ' ').trim();
  if (s === '') return { ok: false, error: 'session name empty' };
  const points = [...s];
  if (points.length > MAX_NAME_CODEPOINTS) {
    s = points.slice(0, MAX_NAME_CODEPOINTS).join('') + '…'; // 이모지가 깨지지 않게 코드포인트 단위 절단(deriveSessionTitle과 동일 방식)
  }
  return { ok: true, name: s };
}
