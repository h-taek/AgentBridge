#!/usr/bin/env node
// @agentbridge-helper-version 0.5.0
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

// packages/core/src/fileLock.ts
var ACQUIRE_TIMEOUT_MS, STALE_LOCK_MS;
var init_fileLock = __esm({
  "packages/core/src/fileLock.ts"() {
    "use strict";
    ACQUIRE_TIMEOUT_MS = 5e3;
    STALE_LOCK_MS = 1e4;
    if (STALE_LOCK_MS <= ACQUIRE_TIMEOUT_MS) {
      throw new Error(
        `fileLock: STALE_LOCK_MS(${STALE_LOCK_MS}) must be > ACQUIRE_TIMEOUT_MS(${ACQUIRE_TIMEOUT_MS})`
      );
    }
  }
});

// packages/core/src/storageRoot.ts
var init_storageRoot = __esm({
  "packages/core/src/storageRoot.ts"() {
    "use strict";
  }
});

// packages/core/src/globalPaths.ts
function profilesRoot(globalDir) {
  return (0, import_node_path.join)(globalDir, "profiles");
}
function projectsRoot(globalDir) {
  return (0, import_node_path.join)(globalDir, "projects");
}
function scopeRoot(globalDir, scope) {
  return scope === "project" ? projectsRoot(globalDir) : profilesRoot(globalDir);
}
function assertProfileSegment(profileId) {
  const v = String(profileId ?? "");
  if (!v || v === "." || v === ".." || /[\\/\u0000]/.test(v)) {
    throw new Error(`Invalid profileId "${v}": must be a single path segment.`);
  }
  return v;
}
function profileDir(globalDir, profileId, scope = "user") {
  return (0, import_node_path.join)(scopeRoot(globalDir, scope), assertProfileSegment(profileId));
}
function profileDocsDir(globalDir, profileId, scope = "user") {
  return (0, import_node_path.join)(profileDir(globalDir, profileId, scope), "docs");
}
var import_node_path;
var init_globalPaths = __esm({
  "packages/core/src/globalPaths.ts"() {
    "use strict";
    import_node_path = require("node:path");
    init_storageRoot();
  }
});

// packages/core/src/shared/global.ts
var GLOBAL_CATEGORIES, DOC_CAPS, PROPOSAL_CAPS;
var init_global = __esm({
  "packages/core/src/shared/global.ts"() {
    "use strict";
    GLOBAL_CATEGORIES = [
      "role",
      "repos",
      "domain",
      "workflows",
      "conventions",
      "infra",
      "verification"
    ];
    DOC_CAPS = {
      title: 200,
      summary: 2e3,
      body: 2e4,
      indexEntries: 50
    };
    PROPOSAL_CAPS = {
      title: DOC_CAPS.title,
      summary: DOC_CAPS.summary,
      body: DOC_CAPS.body,
      maxPerPass: 12
      // 한 패스가 만들 제안 상한 — 폭주 방지
    };
  }
});

