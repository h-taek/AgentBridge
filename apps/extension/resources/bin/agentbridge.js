#!/usr/bin/env node
// @agentbridge-cli-version 0.5.4
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

// packages/core/src/hostRequest.ts
function timeoutForKind(kind) {
  return LONG_KINDS.has(kind) ? LONG_TIMEOUT_MS : HOST_REQUEST_TIMEOUT_MS;
}
function hostRequestPath(sessionDir2) {
  return (0, import_path6.join)(sessionDir2, HOST_REQUEST_FILENAME);
}
function hostResultPath(sessionDir2) {
  return (0, import_path6.join)(sessionDir2, HOST_RESULT_FILENAME);
}
async function readJson(path2) {
  try {
    return JSON.parse(await import_fs5.promises.readFile(path2, "utf8"));
  } catch {
    return null;
  }
}
async function unlinkQuiet(path2) {
  try {
    await import_fs5.promises.unlink(path2);
  } catch {
  }
}
async function sendHostRequest(sessionDir2, request, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? timeoutForKind(request.kind);
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const reqPath = hostRequestPath(sessionDir2);
  const resPath = hostResultPath(sessionDir2);
  await import_fs5.promises.mkdir(sessionDir2, { recursive: true });
  await unlinkQuiet(resPath);
  try {
    await import_fs5.promises.writeFile(reqPath, JSON.stringify(request), { encoding: "utf8", flag: "wx" });
  } catch {
    return {
      id: request.id,
      ok: false,
      output: `\uB2E4\uB978 \uC694\uCCAD\uC774 \uCC98\uB9AC \uC911\uC774\uB2E4 (${request.kind}). \uC7A0\uC2DC \uB4A4 \uB2E4\uC2DC \uBD80\uB978\uB2E4.`,
      at: now()
    };
  }
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const result = await readJson(resPath);
    if (result && result.id === request.id) {
      await unlinkQuiet(resPath);
      return result;
    }
    await sleep(POLL_MS);
  }
  await unlinkQuiet(reqPath);
  return {
    id: request.id,
    ok: false,
    output: `\uD638\uC2A4\uD2B8\uAC00 ${timeoutMs}ms \uC548\uC5D0 \uB2F5\uD558\uC9C0 \uC54A\uC558\uB2E4 (${request.kind}).`,
    at: now()
  };
}
var import_fs5, import_path6, HOST_REQUEST_FILENAME, HOST_RESULT_FILENAME, HOST_REQUEST_TIMEOUT_MS, POLL_MS, HOST_PING, HOST_AGENT_START, HOST_AGENT_SEND, HOST_AGENT_STOP, HOST_AGENT_CLOSE, HOST_AGENT_MERGE, HOST_MEMORY_WRITE, LONG_KINDS, LONG_TIMEOUT_MS, defaultSleep;
var init_hostRequest = __esm({
  "packages/core/src/hostRequest.ts"() {
    "use strict";
    import_fs5 = require("fs");
    import_path6 = require("path");
    HOST_REQUEST_FILENAME = "host-request.json";
    HOST_RESULT_FILENAME = "host-result.json";
    HOST_REQUEST_TIMEOUT_MS = 1e4;
    POLL_MS = 50;
    HOST_PING = "status-ping";
    HOST_AGENT_START = "agent-start";
    HOST_AGENT_SEND = "agent-send";
    HOST_AGENT_STOP = "agent-stop";
    HOST_AGENT_CLOSE = "agent-close";
    HOST_AGENT_MERGE = "agent-merge";
    HOST_MEMORY_WRITE = "memory-write";
    LONG_KINDS = /* @__PURE__ */ new Set([HOST_AGENT_START, HOST_AGENT_CLOSE, HOST_AGENT_MERGE]);
    LONG_TIMEOUT_MS = 3e4;
    defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  applyMemoryWrite: () => applyMemoryWrite,
  parseMemoryWriteRequest: () => parseMemoryWriteRequest,
  requestMemoryWrite: () => requestMemoryWrite,
  updateMemory: () => updateMemory
});
function assertCategory(v) {
  if (!v || !GLOBAL_CATEGORIES.includes(v)) {
    throw new WriteError(`--category\uB294 \uB2E4\uC74C \uC911 \uD558\uB098\uB2E4: ${GLOBAL_CATEGORIES.join(", ")}`);
  }
  return v;
}
function assertFilled(fields) {
  for (const [name, v] of [
    ["--title", fields.title],
    ["--summary", fields.summary],
    ["--body", fields.body]
  ]) {
    if (!v || !v.trim()) throw new WriteError(`${name}\uC774(\uAC00) \uBE44\uC5B4 \uC788\uB2E4`);
  }
}
async function addMemory(storageRoot, profileId, scope, category, fields) {
  const cat = assertCategory(category);
  assertFilled(fields);
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
function optionalString(v, label) {
  if (v === void 0 || v === null) return void 0;
  if (typeof v !== "string") throw new WriteError(`${label}\uC740(\uB294) \uBB38\uC790\uC5F4\uC774\uB2E4`);
  return v;
}
function parseMemoryWriteRequest(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new WriteError("\uC4F0\uAE30 \uC694\uCCAD\uC758 \uBAA8\uC591\uC774 \uC544\uB2C8\uB2E4");
  }
  const p = payload;
  if (p.op !== "add" && p.op !== "update") throw new WriteError(`\uC54C \uC218 \uC5C6\uB294 \uC4F0\uAE30 \uC885\uB958\uB2E4`);
  if (p.scope !== "user" && p.scope !== "project") throw new WriteError("--scope\uB294 user \uB610\uB294 project\uB2E4");
  if (typeof p.profileId !== "string" || !p.profileId) throw new WriteError("\uD504\uB85C\uD544 \uC790\uB9AC\uAC00 \uC5C6\uB2E4");
  const id = optionalString(p.id, "id");
  if (p.op === "update") {
    if (!id) throw new WriteError("\uACE0\uCE60 \uD56D\uBAA9\uC758 \uC2DD\uBCC4\uC790\uAC00 \uC5C6\uB2E4");
    parseDocId(id);
  }
  const rawFields = p.fields ?? {};
  if (typeof rawFields !== "object" || Array.isArray(rawFields)) throw new WriteError("\uD544\uB4DC\uC758 \uBAA8\uC591\uC774 \uC544\uB2C8\uB2E4");
  const fields = {
    title: optionalString(rawFields.title, "--title"),
    summary: optionalString(rawFields.summary, "--summary"),
    body: optionalString(rawFields.body, "--body")
  };
  let category = optionalString(p.category, "--category");
  if (p.op === "add") {
    category = assertCategory(category);
    assertFilled(fields);
  }
  return { op: p.op, scope: p.scope, profileId: p.profileId, category, id, fields };
}
function applyMemoryWrite(storageRoot, req) {
  if (req.op === "add") {
    return addMemory(storageRoot, req.profileId, req.scope, req.category, req.fields);
  }
  return updateMemory(storageRoot, req.profileId, req.scope, req.id, req.fields);
}
async function requestMemoryWrite(sessionDir2, raw) {
  const req = parseMemoryWriteRequest(raw);
  if (!sessionDir2) {
    throw new WriteError("\uC774 \uC138\uC158\uC758 \uC790\uB9AC\uB97C \uC54C \uC218 \uC5C6\uC5B4 \uC4F0\uAE30\uB97C \uB118\uAE30\uC9C0 \uBABB\uD588\uB2E4. \uC571 \uC548\uC5D0\uC11C \uBD80\uB978\uB2E4.");
  }
  const result = await sendHostRequest(sessionDir2, {
    id: `mem-${process.pid}-${Date.now()}`,
    kind: HOST_MEMORY_WRITE,
    at: Date.now(),
    payload: req
  });
  if (!result.ok) throw new WriteError(result.output);
  return result.output;
}
var WriteError, MODEL_WRITE_CONFIDENCE;
var init_write = __esm({
  "packages/core/src/agentCli/write.ts"() {
    "use strict";
    init_global();
    init_hostRequest();
    init_globalPaths();
    init_globalStore();
    init_proposalStore();
    WriteError = class extends Error {
    };
    MODEL_WRITE_CONFIDENCE = 1;
  }
});

// packages/core/src/shellQuote.ts
var init_shellQuote = __esm({
  "packages/core/src/shellQuote.ts"() {
    "use strict";
  }
});

// packages/core/src/cliGlobalDirs.ts
var init_cliGlobalDirs = __esm({
  "packages/core/src/cliGlobalDirs.ts"() {
    "use strict";
  }
});

// packages/core/src/hookInstaller.ts
async function readFileSafe(filePath) {
  try {
    return await import_fs6.promises.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}
function isObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isManaged(v) {
  return isObject(v) && v[MANAGED_FLAG] === true;
}
async function readJsonObject(path2) {
  const raw = await readFileSafe(path2);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function globalHookPaths(homeDir) {
  const home = homeDir ?? (0, import_os2.homedir)();
  return {
    claude: (0, import_path7.join)(home, ".claude", "settings.json"),
    codex: (0, import_path7.join)(home, ".codex", "hooks.json"),
    agy: (0, import_path7.join)(home, ".gemini", "config", "hooks.json")
  };
}
function stripOurHooks(agent, root) {
  const next = { ...root };
  let changed = false;
  if (agent === "agy") {
    if (!isManaged(next[AGY_GROUP]) && !(AGY_GROUP in next)) return null;
    delete next[AGY_GROUP];
    return next;
  }
  const hooks = isObject(next.hooks) ? { ...next.hooks } : null;
  if (!hooks) return null;
  for (const event of Object.keys(hooks)) {
    const arr = Array.isArray(hooks[event]) ? hooks[event] : [];
    const kept = arr.filter((entry) => {
      if (agent === "codex") return !isManaged(entry);
      const inner = isObject(entry) && Array.isArray(entry.hooks) ? entry.hooks : [];
      return !inner.some(
        (h) => isObject(h) && typeof h.command === "string" && h.command.includes(CLAUDE_MARKER)
      );
    });
    if (kept.length === arr.length) continue;
    changed = true;
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (!changed) return null;
  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks;
  return next;
}
async function inspectGlobalHooks(homeDir) {
  const paths = globalHookPaths(homeDir);
  const out = [];
  for (const agent of ["claude", "codex", "agy"]) {
    const path2 = paths[agent];
    const root = await readJsonObject(path2);
    out.push({ agent, path: path2, installed: !!root && stripOurHooks(agent, root) !== null });
  }
  return out;
}
async function removeGlobalHooks(homeDir, logger = noopLogger) {
  const paths = globalHookPaths(homeDir);
  const touched = [];
  for (const agent of ["claude", "codex", "agy"]) {
    const path2 = paths[agent];
    const root = await readJsonObject(path2);
    if (!root) continue;
    const next = stripOurHooks(agent, root);
    if (!next) continue;
    const tmp = `${path2}.${process.pid}.${Date.now()}.tmp`;
    await import_fs6.promises.writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
    await import_fs6.promises.rename(tmp, path2);
    touched.push(path2);
    logger.log(`hookInstaller: ${agent} \uD6C5\uC744 \uAC77\uC5B4\uB0C8\uB2E4 \u2014 ${path2}`);
  }
  return touched;
}
var import_fs6, import_os2, import_path7, CLAUDE_MARKER, MANAGED_FLAG, AGY_GROUP;
var init_hookInstaller = __esm({
  "packages/core/src/hookInstaller.ts"() {
    "use strict";
    import_fs6 = require("fs");
    import_os2 = require("os");
    import_path7 = require("path");
    init_shellQuote();
    init_cliGlobalDirs();
    init_interfaces();
    CLAUDE_MARKER = "agentbridge-memory.js";
    MANAGED_FLAG = "_agentbridge_managed";
    AGY_GROUP = "agentbridge-memory";
  }
});

// packages/core/src/skillTemplate.ts
var SKILL_DIR_NAME;
var init_skillTemplate = __esm({
  "packages/core/src/skillTemplate.ts"() {
    "use strict";
    SKILL_DIR_NAME = "agentbridge";
  }
});

// packages/core/src/skillInstaller.ts
function skillFilePath(agent, homeDir) {
  return (0, import_path8.join)(homeDir ?? (0, import_os3.homedir)(), ...SKILL_ROOTS[agent], SKILL_DIR_NAME, "SKILL.md");
}
var import_os3, import_path8, SKILL_ROOTS;
var init_skillInstaller = __esm({
  "packages/core/src/skillInstaller.ts"() {
    "use strict";
    import_os3 = require("os");
    import_path8 = require("path");
    init_interfaces();
    init_skillTemplate();
    SKILL_ROOTS = {
      claude: [".claude", "skills"],
      codex: [".agents", "skills"],
      agy: [".gemini", "config", "skills"]
    };
  }
});

// packages/core/src/agentCli/status.ts
var status_exports = {};
__export(status_exports, {
  readStatus: () => readStatus
});
async function fileVersion(path2) {
  const name = path2.split("/").pop() ?? "";
  const re = VERSION_RES[name];
  try {
    const raw = await import_fs7.promises.readFile(path2, "utf8");
    return re ? re.exec(raw)?.[1] ?? "\uC54C \uC218 \uC5C6\uC74C" : "\uC788\uC74C";
  } catch {
    return null;
  }
}
async function exists(path2) {
  try {
    await import_fs7.promises.access(path2);
    return true;
  } catch {
    return false;
  }
}
async function readStatus(storageRoot, wsDir, opts = {}) {
  const execPath = opts.execPath ?? process.execPath;
  const cliPath = (0, import_path9.join)(storageRoot, "bin", "agentbridge.js");
  const helperPath = (0, import_path9.join)(storageRoot, "bin", "agentbridge-memory.js");
  const lines = ["## AgentBridge \uBC30\uC120", ""];
  lines.push(`\uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4  ${wsDir}`);
  lines.push(`\uB7F0\uD0C0\uC784        ${execPath}${await exists(execPath) ? "" : "  (\uC5C6\uC74C)"}`);
  lines.push(`CLI           ${cliPath}  ${await fileVersion(cliPath) ?? "\uC5C6\uC74C"}`);
  lines.push(`\uD6C5 \uD5EC\uD37C       ${helperPath}  ${await fileVersion(helperPath) ?? "\uC5C6\uC74C"}`);
  lines.push("");
  lines.push("### \uD6C5");
  for (const h of await inspectGlobalHooks(opts.homeDir)) {
    lines.push(`- ${h.agent.padEnd(7)}${h.path}  ${h.installed ? "\uAE54\uB9BC" : "\uC548 \uAE54\uB9BC"}`);
  }
  lines.push("");
  lines.push("### \uC2A4\uD0AC");
  for (const agent of AGENTS) {
    const path2 = skillFilePath(agent, opts.homeDir);
    const version = await fileVersion(path2);
    lines.push(`- ${agent.padEnd(7)}${path2}  ${version ? `\uAE54\uB9BC ${version}` : "\uC548 \uAE54\uB9BC"}`);
  }
  lines.push("");
  lines.push("### \uD638\uC2A4\uD2B8");
  if (!opts.sessionDir) {
    lines.push("- \uC138\uC158 \uC2E0\uC6D0\uC774 \uC5C6\uC5B4 \uC655\uBCF5\uC744 \uAC74\uB108\uB6F4\uB2E4.");
  } else {
    const res = await sendHostRequest(
      opts.sessionDir,
      { id: `status-${process.pid}-${Date.now()}`, kind: HOST_PING, at: Date.now() },
      { timeoutMs: opts.timeoutMs }
    );
    lines.push(res.ok ? `- \uC751\uB2F5\uD568 \u2014 ${res.output}` : `- \uC751\uB2F5 \uC5C6\uC74C \u2014 ${res.output}`);
  }
  return lines.join("\n");
}
var import_fs7, import_path9, AGENTS, VERSION_RES;
var init_status = __esm({
  "packages/core/src/agentCli/status.ts"() {
    "use strict";
    import_fs7 = require("fs");
    import_path9 = require("path");
    init_hookInstaller();
    init_skillInstaller();
    init_hostRequest();
    AGENTS = ["claude", "codex", "agy"];
    VERSION_RES = {
      "agentbridge.js": /@agentbridge-cli-version (\d+\.\d+\.\d+)/,
      "agentbridge-memory.js": /@agentbridge-helper-version (\d+\.\d+\.\d+)/,
      "SKILL.md": /@agentbridge-skill-version (\d+\.\d+\.\d+)/
    };
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
  return (0, import_path10.join)(workspaceDir, "sessions", sessionId, TURN_SIGNAL_FILENAME);
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
    raw = await import_fs8.promises.readFile(signalFilePath, "utf8");
  } catch {
    return null;
  }
  return parseTurnSignal(raw);
}
function resolveTurnStartFile(workspaceDir, sessionId) {
  return (0, import_path10.join)(workspaceDir, "sessions", sessionId, TURN_START_FILENAME);
}
function parseTurnStart(raw) {
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
  const at = typeof o.at === "number" && Number.isFinite(o.at) ? o.at : 0;
  return {
    agent,
    event,
    sessionId: str(o.sessionId),
    at
  };
}
async function readTurnStart(startFilePath) {
  let raw;
  try {
    raw = await import_fs8.promises.readFile(startFilePath, "utf8");
  } catch {
    return null;
  }
  return parseTurnStart(raw);
}
var import_fs8, import_path10, TURN_SIGNAL_FILENAME, TURN_START_FILENAME;
var init_turnSignal = __esm({
  "packages/core/src/cliAdapter/turnSignal.ts"() {
    "use strict";
    import_fs8 = require("fs");
    import_path10 = require("path");
    init_interfaces();
    init_sessionFileWatcher();
    TURN_SIGNAL_FILENAME = "turn-signal.json";
    TURN_START_FILENAME = "turn-start.json";
  }
});

// packages/core/src/sessionStatus.ts
function computeSessionActivity(input, now) {
  const { startAt, endAt, lastOutputAt, viewedAt } = input;
  const running = startAt !== void 0 && (endAt === void 0 || startAt > endAt);
  if (!running) {
    if (endAt !== void 0 && (viewedAt === void 0 || endAt > viewedAt)) return "done";
    return "idle";
  }
  const lastOutput = lastOutputAt ?? startAt;
  return now - lastOutput >= SILENCE_MS ? "unknown" : "running";
}
async function cachedRead(cache, path2, stat, read) {
  let mtimeMs;
  try {
    mtimeMs = (await stat(path2)).mtimeMs;
  } catch {
    cache.delete(path2);
    return void 0;
  }
  const cached = cache.get(path2);
  if (cached && cached.mtimeMs === mtimeMs) return cached.value;
  const value = await read(path2);
  cache.set(path2, { mtimeMs, value });
  return value;
}
async function cachedLastOutputAt(cache, path2, stat) {
  let mtimeMs;
  try {
    mtimeMs = (await stat(path2)).mtimeMs;
  } catch {
    cache.delete(path2);
    return void 0;
  }
  cache.set(path2, { mtimeMs, value: mtimeMs });
  return mtimeMs;
}
function resolveReplayLogFile(workspaceDir, sessionId) {
  return (0, import_path11.join)(workspaceDir, "sessions", sessionId, "replay.log");
}
async function readSessionActivityInputs(workspaceDir, sessionId, io = defaultIo) {
  const startFile = resolveTurnStartFile(workspaceDir, sessionId);
  const signalFile = resolveTurnSignalFile(workspaceDir, sessionId);
  const replayLogFile = resolveReplayLogFile(workspaceDir, sessionId);
  const [start, signal, lastOutputAt] = await Promise.all([
    cachedRead(startCache, startFile, io.stat, io.readTurnStart),
    cachedRead(signalCache, signalFile, io.stat, io.readTurnSignal),
    cachedLastOutputAt(outputCache, replayLogFile, io.stat)
  ]);
  return {
    startAt: start?.at,
    endAt: signal?.at,
    lastOutputAt
  };
}
var import_fs9, import_path11, SILENCE_MS, defaultIo, startCache, signalCache, outputCache;
var init_sessionStatus = __esm({
  "packages/core/src/sessionStatus.ts"() {
    "use strict";
    import_fs9 = require("fs");
    import_path11 = require("path");
    init_turnSignal();
    SILENCE_MS = 6e4;
    defaultIo = {
      stat: (path2) => import_fs9.promises.stat(path2),
      readTurnStart,
      readTurnSignal
    };
    startCache = /* @__PURE__ */ new Map();
    signalCache = /* @__PURE__ */ new Map();
    outputCache = /* @__PURE__ */ new Map();
  }
});

// packages/core/src/agent/reportState.ts
function resolveReportReadFile(workspaceDir, sessionId) {
  return (0, import_path12.join)(workspaceDir, "sessions", sessionId, REPORT_READ_FILENAME);
}
async function readReportReadAt(workspaceDir, sessionId) {
  let raw;
  try {
    raw = await import_fs10.promises.readFile(resolveReportReadFile(workspaceDir, sessionId), "utf8");
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
  await import_fs10.promises.mkdir((0, import_path12.join)(workspaceDir, "sessions", sessionId), { recursive: true });
  await import_fs10.promises.writeFile(tmp, JSON.stringify({ at }), "utf8");
  await import_fs10.promises.rename(tmp, target);
}
async function isUnread(workspaceDir, sessionId) {
  const signal = await readTurnSignal(resolveTurnSignalFile(workspaceDir, sessionId));
  if (!signal || !signal.complete) return false;
  const readAt = await readReportReadAt(workspaceDir, sessionId);
  return signal.at > readAt;
}
var import_fs10, import_path12, REPORT_READ_FILENAME;
var init_reportState = __esm({
  "packages/core/src/agent/reportState.ts"() {
    "use strict";
    import_fs10 = require("fs");
    import_path12 = require("path");
    init_turnSignal();
    REPORT_READ_FILENAME = "report-read.json";
  }
});

// packages/core/src/agent/gitWorktree.ts
var GIT_MAX_BUFFER;
var init_gitWorktree = __esm({
  "packages/core/src/agent/gitWorktree.ts"() {
    "use strict";
    GIT_MAX_BUFFER = 16 * 1024 * 1024;
  }
});

// packages/core/src/agent/cleanup.ts
async function worktreeExists(treePath) {
  try {
    const stat = await import_fs11.promises.stat(treePath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}
function resolveTreePath(workspaceDir, name) {
  return (0, import_path13.join)(workspaceDir, "trees", name);
}
var import_fs11, import_path13;
var init_cleanup = __esm({
  "packages/core/src/agent/cleanup.ts"() {
    "use strict";
    import_fs11 = require("fs");
    import_path13 = require("path");
    init_gitWorktree();
  }
});

// packages/core/src/agent/diffMerge.ts
function runGit(cwd, args, opts = {}) {
  return new Promise((resolve2, reject) => {
    (0, import_node_child_process2.execFile)(
      "git",
      args,
      {
        cwd,
        timeout: opts.timeout ?? GIT_TIMEOUT_MS2,
        windowsHide: true,
        maxBuffer: GIT_MAX_BUFFER2,
        env: opts.env ? { ...process.env, ...opts.env } : process.env
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr ?? "").trim() || err.message;
          reject(new Error(`git ${args.join(" ")} \uC2E4\uD328 \u2014 ${detail}`));
          return;
        }
        resolve2(String(stdout ?? ""));
      }
    );
  });
}
async function snapshotAgainst(dir, base) {
  const scratch = await import_node_fs3.promises.mkdtemp((0, import_node_path4.join)((0, import_node_os.tmpdir)(), "agentbridge-index-"));
  const env = { GIT_INDEX_FILE: (0, import_node_path4.join)(scratch, "index") };
  try {
    await runGit(dir, ["read-tree", "HEAD"], { env });
    await runGit(dir, ["add", "-A"], { env, timeout: GIT_WRITE_TIMEOUT_MS });
    const stat = await runGit(dir, ["diff", "--cached", "--stat", base], { env });
    const names = await runGit(dir, ["diff", "--cached", "--name-only", base], { env });
    const patch = await runGit(
      dir,
      ["diff", "--cached", "--binary", "--no-ext-diff", base],
      { env, timeout: GIT_WRITE_TIMEOUT_MS }
    );
    return {
      stat: stat.trimEnd(),
      patch,
      files: names.split("\n").map((l) => l.trim()).filter(Boolean)
    };
  } finally {
    await import_node_fs3.promises.rm(scratch, { recursive: true, force: true }).catch(() => {
    });
  }
}
async function forkPoint(treePath, repoPath) {
  const repoHead = (await runGit(repoPath, ["rev-parse", "HEAD"])).trim();
  const base = await runGit(treePath, ["merge-base", "HEAD", repoHead]);
  return base.trim();
}
async function subagentDiff(repoPath, treePath) {
  if (await worktreeExists(treePath)) {
    const base = await forkPoint(treePath, repoPath);
    return { isolated: true, base, ...await snapshotAgainst(treePath, base) };
  }
  return { isolated: false, ...await snapshotAgainst(repoPath, "HEAD") };
}
function truncatePatch(patch, limit = PATCH_LIMIT_BYTES) {
  if (Buffer.byteLength(patch, "utf8") <= limit) return { patch, omitted: [] };
  const chunks = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ") || chunks.length === 0) chunks.push(line);
    else chunks[chunks.length - 1] += "\n" + line;
  }
  const kept = [];
  const omitted = [];
  let size = 0;
  for (const chunk of chunks) {
    const bytes = Buffer.byteLength(chunk, "utf8") + 1;
    if (omitted.length === 0 && size + bytes <= limit) {
      kept.push(chunk);
      size += bytes;
      continue;
    }
    const m = /^diff --git a\/.* b\/(.*)$/.exec(chunk.split("\n")[0] ?? "");
    omitted.push(m ? m[1] : "(\uC774\uB984 \uBD88\uBA85)");
  }
  return { patch: kept.join("\n"), omitted };
}
var import_node_child_process2, import_node_fs3, import_node_path4, import_node_os, GIT_TIMEOUT_MS2, GIT_WRITE_TIMEOUT_MS, GIT_MAX_BUFFER2, PATCH_LIMIT_BYTES;
var init_diffMerge = __esm({
  "packages/core/src/agent/diffMerge.ts"() {
    "use strict";
    import_node_child_process2 = require("node:child_process");
    import_node_fs3 = require("node:fs");
    import_node_path4 = require("node:path");
    import_node_os = require("node:os");
    init_cleanup();
    GIT_TIMEOUT_MS2 = 1e4;
    GIT_WRITE_TIMEOUT_MS = 12e4;
    GIT_MAX_BUFFER2 = 64 * 1024 * 1024;
    PATCH_LIMIT_BYTES = 5e4;
  }
});

// packages/core/src/agentCli/agent.ts
var agent_exports = {};
__export(agent_exports, {
  DEFAULT_WAIT_SEC: () => DEFAULT_WAIT_SEC,
  agentCheck: () => agentCheck,
  agentClose: () => agentClose,
  agentCloseRound: () => agentCloseRound,
  agentDiff: () => agentDiff,
  agentList: () => agentList,
  agentMerge: () => agentMerge,
  agentRead: () => agentRead,
  agentSend: () => agentSend,
  agentStart: () => agentStart,
  agentStop: () => agentStop,
  listSubs: () => listSubs
});
async function readSessions(wsDir) {
  try {
    const raw = await import_fs12.promises.readFile((0, import_path14.join)(wsDir, "workspace.json"), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.sessions) ? parsed.sessions : [];
  } catch {
    return [];
  }
}
async function readWorkspacePath(wsDir) {
  const raw = await import_fs12.promises.readFile((0, import_path14.join)(wsDir, "workspace.json"), "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed.workspacePath) throw new Error("\uC774 \uD504\uB85C\uC81D\uD2B8\uC758 \uD3F4\uB354 \uACBD\uB85C\uB97C \uC54C \uC218 \uC5C6\uB2E4");
  return parsed.workspacePath;
}
async function listSubs(wsDir, callerSessionId) {
  const sessions = await readSessions(wsDir);
  const mine = sessions.filter(
    (s) => s.parentSessionId === callerSessionId && s.agentName && !s.cleanedAt
  );
  return Promise.all(
    mine.map(async (s) => {
      const closed = s.closedAt !== null;
      const activity = closed ? "idle" : computeSessionActivity(await readSessionActivityInputs(wsDir, s.sessionId), Date.now());
      return {
        name: s.agentName,
        sessionId: s.sessionId,
        model: s.model,
        title: s.title ?? s.model,
        closed,
        unread: await isUnread(wsDir, s.sessionId),
        activity
      };
    })
  );
}
async function findSub(wsDir, callerSessionId, name) {
  const subs = await listSubs(wsDir, callerSessionId);
  const found = subs.find((s) => s.name === name);
  if (!found) {
    const known = subs.map((s) => s.name).join(", ") || "(\uC5C6\uC74C)";
    throw new Error(`\uADF8\uB7F0 \uC11C\uBE0C\uAC00 \uC5C6\uB2E4: ${name}. \uC9C0\uAE08 \uC788\uB294 \uAC83: ${known}`);
  }
  return found;
}
function stateText(s) {
  if (s.closed) return "\uB05D\uB0A8";
  switch (s.activity) {
    case "running":
      return "\uB3C4\uB294 \uC911";
    case "unknown":
      return "\uBAA8\uB984 \u2014 \uCD9C\uB825\uC774 \uBA48\uCD98 \uC9C0 \uC624\uB798\uB2E4. \uB04A\uACBC\uC744 \uC218 \uC788\uC73C\uB2C8 \uC5F4\uC5B4 \uBCF4\uAC70\uB098 \uC9C0\uCE68\uC744 \uB2E4\uC2DC \uBCF4\uB0B8\uB2E4";
    case "done":
      return "\uD134 \uB05D\uB0A8";
    default:
      return "\uB178\uB294 \uC911";
  }
}
function rowLine(s) {
  const mark = s.unread ? "  \xB7 \uC548 \uC77D\uC740 \uBCF4\uACE0 \uC788\uC74C" : "";
  return `  ${s.name}  (${s.model}, ${stateText(s)})  ${s.title}${mark}`;
}
async function agentList(wsDir, callerSessionId) {
  const subs = await listSubs(wsDir, callerSessionId);
  if (subs.length === 0) return "\uB744\uC6B4 \uC11C\uBE0C\uAC00 \uC5C6\uB2E4.";
  return [`## \uC11C\uBE0C ${subs.length}\uAC1C`, "", ...subs.map(rowLine)].join("\n");
}
async function agentRead(wsDir, callerSessionId, name, lastN) {
  const sub = await findSub(wsDir, callerSessionId, name);
  const sessionDir2 = (0, import_path14.join)(wsDir, "sessions", sub.sessionId);
  const all = await readAllTurns(sessionDir2);
  await markReported(wsDir, sub.sessionId);
  if (all.length === 0) {
    return `${name}: \uC544\uC9C1 \uAE30\uB85D\uB41C \uD134\uC774 \uC5C6\uB2E4.${sub.closed ? " \uC138\uC158\uC740 \uC774\uBBF8 \uB05D\uB0AC\uB2E4." : ""}`;
  }
  const turns = typeof lastN === "number" ? all.slice(-lastN) : all;
  const lines = [`## ${name} (${sub.model}) \uC758 \uAE30\uB85D \u2014 ${turns.length}\uD134, \uC624\uB798\uB41C \uAC83\uBD80\uD130`, ""];
  for (const t of turns) {
    lines.push(`[${t.completedAt || ""}]`);
    lines.push(`user: ${t.user || ""}`);
    lines.push(`assistant: ${t.assistantBody || ""}`);
    lines.push("");
  }
  return lines.join("\n");
}
async function agentDiff(wsDir, callerSessionId, name, opts = {}) {
  const sub = await findSub(wsDir, callerSessionId, name);
  const repoPath = await readWorkspacePath(wsDir);
  const diff = await subagentDiff(repoPath, resolveTreePath(wsDir, name));
  if (diff.files.length === 0) {
    return `${name}: \uBC14\uB010 \uD30C\uC77C\uC774 \uC5C6\uB2E4.${diff.isolated ? "" : " \uC6D0\uBCF8 \uD3F4\uB354\uC5D0\uC11C \uB3CC\uC558\uC73C\uBBC0\uB85C \uD30C\uC77C\uC744 \uC548 \uACE0\uCE58\uB294 \uC77C\uC774\uC5C8\uC744 \uC218 \uC788\uB2E4."}`;
  }
  const head = diff.isolated ? `## ${name} (${sub.model}) \uC758 \uBCC0\uACBD \u2014 \uACA9\uB9AC worktree, \uBD84\uAE30\uC810 ${(diff.base ?? "").slice(0, 8)} \uC774\uD6C4 \uC804\uCCB4` : `## ${name} (${sub.model}) \uC758 \uBCC0\uACBD \u2014 \uC6D0\uBCF8 \uD3F4\uB354\uC758 \uC9C0\uAE08 \uC0C1\uD0DC. \uC774 \uC11C\uBE0C\uAC00 \uC544\uB2C8\uB77C \uB108\uC640 \uC0AC\uC6A9\uC790\uAC00 \uACE0\uCE5C \uAC83\uB3C4 \uD568\uAED8 \uB4E4\uC5B4 \uC788\uB2E4`;
  const lines = [head, "", diff.stat];
  if (opts.statOnly) return lines.join("\n");
  const cut = truncatePatch(diff.patch);
  lines.push("", cut.patch);
  if (cut.omitted.length > 0) {
    lines.push(
      "",
      `\u2014 \uD328\uCE58\uAC00 \uC0C1\uD55C(${PATCH_LIMIT_BYTES}\uBC14\uC774\uD2B8)\uC744 \uB118\uC5B4 \uC5EC\uAE30\uC11C \uC798\uB790\uB2E4. \uC548 \uC2E4\uB9B0 \uD30C\uC77C ${cut.omitted.length}\uAC1C: ${cut.omitted.join(", ")}`
    );
  }
  return lines.join("\n");
}
async function replayTail(wsDir, sessionId) {
  const path2 = (0, import_path14.join)(wsDir, "sessions", sessionId, "replay.log");
  try {
    const stat = await import_fs12.promises.stat(path2);
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const handle = await import_fs12.promises.open(path2, "r");
    try {
      const buf = Buffer.alloc(stat.size - start);
      await handle.read(buf, 0, buf.length, start);
      return buf.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}
function renderWoke(done, stuck) {
  const lines = [];
  if (done.length > 0) {
    lines.push(`## \uB05D\uB09C \uC11C\uBE0C ${done.length}\uAC1C`, "");
    for (const s of done) lines.push(`  ${s.name}  (${s.model})  ${s.title}`);
    lines.push("", "`agent read <\uC774\uB984>`\uC73C\uB85C \uBCF4\uACE0\uB97C \uC77D\uB294\uB2E4.");
  }
  if (stuck.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`## \uC0C1\uD0DC\uB97C \uC54C \uC218 \uC5C6\uB294 \uC11C\uBE0C ${stuck.length}\uAC1C`, "");
    for (const s of stuck) lines.push(`  ${s.name}  (${s.model})  ${s.title}`);
    lines.push(
      "",
      "\uC644\uB8CC \uC2E0\uD638 \uC5C6\uC774 \uCD9C\uB825\uC774 \uBA48\uCD98 \uC9C0 \uC624\uB798\uB2E4. \uC0AC\uC6A9\uC790\uAC00 \uD134\uC744 \uB04A\uC5C8\uAC70\uB098 \uC11C\uBE0C\uAC00 \uB9C9\uD600 \uC788\uC744 \uC218 \uC788\uB2E4.",
      "`agent read <\uC774\uB984>`\uC73C\uB85C \uC5B4\uB514\uAE4C\uC9C0 \uAC14\uB294\uC9C0 \uBCF4\uACE0, \uC774\uC5B4\uC11C \uC2DC\uD0AC \uAC83\uC774 \uC788\uC73C\uBA74 `agent send`,",
      "\uC544\uB2C8\uBA74 `agent close`\uB85C \uC815\uB9AC\uD55C\uB2E4."
    );
  }
  return lines.join("\n");
}
async function renderEmpty(wsDir, subs, waited) {
  if (subs.length === 0) return "\uB744\uC6B4 \uC11C\uBE0C\uAC00 \uC5C6\uB2E4.";
  const lines = [waited ? "\uAE30\uB2E4\uB9AC\uB294 \uB3D9\uC548 \uB05D\uB09C \uC11C\uBE0C\uAC00 \uC5C6\uB2E4." : "\uB05D\uB0AC\uB294\uB370 \uC548 \uC77D\uC740 \uC11C\uBE0C\uAC00 \uC5C6\uB2E4.", ""];
  for (const s of subs) {
    lines.push(`  ${s.name}  (${s.model}, ${stateText(s)})`);
    if (s.closed) {
      const tail = await replayTail(wsDir, s.sessionId);
      if (tail) {
        lines.push("    \u2014 \uC644\uB8CC \uC2E0\uD638 \uC5C6\uC774 \uB05D\uB0AC\uB2E4. \uD654\uBA74 \uAE30\uB85D\uC758 \uAF2C\uB9AC:");
        for (const l of tail.split("\n").slice(-8)) lines.push(`      ${l.replace(/\s+$/, "")}`);
      } else {
        lines.push("    \u2014 \uC644\uB8CC \uC2E0\uD638 \uC5C6\uC774 \uB05D\uB0AC\uB2E4. \uD654\uBA74 \uAE30\uB85D\uC774 \uC5C6\uB2E4.");
      }
    }
  }
  return lines.join("\n");
}
function wakers(subs) {
  return {
    done: subs.filter((s) => s.unread),
    stuck: subs.filter((s) => !s.unread && s.activity === "unknown")
  };
}
async function agentCheck(wsDir, callerSessionId, opts = {}) {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep2;
  let subs = await listSubs(wsDir, callerSessionId);
  let woke = wakers(subs);
  if (woke.done.length + woke.stuck.length > 0) return renderWoke(woke.done, woke.stuck);
  if (!opts.wait) return renderEmpty(wsDir, subs, false);
  const deadline = now() + (opts.forSec ?? DEFAULT_WAIT_SEC) * 1e3;
  while (now() < deadline) {
    await sleep(WAIT_POLL_MS);
    subs = await listSubs(wsDir, callerSessionId);
    woke = wakers(subs);
    if (woke.done.length + woke.stuck.length > 0) return renderWoke(woke.done, woke.stuck);
  }
  return renderEmpty(wsDir, subs, true);
}
function newRequest(kind, payload) {
  requestSeq += 1;
  return { id: `${process.pid}-${Date.now()}-${requestSeq}`, kind, at: Date.now(), payload };
}
async function callHost(sessionDir2, kind, payload) {
  if (!sessionDir2) {
    return "\uC774 \uC138\uC158\uC758 \uC790\uB9AC\uB97C \uC54C \uC218 \uC5C6\uC5B4 \uD638\uC2A4\uD2B8\uC5D0 \uC694\uCCAD\uC744 \uB118\uAE30\uC9C0 \uBABB\uD588\uB2E4.";
  }
  const result = await sendHostRequest(sessionDir2, newRequest(kind, payload));
  return result.output;
}
function agentStart(sessionDir2, prompt, harnesses, isolate) {
  return callHost(sessionDir2, HOST_AGENT_START, { prompt, harnesses, isolate });
}
function agentSend(sessionDir2, name, prompt) {
  return callHost(sessionDir2, HOST_AGENT_SEND, { name, prompt });
}
function agentStop(sessionDir2, name) {
  return callHost(sessionDir2, HOST_AGENT_STOP, { name });
}
function agentClose(sessionDir2, name) {
  return callHost(sessionDir2, HOST_AGENT_CLOSE, { name });
}
function agentCloseRound(sessionDir2) {
  return callHost(sessionDir2, HOST_AGENT_CLOSE, { round: true });
}
function agentMerge(sessionDir2, name) {
  return callHost(sessionDir2, HOST_AGENT_MERGE, { name });
}
var import_fs12, import_path14, DEFAULT_WAIT_SEC, WAIT_POLL_MS, TAIL_BYTES, defaultSleep2, requestSeq;
var init_agent = __esm({
  "packages/core/src/agentCli/agent.ts"() {
    "use strict";
    import_fs12 = require("fs");
    import_path14 = require("path");
    init_turnsStore();
    init_sessionStatus();
    init_reportState();
    init_cleanup();
    init_diffMerge();
    init_hostRequest();
    DEFAULT_WAIT_SEC = 60;
    WAIT_POLL_MS = 1e3;
    TAIL_BYTES = 2e3;
    defaultSleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
    requestSeq = 0;
  }
});

// packages/core/src/agentCli/uninstall.ts
var uninstall_exports = {};
__export(uninstall_exports, {
  uninstallGlobal: () => uninstallGlobal
});
async function uninstallGlobal(homeDir) {
  const removed = [];
  for (const path2 of await removeGlobalHooks(homeDir)) removed.push(path2);
  for (const agent of AGENTS2) {
    const path2 = skillFilePath(agent, homeDir);
    try {
      await import_fs13.promises.unlink(path2);
      removed.push(path2);
    } catch {
      continue;
    }
    try {
      await import_fs13.promises.rmdir((0, import_path15.dirname)(path2));
    } catch {
    }
  }
  if (removed.length === 0) {
    return "\uAC77\uC5B4\uB0BC \uAC83\uC774 \uC5C6\uB2E4. \uC804\uC5ED\uC5D0 \uAE54\uB9B0 \uC6B0\uB9AC \uD56D\uBAA9\uC774 \uC5C6\uB2E4.";
  }
  return [
    `\uC804\uC5ED\uC5D0\uC11C ${removed.length}\uAC1C\uB97C \uAC77\uC5B4\uB0C8\uB2E4.`,
    "",
    ...removed.map((p) => `- ${p}`),
    "",
    "\uC800\uC7A5\uC18C(\uB300\uD654 \uAE30\uB85D\uACFC \uC9C0\uC2DD)\uB294 \uADF8\uB300\uB85C \uB454\uB2E4."
  ].join("\n");
}
var import_fs13, import_path15, AGENTS2;
var init_uninstall = __esm({
  "packages/core/src/agentCli/uninstall.ts"() {
    "use strict";
    import_fs13 = require("fs");
    import_path15 = require("path");
    init_hookInstaller();
    init_skillInstaller();
    AGENTS2 = ["claude", "codex", "agy"];
  }
});

// packages/core/bin/agentbridge.js
var fs6 = require("fs");
var path = require("path");
var {
  readContext: readContext2,
  readTurns: readTurns2,
  readMemory: readMemory2,
  searchMemory: searchMemory2,
  resolveProfileIdForScope: resolveProfileIdForScope2
} = (init_read(), __toCommonJS(read_exports));
var { requestMemoryWrite: requestMemoryWrite2, WriteError: WriteError2 } = (init_write(), __toCommonJS(write_exports));
var { readStatus: readStatus2 } = (init_status(), __toCommonJS(status_exports));
var {
  agentList: agentList2,
  agentRead: agentRead2,
  agentDiff: agentDiff2,
  agentCheck: agentCheck2,
  agentStart: agentStart2,
  agentSend: agentSend2,
  agentStop: agentStop2,
  agentClose: agentClose2,
  agentCloseRound: agentCloseRound2,
  agentMerge: agentMerge2,
  DEFAULT_WAIT_SEC: DEFAULT_WAIT_SEC2
} = (init_agent(), __toCommonJS(agent_exports));
var { uninstallGlobal: uninstallGlobal2 } = (init_uninstall(), __toCommonJS(uninstall_exports));
var DEFAULT_TURNS = 3;
var COMMANDS = [
  ["context", "\uD604\uC7AC \uD504\uB85C\uC81D\uD2B8\uC758 \uC555\uCD95\uB41C \uC791\uC5C5 \uC0C1\uD0DC"],
  ["turns [--last N]", "\uCD5C\uADFC \uB300\uD654 \uC6D0\uBB38 (\uAE30\uBCF8 " + DEFAULT_TURNS + "\uD134)"],
  ["memory user [--full]", "\uC0AC\uC6A9\uC790 \uC9C0\uC2DD. \uAE30\uBCF8\uC740 \uC694\uC57D, --full\uC774 \uC804\uBB38"],
  ["memory project [--full]", "\uC774 \uC800\uC7A5\uC18C\uC758 \uD504\uB85C\uC81D\uD2B8 \uC9C0\uC2DD"],
  ["memory search <\uC9C8\uC758>", "\uB450 \uC9C0\uC2DD\uC744 \uC9C8\uC758\uB85C \uAC80\uC0C9"],
  ["memory add", "\uC0C8 \uC0AC\uC2E4\uC744 \uC81C\uC548 \uD050\uC5D0 \uB123\uB294\uB2E4 (--scope --category --title --summary --body)"],
  ["memory update <\uC2DD\uBCC4\uC790>", "\uC774\uBBF8 \uC788\uB294 \uD56D\uBAA9\uC744 \uACE0\uCE58\uB294 \uC81C\uC548 (\uAC19\uC740 \uC778\uC790, \uC548 \uC900 \uAC83\uC740 \uADF8\uB300\uB85C)"],
  ["status", "\uC5B4\uB514\uC5D0 \uBB34\uC5C7\uC774 \uAE54\uB824 \uC788\uB294\uC9C0\uC640 \uBC30\uC120 \uC790\uAC00 \uC9C4\uB2E8"],
  ["agent start", '\uC11C\uBE0C\uC5D0\uC774\uC804\uD2B8\uB97C \uB744\uC6B4\uB2E4 (--prompt "..." [--harness claude,codex,agy] [--isolate])'],
  ["agent list", "\uB744\uC6B4 \uC11C\uBE0C\uC758 \uBAA9\uB85D\uACFC \uC0C1\uD0DC"],
  ["agent check", "\uB05D\uB09C \uC11C\uBE0C\uAC00 \uC788\uB294\uC9C0 \uBCF8\uB2E4 (--wait\uBA74 \uC0DD\uAE38 \uB54C\uAE4C\uC9C0, --for <\uCD08>\uB85C \uC0C1\uD55C \uC870\uC815)"],
  ["agent read <\uC774\uB984>", "\uADF8 \uC11C\uBE0C\uC758 \uAE30\uB85D \uC804\uBB38 (--last N\uC73C\uB85C \uC790\uB984)"],
  ["agent diff <\uC774\uB984>", "\uADF8 \uC11C\uBE0C\uAC00 \uC2E4\uC81C\uB85C \uBC14\uAFBC \uAC83 (--stat\uC774\uBA74 \uC694\uC57D\uB9CC)"],
  ["agent send <\uC774\uB984>", '\uB3C4\uB294 \uC11C\uBE0C\uC5D0 \uC9C0\uCE68\uC744 \uB354 \uBCF4\uB0B8\uB2E4 (--prompt "...")'],
  ["agent merge <\uC774\uB984>", "\uADF8 \uC11C\uBE0C\uC758 \uBCC0\uACBD\uC744 \uC6D0\uBCF8\uC5D0 \uC5B9\uB294\uB2E4 (\uC804\uBD80 \uC544\uB2C8\uBA74 \uC544\uBB34\uAC83\uB3C4)"],
  ["agent stop <\uC774\uB984>", "\uC11C\uBE0C\uB97C \uB05D\uB0B8\uB2E4"],
  ["agent close <\uC774\uB984>", "\uC11C\uBE0C\uB97C \uC815\uB9AC\uD55C\uB2E4 (\uACA9\uB9AC\uC600\uC73C\uBA74 \uD3F4\uB354\uC640 \uBE0C\uB79C\uCE58\uB3C4 \uC9C0\uC6B4\uB2E4)"],
  ["agent close --round", "\uB77C\uC6B4\uB4DC\uB97C \uC815\uB9AC\uD55C\uB2E4 (\uBA38\uC9C0\uB41C \uD558\uB098\uB9CC \uB0A8\uAE30\uACE0 \uC804\uBD80)"]
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
    return fs6.realpathSync(v);
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
function sessionDir(wsDir) {
  const token = process.env.AGENTBRIDGE_WS_SESSION || "";
  if (!token || token !== path.basename(token)) return void 0;
  return path.join(wsDir, "sessions", token);
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
        let id;
        if (sub === "update") {
          id = args[1];
          if (!id || id.startsWith("--")) fail("memory update\uC5D0\uB294 \uC2DD\uBCC4\uC790\uAC00 \uC628\uB2E4");
        }
        return requestMemoryWrite2(sessionDir(wsDir), {
          op: sub,
          scope,
          profileId,
          category: strOption(args, "--category"),
          id,
          fields: writeFields(args)
        });
      }
      return usageAndExit();
    }
    case "agent": {
      const sub = args[0];
      const rest = args.slice(1);
      const caller = process.env.AGENTBRIDGE_WS_SESSION || "";
      if (!caller || caller !== path.basename(caller)) fail("\uC774 \uC138\uC158\uC758 \uC2E0\uC6D0\uC744 \uC54C \uC218 \uC5C6\uB2E4");
      const nameArg = () => {
        const v = rest[0];
        if (!v || v.startsWith("--")) {
          const alt = sub === "close" ? "\uC624\uAC70\uB098 --round\uAC00 \uC628\uB2E4" : "\uC628\uB2E4";
          fail("agent " + sub + "\uC5D0\uB294 \uC11C\uBE0C \uC774\uB984\uC774 " + alt);
        }
        return v;
      };
      switch (sub) {
        case "list":
          return agentList2(wsDir, caller);
        case "read": {
          const name = nameArg();
          const i = rest.indexOf("--last");
          return agentRead2(wsDir, caller, name, i === -1 ? void 0 : intOption(rest, "--last", 0));
        }
        case "diff":
          return agentDiff2(wsDir, caller, nameArg(), { statOnly: rest.includes("--stat") });
        case "check":
          return agentCheck2(wsDir, caller, {
            wait: rest.includes("--wait"),
            forSec: intOption(rest, "--for", DEFAULT_WAIT_SEC2)
          });
        case "start": {
          const prompt = strOption(rest, "--prompt");
          if (!prompt) fail("agent start\uC5D0\uB294 --prompt\uAC00 \uC628\uB2E4");
          const raw = strOption(rest, "--harness");
          const harnesses = raw ? raw.split(",").map((h) => h.trim()).filter(Boolean) : ["claude"];
          return agentStart2(sessionDir(wsDir), prompt, harnesses, rest.includes("--isolate"));
        }
        case "send": {
          const name = nameArg();
          const prompt = strOption(rest, "--prompt");
          if (!prompt) fail("agent send\uC5D0\uB294 --prompt\uAC00 \uC628\uB2E4");
          return agentSend2(sessionDir(wsDir), name, prompt);
        }
        case "merge":
          return agentMerge2(sessionDir(wsDir), nameArg());
        case "stop":
          return agentStop2(sessionDir(wsDir), nameArg());
        case "close":
          return rest.includes("--round") ? agentCloseRound2(sessionDir(wsDir)) : agentClose2(sessionDir(wsDir), nameArg());
        default:
          return usageAndExit();
      }
    }
    case "status":
      return readStatus2(storageRoot, wsDir, { sessionDir: sessionDir(wsDir) });
    // 사용자 명령이라 사용법과 스킬의 목록에는 없다. 전역 설정을 걷어내는 일을 모델의
    // 자발적 호출에 열어둘 이유가 없다.
    case "uninstall":
      return uninstallGlobal2();
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
