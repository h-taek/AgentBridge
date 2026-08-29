// 자동제안 추출 프롬프트(§D.1). 입력 = raw 넓은 창(A안) + 기존 프로필 인덱스(중복방지).
// 본문 영어(LLM 일관성). probe 검증: 느슨한 정의는 ~1/3이 단기 기억으로 누수 → 제외목록·판별테스트 필수.
import type { TurnRecord } from './shared/turns';

const CATEGORY_GUIDE = [
  '## Categories (use exactly one of these as `category`)',
  '- role — who the user is, their expertise, durable working-style preferences',
  '- repos — a project treated as a long-term, recurring part of the work: what it is, who it serves, how it is deployed',
  '- domain — domain knowledge and vocabulary: either what the USER carries between projects, or what this project\'s subject matter requires',
  '- workflows — how the user likes to work (process, sequencing, review habits)',
  '- conventions — coding/style/commit conventions the user consistently applies',
  '- infra — tools, services, environments, credentials locations (NOT secrets themselves)',
  '- verification — how the user wants work checked (test commands, acceptance bars)',
].join('\n');

const DISCRIMINATOR = [
  '## What counts as durable (the bar — apply strictly)',
  'Test 1 decides whether to keep a candidate at all:',
  '1. Time: "Would this still be true and useful next month, in a later session?"',
  '   If it is only true *right now* or only inside one task, it FAILS — drop it.',
  '',
  'Test 2 decides where a kept candidate goes — it never drops anything:',
  '2. User vs project: "Is this about HOW the user works / who they are, or about WHAT this project is?"',
  '   The first is `"scope": "user"`. The second is `"scope": "project"`.',
  '   A user fact should still read correctly inside a completely different project.',
  '   A project fact is about this repository and belongs with it — its purpose, its domain,',
  '   its architecture decisions, its deployment and release process, its house rules.',
  '   The same category can appear on both sides: a rule this project enforces is project scope,',
  '   a rule the user applies everywhere is user scope.',
  '',
  '### Exclude (these are NOT durable knowledge — never propose, in either scope)',
  '1. Code implementation details (function names, file contents, current directory layout).',
  '2. Current work state (what is being done now, this task\'s in-progress choices).',
  '3. Time-bound facts ("the build is broken", "waiting on PR #5", "today we...").',
  '4. Incidental trivia from an unrelated task.',
  '',
  'When in doubt about Test 1, DROP it. A missed durable fact is cheap; a polluted profile is expensive.',
  'When in doubt about Test 2, prefer `"scope": "project"` — a fact tied to this repository is the',
  'narrower, safer home.',
].join('\n');

// IR 정제(irModule/prompt.ts)의 LANGUAGE_RULE과 동형 — 프롬프트 본문은 영어지만 *출력 텍스트
// 필드*는 사용자 언어를 따라가야 한다. 이 규칙이 없으면 한국어 대화에도 영어 제안이 나온다.
const LANGUAGE_RULE = [
  '## Language',
  'The output text fields `title`, `summary`, `body` must be written in **the same language the user uses in the conversation turns above** — Korean conversation → Korean text, English → English. Mixed-language sessions follow the *most recent* user turn.',
  '`category` (one of the 7 enums above), `scope` (`user` or `project`) and `confidence` (number) stay as-is — do not translate them.',
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
    'Two kinds of facts are worth keeping, and each has its own home. Facts about the USER — who they',
    'are and how they work — carry across every project. Facts about THIS PROJECT — what it is, what it',
    'decided, how it is built and released — belong with this repository. Tag each one with `scope` so',
    'it lands in the right place. What both kinds share is that they outlive the current task.',
    '',
    CATEGORY_GUIDE,
    '',
    DISCRIMINATOR,
    '',
    '## Already-known entries across both profiles (do NOT re-propose these or close paraphrases)',
    indexBody,
    '',
    `## Conversation turns to analyze (${args.turns.length}, oldest first)`,
    turnsBody,
    '',
    LANGUAGE_RULE,
    '',
    '## Output format',
    '1. Respond with EXACTLY one JSON array. No prose, no code fences — start with `[` and end with `]`.',
    '2. Each element: { "category": <one of the 7>, "scope": "user" | "project", "title": string, "summary": string (1 line), "body": string (1-3 sentences), "confidence": number 0..1, "indexEntries": string[] }.',
    '   `indexEntries`: 4-10 search keywords a *future* question (asked with DIFFERENT words) might use to retrieve this fact. Include synonyms and BOTH Korean and English forms, e.g. ["배포", "deploy", "릴리스", "release"]. Retrieval-only — never shown to the user, so they do NOT follow the user-language rule above.',
    '3. If nothing durable is present, output `[]`. Do not invent. Prefer fewer, high-confidence items.',
    '',
    'Now output the JSON array.',
  ].join('\n');
}