// packages/core/src/globalMarkdown.ts
function extractTitle(markdown) {
  return String(markdown || "").match(/^#\s+(.+)$/m)?.[1]?.trim() || "";
}
function extractSummary(markdown) {
  return String(markdown || "").match(/## Summary\s+([\s\S]*?)(?:\n## |$)/)?.[1]?.trim() || "";
}
function extractIndexEntries(markdown) {
  const m = String(markdown || "").match(/## Index Entries\s+([\s\S]*?)(?:\n## |$)/);
  if (!m?.[1]) return [];
  return m[1].split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim()).filter(Boolean);
}
var CATEGORY_ORDER;
var init_globalMarkdown = __esm({
  "packages/core/src/globalMarkdown.ts"() {
    "use strict";
    init_global();
    CATEGORY_ORDER = [...GLOBAL_CATEGORIES, "general"];
  }
});

// packages/core/src/globalValidate.ts
var CATS;
var init_globalValidate = __esm({
  "packages/core/src/globalValidate.ts"() {
    "use strict";
    init_global();
    CATS = new Set(GLOBAL_CATEGORIES);
  }
});

// packages/core/src/globalStore.ts
async function listDocRelPaths(dir, prefix = "") {
  const entries = await import_node_fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listDocRelPaths((0, import_node_path2.join)(dir, entry.name), rel));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(rel);
  }
  return files.sort();
}
async function readProfileDocs(globalDir, profileId, scope = "user") {
  const docsDir = profileDocsDir(globalDir, profileId, scope);
  const files = (await listDocRelPaths(docsDir)).filter((f) => !/(^|\/)index\.md$/i.test(f));
  const recs = [];
  for (const file of files) {
    const raw = await import_node_fs.promises.readFile((0, import_node_path2.join)(docsDir, file), "utf8");
    const category = file.includes("/") ? file.split("/")[0] : "general";
    const slug = file.replace(/\.md$/i, "").split("/").slice(1).join("/") || file.replace(/\.md$/i, "");
    const detailsMatch = raw.match(/## Details\s+([\s\S]*?)$/);
    recs.push({
      category,
      slug,
      title: extractTitle(raw),
      summary: extractSummary(raw),
      indexEntries: extractIndexEntries(raw),
      body: detailsMatch?.[1]?.trim() || ""
    });
  }
  return recs;
}
var import_node_fs, import_node_path2;
var init_globalStore = __esm({
  "packages/core/src/globalStore.ts"() {
    "use strict";
    import_node_fs = require("node:fs");
    import_node_path2 = require("node:path");
    init_fileLock();
    init_globalPaths();
    init_globalMarkdown();
    init_globalValidate();
  }
});

// packages/core/src/globalSearch.ts
var globalSearch_exports = {};
__export(globalSearch_exports, {
  countTokenMatches: () => countTokenMatches,
  exactPhraseScore: () => exactPhraseScore,
  minimumUsefulScore: () => minimumUsefulScore,
  resolveContext: () => resolveContext,
  scoreDoc: () => scoreDoc,
  tokenizeQuery: () => tokenizeQuery,
  tokenizeRaw: () => tokenizeRaw
});
function tokenizeRaw(text) {
  return String(text || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).flatMap((t) => t.split(/(?<=[a-z0-9])(?=[가-힣])|(?<=[가-힣])(?=[a-z0-9])/u)).map((t) => t.trim()).filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}
function koreanVariant(token) {
  if (!HANGUL.test(token)) return null;
  for (const p of KOREAN_PARTICLES) {
    if (token.length > p.length && token.endsWith(p)) {
      const stem = token.slice(0, token.length - p.length);
      if (stem.length >= 2) return stem;
    }
  }
  return null;
}
function tokenizeQuery(query) {
  const out = /* @__PURE__ */ new Set();
  for (const tok of tokenizeRaw(query)) {
    const v = koreanVariant(tok);
    if (v && STOP_WORDS.has(v)) continue;
    out.add(tok);
    if (v) out.add(v);
  }
  return [...out];
}
function countTokenMatches(text, tokens) {
  const haystack = String(text || "").toLowerCase();
  let sum = 0;
  for (const token of tokens) {
    if (HANGUL.test(token)) {
      if (token.length >= 2 && haystack.includes(token)) sum += 1;
      continue;
    }
    const re = new RegExp(`(?<![a-z0-9])${escapeRegExp(token)}(?![a-z0-9])`);
    if (re.test(haystack)) {
      sum += 1;
    } else if (token.length >= 9) {
      const stem = escapeRegExp(token.slice(0, 7));
      if (new RegExp(`\\b${stem}[a-z]*\\b`).test(haystack)) sum += 1;
    }
  }
  return sum;
}
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function exactPhraseScore(text, query) {
  const phrase = String(query || "").trim().toLowerCase();
  if (phrase.length < 3) return 0;
  return String(text || "").toLowerCase().includes(phrase) ? 1 : 0;
}
function scoreDoc(rec, tokens) {
  const label = rec.indexEntries.join(" ");
  const path2 = `${rec.category}/${rec.slug}`;
  let score = 0;
  score += countTokenMatches(label, tokens) * 10;
  score += countTokenMatches(rec.title, tokens) * 7;
  score += countTokenMatches(rec.summary, tokens) * 5;
  score += countTokenMatches(rec.category, tokens) * 2;
  score += countTokenMatches(path2, tokens) * 2;
  score += countTokenMatches(rec.body, tokens) * 1;
  return score;
}
function minimumUsefulScore(tokens) {
  return tokens.length <= 1 ? 1 : 2;
}
async function resolveContext(globalDir, profileId, query, opts) {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return [];
  const minScore = minimumUsefulScore(tokens);
  const phrase = String(query || "").trim().toLowerCase();
  const docs = await readProfileDocs(globalDir, profileId);
  const scored = [];
  for (const rec of docs) {
    let score = scoreDoc(rec, tokens);
    score += exactPhraseScore(`${rec.title} ${rec.summary} ${rec.indexEntries.join(" ")}`, phrase) * 3;
    if (score < minScore) continue;
    scored.push({ category: rec.category, slug: rec.slug, title: rec.title, summary: rec.summary, score });
  }
  scored.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return scored.slice(0, opts?.topN ?? 5);
}
var STOP_WORDS, KOREAN_PARTICLES, HANGUL;
var init_globalSearch = __esm({
  "packages/core/src/globalSearch.ts"() {
    "use strict";
    init_globalStore();
    STOP_WORDS = /* @__PURE__ */ new Set([
      // 영어 기능어
      "the",
      "a",
      "an",
      "of",
      "to",
      "in",
      "on",
      "for",
      "and",
      "or",
      "is",
      "are",
      "be",
      "this",
      "that",
      "it",
      "as",
      "at",
      "by",
      "with",
      // 한국어 의문사·지시어 (1글자는 토크나이저가 이미 제거 → 2음절↑만 등록)
      "\uC5B4\uB5BB\uAC8C",
      "\uBB34\uC5C7",
      "\uBB34\uC2A8",
      "\uC5B4\uB5A4",
      "\uC5B4\uB290",
      "\uC5B4\uB514",
      "\uC5B8\uC81C",
      "\uB204\uAD6C",
      "\uC5BC\uB9C8",
      // 한국어 기능어·형식명사·흔한 동사(보수적: recall 보호 위해 '작업·사용·처리' 등은 제외)
      "\uBC29\uBC95",
      "\uACBD\uC6B0",
      "\uC815\uB3C4",
      "\uB54C\uBB38",
      "\uD1B5\uD574",
      "\uC704\uD574",
      "\uB300\uD574",
      "\uAD00\uD574",
      "\uC790\uCCB4",
      "\uC9C4\uD589",
      "\uD655\uC778"
    ]);
    KOREAN_PARTICLES = [
      "\uC73C\uB85C",
      "\uC5D0\uC11C",
      "\uAE4C\uC9C0",
      "\uBD80\uD130",
      "\uC5D0\uAC8C",
      "\uD55C\uD14C",
      "\uCC98\uB7FC",
      "\uBCF4\uB2E4",
      "\uB9C8\uB2E4",
      "\uC870\uCC28",
      "\uBC16\uC5D0",
      "\uC744",
      "\uB97C",
      "\uC774",
      "\uAC00",
      "\uC740",
      "\uB294",
      "\uC5D0",
      "\uC758",
      "\uB85C",
      "\uB3C4",
      "\uB9CC",
      "\uACFC",
      "\uC640",
      "\uB791",
      "\uBA70",
      "\uD558\uB2E4",
      "\uD588\uB2E4",
      "\uD558\uB294",
      "\uD558\uACE0"
    ];
    HANGUL = /[가-힣]/;
  }
});

// packages/core/src/globalInject.ts
var globalInject_exports = {};
__export(globalInject_exports, {
  extractPromptFromStdin: () => extractPromptFromStdin,
  extractSessionIdFromStdin: () => extractSessionIdFromStdin,
  renderGlobalMatches: () => renderGlobalMatches,
  resolveQuery: () => resolveQuery
});
function extractPromptFromStdin(stdinRaw) {
  if (!stdinRaw || !stdinRaw.trim()) return "";
  let obj;
  try {
    obj = JSON.parse(stdinRaw);
  } catch {
    return "";
  }
  if (!obj || typeof obj !== "object") return "";
  const rec = obj;
  for (const k of PROMPT_FIELDS) {
    const v = rec[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}
function resolveQuery(stdinRaw, lastUserTurn) {
  const fromStdin = extractPromptFromStdin(stdinRaw);
  if (fromStdin) return fromStdin;
  return lastUserTurn || "";
}
function truncate(s, n) {
  if (typeof s !== "string") return "";
  return s.length <= n ? s : s.slice(0, n) + "\u2026";
}
function renderGlobalMatches(matches) {
  if (!Array.isArray(matches) || matches.length === 0) return "";
  const lines = ["## Global memory (long-term \u2014 relevant to this prompt)", ""];
  for (const m of matches) {
    const summary = m.summary ? " \u2014 " + truncate(m.summary, 200) : "";
    lines.push("- **" + m.title + "** (" + m.category + ")" + summary);
  }
  return lines.join("\n");
}
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
var PROMPT_FIELDS;
var init_globalInject = __esm({
  "packages/core/src/globalInject.ts"() {
    "use strict";
    PROMPT_FIELDS = ["prompt", "user_prompt", "userPrompt", "input", "message", "text"];
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

// packages/core/bin/agentbridge-memory.js
var fs = require("fs");
var path = require("path");
var { resolveContext: resolveContext2 } = (init_globalSearch(), __toCommonJS(globalSearch_exports));
var { resolveQuery: resolveQuery2, renderGlobalMatches: renderGlobalMatches2, extractSessionIdFromStdin: extractSessionIdFromStdin2 } = (init_globalInject(), __toCommonJS(globalInject_exports));
var { wrapInjectedContext: wrapInjectedContext2 } = (init_contextTag(), __toCommonJS(contextTag_exports));
var TERMINATION_EVENTS = /* @__PURE__ */ new Set(["Stop", "StopFailure"]);
function writeHookError(wsDir, agent, event, message) {
  try {
    const token = process.env.AGENTBRIDGE_WS_SESSION || "";
    if (!wsDir || !token || token !== path.basename(token)) return;
    const dir = path.join(wsDir, "sessions", token);
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, "hook-error.json");
    const tmp = out + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ agent, event, message: String(message), at: Date.now() }));
    fs.renameSync(tmp, out);
  } catch {
  }
}
function buildTurnSignal(agent, event, payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const str = (v) => typeof v === "string" && v.trim() ? v : "";
  if (agent === "agy") {
    return {
      agent,
      event,
      sessionId: str(p.conversationId) || str(p.conversation_id),
      transcriptPath: str(p.transcriptPath) || str(p.transcript_path),
      // 배경 작업이 남아 있으면 턴이 아직 안 끝났다.
      complete: p.fullyIdle === true,
      terminationReason: str(p.terminationReason),
      error: str(p.error),
      at: Date.now()
    };
  }
  return {
    agent,
    event,
    sessionId: str(p.session_id),
    transcriptPath: str(p.transcript_path),
    // 자식(서브에이전트) 신호는 부모 턴이 아니다. Stop 스키마엔 원래 없지만 방어로 싣는다.
    agentId: str(p.agent_id),
    // claude는 API·모델 오류로 끊기면 Stop 대신 StopFailure가 온다 (research 04 §1).
    complete: event !== "StopFailure",
    error: str(p.error),
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
function truncate2(s, n) {
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
    lines.push("user: " + truncate2(t.user || "", 1200));
    lines.push("assistant: " + truncate2(t.assistantBody || "", 1200));
    if (Array.isArray(t.toolCalls) && t.toolCalls.length > 0) {
      const tc = t.toolCalls.slice(0, 5).map((c) => "  - " + (c.tool || "?") + "(" + truncate2(c.arg || "", 80) + ")").join("\n");
      lines.push("tools:");
      lines.push(tc);
    }
    if (i < turns.length - 1) lines.push("");
  }
  return lines.join("\n");
}
function buildAdditionalContext(ir, recentTurns, workspaceId, globalBlock) {
  const hasTurns = Array.isArray(recentTurns) && recentTurns.length > 0;
  const hasGlobal = !!(globalBlock && globalBlock.trim());
  if (!ir && !hasTurns && !hasGlobal) {
    return wrapInjectedContext2([
      HOOK_INSTRUCTIONS,
      "",
      "## AgentBridge context (memory uninitialized)",
      "Workspace " + workspaceId + " has no compacted memory (IR) or turn history yet.",
      "This hook will accumulate from the next turn onward and compact into an IR."
    ].join("\n"));
  }
  const parts = [HOOK_INSTRUCTIONS, ""];
  if (hasGlobal) {
    parts.push(globalBlock);
    parts.push("");
  }
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
  } else if (hasTurns) {
    parts.push("## Memory (IR uninitialized \u2014 only recent turns available)");
    parts.push("");
  }
  if (hasTurns) {
    parts.push("## Recent conversation (raw, last " + recentTurns.length + " turns, newest first)");
    parts.push(renderRecentTurns(recentTurns.slice().reverse()));
  }
  return wrapInjectedContext2(parts.join("\n"));
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
      return fs.realpathSync(v);
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
  const irPath = path.join(wsDir, "ir.json");
  const turnsPath = path.join(wsDir, "turns.jsonl");
  const ir = readJsonSafe(irPath);
  const recentTurns = readRecentTurns(turnsPath, 3);
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
      fs.mkdirSync(dir, { recursive: true });
      const out = path.join(dir, "captured.json");
      const tmp = out + "." + process.pid + ".tmp";
      fs.writeFileSync(
        tmp,
        JSON.stringify({
          agent: parsed.agent,
          modelSessionId: sid,
          ppid: process.ppid,
          capturedAt: Date.now()
        })
      );
      fs.renameSync(tmp, out);
    }
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    process.stderr.write("agentbridge-memory: capture write skipped \u2014 " + msg + "\n");
    writeHookError(wsDir, parsed.agent, parsed.event, "\uC138\uC158 id \uCEA1\uCC98 \uC2E4\uD328 \u2014 " + msg);
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
        fs.mkdirSync(dir, { recursive: true });
        const out = path.join(dir, "turn-signal.json");
        const tmp = out + "." + process.pid + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(buildTurnSignal(parsed.agent, parsed.event, payload)));
        fs.renameSync(tmp, out);
      }
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      process.stderr.write("agentbridge-memory: turn signal write skipped \u2014 " + msg + "\n");
      writeHookError(wsDir, parsed.agent, parsed.event, "\uD134 \uC885\uB8CC \uC2E0\uD638 \uC4F0\uAE30 \uC2E4\uD328 \u2014 " + msg);
    }
    process.stdout.write(JSON.stringify(buildTerminationOutput(parsed.agent)));
    process.exit(0);
  }
  let globalBlock = "";
  try {
    const lastTurn = recentTurns.length ? recentTurns[recentTurns.length - 1] : null;
    const lastUserTurn = lastTurn && typeof lastTurn.user === "string" ? lastTurn.user : "";
    const query = resolveQuery2(stdinRaw, lastUserTurn);
    if (query && query.trim()) {
      const globalDir = path.join(storageRoot, "global");
      const matches = await resolveContext2(globalDir, "default", query, { topN: 5 });
      globalBlock = renderGlobalMatches2(matches);
    }
  } catch (e) {
    process.stderr.write(
      "agentbridge-memory: global search skipped \u2014 " + String(e && e.message ? e.message : e) + "\n"
    );
    globalBlock = "";
  }
  const INJECT_BYTE_LIMIT = 9 * 1024;
  let injTurns = recentTurns;
  let additionalContext = buildAdditionalContext(ir, injTurns, path.basename(wsDir), globalBlock);
  while (Buffer.byteLength(additionalContext, "utf8") > INJECT_BYTE_LIMIT && injTurns.length > 0) {
    injTurns = injTurns.slice(1);
    additionalContext = buildAdditionalContext(ir, injTurns, path.basename(wsDir), globalBlock);
  }
  process.stdout.write(
    JSON.stringify(buildHookOutput(parsed.agent, parsed.event, additionalContext))
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
