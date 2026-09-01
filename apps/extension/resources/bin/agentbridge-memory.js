#!/usr/bin/env node
// @agentbridge-helper-version 0.6.0
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// packages/core/src/interfaces.ts
var init_interfaces = __esm({
  "packages/core/src/interfaces.ts"() {
    "use strict";
  }
});

// packages/core/src/sessionFileWatcher.ts
var init_sessionFileWatcher = __esm({
  "packages/core/src/sessionFileWatcher.ts"() {
    "use strict";
  }
});

// packages/core/src/cliAdapter/turnSignal.ts
function resolveTurnSignalFile(workspaceDir, sessionId) {
  return (0, import_path.join)(workspaceDir, "sessions", sessionId, TURN_SIGNAL_FILENAME);
}
function str(v) {
  return typeof v === "string" && v.trim() ? v : "";
}
function parseTurnSignal(raw) {
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj;
  const agent = str(o.agent);
  if (agent !== "claude" && agent !== "codex" && agent !== "agy") return null;
  const event = str(o.event);
  if (!event) return null;
  const agentId = str(o.agentId);
  if (agentId) return null;
  const at = typeof o.at === "number" && Number.isFinite(o.at) ? o.at : 0;
  return {
    agent,
    event,
    sessionId: str(o.sessionId),
    transcriptPath: str(o.transcriptPath),
    complete: o.complete === true,
    terminationReason: str(o.terminationReason) || void 0,
    error: str(o.error) || void 0,
    at
  };
}
async function readTurnSignal(signalFilePath) {
  let raw;
  try {
    raw = await import_fs.promises.readFile(signalFilePath, "utf8");
  } catch {
    return null;
  }
  return parseTurnSignal(raw);
}
var import_fs, import_path, TURN_SIGNAL_FILENAME;
var init_turnSignal = __esm({
  "packages/core/src/cliAdapter/turnSignal.ts"() {
    "use strict";
    import_fs = require("fs");
    import_path = require("path");
    init_interfaces();
    init_sessionFileWatcher();
    TURN_SIGNAL_FILENAME = "turn-signal.json";
  }
});

// packages/core/src/agent/reportState.ts
var reportState_exports = {};
__export(reportState_exports, {
  REPORT_READ_FILENAME: () => REPORT_READ_FILENAME,
  isUnread: () => isUnread,
  listUnread: () => listUnread,
  markReported: () => markReported,
  readReportReadAt: () => readReportReadAt,
  resolveReportReadFile: () => resolveReportReadFile
});
function resolveReportReadFile(workspaceDir, sessionId) {
  return (0, import_path2.join)(workspaceDir, "sessions", sessionId, REPORT_READ_FILENAME);
}
async function readReportReadAt(workspaceDir, sessionId) {
  let raw;
  try {
    raw = await import_fs2.promises.readFile(resolveReportReadFile(workspaceDir, sessionId), "utf8");
  } catch {
    return 0;
  }
  try {
    const obj = JSON.parse(raw);
    return typeof obj.at === "number" && Number.isFinite(obj.at) ? obj.at : 0;
  } catch {
    return 0;
  }
}
async function markReported(workspaceDir, sessionId, at = Date.now()) {
  const target = resolveReportReadFile(workspaceDir, sessionId);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await import_fs2.promises.mkdir((0, import_path2.join)(workspaceDir, "sessions", sessionId), { recursive: true });
  await import_fs2.promises.writeFile(tmp, JSON.stringify({ at }), "utf8");
  await import_fs2.promises.rename(tmp, target);
}
async function isUnread(workspaceDir, sessionId) {
  const signal = await readTurnSignal(resolveTurnSignalFile(workspaceDir, sessionId));
  if (!signal || !signal.complete) return false;
  const readAt = await readReportReadAt(workspaceDir, sessionId);
  return signal.at > readAt;
}
async function listUnread(workspaceDir, sessionIds) {
  const flags = await Promise.all(sessionIds.map((id) => isUnread(workspaceDir, id)));
  return sessionIds.filter((_, i) => flags[i]);
}
var import_fs2, import_path2, REPORT_READ_FILENAME;
var init_reportState = __esm({
  "packages/core/src/agent/reportState.ts"() {
    "use strict";
    import_fs2 = require("fs");
    import_path2 = require("path");
    init_turnSignal();
    REPORT_READ_FILENAME = "report-read.json";
  }
});

