#!/usr/bin/env node
// @agentbridge-cli-version 0.5.0
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

// packages/core/src/agentCli/irRender.ts
var irRender_exports = {};
__export(irRender_exports, {
  renderCommands: () => renderCommands,
  renderDecisions: () => renderDecisions,
  renderFiles: () => renderFiles,
  renderIntent: () => renderIntent,
  renderIrSections: () => renderIrSections,
  renderPending: () => renderPending,
  renderTests: () => renderTests
});
function fmtList(items, indent = "") {
  if (!Array.isArray(items) || items.length === 0) return `${indent}(none)`;
  return items.map((s) => `${indent}- ${String(s)}`).join("\n");
}
function renderIntent(ir) {
  const intent = ir?.intent ?? {};
  const lines = [`goal: ${intent.goal || "(unset)"}`];
  if (intent.role) lines.push(`role: ${intent.role}`);
  if (Array.isArray(intent.constraints) && intent.constraints.length > 0) {
    lines.push("constraints:");
    lines.push(fmtList(intent.constraints, "  "));
  }
  return lines.join("\n");
}
function renderDecisions(ir) {
  const ds = ir?.decisions ?? [];
  if (ds.length === 0) return "(no decisions)";
  return ds.slice(-10).map((d) => {
    const head = d.topic ? `${d.topic} \u2192 ${d.choice}` : d.choice;
    const lines = [`- ${head}`];
    if (d.rationale) lines.push(`  rationale: ${d.rationale}`);
    return lines.join("\n");
  }).join("\n");
}
function renderFiles(ir) {
  const files = ir?.files ?? [];
  if (files.length === 0) return "(no file changes)";
  return files.slice(-15).map((f) => `- [${f.status}] ${f.path}${f.summary ? ` \u2014 ${f.summary}` : ""}`).join("\n");
}
function renderCommands(ir) {
  const cs = ir?.commands ?? [];
  if (cs.length === 0) return "(no commands run)";
  return cs.slice(-10).map((c) => {
    const ec = c.exitCode != null ? ` (exit ${c.exitCode})` : "";
    return `- \`${c.cmd}\`${ec}${c.summary ? ` \u2014 ${c.summary}` : ""}`;
  }).join("\n");
}
function renderTests(ir) {
  const ts = ir?.tests ?? [];
  if (ts.length === 0) return "(no test results)";
  return ts.slice(-5).map((t) => `- [${t.status}] ${t.name}${t.failureSummary ? ` \u2014 ${t.failureSummary}` : ""}`).join("\n");
}
function renderPending(ir) {
  const ps = ir?.pending ?? [];
  if (ps.length === 0) return "(no pending items)";
  return ps.slice(-5).map((p) => {
    const lines = [`- ${p.task}`];
    if (Array.isArray(p.blockers) && p.blockers.length > 0) {
      lines.push(`  blockers: ${p.blockers.join(", ")}`);
    }
    if (p.nextStep) lines.push(`  next: ${p.nextStep}`);
    return lines.join("\n");
  }).join("\n");
}
function renderIrSections(ir) {
  return [
    "### Intent",
    renderIntent(ir),
    "",
    "### Decisions",
    renderDecisions(ir),
    "",
    "### Files",
    renderFiles(ir),
    "",
    "### Commands",
    renderCommands(ir),
    "",
    "### Tests",
    renderTests(ir),
    "",
    "### Pending",
    renderPending(ir)
  ].join("\n");
}
var init_irRender = __esm({
  "packages/core/src/agentCli/irRender.ts"() {
    "use strict";
  }
});

// packages/core/bin/agentbridge.js
var fs = require("fs");
var path = require("path");
var { renderIrSections: renderIrSections2 } = (init_irRender(), __toCommonJS(irRender_exports));
var COMMANDS = [["context", "\uD604\uC7AC \uD504\uB85C\uC81D\uD2B8\uC758 \uC555\uCD95\uB41C \uC791\uC5C5 \uC0C1\uD0DC"]];
var USAGE = [
  "agentbridge \u2014 AgentBridge \uB9E5\uB77D \uC77D\uAE30",
  "",
  "\uC0AC\uC6A9\uBC95: agentbridge <\uBA85\uB839>",
  "",
  ...COMMANDS.map(([name, desc]) => "  " + name.padEnd(18) + desc)
].join("\n");
function usageAndExit() {
  process.stderr.write(USAGE + "\n");
  process.exit(2);
}
function fail(msg) {
  process.stderr.write("agentbridge: " + msg + "\n");
  process.exit(2);
}
function realpath(v) {
  try {
    return fs.realpathSync(v);
  } catch {
    return path.resolve(v);
  }
}
function resolveWorkspaceDir() {
  const raw = process.env.AGENTBRIDGE_WS_DIR || "";
  if (!raw) return null;
  const storageRoot = realpath(path.dirname(path.dirname(__filename)));
  const wsDir = realpath(raw);
  const rel = path.relative(storageRoot, wsDir);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    fail("AGENTBRIDGE_WS_DIR\uAC00 \uC800\uC7A5\uC18C \uB8E8\uD2B8 \uBC16\uC744 \uAC00\uB9AC\uD0A8\uB2E4");
  }
  return wsDir;
}
function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
function cmdContext(wsDir) {
  const ir = readJsonSafe(path.join(wsDir, "ir.json"));
  if (!ir) {
    process.stdout.write("\uC800\uC7A5\uB41C \uC791\uC5C5 \uC0C1\uD0DC\uAC00 \uC5C6\uB2E4. \uC544\uC9C1 \uC555\uCD95\uB41C \uB9E5\uB77D\uC774 \uC313\uC774\uC9C0 \uC54A\uC558\uB2E4.\n");
    return;
  }
  process.stdout.write("## \uC791\uC5C5 \uC0C1\uD0DC (\uC555\uCD95\uB41C \uB9E5\uB77D)\n\n" + renderIrSections2(ir) + "\n");
}
function main() {
  const cmd = process.argv[2];
  const wsDir = resolveWorkspaceDir();
  if (!wsDir) {
    process.stdout.write(
      "AgentBridge: \uC774 \uC138\uC158\uC740 AgentBridge \uBC16\uC5D0\uC11C \uC5F4\uB838\uB2E4. \uB0BC \uB9E5\uB77D\uC774 \uC5C6\uB2E4.\n"
    );
    process.exit(0);
  }
  if (!cmd) usageAndExit();
  switch (cmd) {
    case "context":
      cmdContext(wsDir);
      break;
    default:
      usageAndExit();
  }
}
main();
