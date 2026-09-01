// 전역 스킬 본문 (0.5.0 3단계 W4, B-5).
//
// 지시문만으로는 모델이 명령의 존재를 놓친다. 주입 텍스트 안의 한 문장이라 읽고 셸을 여는
// 단계가 하나 더 있고, B-4가 전부 모델의 자발적 호출에 걸려 있으므로 이 파일이 곧 제품 품질이다.
//
// 본문은 영어로 쓴다 — 모델 프롬프트 언어를 영어로 통일한다(훅 지시문과 같은 규칙). 사용자에게
// 내는 답은 사용자가 쓴 언어를 따르고, 그 규칙은 훅 지시문이 매 턴 싣는다.
//
// 실행 경로는 설치 시점에 박힌다. `node`로 시작하는 형태를 쓰지 않는다 — 사용자 PATH에 node가
// 없으면 모델이 명령을 부르고 조용히 실패하고, 맥락이 전부 pull인 뒤라 그 세션은 맥락이 0이 된다.
//
// `uninstall`은 싣지 않는다. 사용자 명령이지 에이전트 명령이 아니다.

export const SKILL_VERSION = '0.5.0';
export const SKILL_DIR_NAME = 'agentbridge';

// 셸에서 그대로 쓸 수 있게 공백 있는 경로를 감싼다.
function quote(p: string): string {
  return /[\s'"$`\\]/.test(p) ? `'${p.replace(/'/g, `'\\''`)}'` : p;
}

export function renderSkillMarkdown(opts: { execPath: string; cliPath: string }): string {
  const run = `${quote(opts.execPath)} ${quote(opts.cliPath)}`;
  return `---
name: agentbridge
description: >-
  Read and write the working context AgentBridge carries between coding agent
  sessions — the compacted state of this project, the raw recent conversation,
  and the user's durable preferences. Use it when the user refers to earlier
  work ("what we decided", "the thing from before", "continue"), when starting
  a task in a project you have not seen this session, when you need to know how
  this user wants things done, or when something worth remembering comes up.
  Nothing is pushed into your prompt — you must run these commands to see it.
---

# AgentBridge

AgentBridge keeps working context across sessions and across different coding
agents. None of it is injected into your prompt. If you do not run a command,
you do not have it.

Every command is:

    ${run} <command>

The environment already identifies the session — do not pass paths or ids.

## When to run what

Run these when the condition holds, not "if it seems useful":

- **Starting work on this project this session** — \`context\`
- **The user refers to something from before** ("아까 그거", "what we decided",
  "continue where we left off") — \`turns --last 5\`
- **A question about a past decision's rationale, or how this user wants things
  done** (style, tooling, workflow, conventions) — \`memory search "<query>"\`
- **A question about this repository's own rules or history** —
  \`memory project\`
- **Before recording anything** — read first, see below

\`memory search\` is the normal way to look things up. Reading everything is for
the write path only.

## Commands

    ${run} context                       compacted state of the current project
    ${run} turns --last 5                raw recent conversation
    ${run} memory search "<query>"       search both user and project knowledge
    ${run} memory user                   the user's durable preferences (summaries)
    ${run} memory user --full            ... with full bodies
    ${run} memory project                what is durable about this repository
    ${run} memory add --scope user|project --category <c> \\
        --title "..." --summary "..." --body "..."
    ${run} memory update <id> [same flags]

Categories: role, repos, domain, workflows, conventions, infra, verification.

Every item in the read output starts with its identifier
(\`<category>/<slug>\`). That identifier is what \`memory update\` takes.

## Recording something

When the user states a durable preference, a convention, or a decision that
should outlive this session:

1. Read the whole side first — \`memory user --full\` (or
   \`memory project --full\`). Not a search. You need to see everything to know
   whether this is new.
2. If nothing covers it, \`memory add\`.
3. If something covers it, \`memory update <id>\` — pass only the flags you are
   changing; the rest is carried over.

Both go to a proposal queue. The user approves them; they do not become
knowledge on their own, and they will not appear in reads until approved.

Record what would change how someone works next time. Do not record what the
repository already says, or what only matters in this conversation.

## Outside AgentBridge

These commands do nothing in a session that AgentBridge did not open — there is
no context to read there. That is expected, not an error.

<!-- @agentbridge-skill-version ${SKILL_VERSION} -->
`;
}