// packages/core/src/globalInject.ts
var globalInject_exports = {};
__export(globalInject_exports, {
  extractSessionIdFromStdin: () => extractSessionIdFromStdin
});
function extractSessionIdFromStdin(stdinRaw, agent) {
  if (!stdinRaw || !stdinRaw.trim()) return "";
  let obj;
  try {
    obj = JSON.parse(stdinRaw);
  } catch {
    return "";
  }
  if (!obj || typeof obj !== "object") return "";
  const rec = obj;
  const keys = agent === "agy" ? ["conversationId", "conversation_id"] : agent === "codex" ? ["session_id"] : [];
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}
var init_globalInject = __esm({
  "packages/core/src/globalInject.ts"() {
    "use strict";
  }
});

// packages/core/src/contextTag.ts
var contextTag_exports = {};
__export(contextTag_exports, {
  CONTEXT_CLOSE_TAG: () => CONTEXT_CLOSE_TAG,
  CONTEXT_OPEN_TAG: () => CONTEXT_OPEN_TAG,
  CONTEXT_TAG_NAME_PREFIX: () => CONTEXT_TAG_NAME_PREFIX,
  wrapInjectedContext: () => wrapInjectedContext
});
function wrapInjectedContext(body) {
  return CONTEXT_OPEN_TAG + "\n\n" + body + "\n" + CONTEXT_CLOSE_TAG;
}
var CONTEXT_OPEN_TAG, CONTEXT_CLOSE_TAG, CONTEXT_TAG_NAME_PREFIX;
var init_contextTag = __esm({
  "packages/core/src/contextTag.ts"() {
    "use strict";
    CONTEXT_OPEN_TAG = "<agentbridge-context>";
    CONTEXT_CLOSE_TAG = "</agentbridge-context>";
    CONTEXT_TAG_NAME_PREFIX = "<agentbridge-context";
  }
});

