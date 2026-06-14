// 자동제안 추출 프롬프트(§D.1). 입력 = raw 넓은 창(A안) + 기존 프로필 인덱스(중복방지).
// 본문 영어(LLM 일관성). probe 검증: 느슨한 정의는 ~1/3이 단기 기억으로 누수 → 제외목록·판별테스트 필수.
import type { TurnRecord } from './shared/turns';

const CATEGORY_GUIDE = [
  '## Categories (use exactly one of these as `category`)',
  '- role — who the user is, their expertise, durable working-style preferences',
  '- repos — repositories/projects the user works on long-term',
  '- domain — domain/product knowledge that outlives a single task',
  '- workflows — how the user likes to work (process, sequencing, review habits)',
  '- conventions — coding/style/commit conventions the user consistently applies',
  '- infra — tools, services, environments, credentials locations (NOT secrets themselves)',
  '- verification — how the user wants work checked (test commands, acceptance bars)',
].join('\n');

const DISCRIMINATOR = [
  '## What counts as durable (the bar — apply strictly)',
  'Ask for each candidate: "Would this still be useful next month, to a *different* agent in a *different* repo?"',
  'If it is only true *inside this codebase* or *right now*, it FAILS — do not propose it.',
  '',
  '### Exclude (these are NOT durable knowledge — never propose)',
  '1. Code implementation details (function names, file contents, this repo\'s structure).',
  '2. Current work state or decisions (what is being done now, this task\'s choices).',
  '3. Time-bound facts ("the build is broken", "waiting on PR #5", "today we...").',
  '4. Incidental trivia from an unrelated task.',
  '',
  'When in doubt, DROP it. A missed durable fact is cheap; a polluted profile is expensive.',
].join('\n');

function formatTurn(t: TurnRecord, i: number): string {
  const lines = [
    `### Turn ${i + 1} (${t.model}, ${t.completedAt})`,
    'user:', t.user || '(empty)',
    'assistant:', t.assistantBody || '(no body)',
  ];
  if (t.toolCalls?.length) {
    lines.push('toolCalls:');
    for (const c of t.toolCalls) lines.push(`- ${c.tool}(${c.arg})${c.summary ? ' — ' + c.summary : ''}`);
  }
  return lines.join('\n');
}

export type ProposalPromptArgs = {
  turns: TurnRecord[];
  existingIndex: { category: string; title: string }[];
};

export function buildProposalPrompt(args: ProposalPromptArgs): string {
  const turnsBody = args.turns.length
    ? args.turns.map((t, i) => formatTurn(t, i)).join('\n\n')
    : '(no turns to analyze)';
  const indexBody = args.existingIndex.length
    ? args.existingIndex.map((e) => `- [${e.category}] ${e.title}`).join('\n')
    : '(profile is empty)';
  return [
    '# Task: extract durable, long-term knowledge from a coding-agent conversation',
    '',
    'You are analyzing raw conversation turns to find facts worth remembering ACROSS sessions and repos',
    '(a passive long-term memory, like ChatGPT/Claude memory). You are NOT summarizing the current task.',
    '',
    CATEGORY_GUIDE,
    '',
    DISCRIMINATOR,
    '',
    '## Already-known profile entries (do NOT re-propose these or close paraphrases)',
    indexBody,
    '',
    `## Conversation turns to analyze (${args.turns.length}, oldest first)`,
    turnsBody,
    '',
    '## Output format',
    '1. Respond with EXACTLY one JSON array. No prose, no code fences — start with `[` and end with `]`.',
    '2. Each element: { "category": <one of the 7>, "title": string, "summary": string (1 line), "body": string (1-3 sentences), "confidence": number 0..1 }.',
    '3. If nothing durable is present, output `[]`. Do not invent. Prefer fewer, high-confidence items.',
    '',
    'Now output the JSON array.',
  ].join('\n');
}
