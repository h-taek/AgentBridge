#!/usr/bin/env node
"use strict";

// packages/core/bin/agentbridge-memory.js
var fs = require("fs");
var path = require("path");
var ALLOWED_EVENTS = /* @__PURE__ */ new Set([
  "SessionStart",
  "UserPromptSubmit",
  "BeforeAgent",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "PreInvocation",
  "PostInvocation"
]);
function parseArgs(argv) {
  const out = {
    cmd: argv[0] || null,
    agent: null,
    workspace: null,
    userData: null,
    event: null
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--agent" && next) {
      out.agent = next;
      i++;
    } else if (a === "--workspace" && next) {
      out.workspace = next;
      i++;
    } else if (a === "--user-data" && next) {
      out.userData = next;
      i++;
    } else if (a === "--event" && next) {
      out.event = next;
      i++;
    }
  }
  return out;
}
function readJsonSafe(p) {
  try {
    const raw = fs.readFileSync(p, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function readRecentTurns(p, n) {
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n");
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj === "object" && typeof obj.id === "string") out.push(obj);
    } catch {
    }
  }
  if (n <= 0 || out.length <= n) return out;
  return out.slice(out.length - n);
}
function fmtList(items, indent) {
  indent = indent || "";
  if (!Array.isArray(items) || items.length === 0) return indent + "(none)";
  return items.map((s) => indent + "- " + s).join("\n");
}
function renderIntent(ir) {
  const intent = ir && ir.intent || {};
  const lines = ["goal: " + (intent.goal || "(unset)")];
  if (intent.role) lines.push("role: " + intent.role);
  if (Array.isArray(intent.constraints) && intent.constraints.length > 0) {
    lines.push("constraints:");
    lines.push(fmtList(intent.constraints, "  "));
  }
  return lines.join("\n");
}
function renderDecisions(ir) {
  const ds = ir && ir.decisions || [];
  if (ds.length === 0) return "(no decisions)";
  return ds.slice(-10).map((d) => {
    const head = d.topic ? d.topic + " \u2192 " + d.choice : d.choice;
    const lines = ["- " + head];
    if (d.rationale) lines.push("  rationale: " + d.rationale);
    return lines.join("\n");
  }).join("\n");
}
function renderFiles(ir) {
  const fs2 = ir && ir.files || [];
  if (fs2.length === 0) return "(no file changes)";
  return fs2.slice(-15).map((f) => "- [" + f.status + "] " + f.path + (f.summary ? " \u2014 " + f.summary : "")).join("\n");
}
function renderCommands(ir) {
  const cs = ir && ir.commands || [];
  if (cs.length === 0) return "(no commands run)";
  return cs.slice(-10).map((c) => {
    const head = "- `" + c.cmd + "`";
    const ec = c.exitCode != null ? " (exit " + c.exitCode + ")" : "";
    const sum = c.summary ? " \u2014 " + c.summary : "";
    return head + ec + sum;
  }).join("\n");
}
function renderTests(ir) {
  const ts = ir && ir.tests || [];
  if (ts.length === 0) return "(no test results)";
  return ts.slice(-5).map(
    (t) => "- [" + t.status + "] " + t.name + (t.failureSummary ? " \u2014 " + t.failureSummary : "")
  ).join("\n");
}
function renderPending(ir) {
  const ps = ir && ir.pending || [];
  if (ps.length === 0) return "(no pending items)";
  return ps.slice(-5).map((p) => {
    const lines = ["- " + p.task];
    if (Array.isArray(p.blockers) && p.blockers.length > 0) {
      lines.push("  blockers: " + p.blockers.join(", "));
    }
    if (p.nextStep) lines.push("  next: " + p.nextStep);
    return lines.join("\n");
  }).join("\n");
}
var HOOK_INSTRUCTIONS = [
  "The following block is working context maintained and compacted by AgentBridge.",
  "",
  "Handling rules:",
  '1. Do NOT refer to this block as a separate artifact (no "the IR", "you provided", "the context above", etc.). Treat it as natural conversation continuity \u2014 the user is already aware of its contents.',
  "2. Do NOT summarize or re-quote the IR unless the user asks. You may draw on it naturally when needed for accuracy.",
  "3. Project memory files (AGENTS.md / GEMINI.md / CLAUDE.md) keep their normal authority. On conflict with the IR, prefer the most recent user intent; if unsure, ask the user to confirm.",
  "4. **Respond in the same language the user uses in their question.** If the user writes Korean, reply in Korean. If English, reply in English. Mixed sessions follow the most recent user turn. This applies to the model reply only \u2014 IR data and structural enum values stay as recorded."
].join("\n");
function truncate(s, n) {
  if (typeof s !== "string") return "";
  if (s.length <= n) return s;
  return s.slice(0, n) + "\u2026";
}
function renderRecentTurns(turns) {
  if (!Array.isArray(turns) || turns.length === 0) return "(no recent turns)";
  const lines = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const idx = turns.length - turns.length + i + 1;
    lines.push("[Turn " + idx + " \xB7 " + (t.model || "?") + " \xB7 " + (t.completedAt || "") + "]");
    lines.push("user: " + truncate(t.user || "", 1200));
    lines.push("assistant: " + truncate(t.assistantBody || "", 1200));
    if (Array.isArray(t.toolCalls) && t.toolCalls.length > 0) {
      const tc = t.toolCalls.slice(0, 5).map((c) => "  - " + (c.tool || "?") + "(" + truncate(c.arg || "", 80) + ")").join("\n");
      lines.push("tools:");
      lines.push(tc);
    }
    if (i < turns.length - 1) lines.push("");
  }
  return lines.join("\n");
}
function buildAdditionalContext(ir, recentTurns, workspaceId) {
  if (!ir && (!recentTurns || recentTurns.length === 0)) {
    return [
      "<agentbridge-context>",
      HOOK_INSTRUCTIONS,
      "",
      "## AgentBridge context (memory uninitialized)",
      "Workspace " + workspaceId + " has no compacted memory (IR) or turn history yet.",
      "This hook will accumulate from the next turn onward and compact into an IR.",
      "</agentbridge-context>"
    ].join("\n");
  }
  const parts = ["<agentbridge-context>", HOOK_INSTRUCTIONS, ""];
  if (ir) {
    parts.push("## Memory (compacted \u2014 IR)");
    parts.push("");
    parts.push("### Intent");
    parts.push(renderIntent(ir));
    parts.push("");
    parts.push("### Decisions");
    parts.push(renderDecisions(ir));
    parts.push("");
    parts.push("### Files");
    parts.push(renderFiles(ir));
    parts.push("");
    parts.push("### Commands");
    parts.push(renderCommands(ir));
    parts.push("");
    parts.push("### Tests");
    parts.push(renderTests(ir));
    parts.push("");
    parts.push("### Pending");
    parts.push(renderPending(ir));
    parts.push("");
  } else {
    parts.push("## Memory (IR uninitialized \u2014 only recent turns available)");
    parts.push("");
  }
  parts.push(
    "## Recent conversation (raw, last " + (recentTurns ? recentTurns.length : 0) + " turns)"
  );
  parts.push(renderRecentTurns(recentTurns));
  parts.push("</agentbridge-context>");
  return parts.join("\n");
}
function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.cmd !== "inject") {
    process.stderr.write(
      "agentbridge-memory: usage: inject --agent <kind> --workspace <id> --user-data <path> --event <name>\n"
    );
    process.exit(2);
  }
  if (parsed.agent !== "claude" && parsed.agent !== "codex" && parsed.agent !== "agy") {
    process.stderr.write("agentbridge-memory: --agent must be claude|codex|agy\n");
    process.exit(2);
  }
  if (!parsed.workspace) {
    process.stderr.write("agentbridge-memory: --workspace required\n");
    process.exit(2);
  }
  if (!parsed.event || !ALLOWED_EVENTS.has(parsed.event)) {
    process.stderr.write(
      "agentbridge-memory: --event required, one of: " + Array.from(ALLOWED_EVENTS).join("|") + "\n"
    );
    process.exit(2);
  }
  if (!parsed.userData) {
    process.stderr.write(
      "agentbridge-memory: --user-data required (stale or broken hook command \u2014 reopen the session in the app to reinstall hooks)\n"
    );
    process.stdout.write(JSON.stringify(buildHookOutput(parsed.agent, parsed.event, "")));
    process.exit(0);
  }
  const userData = parsed.userData;
  if (parsed.workspace !== path.basename(parsed.workspace) || parsed.workspace === "..") {
    process.stderr.write("agentbridge-memory: --workspace must be a single path segment\n");
    process.stdout.write(JSON.stringify(buildHookOutput(parsed.agent, parsed.event, "")));
    process.exit(0);
  }
  const wsDir = path.join(userData, "workspaces", parsed.workspace);
  const irPath = path.join(wsDir, "ir.json");
  const turnsPath = path.join(wsDir, "turns.jsonl");
  const ir = readJsonSafe(irPath);
  const recentTurns = readRecentTurns(turnsPath, 3);
  const additionalContext = buildAdditionalContext(ir, recentTurns, parsed.workspace);
  process.stdout.write(
    JSON.stringify(buildHookOutput(parsed.agent, parsed.event, additionalContext))
  );
  process.exit(0);
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
try {
  main();
} catch (err) {
  process.stderr.write("agentbridge-memory: " + String(err && err.stack ? err.stack : err) + "\n");
  let fallbackEvent = "UserPromptSubmit";
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.event && ALLOWED_EVENTS.has(parsed.event)) fallbackEvent = parsed.event;
  } catch {
  }
  let fallbackAgent = "claude";
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.agent === "claude" || parsed.agent === "codex" || parsed.agent === "agy") {
      fallbackAgent = parsed.agent;
    }
  } catch {
  }
  process.stdout.write(JSON.stringify(buildHookOutput(fallbackAgent, fallbackEvent, "")));
  process.exit(0);
}