// packages/core/src/skillTemplate.ts
var skillTemplate_exports = {};
__export(skillTemplate_exports, {
  SKILL_DIR_NAME: () => SKILL_DIR_NAME,
  SKILL_VERSION: () => SKILL_VERSION,
  renderRunPrefix: () => renderRunPrefix,
  renderSkillMarkdown: () => renderSkillMarkdown
});
function quote(p) {
  return /[\s'"$`\\]/.test(p) ? `'${p.replace(/'/g, `'\\''`)}'` : p;
}
function renderRunPrefix(opts) {
  return `${quote(opts.execPath)} ${quote(opts.cliPath)}`;
}
function renderSkillMarkdown(opts) {
  const run = renderRunPrefix(opts);
  return `---
name: agentbridge
description: >-
  Use when the user refers to earlier work or an earlier session ("\uC544\uAE4C \uADF8\uAC70",
  "what we decided", "continue where we left off"), when starting a task in a
  project not seen this session, when the answer turns on how this user works
  (style, tooling, workflow, conventions) or on this repository's own rules,
  when the user states something durable worth remembering, or when a context
  or memory command fails and the wiring may be broken. Also use whenever the
  user asks to run work in another agent session \u2014 "\uC11C\uBE0C\uC5D0\uC774\uC804\uD2B8 \uB744\uC6CC", "\uC11C\uBE0C
  \uB744\uC6CC\uC11C ~\uD558\uAC8C \uD574", "spawn a subagent", "run this in codex/claude/agy", "get a
  second opinion from another model", "run these in parallel" \u2014 or asks about
  subagents already started ("\uC11C\uBE0C \uB05D\uB0AC\uC5B4?", "\uBCF4\uACE0 \uC77D\uC5B4\uC918", "what did it say").
---

# AgentBridge

AgentBridge keeps working context across sessions and across coding agents.
None of it is in your prompt. If you do not run a command, you do not have it.

Every command is:

    ${run} <command>

The environment identifies the session \u2014 do not pass paths or ids.

## When to run what

Run these when the condition holds, not "if it seems useful":

- **Starting work on this project this session** \u2014 \`context\`
- **The user refers to something from before** ("\uC544\uAE4C \uADF8\uAC70", "what we decided",
  "continue where we left off") \u2014 \`turns --last 5\`
- **A question about a past decision's rationale, or how this user wants things
  done** (style, tooling, workflow, conventions) \u2014 \`memory search "<query>"\`
- **A question about this repository's own rules or history** \u2014
  \`memory project\`
- **Before recording anything** \u2014 read first, see below

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

## Subagents

You can run other coding agents as subagents. Each gets its own session and
tab; you give it work, it reports back, you read the report.

    agent start --prompt "..." [--harness claude,codex,agy]
    agent list                    the subs you started, and their state
    agent check [--wait] [--for <seconds>]
    agent read <name> [--last N]  that sub's full conversation
    agent send <name> --prompt "..."
    agent stop <name>

\`agent start\` returns the names it issued \u2014 that is what the other commands
take. Default harness is claude; pass several to run the same prompt on each.

A sub does not tell you when it is done. Either \`agent check --wait\`, which
returns as soon as one finishes (up to a minute, \`--for\` raises it), or go do
something else \u2014 the next turn tells you how many finished subs are unread.
Reading a report with \`agent read\` is what clears that.

Every read output item starts with its identifier (\`<category>/<slug>\`) \u2014
that is what \`memory update\` takes.

## Recording something

When the user states a durable preference, a convention, or a decision that
should outlive this session:

1. Pick the scope. One test: is this about **how the user works or who they
   are** (\`--scope user\`), or about **what this repository is** (\`--scope
   project\`) \u2014 its purpose, domain, architecture decisions, release process,
   house rules? A user fact must still read correctly inside a completely
   different project. The same category appears on both sides: a rule this
   repository enforces is project scope, a rule the user applies everywhere is
   user scope. When in doubt, prefer \`project\` \u2014 the narrower home.
2. Read that side in full \u2014 \`memory user --full\` or \`memory project --full\`.
   Not a search: you need everything to know whether this is new. Read only the
   side you picked.
3. Nothing covers it \u2014 \`memory add\`. Something covers it \u2014
   \`memory update <id>\`, passing only the flags you are changing.

Both go to a queue the user approves. They do not appear in reads until then.

Record what would change how someone works next time \u2014 not what the repository
already says, not what only matters in this conversation.

## Outside AgentBridge

In a session AgentBridge did not open they print nothing and exit 0. Expected,
not an error.

<!-- @agentbridge-skill-version ${SKILL_VERSION} -->
`;
}
var SKILL_VERSION, SKILL_DIR_NAME;
var init_skillTemplate = __esm({
  "packages/core/src/skillTemplate.ts"() {
    "use strict";
    SKILL_VERSION = "0.5.5";
    SKILL_DIR_NAME = "agentbridge";
  }
});

// packages/core/bin/agentbridge-memory.js
var fs3 = require("fs");
var path = require("path");
var { isUnread: isUnread2 } = (init_reportState(), __toCommonJS(reportState_exports));
var { extractSessionIdFromStdin: extractSessionIdFromStdin2 } = (init_globalInject(), __toCommonJS(globalInject_exports));
var { wrapInjectedContext: wrapInjectedContext2 } = (init_contextTag(), __toCommonJS(contextTag_exports));
var { renderRunPrefix: renderRunPrefix2 } = (init_skillTemplate(), __toCommonJS(skillTemplate_exports));
var TERMINATION_EVENTS = /* @__PURE__ */ new Set(["Stop", "StopFailure"]);
var INJECTION_EVENTS = /* @__PURE__ */ new Set(["UserPromptSubmit", "PreInvocation"]);
function writeHookError(wsDir, agent, event, message) {
  try {
    const token = process.env.AGENTBRIDGE_WS_SESSION || "";
    if (!wsDir || !token || token !== path.basename(token)) return;
    const dir = path.join(wsDir, "sessions", token);
    fs3.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, "hook-error.json");
    const tmp = out + "." + process.pid + ".tmp";
    fs3.writeFileSync(tmp, JSON.stringify({ agent, event, message: String(message), at: Date.now() }));
    fs3.renameSync(tmp, out);
  } catch {
  }
}
function buildTurnSignal(agent, event, payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const str2 = (v) => typeof v === "string" && v.trim() ? v : "";
  if (agent === "agy") {
    return {
      agent,
      event,
      sessionId: str2(p.conversationId) || str2(p.conversation_id),
      transcriptPath: str2(p.transcriptPath) || str2(p.transcript_path),
      // 배경 작업이 남아 있으면 턴이 아직 안 끝났다.
      complete: p.fullyIdle === true,
      terminationReason: str2(p.terminationReason),
      error: str2(p.error),
      at: Date.now()
    };
  }
  return {
    agent,
    event,
    sessionId: str2(p.session_id),
    transcriptPath: str2(p.transcript_path),
    // 자식(서브에이전트) 신호는 부모 턴이 아니다. Stop 스키마엔 원래 없지만 방어로 싣는다.
    agentId: str2(p.agent_id),
    // claude는 API·모델 오류로 끊기면 Stop 대신 StopFailure가 온다 (research 04 §1).
    complete: event !== "StopFailure",
    error: str2(p.error),
    at: Date.now()
  };
}
var ALLOWED_EVENTS = /* @__PURE__ */ new Set([
  "SessionStart",
  "UserPromptSubmit",
  "BeforeAgent",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "StopFailure",
  "PreInvocation",
  "PostInvocation"
]);
function parseArgs(argv) {
  const out = {
    cmd: argv[0] || null,
    agent: null,
    event: null
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--agent" && next) {
      out.agent = next;
      i++;
    } else if (a === "--event" && next) {
      out.event = next;
      i++;
    }
  }
  return out;
}
function readStdin(timeoutMs) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let data = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        process.stdin.pause();
      } catch {
      }
      resolve(data);
    };
    const timer = setTimeout(finish, timeoutMs);
    if (timer && typeof timer.unref === "function") timer.unref();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      data += c;
    });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      finish();
    });
  });
}
async function buildSubagentLine(wsDir, sessionToken, run) {
  if (!sessionToken || sessionToken !== path.basename(sessionToken)) return "";
  let sessions = [];
  try {
    sessions = JSON.parse(fs3.readFileSync(path.join(wsDir, "workspace.json"), "utf8")).sessions || [];
  } catch {
    return "";
  }
  const mine = sessions.filter((s) => s.parentSessionId === sessionToken && s.agentName);
  if (mine.length === 0) return "";
  const unread = [];
  for (const s of mine) {
    if (await isUnread2(wsDir, s.sessionId)) unread.push(s.agentName);
  }
  if (unread.length === 0) return "";
  return "\n\n" + unread.length + " subagent report(s) finished and unread (" + unread.join(", ") + "). Read with `" + run + " agent read <name>`.";
}
function buildInstructions(storageRoot) {
  const run = renderRunPrefix2({
    execPath: process.execPath,
    cliPath: path.join(storageRoot, "bin", "agentbridge.js")
  });
  return [
    "AgentBridge carries working context across sessions and across coding agents.",
    "None of it is in this prompt. Run a command to see it:",
    "",
    "    " + run + " <command>",
    "",
    'Run these when the condition holds, not "if it seems useful":',
    "",
    "- Starting work on this project this session \u2014 `context`",
    '- The user refers to something from before ("\uC544\uAE4C \uADF8\uAC70", "what we decided",',
    '  "continue where we left off") \u2014 `turns --last 5`',
    "- A question about a past decision's rationale, or how this user wants things done",
    '  (style, tooling, workflow, conventions) \u2014 `memory search "<query>"`',
    "- A question about this repository's own rules or history \u2014 `memory project`",
    "- The user states something durable (a preference, a convention, a decision that should",
    "  outlive this session) \u2014 read that side in full first, then `memory add` or",
    "  `memory update <id>`. Both go to a queue the user approves.",
    '- The user asks for work to run in another agent session \u2014 "\uC11C\uBE0C\uC5D0\uC774\uC804\uD2B8 \uB744\uC6CC", spawn a',
    "  subagent, run it in another harness, a second opinion, several in parallel \u2014",
    '  `agent start --prompt "..." [--harness claude,codex,agy]`. These are AgentBridge',
    "  sessions with their own tabs, not your own built-in subagent tool. Follow up with",
    '  `agent check`, `agent read <name>`, `agent send <name> --prompt "..."`.',
    "",
    "Run `status` if a command fails and you need to know whether the wiring is alive.",
    "",
    "Respond in the language the user writes in. Mixed sessions follow the most recent turn."
  ].join("\n");
}
async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.cmd !== "inject") {
    process.stderr.write(
      "agentbridge-memory: usage: inject --agent <claude|codex|agy> --event <name>\n"
    );
    process.exit(2);
  }
  if (parsed.agent !== "claude" && parsed.agent !== "codex" && parsed.agent !== "agy") {
    process.stderr.write("agentbridge-memory: --agent must be claude|codex|agy\n");
    process.exit(2);
  }
  if (!parsed.event || !ALLOWED_EVENTS.has(parsed.event)) {
    process.stderr.write(
      "agentbridge-memory: --event required, one of: " + Array.from(ALLOWED_EVENTS).join("|") + "\n"
    );
    process.exit(2);
  }
  const realpath = (v) => {
    try {
      return fs3.realpathSync(v);
    } catch {
      return path.resolve(v);
    }
  };
  const storageRoot = realpath(path.dirname(path.dirname(__filename)));
  const wsDir = process.env.AGENTBRIDGE_WS_DIR ? realpath(process.env.AGENTBRIDGE_WS_DIR) : "";
  if (!wsDir) {
    process.stdout.write(JSON.stringify(buildHookOutput(parsed.agent, parsed.event, "")));
    process.exit(0);
  }
  const rel = path.relative(storageRoot, wsDir);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    process.stderr.write("agentbridge-memory: AGENTBRIDGE_WS_DIR must live under the storage root\n");
    writeHookError(wsDir, parsed.agent, parsed.event, "AGENTBRIDGE_WS_DIR\uAC00 \uC800\uC7A5\uC18C \uB8E8\uD2B8 \uBC16\uC744 \uAC00\uB9AC\uD0A8\uB2E4");
    process.stdout.write(JSON.stringify(buildHookOutput(parsed.agent, parsed.event, "")));
    process.exit(0);
  }
  const stdinRaw = await readStdin(200);
  try {
    const token = process.env.AGENTBRIDGE_WS_SESSION || "";
    let sid = extractSessionIdFromStdin2(stdinRaw, parsed.agent);
    if (!sid) {
      if (parsed.agent === "agy") sid = process.env.ANTIGRAVITY_CONVERSATION_ID || "";
      else if (parsed.agent === "codex") sid = process.env.CODEX_THREAD_ID || "";
    }
    if (parsed.agent !== "claude" && token && sid && token === path.basename(token)) {
      const dir = path.join(wsDir, "sessions", token);
      fs3.mkdirSync(dir, { recursive: true });
      const out = path.join(dir, "captured.json");
      const tmp = out + "." + process.pid + ".tmp";
      fs3.writeFileSync(
        tmp,
        JSON.stringify({
          agent: parsed.agent,
          modelSessionId: sid,
          ppid: process.ppid,
          capturedAt: Date.now()
        })
      );
      fs3.renameSync(tmp, out);
    }
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    process.stderr.write("agentbridge-memory: capture write skipped \u2014 " + msg + "\n");
    writeHookError(wsDir, parsed.agent, parsed.event, "\uC138\uC158 id \uCEA1\uCC98 \uC2E4\uD328 \u2014 " + msg);
  }
  if (INJECTION_EVENTS.has(parsed.event)) {
    try {
      const token = process.env.AGENTBRIDGE_WS_SESSION || "";
      if (token && token === path.basename(token)) {
        const sid = extractSessionIdFromStdin2(stdinRaw, parsed.agent);
        const dir = path.join(wsDir, "sessions", token);
        fs3.mkdirSync(dir, { recursive: true });
        const out = path.join(dir, "turn-start.json");
        const tmp = out + "." + process.pid + ".tmp";
        fs3.writeFileSync(
          tmp,
          JSON.stringify({ agent: parsed.agent, event: parsed.event, sessionId: sid, at: Date.now() })
        );
        fs3.renameSync(tmp, out);
      }
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      process.stderr.write("agentbridge-memory: turn start write skipped \u2014 " + msg + "\n");
      writeHookError(wsDir, parsed.agent, parsed.event, "\uD134 \uC2DC\uC791 \uC2E0\uD638 \uC4F0\uAE30 \uC2E4\uD328 \u2014 " + msg);
    }
  }
  if (TERMINATION_EVENTS.has(parsed.event)) {
    try {
      const token = process.env.AGENTBRIDGE_WS_SESSION || "";
      if (token && token === path.basename(token)) {
        let payload = null;
        try {
          payload = JSON.parse(stdinRaw);
        } catch {
          payload = null;
        }
        const dir = path.join(wsDir, "sessions", token);
        fs3.mkdirSync(dir, { recursive: true });
        const out = path.join(dir, "turn-signal.json");
        const tmp = out + "." + process.pid + ".tmp";
        fs3.writeFileSync(tmp, JSON.stringify(buildTurnSignal(parsed.agent, parsed.event, payload)));
        fs3.renameSync(tmp, out);
      }
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      process.stderr.write("agentbridge-memory: turn signal write skipped \u2014 " + msg + "\n");
      writeHookError(wsDir, parsed.agent, parsed.event, "\uD134 \uC885\uB8CC \uC2E0\uD638 \uC4F0\uAE30 \uC2E4\uD328 \u2014 " + msg);
    }
    process.stdout.write(JSON.stringify(buildTerminationOutput(parsed.agent)));
    process.exit(0);
  }
  const run = renderRunPrefix2({
    execPath: process.execPath,
    cliPath: path.join(storageRoot, "bin", "agentbridge.js")
  });
  let subagentLine = "";
  try {
    subagentLine = await buildSubagentLine(wsDir, process.env.AGENTBRIDGE_WS_SESSION || "", run);
  } catch {
  }
  process.stdout.write(
    JSON.stringify(
      buildHookOutput(
        parsed.agent,
        parsed.event,
        wrapInjectedContext2(buildInstructions(storageRoot) + subagentLine)
      )
    )
  );
  process.exit(0);
}
function buildTerminationOutput(agent) {
  if (agent === "agy") return { decision: "stop" };
  return { suppressOutput: true };
}
function buildHookOutput(agent, event, additionalContext) {
  if (agent === "agy") {
    return {
      injectSteps: [{ ephemeralMessage: additionalContext }]
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext
    },
    suppressOutput: true
  };
}
main().catch((err) => {
  process.stderr.write("agentbridge-memory: " + String(err && err.stack ? err.stack : err) + "\n");
  let fallbackEvent = "UserPromptSubmit";
  let fallbackAgent = "claude";
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.event && ALLOWED_EVENTS.has(parsed.event)) fallbackEvent = parsed.event;
    if (parsed.agent === "claude" || parsed.agent === "codex" || parsed.agent === "agy") {
      fallbackAgent = parsed.agent;
    }
  } catch {
  }
  process.stdout.write(JSON.stringify(buildHookOutput(fallbackAgent, fallbackEvent, "")));
  process.exit(0);
});
