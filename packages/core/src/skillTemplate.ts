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

export const SKILL_VERSION = '0.6.4';
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
  or memory command fails and the wiring may be broken. Also use whenever the
  user asks to run work in another agent session — "서브에이전트 띄워", "서브
  띄워서 ~하게 해", "spawn a subagent", "run this in codex/claude/agy", "get a
  second opinion from another model", "run these in parallel" — or asks about
  subagents already started ("서브 끝났어?", "보고 읽어줘", "what did it say").
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
- **The turn started with a list of matching entries** — \`memory read <id>\` for
  the ones that bear on the question. That list carries titles only; the bodies
  are not in your prompt
- **Before recording anything** — read first, see below

\`memory search\` is the normal lookup. Reading everything is for the write path.

## Commands

Each line is the part after the run command.

    context                       compacted state of the current project
    turns --last 5                raw recent conversation
    memory search "<query>"       search both user and project knowledge
    memory read <id>              one entry in full, body included
    memory user                   the user's durable preferences (summaries)
    memory user --full            ... with full bodies
    memory project                what is durable about this repository
    memory add --scope project|user --category <c> \\
        --title "..." --summary "..." --body "..."
    memory update <id> [same flags]
    memory pending                proposals waiting for approval
    memory withdraw <proposal-id> take one back
    session new [--harness claude|codex|agy]
                                  open a new main session tab — only when the
                                  user asks for a new main session
    status                        whether the wiring is alive, when a command
                                  fails

Categories: role, repos, domain, workflows, conventions, infra, verification.

### What \`turns\` and \`context\` hold

Every conversation in this project lands in one place — not just the window
you are in, but other tabs, other CLIs (claude, codex, agy) and earlier
sessions, in time order. \`turns\` is that raw record, each turn labeled with
the CLI it came from; it holds conversations you have never seen, so it is not
you re-reading your own context. \`context\` is the compacted working state (the
IR) built from it. The IR is compacted in batches, so it never holds the last
few turns — that is not staleness. \`context\` says how many turns came after
it; read those with \`turns\`.

\`turns\` and \`agent read\` are not the same. \`turns\` is every conversation in
this project; \`agent read <name>\` is one subagent you started. When the user
says to check the session conversation, that is \`turns\`.

## Subagents

If the hook says you are a subagent, skip this section — a subagent does not
start sessions.

You can run other coding agents as subagents. Each gets its own session and
tab; you give it work, it reports back, you read the report.

    agent models [--harness claude,codex,agy]
                                  models each harness has, and the efforts
                                  each model takes
    agent start --prompt "..." [--harness claude,codex,agy] [--isolate]
                [--model <name> --effort <level>]
    agent list                    the subs you started, and their state
    agent check [--wait] [--for <seconds>]
    agent read <name> [--last N] [--screen]
                                  that sub's full conversation; --screen for
                                  what its terminal shows right now
    agent diff <name> [--stat]    what that sub actually changed
    agent send <name> --prompt "..."
    agent merge <name>            put its changes into the real folder
    agent stop <name>             end it
    agent close <name>            end it and clean up what it left
    agent close --round           clean up the round: everything but the one
                                  you merged

\`agent start\` returns the names it issued — that is what the other commands
take. Default harness is claude; pass several to run the same prompt on each.

Put the whole instruction in \`--prompt\` (\`agent send\` too). Do not write it
to a file and hand the sub the path. Some models' safety classifiers rank what
arrives as the prompt above what a file says, and refuse an instruction that
came through a path. Material the work needs — a plan, a spec, the code under
review — can still be named by path; the instruction itself goes in the prompt.

\`--model\` and \`--effort\` pick the model a sub runs on. Use them when the user
names one, or when a recorded sub evaluation (see below) says which model and
effort suit this kind of work — before starting a sub the user named no model
for, run \`memory search "Sub evaluation"\`. Otherwise leave them out — the sub
runs on its harness's own settings. When you use them, run \`agent models\` first
and take both from its table: they go together, efforts differ per model, and
\`agent start\` refuses a pair the table does not list. An evaluation of a model
the table no longer lists is not evidence. When an evaluation picked the model,
tell the user in one line which entry you went by. With several harnesses, pair
each value with its harness
(\`--model claude=opus,codex=gpt-6-luna --effort claude=high,codex=xhigh\`).

\`--isolate\` gives the sub its own git worktree, so several subs can edit files
without colliding. Skip it for research or review — a fresh checkout has no
dependencies and no instruction files, and paying that cost buys nothing when
nothing is edited. Isolated subs must be closed with \`agent close\` when the
round is over; that removes the worktree and its branch and tells you how to
recover the work.

When a round is over — you picked a result, or the work is dropped — call
\`agent close --round\`. It removes every sub you started except the most
recently merged one, which stays because it is the branch you adopted and the
one you are most likely to keep working with. The next \`--round\` takes that one
too. Calling it is how the subs from a round stop accumulating.

Reviewing a sub means putting two things side by side: what it says it did
(\`agent read\`) and what actually changed (\`agent diff\`). One without the other
is not a review. For a sub that ran without \`--isolate\`, the diff is the whole
folder as it stands now — your own edits and the user's are in there too.

\`agent merge\` takes an isolated sub's changes out of its worktree and lays them
on the real folder. All of them or none — if it cannot apply cleanly, nothing is
touched and you get the list of files that clashed. It does not commit, does not
move history, and does not end the sub. Partial picks are not supported: read
both diffs and write the combination yourself.

A sub does not tell you when it is done, and once your turn ends nobody reads
its report until the user writes again. So before ending a turn, ask whether
this turn's answer needs the sub's result. If it does, first do whatever does
not depend on it, then run \`agent check --wait\` — it returns as soon as one
finishes (up to a minute, \`--for\` raises it) — and run it again while the sub
is still working. Do not end the turn saying you will read the report when it
lands; you will not see it land. End the turn without the result only when the
user said not to wait or handed off a long run, and then tell them the result
is read on their next message. The next turn tells you how many finished subs
are unread; reading a report with \`agent read\` is what clears that.

A sub can also go quiet without finishing: the user interrupted its turn, or it
is stuck waiting on something. \`check\` and the next-turn line both report those
separately from finished ones. That state is what we observed, not a verdict —
read the sub to see how far it got, then send it more instructions or close it.

"Finished" means the sub's harness ended its turn, not that the work you gave
it is done. A harness can hand the work to its own subagent and end its turn
while that runs. When a finished sub's reply is empty, \`agent read\` shows its
screen as well. When the reply says it is waiting, run
\`agent read <name> --screen\`. Read the screen before deciding the sub failed.
If it shows the sub still working or waiting, check again later instead of
closing it.

Every read output item starts with its identifier (\`<category>/<slug>\`) —
that is what \`memory update\` takes.

\`session new\` is not a subagent. It opens a separate main session with no tie to
this one — no report, no round cleanup. Use it only when the user asks for a new
main session (for example, a fresh seat to drive over remote control). For work
you hand off and review, use \`agent start\`.

### Evaluating the model a sub ran on

After reviewing a sub, ask whether its result says something about the model
and effort it ran on — not about your prompt, the environment, or the harness
(a turn that ended early, a report that did not land). Propose a record only
when one of these holds:

- you ran the same work on another model or effort and can compare them
- the same model and effort showed the same tendency a second time
- the user judged the sub's result in words about the model

One result on its own is not an evaluation. Judge from the diff and the test
results, not from the sub's report.

Keep one entry per harness and model: \`--scope user --category workflows\`,
titled \`Sub evaluation — <harness> <model>\`. If it exists, \`memory update\` it
with the new case; otherwise \`memory add\`. \`--body\` replaces the whole body,
so \`memory read\` the entry first and pass its earlier cases with the new one
added. Each case carries the date, the
model, the effort, the kind of work (implement, review, research, ...), and what
the diff and tests showed. The summary is the conclusion so far: which work
this model and effort suit, and which they do not.

## Recording something

### The bar

Record only past this bar. Check in this order.

1. Did the user set this for the future? Record it if the user asked
   you to remember it, or set it as how things should go from now on.
   The test: would the user have said it even if you had done the work
   right? A rule they chose, yes. Pointing out a slip — "why didn't you
   read the existing code?" — no. It only came up because of the slip,
   so it is not this exception, however it is phrased, "from now on"
   included. A plain request to remember stays this exception even when
   it comes with a correction. Anything else goes to 2.

2. Would a capable model know or do this without being told? Then do
   not record it, and nothing below brings it back — not even a second
   time. This covers widely known facts about languages, libraries,
   tools and standards, and good practice a model follows unprompted.
   The test: if this entry were deleted, would a capable model work any
   differently? If not, it is not worth recording. What passes is what
   a model cannot work out on its own: a choice this user made where
   several reasonable options exist, knowledge newer than or outside a
   model's training, and this project's own settings. When a general
   practice comes with a choice of the user's attached, record only the
   choice.

3. Will it still be true, and still change how work is done, in a
   different task weeks from now? Do not record:
   - how to do the task in front of you — steps, workarounds, values
     that stop mattering when this task ends
   - a correction the user made to this turn's output, once it is fixed
   - a single incident. One correction is not a rule yet. Record it when
     it comes up a second time.

Most turns have nothing worth recording. Recording nothing is the default.

### Steps

When something clears the bar:

1. Pick the scope. \`--scope\` is required. It is \`--scope project\` unless the
   user said in so many words that this applies everywhere, across projects.
   A sentence that reads as general is still project scope until the user
   says so. Sub evaluations are the one exception — they are user scope; see
   'Evaluating the model a sub ran on'.
2. Read that side in full — \`memory user --full\` or \`memory project --full\`.
   Not a search: you need everything to know whether this is new. Read only the
   side you picked.
3. Nothing covers it — \`memory add\`. Something covers it —
   \`memory update <id>\`, passing only the flags you are changing.

Both go to a queue the user approves. They do not appear in reads until then.

\`--summary\` is the conclusion — one or two sentences, what to do. \`--body\` is
the grounds: why it was decided, what it replaces, and the user's own wording
where the wording is the point. Do not paraphrase a phrasing preference.

### What counts as evidence

Weigh what you saw, in this order:

1. **What the user said.** Repetition, corrections (scope, order, wording), an
   interruption, a "do it again" — these are the signal. A correction of a slip
   against what a capable model already does is still not a rule — step 1 of
   the bar.
2. **Tool output.** What a command actually printed beats what anyone assumed.
3. **What you said.** Weakest. Your turns record what you tried, not what the
   user wants.

Throw away, first, anything that fails step 2 of the bar — what a capable model
would know or do without being told. Then: options that were discussed and not
adopted; proposals you made that the user did not take up; anything the
repository already states (its README, the code itself); anything an
instruction file that is always loaded already says (CLAUDE.md, AGENTS.md,
GEMINI.md); anything that only matters until this task ends; and a restatement of something already recorded, or a new case
of a lesson already recorded — that is \`memory update <id>\`, not a second
entry.

Record what would change how someone works next time.

### Taking a proposal back

When a proposal in the queue should not be there — wrong scope, below the
bar, a duplicate, or the user said not to keep it — run \`memory pending\`,
then \`memory withdraw <proposal-id>\`. To change a pending proposal, withdraw
it and add it again. Approved entries are not withdrawn; they change through
\`memory update <id>\`.

## Outside AgentBridge

In a session AgentBridge did not open they print nothing and exit 0. Expected,
not an error.

<!-- @agentbridge-skill-version ${SKILL_VERSION} -->
`;
}
