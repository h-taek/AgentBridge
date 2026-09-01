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

export const SKILL_VERSION = '0.5.3';
export const SKILL_DIR_NAME = 'agentbridge';

// 셸에서 그대로 쓸 수 있게 공백 있는 경로를 감싼다.
function quote(p: string): string {
  return /[\s'"$`\\]/.test(p) ? `'${p.replace(/'/g, `'\\''`)}'` : p;
}

// 모델이 실제로 치는 문자열의 앞부분. 스킬 본문과 claude의 허용 규칙(--allowedTools)이 같은
// 값을 써야 한다 — 둘이 어긋나면 모델이 부르는 족족 승인 창이 뜬다.
export function renderRunPrefix(opts: { execPath: string; cliPath: string }): string {
  return `${quote(opts.execPath)} ${quote(opts.cliPath)}`;
}

export function renderSkillMarkdown(opts: { execPath: string; cliPath: string }): string {
  const run = renderRunPrefix(opts);
  return `---
name: agentbridge
description: >-
  Use when the user refers to earlier work or an earlier session ("아까 그거",
  "what we decided", "continue where we left off"), when starting a task in a
  project not seen this session, when the answer turns on how this user works
  (style, tooling, workflow, conventions) or on this repository's own rules,
  when the user states something durable worth remembering, or when a context
  or memory command fails and the wiring may be broken.
---

# AgentBridge

AgentBridge keeps working context across sessions and across coding agents.
None of it is in your prompt. If you do not run a command, you do not have it.

Every command is:

    ${run} <command>

The environment identifies the session — do not pass paths or ids.

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

\`memory search\` is the normal lookup. Reading everything is for the write path.

## Commands

Each line is the part after the run command.

    context                       compacted state of the current project
    turns --last 5                raw recent conversation
    memory search "<query>"       search both user and project knowledge
    memory user                   the user's durable preferences (summaries)
    memory user --full            ... with full bodies
    memory project                what is durable about this repository
    memory add --scope user|project --category <c> \\
        --title "..." --summary "..." --body "..."
    memory update <id> [same flags]

Categories: role, repos, domain, workflows, conventions, infra, verification.

Every read output item starts with its identifier (\`<category>/<slug>\`) —
that is what \`memory update\` takes.

## Recording something

When the user states a durable preference, a convention, or a decision that
should outlive this session:

1. Pick the scope. One test: is this about **how the user works or who they
   are** (\`--scope user\`), or about **what this repository is** (\`--scope
   project\`) — its purpose, domain, architecture decisions, release process,
   house rules? A user fact must still read correctly inside a completely
   different project. The same category appears on both sides: a rule this
   repository enforces is project scope, a rule the user applies everywhere is
   user scope. When in doubt, prefer \`project\` — the narrower home.
2. Read that side in full — \`memory user --full\` or \`memory project --full\`.
   Not a search: you need everything to know whether this is new. Read only the
   side you picked.
3. Nothing covers it — \`memory add\`. Something covers it —
   \`memory update <id>\`, passing only the flags you are changing.

Both go to a queue the user approves. They do not appear in reads until then.

Record what would change how someone works next time — not what the repository
already says, not what only matters in this conversation.

## Outside AgentBridge

In a session AgentBridge did not open they print nothing and exit 0. Expected,
not an error.

<!-- @agentbridge-skill-version ${SKILL_VERSION} -->
`;
}
