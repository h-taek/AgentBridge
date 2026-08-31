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

// packages/core/src/irStore.ts
async function readIR(workspaceRoot) {
  const irPath = (0, import_path.join)(workspaceRoot, "ir.json");
  try {
    const raw = await import_fs.promises.readFile(irPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !("meta" in parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}
var import_fs, import_path;
var init_irStore = __esm({
  "packages/core/src/irStore.ts"() {
    "use strict";
    import_fs = require("fs");
    import_path = require("path");
  }
});

// packages/core/src/shared/turns.ts
var TURN_CAP, COMPACTION_TRIGGER, TURNS_ROTATE;
var init_turns = __esm({
  "packages/core/src/shared/turns.ts"() {
    "use strict";
    TURN_CAP = {
      userBytes: 8 * 1024,
      assistantBodyChars: 500,
      toolCallArgChars: 500
    };
    COMPACTION_TRIGGER = {
      countThreshold: 6,
      bytesThreshold: 192 * 1024,
      keepRecent: 3
    };
    TURNS_ROTATE = {
      maxBytes: 5 * 1024 * 1024,
      maxRecords: 1e3
    };
  }
});

// packages/core/src/interfaces.ts
var noopLogger;
var init_interfaces = __esm({
  "packages/core/src/interfaces.ts"() {
    "use strict";
    noopLogger = {
      log: () => {
      },
      warn: () => {
      }
    };
  }
});

// packages/core/src/turnsStore.ts
function turnsPath(workspaceRoot) {
  return (0, import_path2.join)(workspaceRoot, "turns.jsonl");
}
function deserialize(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (!obj || typeof obj !== "object" || typeof obj.id !== "string") return null;
    return obj;
  } catch {
    return null;
  }
}
async function readAllTurns(workspaceRoot) {
  const p = turnsPath(workspaceRoot);
  let raw;
  try {
    raw = await import_fs2.promises.readFile(p, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const line of raw.split("\n")) {
    const t = deserialize(line);
    if (t) out.push(t);
  }
  return out;
}
var import_fs2, import_path2;
var init_turnsStore = __esm({
  "packages/core/src/turnsStore.ts"() {
    "use strict";
    import_fs2 = require("fs");
    import_path2 = require("path");
    init_turns();
    init_interfaces();
  }
});

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
function getStorageRoot() {
  return (0, import_path3.join)((0, import_os.homedir)(), "agentbridge");
}
var import_os, import_path3;
var init_storageRoot = __esm({
  "packages/core/src/storageRoot.ts"() {
    "use strict";
    import_os = require("os");
    import_path3 = require("path");
  }
});

// packages/core/src/globalPaths.ts
function getGlobalDir(rootOverride) {
  return (0, import_node_path.join)(rootOverride ?? getStorageRoot(), "global");
}
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
function proposalsDir(globalDir, profileId, scope = "user") {
  return (0, import_node_path.join)(profileDir(globalDir, profileId, scope), "proposals");
}
var import_node_path, DEFAULT_PROFILE_ID;
var init_globalPaths = __esm({
  "packages/core/src/globalPaths.ts"() {
    "use strict";
    import_node_path = require("node:path");
    init_storageRoot();
    DEFAULT_PROFILE_ID = "default";
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
function slugify(value) {
  const s = String(value || "").trim().toLowerCase().replace(/[^a-z0-9가-힣]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return s || "doc";
}
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
function resolveProfile(_workspaceId) {
  return DEFAULT_PROFILE_ID;
}
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

// packages/core/src/workspaceId.ts
function canonicalWorkspacePath(folderFsPath) {
  let canonical;
  try {
    canonical = (0, import_fs3.realpathSync)(folderFsPath);
  } catch {
    canonical = (0, import_path4.resolve)(folderFsPath);
  }
  return canonical.normalize("NFC");
}
var import_fs3, import_path4;
var init_workspaceId = __esm({
  "packages/core/src/workspaceId.ts"() {
    "use strict";
    import_fs3 = require("fs");
    import_path4 = require("path");
  }
});

// packages/core/src/gitRemote.ts
function normalizeRemoteUrl(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return "";
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  s = s.replace(/^[^@/]+@/, "");
  s = s.replace(/:(\d+)\//, "/");
  s = s.replace(/:/, "/");
  s = s.replace(/\/+$/, "");
  s = s.replace(/\.git$/i, "");
  s = s.replace(/\/+$/, "");
  s = s.replace(/\/{2,}/g, "/");
  return s.toLowerCase();
}
function profileIdForRemote(normalized) {
  const digest = (0, import_node_crypto.createHash)("sha256").update(normalized, "utf8").digest("hex").slice(0, PROFILE_DIGEST_LEN);
  const tail = normalized.split("/").filter(Boolean).slice(-2).join("-");
  const name = tail.replace(/[^a-z0-9._-]+/gi, "-").replace(/^[.\-]+/, "").replace(/[.\-]+$/, "").slice(0, MAX_NAME_LEN);
  return `${name || "repo"}-${digest}`;
}
function profileIdForPath(folderFsPath) {
  const canonical = canonicalWorkspacePath(folderFsPath);
  const digest = (0, import_node_crypto.createHash)("sha256").update(canonical, "utf8").digest("hex").slice(0, PROFILE_DIGEST_LEN);
  const name = (canonical.split("/").filter(Boolean).pop() ?? "").replace(/[^a-z0-9._-]+/gi, "-").replace(/^[.\-]+/, "").replace(/[.\-]+$/, "").slice(0, MAX_NAME_LEN);
  return `${name || "project"}-${digest}`;
}
async function resolveProjectProfileId(cwd, opts = {}) {
  const log = opts.logger ?? noopLogger;
  const read = opts.readRemote ?? readOriginUrl;
  let url = null;
  try {
    url = await read(cwd);
  } catch (err) {
    log.warn(`gitRemote: origin \uC870\uD68C \uC2E4\uD328 \u2014 ${err instanceof Error ? err.message : String(err)}`);
  }
  const normalized = url ? normalizeRemoteUrl(url) : "";
  return normalized ? profileIdForRemote(normalized) : profileIdForPath(cwd);
}
var import_node_child_process, import_node_crypto, GIT_TIMEOUT_MS, PROFILE_DIGEST_LEN, MAX_NAME_LEN, readOriginUrl;
var init_gitRemote = __esm({
  "packages/core/src/gitRemote.ts"() {
    "use strict";
    import_node_child_process = require("node:child_process");
    import_node_crypto = require("node:crypto");
    init_workspaceId();
    init_interfaces();
    GIT_TIMEOUT_MS = 3e3;
    PROFILE_DIGEST_LEN = 8;
    MAX_NAME_LEN = 48;
    readOriginUrl = (cwd) => new Promise((resolve2) => {
      (0, import_node_child_process.execFile)(
        "git",
        ["config", "--get", "remote.origin.url"],
        { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true },
        (err, stdout) => {
          if (err) return resolve2(null);
          const v = String(stdout ?? "").trim();
          resolve2(v || null);
        }
      );
    });
  }
});

// packages/core/src/globalSearch.ts
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
  const docs = await readProfileDocs(globalDir, profileId, opts?.scope ?? "user");
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

// packages/core/src/agentCli/irRender.ts
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

// packages/core/src/agentCli/read.ts
var read_exports = {};
__export(read_exports, {
  readContext: () => readContext,
  readMemory: () => readMemory,
  readTurns: () => readTurns,
  resolveProfileIdForScope: () => resolveProfileIdForScope,
  searchMemory: () => searchMemory
});
async function readContext(wsDir) {
  const ir = await readIR(wsDir);
  if (!ir) return "\uC800\uC7A5\uB41C \uC791\uC5C5 \uC0C1\uD0DC\uAC00 \uC5C6\uB2E4. \uC544\uC9C1 \uC555\uCD95\uB41C \uB9E5\uB77D\uC774 \uC313\uC774\uC9C0 \uC54A\uC558\uB2E4.";
  return `## \uC791\uC5C5 \uC0C1\uD0DC (\uC555\uCD95\uB41C \uB9E5\uB77D)

${renderIrSections(ir)}`;
}
async function readTurns(wsDir, lastN) {
  const all = await readAllTurns(wsDir);
  if (all.length === 0) return "\uAE30\uB85D\uB41C \uD134\uC774 \uC5C6\uB2E4.";
  const turns = all.slice(-lastN);
  const lines = [`## \uCD5C\uADFC \uB300\uD654 \uC6D0\uBB38 (${turns.length}\uD134, \uC624\uB798\uB41C \uAC83\uBD80\uD130)`, ""];
  for (const t of turns) {
    lines.push(`[${t.model || "?"} \xB7 ${t.completedAt || ""}]`);
    lines.push(`user: ${t.user || ""}`);
    lines.push(`assistant: ${t.assistantBody || ""}`);
    if (Array.isArray(t.toolCalls) && t.toolCalls.length > 0) {
      lines.push("tools:");
      for (const c of t.toolCalls) lines.push(`  - ${c.tool || "?"}(${c.arg || ""})`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
async function resolveProfileIdForScope(wsDir, scope) {
  return scope === "project" ? resolveProjectId(wsDir) : resolveProfile(basenameOf(wsDir));
}
async function resolveProjectId(wsDir) {
  try {
    const raw = await import_fs4.promises.readFile((0, import_path5.join)(wsDir, "workspace.json"), "utf8");
    const workspacePath = JSON.parse(raw)?.workspacePath;
    if (typeof workspacePath !== "string" || !workspacePath) return null;
    return await resolveProjectProfileId(workspacePath);
  } catch {
    return null;
  }
}
function docId(rec) {
  return `${rec.category}/${rec.slug}`;
}
function renderDocs(docs, full) {
  const byCategory = /* @__PURE__ */ new Map();
  for (const d of docs) {
    if (!byCategory.has(d.category)) byCategory.set(d.category, []);
    byCategory.get(d.category).push(d);
  }
  const lines = [];
  for (const category of [...byCategory.keys()].sort()) {
    lines.push(`### ${category}`);
    for (const d of byCategory.get(category)) {
      lines.push(`- ${docId(d)} \u2014 ${d.title}`);
      if (d.summary) lines.push(`  ${d.summary}`);
      if (full && d.body) lines.push(`  ${d.body.split("\n").join("\n  ")}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
async function readMemory(storageRoot, wsDir, scope, full) {
  const globalDir = getGlobalDir(storageRoot);
  const profileId = await resolveProfileIdForScope(wsDir, scope);
  if (!profileId) return "\uC774 \uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4\uC758 \uD504\uB85C\uC81D\uD2B8 \uC9C0\uC2DD \uC790\uB9AC\uB97C \uCC3E\uC744 \uC218 \uC5C6\uB2E4.";
  const docs = await readProfileDocs(globalDir, profileId, scope).catch(() => []);
  if (docs.length === 0) return `${SCOPE_LABEL[scope]}\uC774 \uC544\uC9C1 \uC5C6\uB2E4.`;
  const head = full ? `## ${SCOPE_LABEL[scope]} (${docs.length}\uAC74, \uC804\uBB38)` : `## ${SCOPE_LABEL[scope]} (${docs.length}\uAC74, \uC694\uC57D)

\uC904 \uC55E\uC758 \uAC12\uC774 \uC2DD\uBCC4\uC790\uB2E4. \uC804\uBB38\uC740 --full\uB85C \uBCF8\uB2E4.`;
  return `${head}

${renderDocs(docs, full)}`;
}
function basenameOf(p) {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
async function searchMemory(storageRoot, wsDir, query) {
  const globalDir = getGlobalDir(storageRoot);
  const userId = resolveProfile(basenameOf(wsDir));
  const projectId = await resolveProfileIdForScope(wsDir, "project");
  const [user, project] = await Promise.all([
    resolveContext(globalDir, userId, query, { topN: 5 }).catch(() => []),
    projectId ? resolveContext(globalDir, projectId, query, { topN: 5, scope: "project" }).catch(() => []) : Promise.resolve([])
  ]);
  if (user.length === 0 && project.length === 0) return `"${query}"\uC5D0 \uAC78\uB9AC\uB294 \uC9C0\uC2DD\uC774 \uC5C6\uB2E4.`;
  const lines = [`## "${query}" \uAC80\uC0C9 \uACB0\uACFC`, ""];
  for (const [scope, matches] of [
    ["user", user],
    ["project", project]
  ]) {
    if (matches.length === 0) continue;
    lines.push(`### ${SCOPE_LABEL[scope]}`);
    for (const m of matches) {
      lines.push(`- ${m.category}/${m.slug} \u2014 ${m.title}`);
      if (m.summary) lines.push(`  ${m.summary}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
var import_fs4, import_path5, SCOPE_LABEL;
var init_read = __esm({
  "packages/core/src/agentCli/read.ts"() {
    "use strict";
    import_fs4 = require("fs");
    import_path5 = require("path");
    init_irStore();
    init_turnsStore();
    init_globalStore();
    init_globalPaths();
    init_gitRemote();
    init_globalSearch();
    init_irRender();
    SCOPE_LABEL = { user: "\uC0AC\uC6A9\uC790 \uC9C0\uC2DD", project: "\uD504\uB85C\uC81D\uD2B8 \uC9C0\uC2DD" };
  }
});

// packages/core/src/proposalStore.ts
function dedupKey(category, title) {
  return `${category}::${title.trim().toLowerCase()}`;
}
function shortHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).padStart(7, "0").slice(0, 7);
}
function proposalId(category, title) {
  return `${category}__${slugify(title)}__${shortHash(dedupKey(category, title))}`;
}
function clampLen(s, cap) {
  return typeof s === "string" && s.length > cap ? s.slice(0, cap) : s || "";
}
async function readProposals(globalDir, profileId, scope = "user") {
  const dir = proposalsDir(globalDir, profileId, scope);
  let files;
  try {
    files = await import_node_fs2.promises.readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files.filter((f2) => f2.endsWith(".json")).sort()) {
    try {
      const raw = await import_node_fs2.promises.readFile((0, import_node_path3.join)(dir, f), "utf8");
      const obj = JSON.parse(raw);
      if (obj && typeof obj.title === "string" && typeof obj.category === "string") out.push(obj);
    } catch {
    }
  }
  return out;
}
async function writeProposals(globalDir, profileId, inputs, opts, scope = "user") {
  const dir = proposalsDir(globalDir, profileId, scope);
  await import_node_fs2.promises.mkdir(dir, { recursive: true });
  const seen = /* @__PURE__ */ new Set();
  for (const p of await readProposals(globalDir, profileId, scope)) seen.add(dedupKey(p.category, p.title));
  for (const d of opts.existingDocTitles) seen.add(dedupKey(d.category, d.title));
  const written = [];
  const skipped = [];
  let n = 0;
  for (const inp of inputs) {
    if (n >= PROPOSAL_CAPS.maxPerPass) {
      skipped.push(inp);
      continue;
    }
    const key = dedupKey(inp.category, inp.title);
    if (seen.has(key) && !inp.targetSlug) {
      skipped.push(inp);
      continue;
    }
    seen.add(key);
    const rec = {
      id: proposalId(inp.category, inp.title),
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      category: inp.category,
      // 어느 프로필로 갈지는 이미 정해졌지만, 무엇으로 판단해 여기 왔는지를 함께 남긴다 —
      // 패널이 표시하고, 나중에 재분류가 필요할 때 근거가 된다.
      ...inp.scope ? { scope: inp.scope } : {},
      title: clampLen(inp.title, PROPOSAL_CAPS.title),
      summary: clampLen(inp.summary, PROPOSAL_CAPS.summary),
      body: clampLen(inp.body, PROPOSAL_CAPS.body),
      confidence: typeof inp.confidence === "number" ? Math.max(0, Math.min(1, inp.confidence)) : 0.5,
      ...inp.indexEntries?.length ? { indexEntries: inp.indexEntries.slice(0, DOC_CAPS.indexEntries) } : {},
      ...inp.targetSlug ? { targetSlug: inp.targetSlug } : {}
    };
    await import_node_fs2.promises.writeFile((0, import_node_path3.join)(dir, `${rec.id}.json`), JSON.stringify(rec, null, 2) + "\n", "utf8");
    written.push(rec);
    n++;
  }
  return { written, skipped };
}
var import_node_fs2, import_node_path3;
var init_proposalStore = __esm({
  "packages/core/src/proposalStore.ts"() {
    "use strict";
    import_node_fs2 = require("node:fs");
    import_node_path3 = require("node:path");
    init_globalPaths();
    init_globalMarkdown();
    init_globalStore();
    init_global();
  }
});

// packages/core/src/agentCli/write.ts
var write_exports = {};
__export(write_exports, {
  WriteError: () => WriteError,
  addMemory: () => addMemory,
  updateMemory: () => updateMemory
});
function assertCategory(v) {
  if (!v || !GLOBAL_CATEGORIES.includes(v)) {
    throw new WriteError(`--category\uB294 \uB2E4\uC74C \uC911 \uD558\uB098\uB2E4: ${GLOBAL_CATEGORIES.join(", ")}`);
  }
  return v;
}
async function addMemory(storageRoot, profileId, scope, category, fields) {
  const cat = assertCategory(category);
  for (const [name, v] of [
    ["--title", fields.title],
    ["--summary", fields.summary],
    ["--body", fields.body]
  ]) {
    if (!v || !v.trim()) throw new WriteError(`${name}\uC774(\uAC00) \uBE44\uC5B4 \uC788\uB2E4`);
  }
  const globalDir = getGlobalDir(storageRoot);
  const docs = await readProfileDocs(globalDir, profileId, scope).catch(() => []);
  const { written, skipped } = await writeProposals(
    globalDir,
    profileId,
    [{
      category: cat,
      scope,
      title: fields.title.trim(),
      summary: fields.summary.trim(),
      body: fields.body.trim(),
      confidence: MODEL_WRITE_CONFIDENCE
    }],
    { existingDocTitles: docs.map((d) => ({ category: d.category, title: d.title })) },
    scope
  );
  if (skipped.length > 0) {
    return `\uAC19\uC740 \uC81C\uBAA9\uC774 \uC774\uBBF8 \uC788\uB2E4. \uACE0\uCE58\uB824\uBA74 memory update <\uC2DD\uBCC4\uC790>\uB97C \uC4F4\uB2E4.`;
  }
  return `\uC81C\uC548 \uD050\uC5D0 \uB123\uC5C8\uB2E4 (${written[0].id}). \uC0AC\uC6A9\uC790\uAC00 \uC2B9\uC778\uD574\uC57C \uC9C0\uC2DD\uC774 \uB41C\uB2E4.`;
}
function parseDocId(id) {
  const i = id.indexOf("/");
  if (i <= 0 || i === id.length - 1) {
    throw new WriteError("\uC2DD\uBCC4\uC790\uB294 <\uCE74\uD14C\uACE0\uB9AC>/<slug> \uD615\uC2DD\uC774\uB2E4. memory user\uB85C \uBAA9\uB85D\uC744 \uBCF8\uB2E4");
  }
  return { category: id.slice(0, i), slug: id.slice(i + 1) };
}
async function updateMemory(storageRoot, profileId, scope, id, fields) {
  const { category, slug } = parseDocId(id);
  const globalDir = getGlobalDir(storageRoot);
  const docs = await readProfileDocs(globalDir, profileId, scope).catch(() => []);
  const target = docs.find(
    (d) => d.category === category && d.slug === slug
  );
  if (!target) throw new WriteError(`${id}\uC5D0 \uD574\uB2F9\uD558\uB294 \uD56D\uBAA9\uC774 \uC5C6\uB2E4. memory user\uB85C \uBAA9\uB85D\uC744 \uBCF8\uB2E4`);
  const { written } = await writeProposals(
    globalDir,
    profileId,
    [{
      category: target.category,
      scope,
      title: (fields.title ?? target.title).trim(),
      summary: (fields.summary ?? target.summary).trim(),
      body: (fields.body ?? target.body).trim(),
      confidence: MODEL_WRITE_CONFIDENCE,
      ...target.indexEntries.length ? { indexEntries: target.indexEntries } : {},
      targetSlug: target.slug
    }],
    { existingDocTitles: [] },
    scope
  );
  return `\uACE0\uCE68 \uC81C\uC548\uC744 \uD050\uC5D0 \uB123\uC5C8\uB2E4 (${written[0].id} \u2192 ${id}). \uC0AC\uC6A9\uC790\uAC00 \uC2B9\uC778\uD574\uC57C \uBC18\uC601\uB41C\uB2E4.`;
}
var WriteError, MODEL_WRITE_CONFIDENCE;
var init_write = __esm({
  "packages/core/src/agentCli/write.ts"() {
    "use strict";
    init_global();
    init_globalPaths();
    init_globalStore();
    init_proposalStore();
    WriteError = class extends Error {
    };
    MODEL_WRITE_CONFIDENCE = 1;
  }
});

// packages/core/bin/agentbridge.js
var fs3 = require("fs");
var path = require("path");
var {
  readContext: readContext2,
  readTurns: readTurns2,
  readMemory: readMemory2,
  searchMemory: searchMemory2,
  resolveProfileIdForScope: resolveProfileIdForScope2
} = (init_read(), __toCommonJS(read_exports));
var { addMemory: addMemory2, updateMemory: updateMemory2, WriteError: WriteError2 } = (init_write(), __toCommonJS(write_exports));
var DEFAULT_TURNS = 3;
var COMMANDS = [
  ["context", "\uD604\uC7AC \uD504\uB85C\uC81D\uD2B8\uC758 \uC555\uCD95\uB41C \uC791\uC5C5 \uC0C1\uD0DC"],
  ["turns [--last N]", "\uCD5C\uADFC \uB300\uD654 \uC6D0\uBB38 (\uAE30\uBCF8 " + DEFAULT_TURNS + "\uD134)"],
  ["memory user [--full]", "\uC0AC\uC6A9\uC790 \uC9C0\uC2DD. \uAE30\uBCF8\uC740 \uC694\uC57D, --full\uC774 \uC804\uBB38"],
  ["memory project [--full]", "\uC774 \uC800\uC7A5\uC18C\uC758 \uD504\uB85C\uC81D\uD2B8 \uC9C0\uC2DD"],
  ["memory search <\uC9C8\uC758>", "\uB450 \uC9C0\uC2DD\uC744 \uC9C8\uC758\uB85C \uAC80\uC0C9"],
  ["memory add", "\uC0C8 \uC0AC\uC2E4\uC744 \uC81C\uC548 \uD050\uC5D0 \uB123\uB294\uB2E4 (--scope --category --title --summary --body)"],
  ["memory update <\uC2DD\uBCC4\uC790>", "\uC774\uBBF8 \uC788\uB294 \uD56D\uBAA9\uC744 \uACE0\uCE58\uB294 \uC81C\uC548 (\uAC19\uC740 \uC778\uC790, \uC548 \uC900 \uAC83\uC740 \uADF8\uB300\uB85C)"]
];
var USAGE = [
  "agentbridge \u2014 AgentBridge \uB9E5\uB77D \uC77D\uAE30",
  "",
  "\uC0AC\uC6A9\uBC95: agentbridge <\uBA85\uB839>",
  "",
  ...COMMANDS.map(([name, desc]) => "  " + name.padEnd(26) + desc)
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
    return fs3.realpathSync(v);
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
function intOption(args, name, fallback) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const n = Number(args[i + 1]);
  if (!Number.isInteger(n) || n <= 0) fail(name + "\uC5D0\uB294 1 \uC774\uC0C1\uC758 \uC815\uC218\uAC00 \uC628\uB2E4");
  return n;
}
function strOption(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return void 0;
  const v = args[i + 1];
  if (v === void 0 || v.startsWith("--")) fail(name + "\uC5D0 \uAC12\uC774 \uC5C6\uB2E4");
  return v;
}
function scopeOption(args) {
  const v = strOption(args, "--scope") || "user";
  if (v !== "user" && v !== "project") fail("--scope\uB294 user \uB610\uB294 project\uB2E4");
  return v;
}
function writeFields(args) {
  return {
    title: strOption(args, "--title"),
    summary: strOption(args, "--summary"),
    body: strOption(args, "--body")
  };
}
async function dispatch(cmd, args, wsDir, storageRoot) {
  switch (cmd) {
    case "context":
      return readContext2(wsDir);
    case "turns":
      return readTurns2(wsDir, intOption(args, "--last", DEFAULT_TURNS));
    case "memory": {
      const sub = args[0];
      if (sub === "user" || sub === "project") {
        return readMemory2(storageRoot, wsDir, sub, args.includes("--full"));
      }
      if (sub === "search") {
        const query = args.slice(1).join(" ").trim();
        if (!query) fail("memory search\uC5D0\uB294 \uC9C8\uC758\uAC00 \uC628\uB2E4");
        return searchMemory2(storageRoot, wsDir, query);
      }
      if (sub === "add" || sub === "update") {
        const scope = scopeOption(args);
        const profileId = await resolveProfileIdForScope2(wsDir, scope);
        if (!profileId) fail("\uC774 \uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4\uC758 \uD504\uB85C\uC81D\uD2B8 \uC9C0\uC2DD \uC790\uB9AC\uB97C \uCC3E\uC744 \uC218 \uC5C6\uB2E4");
        if (sub === "add") {
          return addMemory2(storageRoot, profileId, scope, strOption(args, "--category"), writeFields(args));
        }
        const id = args[1];
        if (!id || id.startsWith("--")) fail("memory update\uC5D0\uB294 \uC2DD\uBCC4\uC790\uAC00 \uC628\uB2E4");
        return updateMemory2(storageRoot, profileId, scope, id, writeFields(args));
      }
      return usageAndExit();
    }
    default:
      return usageAndExit();
  }
}
async function main() {
  const cmd = process.argv[2];
  const args = process.argv.slice(3);
  const wsDir = resolveWorkspaceDir();
  if (!wsDir) {
    process.stdout.write(
      "AgentBridge: \uC774 \uC138\uC158\uC740 AgentBridge \uBC16\uC5D0\uC11C \uC5F4\uB838\uB2E4. \uB0BC \uB9E5\uB77D\uC774 \uC5C6\uB2E4.\n"
    );
    process.exit(0);
  }
  if (!cmd) usageAndExit();
  const storageRoot = realpath(path.dirname(path.dirname(__filename)));
  const out = await dispatch(cmd, args, wsDir, storageRoot);
  process.stdout.write(out + "\n");
}
main().catch((err) => {
  fail(err instanceof WriteError2 ? err.message : String(err && err.message || err));
});
