#!/usr/bin/env node
// @agentbridge-cli-version 0.6.2
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
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
function archiveDir(workspaceRoot) {
  return (0, import_path2.join)(workspaceRoot, "archive");
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
async function readArchivedTurns(workspaceRoot) {
  const dir = archiveDir(workspaceRoot);
  let files;
  try {
    files = await import_fs2.promises.readdir(dir);
  } catch {
    return [];
  }
  const snapshots = files.filter((f) => f.startsWith("compressed_") && f.endsWith(".jsonl")).sort();
  const out = [];
  for (const f of snapshots) {
    let raw;
    try {
      raw = await import_fs2.promises.readFile((0, import_path2.join)(dir, f), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t);
        if (obj && obj.type === "ir_snapshot") continue;
        if (obj && typeof obj.id === "string") out.push(obj);
      } catch {
      }
    }
  }
  return out;
}
async function readTurnHistory(workspaceRoot) {
  const merged = [...await readArchivedTurns(workspaceRoot), ...await readAllTurns(workspaceRoot)];
  const byId = /* @__PURE__ */ new Map();
  for (const t of merged) if (!byId.has(t.id)) byId.set(t.id, t);
  return [...byId.values()];
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
var init_globalMarkdown = __esm({
  "packages/core/src/globalMarkdown.ts"() {
    "use strict";
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
function extractTagsBeforeDetails(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  let inTags = false;
  const tags = [];
  for (const line of lines) {
    if (/^## Details(?:\s|$)/.test(line)) break;
    if (/^## /.test(line)) {
      inTags = /^## Tags(?:\s|$)/.test(line);
      continue;
    }
    if (inTags) {
      const trimmed = line.trim();
      if (trimmed.startsWith("- ")) {
        const tag = trimmed.slice(2).trim();
        if (tag) tags.push(tag);
      }
    }
  }
  return tags;
}
async function readProfileDocs(globalDir, profileId, scope = "user") {
  const docsDir = profileDocsDir(globalDir, profileId, scope);
  const files = await listDocRelPaths(docsDir);
  const recs = [];
  for (const file of files) {
    const fullPath = (0, import_node_path2.resolve)(docsDir, file);
    const raw = await import_node_fs.promises.readFile(fullPath, "utf8");
    const category = file.includes("/") ? file.split("/")[0] : "general";
    const slug = file.replace(/\.md$/i, "").split("/").slice(1).join("/") || file.replace(/\.md$/i, "");
    const detailsMatch = raw.match(/## Details\s+([\s\S]*?)$/);
    recs.push({
      category,
      slug,
      title: extractTitle(raw),
      summary: extractSummary(raw),
      indexEntries: extractIndexEntries(raw),
      body: detailsMatch?.[1]?.trim() || "",
      tags: extractTagsBeforeDetails(raw),
      path: fullPath
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
async function resolveProjectProfileKey(cwd, opts = {}) {
  const log = opts.logger ?? noopLogger;
  const read = opts.readRemote ?? readOriginUrl;
  let url = null;
  try {
    url = await read(cwd);
  } catch (err) {
    log.warn(`gitRemote: origin \uC870\uD68C \uC2E4\uD328 \u2014 ${err instanceof Error ? err.message : String(err)}`);
  }
  const normalized = url ? normalizeRemoteUrl(url) : "";
  return normalized ? { id: profileIdForRemote(normalized), keyedBy: "remote" } : { id: profileIdForPath(cwd), keyedBy: "path" };
}
async function resolveProjectProfileId(cwd, opts = {}) {
  return (await resolveProjectProfileKey(cwd, opts)).id;
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
    readOriginUrl = (cwd) => new Promise((resolve3) => {
      (0, import_node_child_process.execFile)(
        "git",
        ["config", "--get", "remote.origin.url"],
        { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true },
        (err, stdout) => {
          if (err) return resolve3(null);
          const v = String(stdout ?? "").trim();
          resolve3(v || null);
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
function tokenizeQueryGroups(query) {
  const groups = [];
  const seen = /* @__PURE__ */ new Set();
  for (const tok of tokenizeRaw(query)) {
    const v = koreanVariant(tok);
    if (v && STOP_WORDS.has(v)) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    groups.push(v ? [tok, v] : [tok]);
  }
  return groups;
}
function tokenizeQuery(query) {
  const out = /* @__PURE__ */ new Set();
  for (const group of tokenizeQueryGroups(query)) for (const tok of group) out.add(tok);
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

// packages/core/src/memoryReadLog.ts
function memoryReadLogPath(globalDir) {
  return (0, import_node_path3.join)(globalDir, "memory-reads.jsonl");
}
async function appendMemoryReadLog(globalDir, entries) {
  if (entries.length === 0) return;
  const at = (/* @__PURE__ */ new Date()).toISOString();
  const lines = entries.map((e) => JSON.stringify({ id: e.id, scope: e.scope, at }) + "\n").join("");
  try {
    await import_node_fs2.promises.mkdir(globalDir, { recursive: true });
    await import_node_fs2.promises.appendFile(memoryReadLogPath(globalDir), lines, "utf8");
  } catch {
  }
}
var import_node_fs2, import_node_path3;
var init_memoryReadLog = __esm({
  "packages/core/src/memoryReadLog.ts"() {
    "use strict";
    import_node_fs2 = require("node:fs");
    import_node_path3 = require("node:path");
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
  readMemoryDoc: () => readMemoryDoc,
  readTurns: () => readTurns,
  resolveProfileIdForScope: () => resolveProfileIdForScope,
  searchMemory: () => searchMemory
});
async function readContext(wsDir) {
  const ir = await readIR(wsDir);
  if (!ir) return "\uC800\uC7A5\uB41C \uC791\uC5C5 \uC0C1\uD0DC\uAC00 \uC5C6\uB2E4. \uC544\uC9C1 \uC555\uCD95\uB41C \uB9E5\uB77D\uC774 \uC313\uC774\uC9C0 \uC54A\uC558\uB2E4.";
  const pending = (await readAllTurns(wsDir)).length;
  const boundary = pending > 0 ? `${ir.meta.updatedAt}\uAE4C\uC9C0\uC758 \uB300\uD654\uB97C \uC555\uCD95\uD55C \uC0C1\uD0DC\uB2E4. \uADF8 \uB4A4 ${pending}\uD134\uC740 \uC544\uC9C1 \uC5EC\uAE30 \uC5C6\uB2E4 \u2014 \`turns --last ${pending}\`\uB85C \uC6D0\uBB38\uC744 \uBCF8\uB2E4.` : `${ir.meta.updatedAt}\uAE4C\uC9C0\uC758 \uB300\uD654\uB97C \uC555\uCD95\uD55C \uC0C1\uD0DC\uB2E4. \uADF8 \uB4A4 \uC313\uC778 \uD134\uC740 \uC5C6\uB2E4.`;
  return `## \uC791\uC5C5 \uC0C1\uD0DC (\uC555\uCD95\uB41C \uB9E5\uB77D)

${boundary}

${renderIrSections(ir)}`;
}
async function readTurns(wsDir, lastN) {
  const all = await readTurnHistory(wsDir);
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
function splitDocId(id) {
  const trimmed = String(id || "").trim();
  const cut = trimmed.indexOf("/");
  if (cut <= 0 || cut === trimmed.length - 1) return null;
  return { category: trimmed.slice(0, cut), slug: trimmed.slice(cut + 1) };
}
function renderDocFull(rec, scope) {
  const lines = [`## ${rec.title}`, "", `${SCOPE_LABEL[scope]} \xB7 ${docId(rec)}`, ""];
  if (rec.summary) lines.push(rec.summary, "");
  if (rec.body) lines.push(rec.body);
  return lines.join("\n").trimEnd();
}
async function readMemoryDoc(storageRoot, wsDir, id, scope) {
  const parsed = splitDocId(id);
  if (!parsed) return `"${id}"\uB294 \uC2DD\uBCC4\uC790 \uBAA8\uC591\uC774 \uC544\uB2C8\uB2E4. <\uCE74\uD14C\uACE0\uB9AC>/<\uC2AC\uB7EC\uADF8>\uB85C \uC628\uB2E4.`;
  const globalDir = getGlobalDir(storageRoot);
  const scopes = scope ? [scope] : ["user", "project"];
  const found = [];
  for (const s of scopes) {
    const profileId = await resolveProfileIdForScope(wsDir, s);
    if (!profileId) continue;
    const docs = await readProfileDocs(globalDir, profileId, s).catch(() => []);
    const hit = docs.find((d) => d.category === parsed.category && d.slug === parsed.slug);
    if (hit) found.push({ rec: hit, scope: s });
  }
  if (found.length === 0) {
    return `"${id}"\uC5D0 \uD574\uB2F9\uD558\uB294 \uD56D\uBAA9\uC774 \uC5C6\uB2E4. \uC2DD\uBCC4\uC790\uB294 \`memory search\`\uB098 \`memory user\`\uC758 \uC904 \uC55E\uC5D0 \uC788\uB2E4.`;
  }
  await appendMemoryReadLog(globalDir, found.map((f) => ({ id, scope: f.scope })));
  return found.map((f) => renderDocFull(f.rec, f.scope)).join("\n\n");
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
    init_memoryReadLog();
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
var import_fs5, import_path6, HOST_REQUEST_FILENAME, HOST_RESULT_FILENAME, HOST_REQUEST_TIMEOUT_MS, POLL_MS, HOST_PING, HOST_AGENT_START, HOST_AGENT_SEND, HOST_AGENT_STOP, HOST_AGENT_CLOSE, HOST_AGENT_MERGE, HOST_AGENT_MODELS, HOST_MEMORY_WRITE, HOST_SESSION_NEW, LONG_KINDS, LONG_TIMEOUT_MS, defaultSleep;
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
    HOST_AGENT_MODELS = "agent-models";
    HOST_MEMORY_WRITE = "memory-write";
    HOST_SESSION_NEW = "session-new";
    LONG_KINDS = /* @__PURE__ */ new Set([
      HOST_AGENT_START,
      HOST_AGENT_CLOSE,
      HOST_AGENT_MERGE,
      HOST_AGENT_MODELS,
      HOST_SESSION_NEW
    ]);
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
    files = await import_node_fs3.promises.readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files.filter((f2) => f2.endsWith(".json")).sort()) {
    try {
      const raw = await import_node_fs3.promises.readFile((0, import_node_path4.join)(dir, f), "utf8");
      const obj = JSON.parse(raw);
      if (obj && typeof obj.title === "string" && typeof obj.category === "string") out.push(obj);
    } catch {
    }
  }
  return out;
}
async function writeProposals(globalDir, profileId, inputs, opts, scope = "user") {
  const dir = proposalsDir(globalDir, profileId, scope);
  await import_node_fs3.promises.mkdir(dir, { recursive: true });
  const pendingIds = /* @__PURE__ */ new Map();
  const docKeys = /* @__PURE__ */ new Set();
  for (const p of await readProposals(globalDir, profileId, scope)) {
    pendingIds.set(dedupKey(p.category, p.title), p.id);
  }
  for (const d of opts.existingDocTitles) docKeys.add(dedupKey(d.category, d.title));
  const written = [];
  const skipped = [];
  let n = 0;
  for (const inp of inputs) {
    if (n >= PROPOSAL_CAPS.maxPerPass) {
      skipped.push({ input: inp, reason: "cap" });
      continue;
    }
    const key = dedupKey(inp.category, inp.title);
    if (!inp.targetSlug) {
      if (docKeys.has(key)) {
        skipped.push({ input: inp, reason: "doc" });
        continue;
      }
      const pendingId = pendingIds.get(key);
      if (pendingId !== void 0) {
        skipped.push({ input: inp, reason: "pending", pendingId });
        continue;
      }
    }
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
    await import_node_fs3.promises.writeFile((0, import_node_path4.join)(dir, `${rec.id}.json`), JSON.stringify(rec, null, 2) + "\n", "utf8");
    pendingIds.set(key, rec.id);
    written.push(rec);
    n++;
  }
  return { written, skipped };
}
async function discardProposal(globalDir, profileId, proposalId2, scope = "user") {
  const file = (0, import_node_path4.join)(proposalsDir(globalDir, profileId, scope), `${proposalId2}.json`);
  try {
    await import_node_fs3.promises.unlink(file);
    return true;
  } catch {
    return false;
  }
}
var import_node_fs3, import_node_path4;
var init_proposalStore = __esm({
  "packages/core/src/proposalStore.ts"() {
    "use strict";
    import_node_fs3 = require("node:fs");
    import_node_path4 = require("node:path");
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
  listPendingProposals: () => listPendingProposals,
  parseMemoryWriteRequest: () => parseMemoryWriteRequest,
  requestMemoryWrite: () => requestMemoryWrite,
  resolveUpdateTarget: () => resolveUpdateTarget,
  resolveWithdrawTarget: () => resolveWithdrawTarget,
  updateMemory: () => updateMemory,
  withdrawMemory: () => withdrawMemory
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
    const hit = skipped[0];
    if (hit.reason === "pending") {
      const pid = hit.pendingId ?? "<id>";
      return `\uB300\uAE30\uC5F4\uC5D0 \uAC19\uC740 \uC81C\uBAA9\uC758 \uC81C\uC548\uC774 \uC788\uB2E4 (${pid}). \uBC14\uAFB8\uB824\uBA74 memory withdraw ${pid} \uB4A4\uC5D0 \uB2E4\uC2DC add \uD55C\uB2E4`;
    }
    return "\uAC19\uC740 \uC81C\uBAA9\uC774 \uC774\uBBF8 \uC788\uB2E4. \uACE0\uCE58\uB824\uBA74 memory update <\uC2DD\uBCC4\uC790>\uB97C \uC4F4\uB2E4.";
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
function assertProposalId(id) {
  if (!id || !id.trim()) throw new WriteError("\uB0B4\uB9B4 \uC81C\uC548\uC758 \uC2DD\uBCC4\uC790\uAC00 \uC5C6\uB2E4");
  if (id.includes("/") || id.includes("\\") || id === "." || id === "..") {
    throw new WriteError("\uC81C\uC548 \uC2DD\uBCC4\uC790 \uD615\uC2DD\uC774 \uC544\uB2C8\uB2E4. memory pending\uC73C\uB85C \uD655\uC778\uD55C\uB2E4");
  }
}
async function resolveScopedTarget(wsDir, scope, existsInScope, notFoundMsg) {
  const scopes = scope ? [scope] : ["user", "project"];
  const found = [];
  for (const s of scopes) {
    const profileId = await resolveProfileIdForScope(wsDir, s);
    if (!profileId) {
      if (scope) throw new WriteError("\uC774 \uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4\uC758 \uD504\uB85C\uC81D\uD2B8 \uC9C0\uC2DD \uC790\uB9AC\uB97C \uCC3E\uC744 \uC218 \uC5C6\uB2E4");
      continue;
    }
    if (await existsInScope(s, profileId)) {
      found.push({ scope: s, profileId });
    }
  }
  if (found.length === 0) throw new WriteError(notFoundMsg);
  if (found.length > 1) throw new WriteError("\uC591\uCABD\uC5D0 \uAC19\uC740 \uC2DD\uBCC4\uC790\uAC00 \uC788\uB2E4. --scope\uB85C \uACE0\uB978\uB2E4");
  return found[0];
}
async function resolveUpdateTarget(storageRoot, wsDir, id, scope) {
  const { category, slug } = parseDocId(id);
  const globalDir = getGlobalDir(storageRoot);
  return resolveScopedTarget(
    wsDir,
    scope,
    async (s, profileId) => {
      const docs = await readProfileDocs(globalDir, profileId, s).catch(() => []);
      return docs.some((d) => d.category === category && d.slug === slug);
    },
    `${id}\uC5D0 \uD574\uB2F9\uD558\uB294 \uD56D\uBAA9\uC774 \uC5C6\uB2E4. memory user\uB85C \uBAA9\uB85D\uC744 \uBCF8\uB2E4`
  );
}
async function listPendingProposals(storageRoot, wsDir, scope) {
  const globalDir = getGlobalDir(storageRoot);
  const scopes = scope ? [scope] : ["user", "project"];
  const lines = [];
  for (const s of scopes) {
    const profileId = await resolveProfileIdForScope(wsDir, s);
    if (!profileId) continue;
    const proposals = await readProposals(globalDir, profileId, s).catch(() => []);
    if (proposals.length === 0) continue;
    lines.push(`### ${SCOPE_LABEL2[s]}`);
    for (const p of proposals) {
      const kind = p.targetSlug ? `\uACE0\uCE68 ${p.category}/${p.targetSlug}` : "\uC0C8 \uD56D\uBAA9";
      lines.push(`${p.id}  ${kind}  ${p.title}`);
    }
    lines.push("");
  }
  if (lines.length === 0) return "\uB300\uAE30 \uC911\uC778 \uC81C\uC548\uC774 \uC5C6\uB2E4";
  return lines.join("\n").trimEnd();
}
async function resolveWithdrawTarget(storageRoot, wsDir, id, scope) {
  assertProposalId(id);
  const globalDir = getGlobalDir(storageRoot);
  return resolveScopedTarget(
    wsDir,
    scope,
    async (s, profileId) => {
      const proposals = await readProposals(globalDir, profileId, s).catch(() => []);
      return proposals.some((p) => p.id === id);
    },
    `${id}\uC5D0 \uD574\uB2F9\uD558\uB294 \uB300\uAE30 \uC81C\uC548\uC774 \uC5C6\uB2E4. memory pending\uC73C\uB85C \uBAA9\uB85D\uC744 \uBCF8\uB2E4`
  );
}
async function withdrawMemory(storageRoot, profileId, scope, id) {
  assertProposalId(id);
  const removed = await discardProposal(getGlobalDir(storageRoot), profileId, id, scope);
  if (!removed) {
    throw new WriteError(`${id}\uC5D0 \uD574\uB2F9\uD558\uB294 \uB300\uAE30 \uC81C\uC548\uC774 \uC5C6\uB2E4. memory pending\uC73C\uB85C \uBAA9\uB85D\uC744 \uBCF8\uB2E4`);
  }
  return `\uB300\uAE30 \uC81C\uC548\uC744 \uB0B4\uB838\uB2E4 (${id}).`;
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
  if (p.op !== "add" && p.op !== "update" && p.op !== "withdraw") {
    throw new WriteError(`\uC54C \uC218 \uC5C6\uB294 \uC4F0\uAE30 \uC885\uB958\uB2E4`);
  }
  if (p.scope !== "user" && p.scope !== "project") throw new WriteError("--scope\uB294 user \uB610\uB294 project\uB2E4");
  if (typeof p.profileId !== "string" || !p.profileId) throw new WriteError("\uD504\uB85C\uD544 \uC790\uB9AC\uAC00 \uC5C6\uB2E4");
  const id = optionalString(p.id, "id");
  if (p.op === "update") {
    if (!id) throw new WriteError("\uACE0\uCE60 \uD56D\uBAA9\uC758 \uC2DD\uBCC4\uC790\uAC00 \uC5C6\uB2E4");
    parseDocId(id);
  }
  if (p.op === "withdraw") {
    assertProposalId(id ?? "");
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
  if (req.op === "withdraw") {
    return withdrawMemory(storageRoot, req.profileId, req.scope, req.id);
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
var WriteError, MODEL_WRITE_CONFIDENCE, SCOPE_LABEL2;
var init_write = __esm({
  "packages/core/src/agentCli/write.ts"() {
    "use strict";
    init_global();
    init_hostRequest();
    init_globalPaths();
    init_globalStore();
    init_proposalStore();
    init_read();
    WriteError = class extends Error {
    };
    MODEL_WRITE_CONFIDENCE = 1;
    SCOPE_LABEL2 = { user: "\uC0AC\uC6A9\uC790 \uC9C0\uC2DD", project: "\uD504\uB85C\uC81D\uD2B8 \uC9C0\uC2DD" };
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

// packages/core/src/cleanupSkillTemplate.ts
var CLEANUP_SKILL_DIR_NAME;
var init_cleanupSkillTemplate = __esm({
  "packages/core/src/cleanupSkillTemplate.ts"() {
    "use strict";
    CLEANUP_SKILL_DIR_NAME = "agentbridge-memory-cleanup";
  }
});

// packages/core/src/skillInstaller.ts
function skillFilePath(agent, homeDir, dirName = SKILL_DIR_NAME) {
  return (0, import_path8.join)(homeDir ?? (0, import_os3.homedir)(), ...SKILL_ROOTS[agent], dirName, "SKILL.md");
}
var import_os3, import_path8, SKILL_ROOTS;
var init_skillInstaller = __esm({
  "packages/core/src/skillInstaller.ts"() {
    "use strict";
    import_os3 = require("os");
    import_path8 = require("path");
    init_interfaces();
    init_skillTemplate();
    init_cleanupSkillTemplate();
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

// packages/core/src/replayPaths.ts
function replayLogPath(sessionDir2) {
  return (0, import_path11.join)(sessionDir2, "replay.log");
}
function replaySizePath(sessionDir2) {
  return (0, import_path11.join)(sessionDir2, "replay-size.json");
}
var import_path11;
var init_replayPaths = __esm({
  "packages/core/src/replayPaths.ts"() {
    "use strict";
    import_path11 = require("path");
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
async function readSessionActivityInputs(workspaceDir, sessionId, io = defaultIo) {
  const startFile = resolveTurnStartFile(workspaceDir, sessionId);
  const signalFile = resolveTurnSignalFile(workspaceDir, sessionId);
  const replayLogFile = replayLogPath((0, import_path12.join)(workspaceDir, "sessions", sessionId));
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
var import_fs9, import_path12, SILENCE_MS, defaultIo, startCache, signalCache, outputCache;
var init_sessionStatus = __esm({
  "packages/core/src/sessionStatus.ts"() {
    "use strict";
    import_fs9 = require("fs");
    import_path12 = require("path");
    init_turnSignal();
    init_replayPaths();
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
  return (0, import_path13.join)(workspaceDir, "sessions", sessionId, REPORT_READ_FILENAME);
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
  await import_fs10.promises.mkdir((0, import_path13.join)(workspaceDir, "sessions", sessionId), { recursive: true });
  await import_fs10.promises.writeFile(tmp, JSON.stringify({ at }), "utf8");
  await import_fs10.promises.rename(tmp, target);
}
async function isUnread(workspaceDir, sessionId) {
  const signal = await readTurnSignal(resolveTurnSignalFile(workspaceDir, sessionId));
  if (!signal || !signal.complete) return false;
  const readAt = await readReportReadAt(workspaceDir, sessionId);
  return signal.at > readAt;
}
var import_fs10, import_path13, REPORT_READ_FILENAME;
var init_reportState = __esm({
  "packages/core/src/agent/reportState.ts"() {
    "use strict";
    import_fs10 = require("fs");
    import_path13 = require("path");
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
  return (0, import_path14.join)(workspaceDir, "trees", name);
}
var import_fs11, import_path14;
var init_cleanup = __esm({
  "packages/core/src/agent/cleanup.ts"() {
    "use strict";
    import_fs11 = require("fs");
    import_path14 = require("path");
    init_gitWorktree();
  }
});

// packages/core/src/agent/diffMerge.ts
function runGit(cwd, args, opts = {}) {
  return new Promise((resolve3, reject) => {
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
        resolve3(String(stdout ?? ""));
      }
    );
  });
}
async function snapshotAgainst(dir, base) {
  const scratch = await import_node_fs4.promises.mkdtemp((0, import_node_path5.join)((0, import_node_os.tmpdir)(), "agentbridge-index-"));
  const env = { GIT_INDEX_FILE: (0, import_node_path5.join)(scratch, "index") };
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
    await import_node_fs4.promises.rm(scratch, { recursive: true, force: true }).catch(() => {
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
var import_node_child_process2, import_node_fs4, import_node_path5, import_node_os, GIT_TIMEOUT_MS2, GIT_WRITE_TIMEOUT_MS, GIT_MAX_BUFFER2, PATCH_LIMIT_BYTES;
var init_diffMerge = __esm({
  "packages/core/src/agent/diffMerge.ts"() {
    "use strict";
    import_node_child_process2 = require("node:child_process");
    import_node_fs4 = require("node:fs");
    import_node_path5 = require("node:path");
    import_node_os = require("node:os");
    init_cleanup();
    GIT_TIMEOUT_MS2 = 1e4;
    GIT_WRITE_TIMEOUT_MS = 12e4;
    GIT_MAX_BUFFER2 = 64 * 1024 * 1024;
    PATCH_LIMIT_BYTES = 5e4;
  }
});

// node_modules/.pnpm/@xterm+headless@6.1.0-beta.220/node_modules/@xterm/headless/lib-headless/xterm-headless.js
var require_xterm_headless = __commonJS({
  "node_modules/.pnpm/@xterm+headless@6.1.0-beta.220/node_modules/@xterm/headless/lib-headless/xterm-headless.js"(exports2) {
    (() => {
      "use strict";
      var e = { 25(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.InstantiationService = t2.ServiceCollection = void 0;
        const s2 = i2(501), r2 = i2(201);
        class n2 {
          _entries = /* @__PURE__ */ new Map();
          constructor(...e3) {
            for (const [t3, i3] of e3) this.set(t3, i3);
          }
          set(e3, t3) {
            const i3 = this._entries.get(e3);
            return this._entries.set(e3, t3), i3;
          }
          forEach(e3) {
            for (const [t3, i3] of this._entries.entries()) e3(t3, i3);
          }
          has(e3) {
            return this._entries.has(e3);
          }
          get(e3) {
            return this._entries.get(e3);
          }
        }
        t2.ServiceCollection = n2, t2.InstantiationService = class {
          serviceBrand;
          _services = new n2();
          constructor() {
            this._services.set(s2.IInstantiationService, this);
          }
          setService(e3, t3) {
            this._services.set(e3, t3);
          }
          getService(e3) {
            return this._services.get(e3);
          }
          createInstance(e3, ...t3) {
            const i3 = (0, r2.getServiceDependencies)(e3).sort((e4, t4) => e4.index - t4.index), s3 = [];
            for (const t4 of i3) {
              const i4 = this._services.get(t4.id);
              if (!i4) throw new Error(`[createInstance] ${e3.name} depends on UNKNOWN service ${t4.id._id}.`);
              s3.push(i4);
            }
            const n3 = i3.length > 0 ? i3[0].index : t3.length;
            if (t3.length !== n3) throw new Error(`[createInstance] First service dependency of ${e3.name} at position ${n3 + 1} conflicts with ${t3.length} static arguments`);
            return new e3(...[...t3, ...s3]);
          }
        };
      }, 27(e2, t2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.AddonManager = void 0, t2.AddonManager = class {
          _addons = [];
          dispose() {
            for (let e3 = this._addons.length - 1; e3 >= 0; e3--) this._addons[e3].instance.dispose();
          }
          loadAddon(e3, t3) {
            const i2 = { instance: t3, dispose: t3.dispose, isDisposed: false };
            this._addons.push(i2), t3.dispose = () => this._wrappedAddonDispose(i2), t3.activate(e3);
          }
          _wrappedAddonDispose(e3) {
            if (e3.isDisposed) return;
            let t3 = -1;
            for (let i2 = 0; i2 < this._addons.length; i2++) if (this._addons[i2] === e3) {
              t3 = i2;
              break;
            }
            if (-1 === t3) throw new Error("Could not dispose an addon that has not been loaded");
            e3.isDisposed = true, e3.dispose.apply(e3.instance), this._addons.splice(t3, 1);
          }
        };
      }, 55(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.CellData = void 0;
        const s2 = i2(726), r2 = i2(938), n2 = i2(451);
        class a extends n2.AttributeData {
          static fromCharData(e3) {
            const t3 = new a();
            return t3.setFromCharData(e3), t3;
          }
          content = 0;
          fg = 0;
          bg = 0;
          extended = new n2.ExtendedAttrs();
          combinedData = "";
          isCombined() {
            return 2097152 & this.content;
          }
          getWidth() {
            return this.content >> 22;
          }
          getChars() {
            return 2097152 & this.content ? this.combinedData : 2097151 & this.content ? (0, s2.stringFromCodePoint)(2097151 & this.content) : "";
          }
          getCode() {
            return this.isCombined() ? this.combinedData.charCodeAt(this.combinedData.length - 1) : 2097151 & this.content;
          }
          setFromCharData(e3) {
            this.fg = e3[r2.CHAR_DATA_ATTR_INDEX], this.bg = 0;
            let t3 = false;
            if (e3[r2.CHAR_DATA_CHAR_INDEX].length > 2) t3 = true;
            else if (2 === e3[r2.CHAR_DATA_CHAR_INDEX].length) {
              const i3 = e3[r2.CHAR_DATA_CHAR_INDEX].charCodeAt(0);
              if (55296 <= i3 && i3 <= 56319) {
                const s3 = e3[r2.CHAR_DATA_CHAR_INDEX].charCodeAt(1);
                56320 <= s3 && s3 <= 57343 ? this.content = 1024 * (i3 - 55296) + s3 - 56320 + 65536 | e3[r2.CHAR_DATA_WIDTH_INDEX] << 22 : t3 = true;
              } else t3 = true;
            } else this.content = e3[r2.CHAR_DATA_CHAR_INDEX].charCodeAt(0) | e3[r2.CHAR_DATA_WIDTH_INDEX] << 22;
            t3 && (this.combinedData = e3[r2.CHAR_DATA_CHAR_INDEX], this.content = 2097152 | e3[r2.CHAR_DATA_WIDTH_INDEX] << 22);
          }
          getAsCharData() {
            return [this.fg, this.getChars(), this.getWidth(), this.getCode()];
          }
          attributesEquals(e3) {
            if (this.getFgColorMode() !== e3.getFgColorMode() || this.getFgColor() !== e3.getFgColor()) return false;
            if (this.getBgColorMode() !== e3.getBgColorMode() || this.getBgColor() !== e3.getBgColor()) return false;
            if (this.isInverse() !== e3.isInverse()) return false;
            if (this.isBold() !== e3.isBold()) return false;
            if (this.isUnderline() !== e3.isUnderline()) return false;
            if (this.isUnderline()) {
              if (this.getUnderlineStyle() !== e3.getUnderlineStyle()) return false;
              const t3 = this.isUnderlineColorDefault(), i3 = e3.isUnderlineColorDefault();
              if (!t3 || !i3) {
                if (t3 !== i3) return false;
                if (this.getUnderlineColor() !== e3.getUnderlineColor()) return false;
                if (this.getUnderlineColorMode() !== e3.getUnderlineColorMode()) return false;
              }
            }
            return this.isOverline() === e3.isOverline() && this.isBlink() === e3.isBlink() && this.isInvisible() === e3.isInvisible() && this.isItalic() === e3.isItalic() && this.isDim() === e3.isDim() && this.isStrikethrough() === e3.isStrikethrough();
          }
        }
        t2.CellData = a;
      }, 56(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.OptionsService = t2.DEFAULT_OPTIONS = void 0;
        const s2 = i2(812), r2 = i2(701), n2 = i2(636);
        t2.DEFAULT_OPTIONS = { cols: 80, rows: 24, showCursorImmediately: false, cursorBlink: false, blinkIntervalDuration: 0, cursorStyle: "block", cursorWidth: 1, cursorInactiveStyle: "outline", drawBoldTextInBrightColors: true, documentOverride: null, fastScrollSensitivity: 5, fontFamily: "monospace", fontSize: 15, fontWeight: "normal", fontWeightBold: "bold", ignoreBracketedPasteMode: false, lineHeight: 1, letterSpacing: 0, linkHandler: null, logLevel: "info", logger: null, scrollback: 1e3, scrollbar: { showScrollbar: true }, scrollOnEraseInDisplay: false, scrollOnUserInput: true, scrollSensitivity: 1, screenReaderMode: false, smoothScrollDuration: 0, macOptionIsMeta: false, macOptionClickForcesSelection: false, minimumContrastRatio: 1, disableStdin: false, allowProposedApi: false, allowTransparency: false, tabStopWidth: 8, theme: {}, reflowCursorLine: false, rescaleOverlappingGlyphs: false, rightClickSelectsWord: r2.isMac, windowOptions: {}, windowsPty: {}, wordSeparator: " ()[]{}',\"`", altClickMovesCursor: true, convertEol: false, termName: "xterm", quirks: {}, vtExtensions: {} };
        const a = ["normal", "bold", "100", "200", "300", "400", "500", "600", "700", "800", "900"];
        class o extends s2.Disposable {
          serviceBrand;
          rawOptions;
          options;
          _onOptionChange = this._register(new n2.Emitter());
          onOptionChange = this._onOptionChange.event;
          constructor(e3) {
            super();
            const i3 = { ...t2.DEFAULT_OPTIONS };
            for (const t3 in e3) if (t3 in i3) try {
              const s3 = e3[t3];
              i3[t3] = this._sanitizeAndValidateOption(t3, s3);
            } catch (e4) {
              console.error(e4);
            }
            this.rawOptions = i3, this.options = { ...i3 }, this._setupOptions(), this._register((0, s2.toDisposable)(() => {
              this.rawOptions.linkHandler = null, this.rawOptions.documentOverride = null;
            }));
          }
          onSpecificOptionChange(e3, t3) {
            return this.onOptionChange((i3) => {
              i3 === e3 && t3(this.rawOptions[e3]);
            });
          }
          onMultipleOptionChange(e3, t3) {
            return this.onOptionChange((i3) => {
              -1 !== e3.indexOf(i3) && t3();
            });
          }
          _setupOptions() {
            const e3 = (e4) => {
              if (!(e4 in t2.DEFAULT_OPTIONS)) throw new Error(`No option with key "${e4}"`);
              return this.rawOptions[e4];
            }, i3 = (e4, i4) => {
              if (!(e4 in t2.DEFAULT_OPTIONS)) throw new Error(`No option with key "${e4}"`);
              i4 = this._sanitizeAndValidateOption(e4, i4), this.rawOptions[e4] !== i4 && (this.rawOptions[e4] = i4, this._onOptionChange.fire(e4));
            };
            for (const t3 in this.rawOptions) {
              const s3 = { get: e3.bind(this, t3), set: i3.bind(this, t3) };
              Object.defineProperty(this.options, t3, s3);
            }
          }
          _sanitizeAndValidateOption(e3, i3) {
            switch (e3) {
              case "cursorStyle":
                if (i3 || (i3 = t2.DEFAULT_OPTIONS[e3]), !/* @__PURE__ */ (function(e4) {
                  return "block" === e4 || "underline" === e4 || "bar" === e4;
                })(i3)) throw new Error(`"${i3}" is not a valid value for ${e3}`);
                break;
              case "wordSeparator":
                i3 || (i3 = t2.DEFAULT_OPTIONS[e3]);
                break;
              case "fontWeight":
              case "fontWeightBold":
                if ("number" == typeof i3 && 1 <= i3 && i3 <= 1e3) break;
                i3 = a.includes(i3) ? i3 : t2.DEFAULT_OPTIONS[e3];
                break;
              case "blinkIntervalDuration":
                if ((i3 = Math.floor(i3)) < 0) throw new Error(`${e3} cannot be less than 0, value: ${i3}`);
                break;
              case "cursorWidth":
                i3 = Math.floor(i3);
              case "lineHeight":
              case "tabStopWidth":
                if (i3 < 1) throw new Error(`${e3} cannot be less than 1, value: ${i3}`);
                break;
              case "minimumContrastRatio":
                i3 = Math.max(1, Math.min(21, Math.round(10 * i3) / 10));
                break;
              case "scrollback":
                if ((i3 = Math.min(i3, 4294967295)) < 0) throw new Error(`${e3} cannot be less than 0, value: ${i3}`);
                break;
              case "fastScrollSensitivity":
              case "scrollSensitivity":
                if (i3 <= 0) throw new Error(`${e3} cannot be less than or equal to 0, value: ${i3}`);
                break;
              case "rows":
              case "cols":
                if (!i3 && 0 !== i3) throw new Error(`${e3} must be numeric, value: ${i3}`);
                break;
              case "windowsPty":
                i3 = i3 ?? {};
            }
            return i3;
          }
        }
        t2.OptionsService = o;
      }, 71(e2, t2, i2) {
        var s2 = this && this.__decorate || function(e3, t3, i3, s3) {
          var r3, n3 = arguments.length, a2 = n3 < 3 ? t3 : null === s3 ? s3 = Object.getOwnPropertyDescriptor(t3, i3) : s3;
          if ("object" == typeof Reflect && "function" == typeof Reflect.decorate) a2 = Reflect.decorate(e3, t3, i3, s3);
          else for (var o2 = e3.length - 1; o2 >= 0; o2--) (r3 = e3[o2]) && (a2 = (n3 < 3 ? r3(a2) : n3 > 3 ? r3(t3, i3, a2) : r3(t3, i3)) || a2);
          return n3 > 3 && a2 && Object.defineProperty(t3, i3, a2), a2;
        }, r2 = this && this.__param || function(e3, t3) {
          return function(i3, s3) {
            t3(i3, s3, e3);
          };
        };
        Object.defineProperty(t2, "__esModule", { value: true }), t2.CoreService = void 0;
        const n2 = i2(453), a = i2(812), o = i2(501), h = i2(636), c = Object.freeze({ insertMode: false }), l = Object.freeze({ applicationCursorKeys: false, applicationKeypad: false, bracketedPasteMode: false, colorSchemeUpdates: false, cursorBlink: void 0, cursorStyle: void 0, origin: false, reverseWraparound: false, sendFocus: false, synchronizedOutput: false, win32InputMode: false, wraparound: true });
        let _ = class extends a.Disposable {
          _bufferService;
          _logService;
          _optionsService;
          serviceBrand;
          isCursorInitialized;
          isCursorHidden = false;
          modes;
          decPrivateModes;
          kittyKeyboard;
          _onData = this._register(new h.Emitter());
          onData = this._onData.event;
          _onUserInput = this._register(new h.Emitter());
          onUserInput = this._onUserInput.event;
          _onBinary = this._register(new h.Emitter());
          onBinary = this._onBinary.event;
          _onRequestScrollToBottom = this._register(new h.Emitter());
          onRequestScrollToBottom = this._onRequestScrollToBottom.event;
          constructor(e3, t3, i3) {
            super(), this._bufferService = e3, this._logService = t3, this._optionsService = i3, this.isCursorInitialized = i3.rawOptions.showCursorImmediately ?? false, this.modes = (0, n2.clone)(c), this.decPrivateModes = (0, n2.clone)(l), this.kittyKeyboard = { flags: 0, mainFlags: 0, altFlags: 0, mainStack: [], altStack: [] };
          }
          reset() {
            this.modes = (0, n2.clone)(c), this.decPrivateModes = (0, n2.clone)(l), this.kittyKeyboard = { flags: 0, mainFlags: 0, altFlags: 0, mainStack: [], altStack: [] };
          }
          triggerDataEvent(e3, t3 = false) {
            if (this._optionsService.rawOptions.disableStdin) return;
            const i3 = this._bufferService.buffer;
            t3 && this._optionsService.rawOptions.scrollOnUserInput && i3.ybase !== i3.ydisp && this._onRequestScrollToBottom.fire(), t3 && this._onUserInput.fire(), this._logService.debug(`sending data "${e3}"`), this._logService.trace("sending data (codes)", () => e3.split("").map((e4) => e4.charCodeAt(0))), this._onData.fire(e3);
          }
          triggerBinaryEvent(e3) {
            this._optionsService.rawOptions.disableStdin || (this._logService.debug(`sending binary "${e3}"`), this._logService.trace("sending binary (codes)", () => e3.split("").map((e4) => e4.charCodeAt(0))), this._onBinary.fire(e3));
          }
        };
        t2.CoreService = _, t2.CoreService = _ = s2([r2(0, o.IBufferService), r2(1, o.ILogService), r2(2, o.IOptionsService)], _);
      }, 73(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.Buffer = t2.MAX_BUFFER_SIZE = void 0;
        const s2 = i2(639), r2 = i2(812), n2 = i2(168), a = i2(451), o = i2(107), h = i2(326), c = i2(732), l = i2(55), _ = i2(938), d = i2(158), f = i2(760);
        t2.MAX_BUFFER_SIZE = 4294967295;
        class u extends r2.Disposable {
          _hasScrollback;
          _optionsService;
          _bufferService;
          _logService;
          lines;
          ydisp = 0;
          ybase = 0;
          y = 0;
          x = 0;
          scrollBottom;
          scrollTop;
          tabs = {};
          savedY = 0;
          savedX = 0;
          savedCurAttrData = o.DEFAULT_ATTR_DATA.clone();
          savedCharset = f.DEFAULT_CHARSET;
          savedCharsets = [];
          savedGlevel = 0;
          savedOriginMode = false;
          savedWraparoundMode = true;
          markers = [];
          _nullCell = l.CellData.fromCharData([0, _.NULL_CELL_CHAR, _.NULL_CELL_WIDTH, _.NULL_CELL_CODE]);
          _whitespaceCell = l.CellData.fromCharData([0, _.WHITESPACE_CELL_CHAR, _.WHITESPACE_CELL_WIDTH, _.WHITESPACE_CELL_CODE]);
          _cols;
          _rows;
          _isClearing = false;
          _memoryCleanupQueue;
          _memoryCleanupPosition = 0;
          _stringCache;
          constructor(e3, t3, i3, a2) {
            super(), this._hasScrollback = e3, this._optionsService = t3, this._bufferService = i3, this._logService = a2, this._cols = this._bufferService.cols, this._rows = this._bufferService.rows, this.lines = new s2.CircularList(this._getCorrectBufferLength(this._rows)), this.scrollTop = 0, this.scrollBottom = this._rows - 1, this.setupTabStops(), this._memoryCleanupQueue = new n2.IdleTaskQueue(this._logService), this._register((0, r2.toDisposable)(() => this._memoryCleanupQueue.clear())), this._register((0, r2.toDisposable)(() => this.clearAllMarkers())), this._stringCache = this._register(new h.BufferLineStringCache());
          }
          getNullCell(e3) {
            return e3 ? (this._nullCell.fg = e3.fg, this._nullCell.bg = e3.bg, this._nullCell.extended = e3.extended) : (this._nullCell.fg = 0, this._nullCell.bg = 0, this._nullCell.extended = new a.ExtendedAttrs()), this._nullCell;
          }
          getWhitespaceCell(e3) {
            return e3 ? (this._whitespaceCell.fg = e3.fg, this._whitespaceCell.bg = e3.bg, this._whitespaceCell.extended = e3.extended) : (this._whitespaceCell.fg = 0, this._whitespaceCell.bg = 0, this._whitespaceCell.extended = new a.ExtendedAttrs()), this._whitespaceCell;
          }
          getBlankLine(e3, t3) {
            return new o.BufferLine(this._stringCache, this._bufferService.cols, this.getNullCell(e3), t3);
          }
          get hasScrollback() {
            return this._hasScrollback && this.lines.maxLength > this._rows;
          }
          get isCursorInViewport() {
            const e3 = this.ybase + this.y - this.ydisp;
            return e3 >= 0 && e3 < this._rows;
          }
          _getCorrectBufferLength(e3) {
            if (!this._hasScrollback) return e3;
            const i3 = e3 + this._optionsService.rawOptions.scrollback;
            return i3 > t2.MAX_BUFFER_SIZE ? t2.MAX_BUFFER_SIZE : i3;
          }
          fillViewportRows(e3) {
            if (0 === this.lines.length) {
              e3 ??= o.DEFAULT_ATTR_DATA;
              let t3 = this._rows;
              for (; t3--; ) this.lines.push(this.getBlankLine(e3));
            }
          }
          clear() {
            this._stringCache.clear(), this.ydisp = 0, this.ybase = 0, this.y = 0, this.x = 0, this.lines = new s2.CircularList(this._getCorrectBufferLength(this._rows)), this.scrollTop = 0, this.scrollBottom = this._rows - 1, this.setupTabStops();
          }
          resize(e3, t3) {
            const i3 = this.getNullCell(o.DEFAULT_ATTR_DATA);
            this._stringCache.clear();
            let s3 = 0;
            const r3 = this._getCorrectBufferLength(t3);
            if (r3 > this.lines.maxLength && (this.lines.maxLength = r3), this.lines.length > 0) {
              if (this._cols < e3) for (let t4 = 0; t4 < this.lines.length; t4++) s3 += +this.lines.get(t4).resize(e3, i3);
              let n3 = 0;
              if (this._rows < t3) for (let s4 = this._rows; s4 < t3; s4++) this.lines.length < t3 + this.ybase && (void 0 !== this._optionsService.rawOptions.windowsPty.backend || void 0 !== this._optionsService.rawOptions.windowsPty.buildNumber ? this.lines.push(new o.BufferLine(this._stringCache, e3, i3, false)) : this.ybase > 0 && this.lines.length <= this.ybase + this.y + n3 + 1 ? (this.ybase--, n3++, this.ydisp > 0 && this.ydisp--) : this.lines.push(new o.BufferLine(this._stringCache, e3, i3, false)));
              else for (let e4 = this._rows; e4 > t3; e4--) this.lines.length > t3 + this.ybase && (this.lines.length > this.ybase + this.y + 1 ? this.lines.pop() : (this.ybase++, this.ydisp++));
              if (r3 < this.lines.maxLength) {
                const e4 = this.lines.length - r3;
                e4 > 0 && (this.lines.trimStart(e4), this.ybase = Math.max(this.ybase - e4, 0), this.ydisp = Math.max(this.ydisp - e4, 0), this.savedY = Math.max(this.savedY - e4, 0)), this.lines.maxLength = r3;
              }
              this.x = Math.min(this.x, e3 - 1), this.y = Math.min(this.y, t3 - 1), n3 && (this.y += n3), this.savedX = Math.min(this.savedX, e3 - 1), this.scrollTop = 0;
            }
            if (this.scrollBottom = t3 - 1, this._isReflowEnabled && (this._reflow(e3, t3), this._cols > e3)) for (let t4 = 0; t4 < this.lines.length; t4++) s3 += +this.lines.get(t4).resize(e3, i3);
            if (this._cols = e3, this._rows = t3, this.lines.length > 0) {
              const e4 = Math.max(0, this.lines.length - this.ybase - 1);
              this.y = Math.min(this.y, e4);
            }
            this._memoryCleanupQueue.clear(), s3 > 0.1 * this.lines.length && (this._memoryCleanupPosition = 0, this._memoryCleanupQueue.enqueue(() => this._batchedMemoryCleanup()));
          }
          _batchedMemoryCleanup() {
            let e3 = true;
            this._memoryCleanupPosition >= this.lines.length && (this._memoryCleanupPosition = 0, e3 = false);
            let t3 = 0;
            for (; this._memoryCleanupPosition < this.lines.length; ) if (t3 += this.lines.get(this._memoryCleanupPosition++).cleanupMemory(), t3 > 100) return true;
            return e3;
          }
          get _isReflowEnabled() {
            const e3 = this._optionsService.rawOptions.windowsPty;
            return e3 && e3.buildNumber ? this._hasScrollback && "conpty" === e3.backend && e3.buildNumber >= 21376 : this._hasScrollback;
          }
          _reflow(e3, t3) {
            this._cols !== e3 && (e3 > this._cols ? this._reflowLarger(e3, t3) : this._reflowSmaller(e3, t3));
          }
          _reflowLarger(e3, t3) {
            const i3 = this._optionsService.rawOptions.reflowCursorLine, s3 = (0, c.reflowLargerGetLinesToRemove)(this.lines, this._cols, e3, this.ybase + this.y, this.getNullCell(o.DEFAULT_ATTR_DATA), i3);
            if (s3.length > 0) {
              const i4 = (0, c.reflowLargerCreateNewLayout)(this.lines, s3);
              (0, c.reflowLargerApplyNewLayout)(this.lines, i4.layout), this._reflowLargerAdjustViewport(e3, t3, i4.countRemoved);
            }
          }
          _reflowLargerAdjustViewport(e3, t3, i3) {
            const s3 = this.getNullCell(o.DEFAULT_ATTR_DATA);
            let r3 = i3;
            for (; r3-- > 0; ) 0 === this.ybase ? (this.y > 0 && this.y--, this.lines.length < t3 && this.lines.push(new o.BufferLine(this._stringCache, e3, s3, false))) : (this.ydisp === this.ybase && this.ydisp--, this.ybase--);
            this.savedY = Math.max(this.savedY - i3, 0);
          }
          _reflowSmaller(e3, t3) {
            const i3 = this._optionsService.rawOptions.reflowCursorLine, s3 = this.getNullCell(o.DEFAULT_ATTR_DATA), r3 = [];
            let n3 = 0;
            for (let a2 = this.lines.length - 1; a2 >= 0; a2--) {
              let h2 = this.lines.get(a2);
              if (!h2 || !h2.isWrapped && h2.getTrimmedLength() <= e3) continue;
              const l2 = [h2];
              for (; h2.isWrapped && a2 > 0; ) h2 = this.lines.get(--a2), l2.unshift(h2);
              if (!i3) {
                const e4 = this.ybase + this.y;
                if (e4 >= a2 && e4 < a2 + l2.length) continue;
              }
              const _2 = l2[l2.length - 1].getTrimmedLength(), d2 = (0, c.reflowSmallerGetNewLineLengths)(l2, this._cols, e3), f2 = d2.length - l2.length;
              let u2;
              u2 = 0 === this.ybase && this.y !== this.lines.length - 1 ? Math.max(0, this.y - this.lines.maxLength + f2) : Math.max(0, this.lines.length - this.lines.maxLength + f2);
              const g = [];
              for (let e4 = 0; e4 < f2; e4++) {
                const e5 = this.getBlankLine(o.DEFAULT_ATTR_DATA, true);
                g.push(e5);
              }
              g.length > 0 && (r3.push({ start: a2 + l2.length + n3, newLines: g }), n3 += g.length), l2.push(...g);
              let p = d2.length - 1, v = d2[p];
              0 === v && (p--, v = d2[p]);
              let b = l2.length - f2 - 1, S = _2;
              for (; b >= 0; ) {
                const e4 = Math.min(S, v);
                if (void 0 === l2[p]) break;
                if (l2[p].copyCellsFrom(l2[b], S - e4, v - e4, e4, true), v -= e4, 0 === v && (p--, v = d2[p]), S -= e4, 0 === S) {
                  b--;
                  const e5 = Math.max(b, 0);
                  S = (0, c.getWrappedLineTrimmedLength)(l2, e5, this._cols);
                }
              }
              for (let t4 = 0; t4 < l2.length; t4++) d2[t4] < e3 && l2[t4].setCell(d2[t4], s3);
              let m = f2 - u2;
              for (; m-- > 0; ) 0 === this.ybase ? this.y < t3 - 1 ? (this.y++, this.lines.pop()) : (this.ybase++, this.ydisp++) : this.ybase < Math.min(this.lines.maxLength, this.lines.length + n3) - t3 && (this.ybase === this.ydisp && this.ydisp++, this.ybase++);
              this.savedY = Math.min(this.savedY + f2, this.ybase + t3 - 1);
            }
            if (r3.length > 0) {
              const e4 = [], t4 = [];
              for (let e5 = 0; e5 < this.lines.length; e5++) t4.push(this.lines.get(e5));
              const i4 = this.lines.length;
              let s4 = i4 - 1, a2 = 0, o2 = r3[a2];
              this.lines.length = Math.min(this.lines.maxLength, this.lines.length + n3);
              let h2 = 0;
              for (let c3 = Math.min(this.lines.maxLength - 1, i4 + n3 - 1); c3 >= 0; c3--) if (o2 && o2.start > s4 + h2) {
                for (let e5 = o2.newLines.length - 1; e5 >= 0; e5--) this.lines.set(c3--, o2.newLines[e5]);
                c3++, e4.push({ index: s4 + 1, amount: o2.newLines.length }), h2 += o2.newLines.length, o2 = r3[++a2];
              } else this.lines.set(c3, t4[s4--]);
              let c2 = 0;
              for (let t5 = e4.length - 1; t5 >= 0; t5--) e4[t5].index += c2, this.lines.onInsertEmitter.fire(e4[t5]), c2 += e4[t5].amount;
              const l2 = Math.max(0, i4 + n3 - this.lines.maxLength);
              l2 > 0 && this.lines.onTrimEmitter.fire(l2);
            }
          }
          translateBufferLineToString(e3, t3, i3 = 0, s3) {
            const r3 = this.lines.get(e3);
            return r3 ? r3.translateToString(t3, i3, s3) : "";
          }
          getWrappedRangeForLine(e3) {
            let t3 = e3, i3 = e3;
            for (; t3 > 0 && this.lines.get(t3).isWrapped; ) t3--;
            for (; i3 + 1 < this.lines.length && this.lines.get(i3 + 1).isWrapped; ) i3++;
            return { first: t3, last: i3 };
          }
          setupTabStops(e3) {
            for (null != e3 ? this.tabs[e3] || (e3 = this.prevStop(e3)) : (this.tabs = {}, e3 = 0); e3 < this._cols; e3 += this._optionsService.rawOptions.tabStopWidth) this.tabs[e3] = true;
          }
          prevStop(e3) {
            for (e3 ??= this.x; !this.tabs[--e3] && e3 > 0; ) ;
            return e3 >= this._cols ? this._cols - 1 : e3 < 0 ? 0 : e3;
          }
          nextStop(e3) {
            for (e3 ??= this.x; !this.tabs[++e3] && e3 < this._cols; ) ;
            return e3 >= this._cols ? this._cols - 1 : e3 < 0 ? 0 : e3;
          }
          clearMarkers(e3) {
            this._isClearing = true;
            for (let t3 = 0; t3 < this.markers.length; t3++) this.markers[t3].line === e3 && (this.markers[t3].dispose(), this.markers.splice(t3--, 1));
            this._isClearing = false;
          }
          clearAllMarkers() {
            this._isClearing = true;
            for (let e3 = 0; e3 < this.markers.length; e3++) this.markers[e3].dispose();
            this.markers.length = 0, this._isClearing = false;
          }
          addMarker(e3) {
            const t3 = new d.Marker(e3);
            return this.markers.push(t3), t3.register(this.lines.onTrim((e4) => {
              t3.line -= e4, t3.line < 0 && t3.dispose();
            })), t3.register(this.lines.onInsert((e4) => {
              t3.line >= e4.index && (t3.line += e4.amount);
            })), t3.register(this.lines.onDelete((e4) => {
              t3.line >= e4.index && t3.line < e4.index + e4.amount && t3.dispose(), t3.line > e4.index && (t3.line -= e4.amount);
            })), t3.register(t3.onDispose(() => this._removeMarker(t3))), t3;
          }
          _removeMarker(e3) {
            this._isClearing || this.markers.splice(this.markers.indexOf(e3), 1);
          }
        }
        t2.Buffer = u;
      }, 97(e2, t2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.ParserApi = void 0, t2.ParserApi = class {
          _core;
          constructor(e3) {
            this._core = e3;
          }
          registerCsiHandler(e3, t3) {
            return this._core.registerCsiHandler(e3, (e4) => t3(e4.toArray()));
          }
          addCsiHandler(e3, t3) {
            return this.registerCsiHandler(e3, t3);
          }
          registerDcsHandler(e3, t3) {
            return this._core.registerDcsHandler(e3, (e4, i2) => t3(e4, i2.toArray()));
          }
          addDcsHandler(e3, t3) {
            return this.registerDcsHandler(e3, t3);
          }
          registerEscHandler(e3, t3) {
            return this._core.registerEscHandler(e3, t3);
          }
          addEscHandler(e3, t3) {
            return this.registerEscHandler(e3, t3);
          }
          registerOscHandler(e3, t3) {
            return this._core.registerOscHandler(e3, t3);
          }
          addOscHandler(e3, t3) {
            return this.registerOscHandler(e3, t3);
          }
          registerApcHandler(e3, t3) {
            return this._core.registerApcHandler(e3, t3);
          }
        };
      }, 101(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.BufferNamespaceApi = void 0;
        const s2 = i2(235), r2 = i2(812), n2 = i2(636);
        class a extends r2.Disposable {
          _core;
          _normal;
          _alternate;
          _onBufferChange = this._register(new n2.Emitter());
          onBufferChange = this._onBufferChange.event;
          constructor(e3) {
            super(), this._core = e3, this._normal = new s2.BufferApiView(this._core.buffers.normal, "normal"), this._alternate = new s2.BufferApiView(this._core.buffers.alt, "alternate"), this._core.buffers.onBufferActivate(() => this._onBufferChange.fire(this.active));
          }
          get active() {
            if (this._core.buffers.active === this._core.buffers.normal) return this.normal;
            if (this._core.buffers.active === this._core.buffers.alt) return this.alternate;
            throw new Error("Active buffer is neither normal nor alternate");
          }
          get normal() {
            return this._normal.init(this._core.buffers.normal);
          }
          get alternate() {
            return this._alternate.init(this._core.buffers.alt);
          }
        }
        t2.BufferNamespaceApi = a;
      }, 107(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.BufferLine = t2.DEFAULT_ATTR_DATA = void 0;
        const s2 = i2(451), r2 = i2(55), n2 = i2(938), a = i2(726);
        t2.DEFAULT_ATTR_DATA = Object.freeze(new s2.AttributeData());
        let o = 0;
        const h = new r2.CellData();
        class c {
          _stringCache;
          isWrapped;
          _data;
          _combined = {};
          _extendedAttrs = {};
          _stringCacheEntryRef;
          length;
          constructor(e3, t3, i3, s3 = false) {
            this._stringCache = e3, this.isWrapped = s3, this._data = new Uint32Array(3 * t3);
            const a2 = i3 ?? r2.CellData.fromCharData([0, n2.NULL_CELL_CHAR, n2.NULL_CELL_WIDTH, n2.NULL_CELL_CODE]);
            for (let e4 = 0; e4 < t3; ++e4) this.setCell(e4, a2);
            this.length = t3;
          }
          get(e3) {
            const t3 = this._data[3 * e3 + 0], i3 = 2097151 & t3;
            return [this._data[3 * e3 + 1], 2097152 & t3 ? this._combined[e3] : i3 ? (0, a.stringFromCodePoint)(i3) : "", t3 >> 22, 2097152 & t3 ? this._combined[e3].charCodeAt(this._combined[e3].length - 1) : i3];
          }
          set(e3, t3) {
            this._invalidateStringCache(), this._data[3 * e3 + 1] = t3[n2.CHAR_DATA_ATTR_INDEX], t3[n2.CHAR_DATA_CHAR_INDEX].length > 1 ? (this._combined[e3] = t3[1], this._data[3 * e3 + 0] = 2097152 | e3 | t3[n2.CHAR_DATA_WIDTH_INDEX] << 22) : this._data[3 * e3 + 0] = t3[n2.CHAR_DATA_CHAR_INDEX].charCodeAt(0) | t3[n2.CHAR_DATA_WIDTH_INDEX] << 22;
          }
          getWidth(e3) {
            return this._data[3 * e3 + 0] >> 22;
          }
          hasWidth(e3) {
            return 12582912 & this._data[3 * e3 + 0];
          }
          getFg(e3) {
            return this._data[3 * e3 + 1];
          }
          getBg(e3) {
            return this._data[3 * e3 + 2];
          }
          hasContent(e3) {
            return 4194303 & this._data[3 * e3 + 0];
          }
          getCodePoint(e3) {
            const t3 = this._data[3 * e3 + 0];
            return 2097152 & t3 ? this._combined[e3].charCodeAt(this._combined[e3].length - 1) : 2097151 & t3;
          }
          isCombined(e3) {
            return 2097152 & this._data[3 * e3 + 0];
          }
          getString(e3) {
            const t3 = this._data[3 * e3 + 0];
            return 2097152 & t3 ? this._combined[e3] : 2097151 & t3 ? (0, a.stringFromCodePoint)(2097151 & t3) : "";
          }
          isProtected(e3) {
            return 536870912 & this._data[3 * e3 + 2];
          }
          loadCell(e3, t3) {
            return o = 3 * e3, t3.content = this._data[o + 0], t3.fg = this._data[o + 1], t3.bg = this._data[o + 2], 2097152 & t3.content && (t3.combinedData = this._combined[e3]), 268435456 & t3.bg && (t3.extended = this._extendedAttrs[e3]), t3;
          }
          setCell(e3, t3) {
            this._invalidateStringCache(), 2097152 & t3.content && (this._combined[e3] = t3.combinedData), 268435456 & t3.bg && (this._extendedAttrs[e3] = t3.extended), this._data[3 * e3 + 0] = t3.content, this._data[3 * e3 + 1] = t3.fg, this._data[3 * e3 + 2] = t3.bg;
          }
          setCellFromCodepoint(e3, t3, i3, s3) {
            this._invalidateStringCache(), 268435456 & s3.bg && (this._extendedAttrs[e3] = s3.extended), this._data[3 * e3 + 0] = t3 | i3 << 22, this._data[3 * e3 + 1] = s3.fg, this._data[3 * e3 + 2] = s3.bg;
          }
          addCodepointToCell(e3, t3, i3) {
            this._invalidateStringCache();
            let s3 = this._data[3 * e3 + 0];
            2097152 & s3 ? this._combined[e3] += (0, a.stringFromCodePoint)(t3) : 2097151 & s3 ? (this._combined[e3] = (0, a.stringFromCodePoint)(2097151 & s3) + (0, a.stringFromCodePoint)(t3), s3 &= -2097152, s3 |= 2097152) : s3 = t3 | 1 << 22, i3 && (s3 &= -12582913, s3 |= i3 << 22), this._data[3 * e3 + 0] = s3;
          }
          insertCells(e3, t3, i3) {
            if (this._invalidateStringCache(), (e3 %= this.length) && 2 === this.getWidth(e3 - 1) && this.setCellFromCodepoint(e3 - 1, 0, 1, i3), t3 < this.length - e3) {
              for (let i4 = this.length - e3 - t3 - 1; i4 >= 0; --i4) this.setCell(e3 + t3 + i4, this.loadCell(e3 + i4, h));
              for (let s3 = 0; s3 < t3; ++s3) this.setCell(e3 + s3, i3);
            } else for (let t4 = e3; t4 < this.length; ++t4) this.setCell(t4, i3);
            2 === this.getWidth(this.length - 1) && this.setCellFromCodepoint(this.length - 1, 0, 1, i3);
          }
          deleteCells(e3, t3, i3) {
            if (this._invalidateStringCache(), e3 %= this.length, t3 < this.length - e3) {
              for (let i4 = 0; i4 < this.length - e3 - t3; ++i4) this.setCell(e3 + i4, this.loadCell(e3 + t3 + i4, h));
              for (let e4 = this.length - t3; e4 < this.length; ++e4) this.setCell(e4, i3);
            } else for (let t4 = e3; t4 < this.length; ++t4) this.setCell(t4, i3);
            e3 && 2 === this.getWidth(e3 - 1) && this.setCellFromCodepoint(e3 - 1, 0, 1, i3), 0 !== this.getWidth(e3) || this.hasContent(e3) || this.setCellFromCodepoint(e3, 0, 1, i3);
          }
          replaceCells(e3, t3, i3, s3 = false) {
            if (this._invalidateStringCache(), s3) for (e3 && 2 === this.getWidth(e3 - 1) && !this.isProtected(e3 - 1) && this.setCellFromCodepoint(e3 - 1, 0, 1, i3), t3 < this.length && 2 === this.getWidth(t3 - 1) && !this.isProtected(t3) && this.setCellFromCodepoint(t3, 0, 1, i3); e3 < t3 && e3 < this.length; ) this.isProtected(e3) || this.setCell(e3, i3), e3++;
            else for (e3 && 2 === this.getWidth(e3 - 1) && this.setCellFromCodepoint(e3 - 1, 0, 1, i3), t3 < this.length && 2 === this.getWidth(t3 - 1) && this.setCellFromCodepoint(t3, 0, 1, i3); e3 < t3 && e3 < this.length; ) this.setCell(e3++, i3);
          }
          resize(e3, t3) {
            if (this._invalidateStringCache(), e3 === this.length) return 4 * this._data.length * 2 < this._data.buffer.byteLength;
            const i3 = 3 * e3;
            if (e3 > this.length) {
              if (this._data.buffer.byteLength >= 4 * i3) this._data = new Uint32Array(this._data.buffer, 0, i3);
              else {
                const e4 = new Uint32Array(i3);
                e4.set(this._data), this._data = e4;
              }
              for (let i4 = this.length; i4 < e3; ++i4) this.setCell(i4, t3);
            } else {
              this._data = this._data.subarray(0, i3);
              const t4 = Object.keys(this._combined);
              for (let i4 = 0; i4 < t4.length; i4++) {
                const s4 = parseInt(t4[i4], 10);
                s4 >= e3 && delete this._combined[s4];
              }
              const s3 = Object.keys(this._extendedAttrs);
              for (let t5 = 0; t5 < s3.length; t5++) {
                const i4 = parseInt(s3[t5], 10);
                i4 >= e3 && delete this._extendedAttrs[i4];
              }
            }
            return this.length = e3, 4 * i3 * 2 < this._data.buffer.byteLength;
          }
          cleanupMemory() {
            if (4 * this._data.length * 2 < this._data.buffer.byteLength) {
              const e3 = new Uint32Array(this._data.length);
              return e3.set(this._data), this._data = e3, 1;
            }
            return 0;
          }
          fill(e3, t3 = false) {
            if (this._invalidateStringCache(), t3) for (let t4 = 0; t4 < this.length; ++t4) this.isProtected(t4) || this.setCell(t4, e3);
            else {
              this._combined = {}, this._extendedAttrs = {};
              for (let t4 = 0; t4 < this.length; ++t4) this.setCell(t4, e3);
            }
          }
          copyFrom(e3) {
            this._invalidateStringCache(), this.length !== e3.length ? this._data = new Uint32Array(e3._data) : this._data.set(e3._data), this.length = e3.length, this._combined = {};
            for (const t3 in e3._combined) this._combined[t3] = e3._combined[t3];
            this._extendedAttrs = {};
            for (const t3 in e3._extendedAttrs) this._extendedAttrs[t3] = e3._extendedAttrs[t3];
            this.isWrapped = e3.isWrapped;
          }
          clone() {
            const e3 = new c(this._stringCache, 0, void 0, false);
            e3._data = new Uint32Array(this._data), e3.length = this.length;
            for (const t3 in this._combined) e3._combined[t3] = this._combined[t3];
            for (const t3 in this._extendedAttrs) e3._extendedAttrs[t3] = this._extendedAttrs[t3];
            return e3.isWrapped = this.isWrapped, e3;
          }
          getTrimmedLength() {
            for (let e3 = this.length - 1; e3 >= 0; --e3) if (4194303 & this._data[3 * e3 + 0]) return e3 + (this._data[3 * e3 + 0] >> 22);
            return 0;
          }
          getNoBgTrimmedLength() {
            for (let e3 = this.length - 1; e3 >= 0; --e3) if (4194303 & this._data[3 * e3 + 0] || 50331648 & this._data[3 * e3 + 2]) return e3 + (this._data[3 * e3 + 0] >> 22);
            return 0;
          }
          copyCellsFrom(e3, t3, i3, s3, r3) {
            this._invalidateStringCache();
            const n3 = e3._data;
            if (r3) for (let r4 = s3 - 1; r4 >= 0; r4--) {
              for (let e4 = 0; e4 < 3; e4++) this._data[3 * (i3 + r4) + e4] = n3[3 * (t3 + r4) + e4];
              268435456 & n3[3 * (t3 + r4) + 2] && (this._extendedAttrs[i3 + r4] = e3._extendedAttrs[t3 + r4]);
            }
            else for (let r4 = 0; r4 < s3; r4++) {
              for (let e4 = 0; e4 < 3; e4++) this._data[3 * (i3 + r4) + e4] = n3[3 * (t3 + r4) + e4];
              268435456 & n3[3 * (t3 + r4) + 2] && (this._extendedAttrs[i3 + r4] = e3._extendedAttrs[t3 + r4]);
            }
            const a2 = Object.keys(e3._combined);
            for (let s4 = 0; s4 < a2.length; s4++) {
              const r4 = parseInt(a2[s4], 10);
              r4 >= t3 && (this._combined[r4 - t3 + i3] = e3._combined[r4]);
            }
          }
          translateToString(e3, t3, i3, s3) {
            const r3 = (void 0 === t3 || 0 === t3) && void 0 === i3 && void 0 === s3;
            r3 && this._stringCache.touch?.();
            const o2 = r3 ? this._getStringCacheEntry(false) : void 0;
            if (r3 && void 0 !== o2?.value) {
              if (e3) return o2.isTrimmed ? o2.value : o2.value.trimEnd();
              if (!o2.isTrimmed) return o2.value;
            }
            t3 = t3 ?? 0, i3 = i3 ?? this.length, e3 && (i3 = Math.min(i3, this.getTrimmedLength())), s3 && (s3.length = 0);
            let h2 = "";
            for (; t3 < i3; ) {
              const e4 = this._data[3 * t3 + 0], i4 = 2097151 & e4, r4 = 2097152 & e4 ? this._combined[t3] : i4 ? (0, a.stringFromCodePoint)(i4) : n2.WHITESPACE_CELL_CHAR;
              if (h2 += r4, s3) for (let e5 = 0; e5 < r4.length; ++e5) s3.push(t3);
              t3 += e4 >> 22 || 1;
            }
            if (s3 && s3.push(t3), r3) {
              const t4 = this._getStringCacheEntry(true);
              t4.value = h2, t4.isTrimmed = !!e3;
            }
            return h2;
          }
          _getStringCacheEntry(e3) {
            const t3 = this._stringCacheEntryRef?.deref();
            if (t3 && t3.generation === this._stringCache.generation) return t3;
            if (!e3) return;
            const i3 = this._stringCache.allocateEntry();
            return this._stringCacheEntryRef = new WeakRef(i3), i3;
          }
          _invalidateStringCache() {
            const e3 = this._getStringCacheEntry(false);
            e3 && (e3.value = void 0, e3.isTrimmed = false);
          }
        }
        t2.BufferLine = c;
      }, 132(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.IntervalTimer = t2.TimeoutTimer = void 0, t2.timeout = function(e3) {
          return new Promise((t3) => setTimeout(t3, e3));
        }, t2.disposableTimeout = function(e3, t3 = 0, i3) {
          const r2 = setTimeout(() => {
            e3(), i3 && n2.dispose();
          }, t3), n2 = (0, s2.toDisposable)(() => {
            clearTimeout(r2);
          });
          return i3?.add(n2), n2;
        };
        const s2 = i2(812);
        t2.TimeoutTimer = class {
          _token = -1;
          _isDisposed = false;
          dispose() {
            this.cancel(), this._isDisposed = true;
          }
          cancel() {
            -1 !== this._token && (clearTimeout(this._token), this._token = -1);
          }
          cancelAndSet(e3, t3) {
            if (this._isDisposed) throw new Error("Calling cancelAndSet on a disposed TimeoutTimer");
            this.cancel(), this._token = setTimeout(() => {
              this._token = -1, e3();
            }, t3);
          }
          setIfNotSet(e3, t3) {
            if (this._isDisposed) throw new Error("Calling setIfNotSet on a disposed TimeoutTimer");
            -1 === this._token && (this._token = setTimeout(() => {
              this._token = -1, e3();
            }, t3));
          }
        }, t2.IntervalTimer = class {
          _disposable;
          _isDisposed = false;
          cancel() {
            this._disposable?.dispose(), this._disposable = void 0;
          }
          cancelAndSet(e3, t3, i3 = globalThis) {
            if (this._isDisposed) throw new Error("Calling cancelAndSet on a disposed IntervalTimer");
            this.cancel();
            const s3 = i3.setInterval(() => {
              e3();
            }, t3);
            this._disposable = { dispose: () => {
              i3.clearInterval(s3), this._disposable = void 0;
            } };
          }
          dispose() {
            this.cancel(), this._isDisposed = true;
          }
        };
      }, 158(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.Marker = void 0;
        const s2 = i2(636), r2 = i2(812);
        class n2 {
          line;
          static _nextId = 1;
          isDisposed = false;
          _disposables = [];
          _id = n2._nextId++;
          get id() {
            return this._id;
          }
          _onDispose = this.register(new s2.Emitter());
          onDispose = this._onDispose.event;
          constructor(e3) {
            this.line = e3;
          }
          dispose() {
            this.isDisposed || (this.isDisposed = true, this.line = -1, this._onDispose.fire(), (0, r2.dispose)(this._disposables), this._disposables.length = 0);
          }
          register(e3) {
            return this._disposables.push(e3), e3;
          }
        }
        t2.Marker = n2;
      }, 168(e2, t2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.DebouncedIdleTask = t2.IdleTaskQueue = t2.PriorityTaskQueue = void 0;
        class i2 {
          _tasks = [];
          _idleCallback;
          _i = 0;
          _logService;
          constructor(e3) {
            this._logService = e3;
          }
          enqueue(e3) {
            this._tasks.push(e3), this._start();
          }
          flush() {
            for (; this._i < this._tasks.length; ) this._tasks[this._i]() || this._i++;
            this.clear();
          }
          clear() {
            this._idleCallback && (this._cancelCallback(this._idleCallback), this._idleCallback = void 0), this._i = 0, this._tasks.length = 0;
          }
          _start() {
            this._idleCallback || (this._idleCallback = this._requestCallback(this._process.bind(this)));
          }
          _process(e3) {
            this._idleCallback = void 0;
            let t3 = 0, i3 = 0, s3 = e3.timeRemaining(), r2 = 0;
            for (; this._i < this._tasks.length; ) {
              if (t3 = performance.now(), this._tasks[this._i]() || this._i++, t3 = Math.max(1, performance.now() - t3), i3 = Math.max(t3, i3), r2 = e3.timeRemaining(), 1.5 * i3 > r2) return s3 - t3 < -20 && this._logService.warn(`task queue exceeded allotted deadline by ${Math.abs(Math.round(s3 - t3))}ms`), void this._start();
              s3 = r2;
            }
            this.clear();
          }
        }
        class s2 extends i2 {
          _requestCallback(e3) {
            return setTimeout(() => e3(this._createDeadline(16)));
          }
          _cancelCallback(e3) {
            clearTimeout(e3);
          }
          _createDeadline(e3) {
            const t3 = performance.now() + e3;
            return { timeRemaining: () => Math.max(0, t3 - performance.now()) };
          }
        }
        t2.PriorityTaskQueue = s2, t2.IdleTaskQueue = "requestIdleCallback" in globalThis ? class extends i2 {
          _requestCallback(e3) {
            return requestIdleCallback(e3);
          }
          _cancelCallback(e3) {
            cancelIdleCallback(e3);
          }
        } : s2, t2.DebouncedIdleTask = class {
          _queue;
          constructor(e3) {
            this._queue = new t2.IdleTaskQueue(e3);
          }
          set(e3) {
            this._queue.clear(), this._queue.enqueue(e3);
          }
          flush() {
            this._queue.flush();
          }
          dispose() {
            this._queue.clear();
          }
        };
      }, 201(e2, t2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.serviceRegistry = void 0, t2.getServiceDependencies = function(e3) {
          return e3.di$dependencies || [];
        }, t2.createDecorator = function(e3) {
          if (t2.serviceRegistry.has(e3)) return t2.serviceRegistry.get(e3);
          const i2 = function(e4, t3, s2) {
            if (3 !== arguments.length) throw new Error("@IServiceName-decorator can only be used to decorate a parameter");
            !(function(e5, t4, i3) {
              t4.di$target === t4 ? t4.di$dependencies.push({ id: e5, index: i3 }) : (t4.di$dependencies = [{ id: e5, index: i3 }], t4.di$target = t4);
            })(i2, e4, s2);
          };
          return i2._id = e3, t2.serviceRegistry.set(e3, i2), i2;
        }, t2.serviceRegistry = /* @__PURE__ */ new Map();
      }, 235(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.BufferApiView = void 0;
        const s2 = i2(793), r2 = i2(55);
        t2.BufferApiView = class {
          _buffer;
          type;
          constructor(e3, t3) {
            this._buffer = e3, this.type = t3;
          }
          init(e3) {
            return this._buffer = e3, this;
          }
          get cursorY() {
            return this._buffer.y;
          }
          get cursorX() {
            return this._buffer.x;
          }
          get viewportY() {
            return this._buffer.ydisp;
          }
          get baseY() {
            return this._buffer.ybase;
          }
          get length() {
            return this._buffer.lines.length;
          }
          getLine(e3) {
            const t3 = this._buffer.lines.get(e3);
            if (t3) return new s2.BufferLineApiView(t3);
          }
          getNullCell() {
            return new r2.CellData();
          }
        };
      }, 240(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.MouseStateService = void 0;
        const s2 = i2(812), r2 = i2(636), n2 = { NONE: { events: 0, restrict: () => false }, X10: { events: 1, restrict: (e3) => 4 !== e3.button && 1 === e3.action && (e3.ctrl = false, e3.alt = false, e3.shift = false, true) }, VT200: { events: 19, restrict: (e3) => 32 !== e3.action }, DRAG: { events: 23, restrict: (e3) => 32 !== e3.action || 3 !== e3.button }, ANY: { events: 31, restrict: (e3) => true } };
        function a(e3, t3) {
          let i3 = (e3.ctrl ? 16 : 0) | (e3.shift ? 4 : 0) | (e3.alt ? 8 : 0);
          return 4 === e3.button ? (i3 |= 64, i3 |= e3.action) : (i3 |= 3 & e3.button, 4 & e3.button && (i3 |= 64), 8 & e3.button && (i3 |= 128), 32 === e3.action ? i3 |= 32 : 0 !== e3.action || t3 || (i3 |= 3)), i3;
        }
        const o = String.fromCharCode, h = { DEFAULT: (e3) => {
          const t3 = [a(e3, false) + 32, e3.col + 32, e3.row + 32];
          return t3[0] > 255 || t3[1] > 255 || t3[2] > 255 ? "" : `\x1B[M${o(t3[0])}${o(t3[1])}${o(t3[2])}`;
        }, SGR: (e3) => {
          const t3 = 0 === e3.action && 4 !== e3.button ? "m" : "M";
          return `\x1B[<${a(e3, true)};${e3.col};${e3.row}${t3}`;
        }, SGR_PIXELS: (e3) => {
          const t3 = 0 === e3.action && 4 !== e3.button ? "m" : "M";
          return `\x1B[<${a(e3, true)};${e3.x};${e3.y}${t3}`;
        } };
        class c extends s2.Disposable {
          serviceBrand;
          _protocols = {};
          _encodings = {};
          _activeProtocol = "";
          _activeEncoding = "";
          _customWheelEventHandler;
          _onProtocolChange = this._register(new r2.Emitter());
          onProtocolChange = this._onProtocolChange.event;
          constructor() {
            super();
            for (const e3 of Object.keys(n2)) this.addProtocol(e3, n2[e3]);
            for (const e3 of Object.keys(h)) this.addEncoding(e3, h[e3]);
            this.reset();
          }
          addProtocol(e3, t3) {
            this._protocols[e3] = t3;
          }
          addEncoding(e3, t3) {
            this._encodings[e3] = t3;
          }
          get activeProtocol() {
            return this._activeProtocol;
          }
          get areMouseEventsActive() {
            return 0 !== this._protocols[this._activeProtocol].events;
          }
          set activeProtocol(e3) {
            if (!this._protocols[e3]) throw new Error(`unknown protocol "${e3}"`);
            this._activeProtocol = e3, this._onProtocolChange.fire(this._protocols[e3].events);
          }
          get activeEncoding() {
            return this._activeEncoding;
          }
          set activeEncoding(e3) {
            if (!this._encodings[e3]) throw new Error(`unknown encoding "${e3}"`);
            this._activeEncoding = e3;
          }
          reset() {
            this.activeProtocol = "NONE", this.activeEncoding = "DEFAULT";
          }
          setCustomWheelEventHandler(e3) {
            this._customWheelEventHandler = e3;
          }
          allowCustomWheelEvent(e3) {
            return !this._customWheelEventHandler || false !== this._customWheelEventHandler(e3);
          }
          restrictMouseEvent(e3) {
            return this._protocols[this._activeProtocol].restrict(e3);
          }
          encodeMouseEvent(e3) {
            return this._encodings[this._activeEncoding](e3);
          }
          get isDefaultEncoding() {
            return "DEFAULT" === this._activeEncoding;
          }
          get isPixelEncoding() {
            return "SGR_PIXELS" === this._activeEncoding;
          }
        }
        t2.MouseStateService = c;
      }, 262(e2, t2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.Params = void 0;
        class i2 {
          maxLength;
          maxSubParamsLength;
          params;
          length;
          _subParams;
          _subParamsLength;
          _subParamsIdx;
          _rejectDigits;
          _rejectSubDigits;
          _digitIsSub;
          static fromArray(e3) {
            const t3 = new i2();
            if (!e3.length) return t3;
            for (let i3 = Array.isArray(e3[0]) ? 1 : 0; i3 < e3.length; ++i3) {
              const s2 = e3[i3];
              if (Array.isArray(s2)) for (let e4 = 0; e4 < s2.length; ++e4) t3.addSubParam(s2[e4]);
              else t3.addParam(s2);
            }
            return t3;
          }
          constructor(e3 = 32, t3 = 32) {
            if (this.maxLength = e3, this.maxSubParamsLength = t3, t3 > 256) throw new Error("maxSubParamsLength must not be greater than 256");
            this.params = new Int32Array(e3), this.length = 0, this._subParams = new Int32Array(t3), this._subParamsLength = 0, this._subParamsIdx = new Uint16Array(e3), this._rejectDigits = false, this._rejectSubDigits = false, this._digitIsSub = false;
          }
          clone() {
            const e3 = new i2(this.maxLength, this.maxSubParamsLength);
            return e3.params.set(this.params), e3.length = this.length, e3._subParams.set(this._subParams), e3._subParamsLength = this._subParamsLength, e3._subParamsIdx.set(this._subParamsIdx), e3._rejectDigits = this._rejectDigits, e3._rejectSubDigits = this._rejectSubDigits, e3._digitIsSub = this._digitIsSub, e3;
          }
          toArray() {
            const e3 = [];
            for (let t3 = 0; t3 < this.length; ++t3) {
              e3.push(this.params[t3]);
              const i3 = this._subParamsIdx[t3] >> 8, s2 = 255 & this._subParamsIdx[t3];
              s2 - i3 > 0 && e3.push(Array.prototype.slice.call(this._subParams, i3, s2));
            }
            return e3;
          }
          reset() {
            this.length = 0, this._subParamsLength = 0, this._rejectDigits = false, this._rejectSubDigits = false, this._digitIsSub = false;
          }
          resetZdm() {
            this.length = 1, this._subParamsLength = 0, this._rejectDigits = false, this._rejectSubDigits = false, this._digitIsSub = false, this._subParamsIdx[0] = 0, this.params[0] = 0;
          }
          addParam(e3) {
            if (this._digitIsSub = false, this.length >= this.maxLength) this._rejectDigits = true;
            else {
              if (e3 < -1) throw new Error("values lesser than -1 are not allowed");
              this._subParamsIdx[this.length] = this._subParamsLength << 8 | this._subParamsLength, this.params[this.length++] = e3 > 2147483647 ? 2147483647 : e3;
            }
          }
          addSubParam(e3) {
            if (this._digitIsSub = true, this.length) if (this._rejectDigits || this._subParamsLength >= this.maxSubParamsLength) this._rejectSubDigits = true;
            else {
              if (e3 < -1) throw new Error("values lesser than -1 are not allowed");
              this._subParams[this._subParamsLength++] = e3 > 2147483647 ? 2147483647 : e3, this._subParamsIdx[this.length - 1]++;
            }
          }
          hasSubParams(e3) {
            return (255 & this._subParamsIdx[e3]) - (this._subParamsIdx[e3] >> 8) > 0;
          }
          getSubParams(e3) {
            const t3 = this._subParamsIdx[e3] >> 8, i3 = 255 & this._subParamsIdx[e3];
            return i3 - t3 > 0 ? this._subParams.subarray(t3, i3) : null;
          }
          getSubParamsAll() {
            const e3 = {};
            for (let t3 = 0; t3 < this.length; ++t3) {
              const i3 = this._subParamsIdx[t3] >> 8, s2 = 255 & this._subParamsIdx[t3];
              s2 - i3 > 0 && (e3[t3] = this._subParams.slice(i3, s2));
            }
            return e3;
          }
          addDigit(e3) {
            let t3;
            if (this._rejectDigits || !(t3 = this._digitIsSub ? this._subParamsLength : this.length) || this._digitIsSub && this._rejectSubDigits) return;
            const i3 = this._digitIsSub ? this._subParams : this.params, s2 = i3[t3 - 1];
            i3[t3 - 1] = ~s2 ? Math.min(10 * s2 + e3, 2147483647) : e3;
          }
        }
        t2.Params = i2;
      }, 276(e2, t2, i2) {
        var s2 = this && this.__decorate || function(e3, t3, i3, s3) {
          var r3, n3 = arguments.length, a2 = n3 < 3 ? t3 : null === s3 ? s3 = Object.getOwnPropertyDescriptor(t3, i3) : s3;
          if ("object" == typeof Reflect && "function" == typeof Reflect.decorate) a2 = Reflect.decorate(e3, t3, i3, s3);
          else for (var o2 = e3.length - 1; o2 >= 0; o2--) (r3 = e3[o2]) && (a2 = (n3 < 3 ? r3(a2) : n3 > 3 ? r3(t3, i3, a2) : r3(t3, i3)) || a2);
          return n3 > 3 && a2 && Object.defineProperty(t3, i3, a2), a2;
        }, r2 = this && this.__param || function(e3, t3) {
          return function(i3, s3) {
            t3(i3, s3, e3);
          };
        };
        Object.defineProperty(t2, "__esModule", { value: true }), t2.LogService = void 0;
        const n2 = i2(812), a = i2(501), o = { trace: a.LogLevelEnum.TRACE, debug: a.LogLevelEnum.DEBUG, info: a.LogLevelEnum.INFO, warn: a.LogLevelEnum.WARN, error: a.LogLevelEnum.ERROR, off: a.LogLevelEnum.OFF };
        let h = class extends n2.Disposable {
          _optionsService;
          serviceBrand;
          _logLevel = a.LogLevelEnum.OFF;
          get logLevel() {
            return this._logLevel;
          }
          constructor(e3) {
            super(), this._optionsService = e3, this._updateLogLevel(), this._register(this._optionsService.onSpecificOptionChange("logLevel", () => this._updateLogLevel()));
          }
          _updateLogLevel() {
            this._logLevel = o[this._optionsService.rawOptions.logLevel];
          }
          _evalLazyOptionalParams(e3) {
            for (let t3 = 0; t3 < e3.length; t3++) "function" == typeof e3[t3] && (e3[t3] = e3[t3]());
          }
          _log(e3, t3, i3) {
            this._evalLazyOptionalParams(i3), e3.call(console, (this._optionsService.options.logger ? "" : "xterm.js: ") + t3, ...i3);
          }
          trace(e3, ...t3) {
            this._logLevel <= a.LogLevelEnum.TRACE && this._log(this._optionsService.options.logger?.trace.bind(this._optionsService.options.logger) ?? console.log, e3, t3);
          }
          debug(e3, ...t3) {
            this._logLevel <= a.LogLevelEnum.DEBUG && this._log(this._optionsService.options.logger?.debug.bind(this._optionsService.options.logger) ?? console.log, e3, t3);
          }
          info(e3, ...t3) {
            this._logLevel <= a.LogLevelEnum.INFO && this._log(this._optionsService.options.logger?.info.bind(this._optionsService.options.logger) ?? console.info, e3, t3);
          }
          warn(e3, ...t3) {
            this._logLevel <= a.LogLevelEnum.WARN && this._log(this._optionsService.options.logger?.warn.bind(this._optionsService.options.logger) ?? console.warn, e3, t3);
          }
          error(e3, ...t3) {
            this._logLevel <= a.LogLevelEnum.ERROR && this._log(this._optionsService.options.logger?.error.bind(this._optionsService.options.logger) ?? console.error, e3, t3);
          }
        };
        t2.LogService = h, t2.LogService = h = s2([r2(0, a.IOptionsService)], h);
      }, 326(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.BufferLineStringCache = void 0;
        const s2 = i2(132), r2 = i2(812);
        class n2 extends r2.Disposable {
          generation = 0;
          entries = /* @__PURE__ */ new Set();
          _clearTimeout = this._register(new r2.MutableDisposable());
          _lastAccessTimestamp = 0;
          constructor() {
            super(), this._register((0, r2.toDisposable)(() => this.entries.clear()));
          }
          touch() {
            this._scheduleClear();
          }
          allocateEntry() {
            const e3 = { value: void 0, isTrimmed: false, generation: this.generation };
            return this.entries.add(e3), this._scheduleClear(), e3;
          }
          clear() {
            this._clearTimeout.clear(), this._lastAccessTimestamp = 0, this.generation++;
            for (const e3 of this.entries) e3.value = void 0, e3.isTrimmed = false;
            this.entries.clear();
          }
          _scheduleClear() {
            this._lastAccessTimestamp = Date.now(), this._clearTimeout.value || this._scheduleClearTimeout(15e3);
          }
          _scheduleClearTimeout(e3) {
            this._clearTimeout.value = (0, s2.disposableTimeout)(() => {
              const e4 = Date.now() - this._lastAccessTimestamp;
              e4 >= 15e3 ? this.clear() : this._scheduleClearTimeout(15e3 - e4);
            }, e3);
          }
        }
        t2.BufferLineStringCache = n2;
      }, 335(e2, t2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.UnicodeApi = void 0, t2.UnicodeApi = class {
          _core;
          constructor(e3) {
            this._core = e3;
          }
          register(e3) {
            this._core.unicodeService.register(e3);
          }
          get versions() {
            return this._core.unicodeService.versions;
          }
          get activeVersion() {
            return this._core.unicodeService.activeVersion;
          }
          set activeVersion(e3) {
            this._core.unicodeService.activeVersion = e3;
          }
        };
      }, 346(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.OscHandler = t2.OscParser = void 0;
        const s2 = i2(726), r2 = [];
        t2.OscParser = class {
          _state = 0;
          _active = r2;
          _id = -1;
          _handlers = /* @__PURE__ */ Object.create(null);
          _handlerFb = () => {
          };
          _stack = { paused: false, loopPosition: 0, fallThrough: false };
          registerHandler(e3, t3) {
            this._handlers[e3] ??= [];
            const i3 = this._handlers[e3];
            return i3.push(t3), { dispose: () => {
              const e4 = i3.indexOf(t3);
              -1 !== e4 && i3.splice(e4, 1);
            } };
          }
          clearHandler(e3) {
            this._handlers[e3] && delete this._handlers[e3];
          }
          setHandlerFallback(e3) {
            this._handlerFb = e3;
          }
          dispose() {
            this._handlers = /* @__PURE__ */ Object.create(null), this._handlerFb = () => {
            }, this._active = r2;
          }
          reset() {
            if (2 === this._state) for (let e3 = this._stack.paused ? this._stack.loopPosition - 1 : this._active.length - 1; e3 >= 0; --e3) this._active[e3].end(false);
            this._stack.paused = false, this._active = r2, this._id = -1, this._state = 0;
          }
          _start() {
            if (this._active = this._handlers[this._id] || r2, this._active.length) for (let e3 = this._active.length - 1; e3 >= 0; e3--) this._active[e3].start();
            else this._handlerFb(this._id, "START");
          }
          _put(e3, t3, i3) {
            if (this._active.length) for (let s3 = this._active.length - 1; s3 >= 0; s3--) this._active[s3].put(e3, t3, i3);
            else this._handlerFb(this._id, "PUT", (0, s2.utf32ToString)(e3, t3, i3));
          }
          start() {
            this.reset(), this._state = 1;
          }
          put(e3, t3, i3) {
            if (3 !== this._state) {
              if (1 === this._state) for (; t3 < i3; ) {
                const i4 = e3[t3++];
                if (59 === i4) {
                  this._state = 2, this._start();
                  break;
                }
                if (i4 < 48 || 57 < i4) return void (this._state = 3);
                -1 === this._id && (this._id = 0), this._id = 10 * this._id + i4 - 48;
              }
              2 === this._state && i3 - t3 > 0 && this._put(e3, t3, i3);
            }
          }
          end(e3, t3 = true) {
            if (0 !== this._state) {
              if (3 !== this._state) if (1 === this._state && this._start(), this._active.length) {
                let i3 = false, s3 = this._active.length - 1, r3 = false;
                if (this._stack.paused && (s3 = this._stack.loopPosition - 1, i3 = t3, r3 = this._stack.fallThrough, this._stack.paused = false), !r3 && false === i3) {
                  for (; s3 >= 0 && (i3 = this._active[s3].end(e3), true !== i3); s3--) if (i3 instanceof Promise) return this._stack.paused = true, this._stack.loopPosition = s3, this._stack.fallThrough = false, i3;
                  s3--;
                }
                for (; s3 >= 0; s3--) if (i3 = this._active[s3].end(false), i3 instanceof Promise) return this._stack.paused = true, this._stack.loopPosition = s3, this._stack.fallThrough = true, i3;
              } else this._handlerFb(this._id, "END", e3);
              this._active = r2, this._id = -1, this._state = 0;
            }
          }
        };
        class n2 {
          _handler;
          static _payloadLimit = 1e7;
          _data = "";
          _hitLimit = false;
          constructor(e3) {
            this._handler = e3;
          }
          start() {
            this._data = "", this._hitLimit = false;
          }
          put(e3, t3, i3) {
            this._hitLimit || (this._data += (0, s2.utf32ToString)(e3, t3, i3), this._data.length > n2._payloadLimit && (this._data = "", this._hitLimit = true));
          }
          end(e3) {
            let t3 = false;
            if (this._hitLimit) t3 = false;
            else if (e3 && (t3 = this._handler(this._data), t3 instanceof Promise)) return t3.then((e4) => (this._data = "", this._hitLimit = false, e4));
            return this._data = "", this._hitLimit = false, t3;
          }
        }
        t2.OscHandler = n2;
      }, 415(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.UnicodeService = void 0;
        const s2 = i2(428), r2 = i2(636);
        class n2 {
          serviceBrand;
          _providers = /* @__PURE__ */ Object.create(null);
          _active = "";
          _activeProvider;
          _onChange = new r2.Emitter();
          onChange = this._onChange.event;
          static extractShouldJoin(e3) {
            return !!(1 & e3);
          }
          static extractWidth(e3) {
            return e3 >> 1 & 3;
          }
          static extractCharKind(e3) {
            return e3 >> 3;
          }
          static createPropertyValue(e3, t3, i3 = false) {
            return (16777215 & e3) << 3 | (3 & t3) << 1 | (i3 ? 1 : 0);
          }
          constructor() {
            const e3 = new s2.UnicodeV6();
            this.register(e3), this._active = e3.version, this._activeProvider = e3;
          }
          dispose() {
            this._onChange.dispose();
          }
          get versions() {
            return Object.keys(this._providers);
          }
          get activeVersion() {
            return this._active;
          }
          set activeVersion(e3) {
            if (!this._providers[e3]) throw new Error(`unknown Unicode version "${e3}"`);
            this._active = e3, this._activeProvider = this._providers[e3], this._onChange.fire(e3);
          }
          register(e3) {
            this._providers[e3.version] = e3;
          }
          wcwidth(e3) {
            return this._activeProvider.wcwidth(e3);
          }
          getStringCellWidth(e3) {
            let t3 = 0, i3 = 0;
            const s3 = e3.length;
            for (let r3 = 0; r3 < s3; ++r3) {
              let a = e3.charCodeAt(r3);
              if (55296 <= a && a <= 56319) {
                if (++r3 >= s3) return t3 + this.wcwidth(a);
                const i4 = e3.charCodeAt(r3);
                56320 <= i4 && i4 <= 57343 ? a = 1024 * (a - 55296) + i4 - 56320 + 65536 : t3 += this.wcwidth(i4);
              }
              const o = this.charProperties(a, i3);
              let h = n2.extractWidth(o);
              n2.extractShouldJoin(o) && (h -= n2.extractWidth(i3)), t3 += h, i3 = o;
            }
            return t3;
          }
          charProperties(e3, t3) {
            return this._activeProvider.charProperties(e3, t3);
          }
        }
        t2.UnicodeService = n2;
      }, 428(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.UnicodeV6 = void 0;
        const s2 = i2(415), r2 = [[768, 879], [1155, 1158], [1160, 1161], [1425, 1469], [1471, 1471], [1473, 1474], [1476, 1477], [1479, 1479], [1536, 1539], [1552, 1557], [1611, 1630], [1648, 1648], [1750, 1764], [1767, 1768], [1770, 1773], [1807, 1807], [1809, 1809], [1840, 1866], [1958, 1968], [2027, 2035], [2305, 2306], [2364, 2364], [2369, 2376], [2381, 2381], [2385, 2388], [2402, 2403], [2433, 2433], [2492, 2492], [2497, 2500], [2509, 2509], [2530, 2531], [2561, 2562], [2620, 2620], [2625, 2626], [2631, 2632], [2635, 2637], [2672, 2673], [2689, 2690], [2748, 2748], [2753, 2757], [2759, 2760], [2765, 2765], [2786, 2787], [2817, 2817], [2876, 2876], [2879, 2879], [2881, 2883], [2893, 2893], [2902, 2902], [2946, 2946], [3008, 3008], [3021, 3021], [3134, 3136], [3142, 3144], [3146, 3149], [3157, 3158], [3260, 3260], [3263, 3263], [3270, 3270], [3276, 3277], [3298, 3299], [3393, 3395], [3405, 3405], [3530, 3530], [3538, 3540], [3542, 3542], [3633, 3633], [3636, 3642], [3655, 3662], [3761, 3761], [3764, 3769], [3771, 3772], [3784, 3789], [3864, 3865], [3893, 3893], [3895, 3895], [3897, 3897], [3953, 3966], [3968, 3972], [3974, 3975], [3984, 3991], [3993, 4028], [4038, 4038], [4141, 4144], [4146, 4146], [4150, 4151], [4153, 4153], [4184, 4185], [4448, 4607], [4959, 4959], [5906, 5908], [5938, 5940], [5970, 5971], [6002, 6003], [6068, 6069], [6071, 6077], [6086, 6086], [6089, 6099], [6109, 6109], [6155, 6157], [6313, 6313], [6432, 6434], [6439, 6440], [6450, 6450], [6457, 6459], [6679, 6680], [6912, 6915], [6964, 6964], [6966, 6970], [6972, 6972], [6978, 6978], [7019, 7027], [7616, 7626], [7678, 7679], [8203, 8207], [8234, 8238], [8288, 8291], [8298, 8303], [8400, 8431], [12330, 12335], [12441, 12442], [43014, 43014], [43019, 43019], [43045, 43046], [64286, 64286], [65024, 65039], [65056, 65059], [65279, 65279], [65529, 65531]], n2 = [[68097, 68099], [68101, 68102], [68108, 68111], [68152, 68154], [68159, 68159], [119143, 119145], [119155, 119170], [119173, 119179], [119210, 119213], [119362, 119364], [917505, 917505], [917536, 917631], [917760, 917999]];
        let a;
        t2.UnicodeV6 = class {
          version = "6";
          constructor() {
            if (!a) {
              a = new Uint8Array(65536), a.fill(1), a[0] = 0, a.fill(0, 1, 32), a.fill(0, 127, 160), a.fill(2, 4352, 4448), a[9001] = 2, a[9002] = 2, a.fill(2, 11904, 42192), a[12351] = 1, a.fill(2, 44032, 55204), a.fill(2, 63744, 64256), a.fill(2, 65040, 65050), a.fill(2, 65072, 65136), a.fill(2, 65280, 65377), a.fill(2, 65504, 65511);
              for (let e3 = 0; e3 < r2.length; ++e3) a.fill(0, r2[e3][0], r2[e3][1] + 1);
            }
          }
          wcwidth(e3) {
            return e3 < 32 ? 0 : e3 < 127 ? 1 : e3 < 65536 ? a[e3] : (function(e4, t3) {
              let i3, s3 = 0, r3 = t3.length - 1;
              if (e4 < t3[0][0] || e4 > t3[r3][1]) return false;
              for (; r3 >= s3; ) if (i3 = s3 + r3 >> 1, e4 > t3[i3][1]) s3 = i3 + 1;
              else {
                if (!(e4 < t3[i3][0])) return true;
                r3 = i3 - 1;
              }
              return false;
            })(e3, n2) ? 0 : e3 >= 131072 && e3 <= 196605 || e3 >= 196608 && e3 <= 262141 ? 2 : 1;
          }
          charProperties(e3, t3) {
            let i3 = this.wcwidth(e3), r3 = 0 === i3 && 0 !== t3;
            if (r3) {
              const e4 = s2.UnicodeService.extractWidth(t3);
              0 === e4 ? r3 = false : e4 > i3 && (i3 = e4);
            }
            return s2.UnicodeService.createPropertyValue(0, i3, r3);
          }
        };
      }, 451(e2, t2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.ExtendedAttrs = t2.AttributeData = void 0;
        class i2 {
          static toColorRGB(e3) {
            return [e3 >>> 16 & 255, e3 >>> 8 & 255, 255 & e3];
          }
          static fromColorRGB(e3) {
            return (255 & e3[0]) << 16 | (255 & e3[1]) << 8 | 255 & e3[2];
          }
          clone() {
            const e3 = new i2();
            return e3.fg = this.fg, e3.bg = this.bg, e3.extended = this.extended.clone(), e3;
          }
          fg = 0;
          bg = 0;
          extended = new s2();
          isInverse() {
            return 67108864 & this.fg;
          }
          isBold() {
            return 134217728 & this.fg;
          }
          isUnderline() {
            return this.hasExtendedAttrs() && 0 !== this.extended.underlineStyle ? 1 : 268435456 & this.fg;
          }
          isBlink() {
            return 536870912 & this.fg;
          }
          isInvisible() {
            return 1073741824 & this.fg;
          }
          isItalic() {
            return 67108864 & this.bg;
          }
          isDim() {
            return 134217728 & this.bg;
          }
          isStrikethrough() {
            return 2147483648 & this.fg;
          }
          isProtected() {
            return 536870912 & this.bg;
          }
          isOverline() {
            return 1073741824 & this.bg;
          }
          getFgColorMode() {
            return 50331648 & this.fg;
          }
          getBgColorMode() {
            return 50331648 & this.bg;
          }
          isFgRGB() {
            return !(50331648 & ~this.fg);
          }
          isBgRGB() {
            return !(50331648 & ~this.bg);
          }
          isFgPalette() {
            return 16777216 == (50331648 & this.fg) || 33554432 == (50331648 & this.fg);
          }
          isBgPalette() {
            return 16777216 == (50331648 & this.bg) || 33554432 == (50331648 & this.bg);
          }
          isFgDefault() {
            return !(50331648 & this.fg);
          }
          isBgDefault() {
            return !(50331648 & this.bg);
          }
          isAttributeDefault() {
            return 0 === this.fg && 0 === this.bg;
          }
          getFgColor() {
            switch (50331648 & this.fg) {
              case 16777216:
              case 33554432:
                return 255 & this.fg;
              case 50331648:
                return 16777215 & this.fg;
              default:
                return -1;
            }
          }
          getBgColor() {
            switch (50331648 & this.bg) {
              case 16777216:
              case 33554432:
                return 255 & this.bg;
              case 50331648:
                return 16777215 & this.bg;
              default:
                return -1;
            }
          }
          hasExtendedAttrs() {
            return 268435456 & this.bg;
          }
          updateExtended() {
            this.extended.isEmpty() ? this.bg &= -268435457 : this.bg |= 268435456;
          }
          getUnderlineColor() {
            if (268435456 & this.bg && ~this.extended.underlineColor) switch (50331648 & this.extended.underlineColor) {
              case 16777216:
              case 33554432:
                return 255 & this.extended.underlineColor;
              case 50331648:
                return 16777215 & this.extended.underlineColor;
              default:
                return this.getFgColor();
            }
            return this.getFgColor();
          }
          getUnderlineColorMode() {
            return 268435456 & this.bg && ~this.extended.underlineColor ? 50331648 & this.extended.underlineColor : this.getFgColorMode();
          }
          isUnderlineColorRGB() {
            return 268435456 & this.bg && ~this.extended.underlineColor ? !(50331648 & ~this.extended.underlineColor) : this.isFgRGB();
          }
          isUnderlineColorPalette() {
            return 268435456 & this.bg && ~this.extended.underlineColor ? 16777216 == (50331648 & this.extended.underlineColor) || 33554432 == (50331648 & this.extended.underlineColor) : this.isFgPalette();
          }
          isUnderlineColorDefault() {
            return 268435456 & this.bg && ~this.extended.underlineColor ? !(50331648 & this.extended.underlineColor) : this.isFgDefault();
          }
          getUnderlineStyle() {
            return 268435456 & this.fg ? 268435456 & this.bg ? this.extended.underlineStyle : 1 : 0;
          }
          getUnderlineVariantOffset() {
            return this.extended.underlineVariantOffset;
          }
        }
        t2.AttributeData = i2;
        class s2 {
          _ext = 0;
          get ext() {
            return this._urlId ? -469762049 & this._ext | this.underlineStyle << 26 : this._ext;
          }
          set ext(e3) {
            this._ext = e3;
          }
          get underlineStyle() {
            return this._urlId ? 5 : (469762048 & this._ext) >> 26;
          }
          set underlineStyle(e3) {
            this._ext &= -469762049, this._ext |= e3 << 26 & 469762048;
          }
          get underlineColor() {
            return 67108863 & this._ext;
          }
          set underlineColor(e3) {
            this._ext &= -67108864, this._ext |= 67108863 & e3;
          }
          _urlId = 0;
          get urlId() {
            return this._urlId;
          }
          set urlId(e3) {
            this._urlId = e3;
          }
          get underlineVariantOffset() {
            const e3 = (3758096384 & this._ext) >> 29;
            return e3 < 0 ? 4294967288 ^ e3 : e3;
          }
          set underlineVariantOffset(e3) {
            this._ext &= 536870911, this._ext |= e3 << 29 & 3758096384;
          }
          constructor(e3 = 0, t3 = 0) {
            this._ext = e3, this._urlId = t3;
          }
          clone() {
            return new s2(this._ext, this._urlId);
          }
          isEmpty() {
            return 0 === this.underlineStyle && 0 === this._urlId;
          }
        }
        t2.ExtendedAttrs = s2;
      }, 453(e2, t2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.clone = function e3(t3, i2 = 5) {
          if ("object" != typeof t3) return t3;
          const s2 = Array.isArray(t3) ? [] : {};
          for (const r2 in t3) s2[r2] = i2 <= 1 ? t3[r2] : t3[r2] && e3(t3[r2], i2 - 1);
          return s2;
        };
      }, 478(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.BufferSet = void 0;
        const s2 = i2(812), r2 = i2(73), n2 = i2(636);
        class a extends s2.Disposable {
          _optionsService;
          _bufferService;
          _logService;
          _normal;
          _alt;
          _activeBuffer;
          _normalBuffer = this._register(new s2.MutableDisposable());
          _altBuffer = this._register(new s2.MutableDisposable());
          _onBufferActivate = this._register(new n2.Emitter());
          onBufferActivate = this._onBufferActivate.event;
          constructor(e3, t3, i3) {
            super(), this._optionsService = e3, this._bufferService = t3, this._logService = i3, this.reset(), this._register(this._optionsService.onSpecificOptionChange("scrollback", () => this.resize(this._bufferService.cols, this._bufferService.rows))), this._register(this._optionsService.onSpecificOptionChange("tabStopWidth", () => this.setupTabStops()));
          }
          reset() {
            this._normal = new r2.Buffer(true, this._optionsService, this._bufferService, this._logService), this._normalBuffer.value = this._normal, this._normal.fillViewportRows(), this._alt = new r2.Buffer(false, this._optionsService, this._bufferService, this._logService), this._altBuffer.value = this._alt, this._activeBuffer = this._normal, this._onBufferActivate.fire({ activeBuffer: this._normal, inactiveBuffer: this._alt }), this.setupTabStops();
          }
          get alt() {
            return this._alt;
          }
          get active() {
            return this._activeBuffer;
          }
          get normal() {
            return this._normal;
          }
          activateNormalBuffer() {
            this._activeBuffer !== this._normal && (this._normal.x = this._alt.x, this._normal.y = this._alt.y, this._alt.clearAllMarkers(), this._alt.clear(), this._activeBuffer = this._normal, this._onBufferActivate.fire({ activeBuffer: this._normal, inactiveBuffer: this._alt }));
          }
          activateAltBuffer(e3) {
            this._activeBuffer !== this._alt && (this._alt.fillViewportRows(e3), this._alt.x = this._normal.x, this._alt.y = this._normal.y, this._activeBuffer = this._alt, this._onBufferActivate.fire({ activeBuffer: this._alt, inactiveBuffer: this._normal }));
          }
          resize(e3, t3) {
            this._normal.resize(e3, t3), this._alt.resize(e3, t3), this.setupTabStops(e3);
          }
          setupTabStops(e3) {
            this._normal.setupTabStops(e3), this._alt.setupTabStops(e3);
          }
        }
        t2.BufferSet = a;
      }, 486(e2, t2, i2) {
        var s2 = this && this.__decorate || function(e3, t3, i3, s3) {
          var r3, n3 = arguments.length, a2 = n3 < 3 ? t3 : null === s3 ? s3 = Object.getOwnPropertyDescriptor(t3, i3) : s3;
          if ("object" == typeof Reflect && "function" == typeof Reflect.decorate) a2 = Reflect.decorate(e3, t3, i3, s3);
          else for (var o2 = e3.length - 1; o2 >= 0; o2--) (r3 = e3[o2]) && (a2 = (n3 < 3 ? r3(a2) : n3 > 3 ? r3(t3, i3, a2) : r3(t3, i3)) || a2);
          return n3 > 3 && a2 && Object.defineProperty(t3, i3, a2), a2;
        }, r2 = this && this.__param || function(e3, t3) {
          return function(i3, s3) {
            t3(i3, s3, e3);
          };
        };
        Object.defineProperty(t2, "__esModule", { value: true }), t2.InputHandler = t2.WindowsOptionsReportType = void 0, t2.isValidColorIndex = E;
        const n2 = i2(760), a = i2(717), o = i2(812), h = i2(726), c = i2(107), l = i2(938), _ = i2(55), d = i2(451), f = i2(501), u = i2(415), g = i2(346), p = i2(823), v = i2(607), b = i2(693), S = i2(636), m = i2(804), y = { "(": 0, ")": 1, "*": 2, "+": 3, "-": 1, ".": 2 };
        function C(e3, t3) {
          if (e3 > 24) return t3.setWinLines || false;
          switch (e3) {
            case 1:
              return !!t3.restoreWin;
            case 2:
              return !!t3.minimizeWin;
            case 3:
              return !!t3.setWinPosition;
            case 4:
              return !!t3.setWinSizePixels;
            case 5:
              return !!t3.raiseWin;
            case 6:
              return !!t3.lowerWin;
            case 7:
              return !!t3.refreshWin;
            case 8:
              return !!t3.setWinSizeChars;
            case 9:
              return !!t3.maximizeWin;
            case 10:
              return !!t3.fullscreenWin;
            case 11:
              return !!t3.getWinState;
            case 13:
              return !!t3.getWinPosition;
            case 14:
              return !!t3.getWinSizePixels;
            case 15:
              return !!t3.getScreenSizePixels;
            case 16:
              return !!t3.getCellSizePixels;
            case 18:
              return !!t3.getWinSizeChars;
            case 19:
              return !!t3.getScreenSizeChars;
            case 20:
              return !!t3.getIconTitle;
            case 21:
              return !!t3.getWinTitle;
            case 22:
              return !!t3.pushTitle;
            case 23:
              return !!t3.popTitle;
            case 24:
              return !!t3.setWinLines;
          }
          return false;
        }
        var w;
        !(function(e3) {
          e3[e3.GET_WIN_SIZE_PIXELS = 0] = "GET_WIN_SIZE_PIXELS", e3[e3.GET_CELL_SIZE_PIXELS = 1] = "GET_CELL_SIZE_PIXELS";
        })(w || (t2.WindowsOptionsReportType = w = {}));
        let B = 0;
        class k extends o.Disposable {
          _bufferService;
          _charsetService;
          _coreService;
          _logService;
          _optionsService;
          _oscLinkService;
          _mouseStateService;
          _unicodeService;
          _parser;
          _parseBuffer = new Uint32Array(4096);
          _stringDecoder = new h.StringToUtf32();
          _utf8Decoder = new h.Utf8ToUtf32();
          _windowTitle = "";
          _iconName = "";
          _dirtyRowTracker;
          _windowTitleStack = [];
          _iconNameStack = [];
          _curAttrData = c.DEFAULT_ATTR_DATA.clone();
          getAttrData() {
            return this._curAttrData;
          }
          _eraseAttrDataInternal = c.DEFAULT_ATTR_DATA.clone();
          _activeBuffer;
          _onRequestBell = this._register(new S.Emitter());
          onRequestBell = this._onRequestBell.event;
          _onRequestRefreshRows = this._register(new S.Emitter());
          onRequestRefreshRows = this._onRequestRefreshRows.event;
          _onRequestReset = this._register(new S.Emitter());
          onRequestReset = this._onRequestReset.event;
          _onRequestSendFocus = this._register(new S.Emitter());
          onRequestSendFocus = this._onRequestSendFocus.event;
          _onRequestSyncScrollBar = this._register(new S.Emitter());
          onRequestSyncScrollBar = this._onRequestSyncScrollBar.event;
          _onRequestWindowsOptionsReport = this._register(new S.Emitter());
          onRequestWindowsOptionsReport = this._onRequestWindowsOptionsReport.event;
          _onA11yChar = this._register(new S.Emitter());
          onA11yChar = this._onA11yChar.event;
          _onA11yTab = this._register(new S.Emitter());
          onA11yTab = this._onA11yTab.event;
          _onCursorMove = this._register(new S.Emitter());
          onCursorMove = this._onCursorMove.event;
          _onLineFeed = this._register(new S.Emitter());
          onLineFeed = this._onLineFeed.event;
          _onScroll = this._register(new S.Emitter());
          onScroll = this._onScroll.event;
          _onTitleChange = this._register(new S.Emitter());
          onTitleChange = this._onTitleChange.event;
          _onColor = this._register(new S.Emitter());
          onColor = this._onColor.event;
          _onRequestColorSchemeQuery = this._register(new S.Emitter());
          onRequestColorSchemeQuery = this._onRequestColorSchemeQuery.event;
          _parseStack = { paused: false, cursorStartX: 0, cursorStartY: 0, decodedLength: 0, position: 0 };
          constructor(e3, t3, i3, s3, r3, o2, h2, c2, l2 = new a.EscapeSequenceParser()) {
            super(), this._bufferService = e3, this._charsetService = t3, this._coreService = i3, this._logService = s3, this._optionsService = r3, this._oscLinkService = o2, this._mouseStateService = h2, this._unicodeService = c2, this._parser = l2, this._register(this._parser), this._dirtyRowTracker = new A(this._bufferService), this._activeBuffer = this._bufferService.buffer, this._register(this._bufferService.buffers.onBufferActivate((e4) => this._activeBuffer = e4.activeBuffer)), this._parser.setCsiHandlerFallback((e4, t4) => {
              this._logService.debug("Unknown CSI code: ", { identifier: this._parser.identToString(e4), params: t4.toArray() });
            }), this._parser.setEscHandlerFallback((e4) => {
              this._logService.debug("Unknown ESC code: ", { identifier: this._parser.identToString(e4) });
            }), this._parser.setExecuteHandlerFallback((e4) => {
              this._logService.debug("Unknown EXECUTE code: ", { code: e4 });
            }), this._parser.setOscHandlerFallback((e4, t4, i4) => {
              this._logService.debug("Unknown OSC code: ", { identifier: e4, action: t4, data: i4 });
            }), this._parser.setDcsHandlerFallback((e4, t4, i4) => {
              "HOOK" === t4 && (i4 = i4.toArray()), this._logService.debug("Unknown DCS code: ", { identifier: this._parser.identToString(e4), action: t4, payload: i4 });
            }), this._parser.setApcHandlerFallback((e4, t4, i4) => {
              this._logService.debug("Unknown APC code: ", { identifier: this._parser.identToString(e4), action: t4, payload: i4 });
            }), this._parser.setPrintHandler((e4, t4, i4) => this.print(e4, t4, i4)), this._parser.registerCsiHandler({ final: "@" }, (e4) => this.insertChars(e4)), this._parser.registerCsiHandler({ intermediates: " ", final: "@" }, (e4) => this.scrollLeft(e4)), this._parser.registerCsiHandler({ final: "A" }, (e4) => this.cursorUp(e4)), this._parser.registerCsiHandler({ intermediates: " ", final: "A" }, (e4) => this.scrollRight(e4)), this._parser.registerCsiHandler({ final: "B" }, (e4) => this.cursorDown(e4)), this._parser.registerCsiHandler({ final: "C" }, (e4) => this.cursorForward(e4)), this._parser.registerCsiHandler({ final: "D" }, (e4) => this.cursorBackward(e4)), this._parser.registerCsiHandler({ final: "E" }, (e4) => this.cursorNextLine(e4)), this._parser.registerCsiHandler({ final: "F" }, (e4) => this.cursorPrecedingLine(e4)), this._parser.registerCsiHandler({ final: "G" }, (e4) => this.cursorCharAbsolute(e4)), this._parser.registerCsiHandler({ final: "H" }, (e4) => this.cursorPosition(e4)), this._parser.registerCsiHandler({ final: "I" }, (e4) => this.cursorForwardTab(e4)), this._parser.registerCsiHandler({ final: "J" }, (e4) => this.eraseInDisplay(e4, false)), this._parser.registerCsiHandler({ prefix: "?", final: "J" }, (e4) => this.eraseInDisplay(e4, true)), this._parser.registerCsiHandler({ final: "K" }, (e4) => this.eraseInLine(e4, false)), this._parser.registerCsiHandler({ prefix: "?", final: "K" }, (e4) => this.eraseInLine(e4, true)), this._parser.registerCsiHandler({ final: "L" }, (e4) => this.insertLines(e4)), this._parser.registerCsiHandler({ final: "M" }, (e4) => this.deleteLines(e4)), this._parser.registerCsiHandler({ final: "P" }, (e4) => this.deleteChars(e4)), this._parser.registerCsiHandler({ final: "S" }, (e4) => this.scrollUp(e4)), this._parser.registerCsiHandler({ final: "T" }, (e4) => this.scrollDown(e4)), this._parser.registerCsiHandler({ final: "X" }, (e4) => this.eraseChars(e4)), this._parser.registerCsiHandler({ final: "Z" }, (e4) => this.cursorBackwardTab(e4)), this._parser.registerCsiHandler({ final: "^" }, (e4) => this.scrollDown(e4)), this._parser.registerCsiHandler({ final: "`" }, (e4) => this.charPosAbsolute(e4)), this._parser.registerCsiHandler({ final: "a" }, (e4) => this.hPositionRelative(e4)), this._parser.registerCsiHandler({ final: "b" }, (e4) => this.repeatPrecedingCharacter(e4)), this._parser.registerCsiHandler({ final: "c" }, (e4) => this.sendDeviceAttributesPrimary(e4)), this._parser.registerCsiHandler({ prefix: ">", final: "c" }, (e4) => this.sendDeviceAttributesSecondary(e4)), this._parser.registerCsiHandler({ final: "d" }, (e4) => this.linePosAbsolute(e4)), this._parser.registerCsiHandler({ final: "e" }, (e4) => this.vPositionRelative(e4)), this._parser.registerCsiHandler({ final: "f" }, (e4) => this.hVPosition(e4)), this._parser.registerCsiHandler({ final: "g" }, (e4) => this.tabClear(e4)), this._parser.registerCsiHandler({ final: "h" }, (e4) => this.setMode(e4)), this._parser.registerCsiHandler({ prefix: "?", final: "h" }, (e4) => this.setModePrivate(e4)), this._parser.registerCsiHandler({ final: "l" }, (e4) => this.resetMode(e4)), this._parser.registerCsiHandler({ prefix: "?", final: "l" }, (e4) => this.resetModePrivate(e4)), this._parser.registerCsiHandler({ final: "m" }, (e4) => this.charAttributes(e4)), this._parser.registerCsiHandler({ final: "n" }, (e4) => this.deviceStatus(e4)), this._parser.registerCsiHandler({ prefix: "?", final: "n" }, (e4) => this.deviceStatusPrivate(e4)), this._parser.registerCsiHandler({ intermediates: "!", final: "p" }, (e4) => this.softReset(e4)), this._parser.registerCsiHandler({ prefix: ">", final: "q" }, (e4) => this.sendXtVersion(e4)), this._parser.registerCsiHandler({ intermediates: " ", final: "q" }, (e4) => this.setCursorStyle(e4)), this._parser.registerCsiHandler({ final: "r" }, (e4) => this.setScrollRegion(e4)), this._parser.registerCsiHandler({ final: "s" }, (e4) => this.saveCursor(e4)), this._parser.registerCsiHandler({ final: "t" }, (e4) => this.windowOptions(e4)), this._parser.registerCsiHandler({ final: "u" }, (e4) => this.restoreCursor(e4)), this._parser.registerCsiHandler({ intermediates: "'", final: "}" }, (e4) => this.insertColumns(e4)), this._parser.registerCsiHandler({ intermediates: "'", final: "~" }, (e4) => this.deleteColumns(e4)), this._parser.registerCsiHandler({ intermediates: '"', final: "q" }, (e4) => this.selectProtected(e4)), this._parser.registerCsiHandler({ intermediates: "$", final: "p" }, (e4) => this.requestMode(e4, true)), this._parser.registerCsiHandler({ prefix: "?", intermediates: "$", final: "p" }, (e4) => this.requestMode(e4, false)), this._parser.registerCsiHandler({ prefix: "=", final: "u" }, (e4) => this.kittyKeyboardSet(e4)), this._parser.registerCsiHandler({ prefix: "?", final: "u" }, (e4) => this.kittyKeyboardQuery(e4)), this._parser.registerCsiHandler({ prefix: ">", final: "u" }, (e4) => this.kittyKeyboardPush(e4)), this._parser.registerCsiHandler({ prefix: "<", final: "u" }, (e4) => this.kittyKeyboardPop(e4)), this._parser.setExecuteHandler("\x07", () => this.bell()), this._parser.setExecuteHandler("\n", () => this.lineFeed()), this._parser.setExecuteHandler("\v", () => this.lineFeed()), this._parser.setExecuteHandler("\f", () => this.lineFeed()), this._parser.setExecuteHandler("\r", () => this.carriageReturn()), this._parser.setExecuteHandler("\b", () => this.backspace()), this._parser.setExecuteHandler("	", () => this.tab()), this._parser.setExecuteHandler("", () => this.shiftOut()), this._parser.setExecuteHandler("", () => this.shiftIn()), this._parser.setExecuteHandler("\x84", () => this.index()), this._parser.setExecuteHandler("\x85", () => this.nextLine()), this._parser.setExecuteHandler("\x88", () => this.tabSet()), this._parser.registerOscHandler(0, new g.OscHandler((e4) => (this.setTitle(e4), this.setIconName(e4), true))), this._parser.registerOscHandler(1, new g.OscHandler((e4) => this.setIconName(e4))), this._parser.registerOscHandler(2, new g.OscHandler((e4) => this.setTitle(e4))), this._parser.registerOscHandler(4, new g.OscHandler((e4) => this.setOrReportIndexedColor(e4))), this._parser.registerOscHandler(8, new g.OscHandler((e4) => this.setHyperlink(e4))), this._parser.registerOscHandler(10, new g.OscHandler((e4) => this.setOrReportFgColor(e4))), this._parser.registerOscHandler(11, new g.OscHandler((e4) => this.setOrReportBgColor(e4))), this._parser.registerOscHandler(12, new g.OscHandler((e4) => this.setOrReportCursorColor(e4))), this._parser.registerOscHandler(104, new g.OscHandler((e4) => this.restoreIndexedColor(e4))), this._parser.registerOscHandler(110, new g.OscHandler((e4) => this.restoreFgColor(e4))), this._parser.registerOscHandler(111, new g.OscHandler((e4) => this.restoreBgColor(e4))), this._parser.registerOscHandler(112, new g.OscHandler((e4) => this.restoreCursorColor(e4))), this._parser.registerEscHandler({ final: "7" }, () => this.saveCursor()), this._parser.registerEscHandler({ final: "8" }, () => this.restoreCursor()), this._parser.registerEscHandler({ final: "D" }, () => this.index()), this._parser.registerEscHandler({ final: "E" }, () => this.nextLine()), this._parser.registerEscHandler({ final: "H" }, () => this.tabSet()), this._parser.registerEscHandler({ final: "M" }, () => this.reverseIndex()), this._parser.registerEscHandler({ final: "=" }, () => this.keypadApplicationMode()), this._parser.registerEscHandler({ final: ">" }, () => this.keypadNumericMode()), this._parser.registerEscHandler({ final: "c" }, () => this.fullReset()), this._parser.registerEscHandler({ final: "n" }, () => this.setgLevel(2)), this._parser.registerEscHandler({ final: "o" }, () => this.setgLevel(3)), this._parser.registerEscHandler({ final: "|" }, () => this.setgLevel(3)), this._parser.registerEscHandler({ final: "}" }, () => this.setgLevel(2)), this._parser.registerEscHandler({ final: "~" }, () => this.setgLevel(1)), this._parser.registerEscHandler({ intermediates: "%", final: "@" }, () => this.selectDefaultCharset()), this._parser.registerEscHandler({ intermediates: "%", final: "G" }, () => this.selectDefaultCharset());
            for (const e4 in n2.CHARSETS) this._parser.registerEscHandler({ intermediates: "(", final: e4 }, () => this.selectCharset("(" + e4)), this._parser.registerEscHandler({ intermediates: ")", final: e4 }, () => this.selectCharset(")" + e4)), this._parser.registerEscHandler({ intermediates: "*", final: e4 }, () => this.selectCharset("*" + e4)), this._parser.registerEscHandler({ intermediates: "+", final: e4 }, () => this.selectCharset("+" + e4)), this._parser.registerEscHandler({ intermediates: "-", final: e4 }, () => this.selectCharset("-" + e4)), this._parser.registerEscHandler({ intermediates: ".", final: e4 }, () => this.selectCharset("." + e4)), this._parser.registerEscHandler({ intermediates: "/", final: e4 }, () => this.selectCharset("/" + e4));
            this._parser.registerEscHandler({ intermediates: "#", final: "8" }, () => this.screenAlignmentPattern()), this._parser.setErrorHandler((e4) => (this._logService.error("Parsing error: ", e4), e4)), this._parser.registerDcsHandler({ intermediates: "$", final: "q" }, new p.DcsHandler((e4, t4) => this.requestStatusString(e4, t4)));
          }
          _preserveStack(e3, t3, i3, s3) {
            this._parseStack.paused = true, this._parseStack.cursorStartX = e3, this._parseStack.cursorStartY = t3, this._parseStack.decodedLength = i3, this._parseStack.position = s3;
          }
          _logSlowResolvingAsync(e3) {
            if (this._logService.logLevel <= f.LogLevelEnum.WARN) {
              let t3;
              const i3 = new Promise((e4, i4) => {
                t3 = setTimeout(() => i4("#SLOW_TIMEOUT"), 5e3);
              });
              Promise.race([e3, i3]).then(() => {
                void 0 !== t3 && clearTimeout(t3);
              }, (e4) => {
                if (void 0 !== t3 && clearTimeout(t3), "#SLOW_TIMEOUT" !== e4) throw e4;
                console.warn("async parser handler taking longer than 5000 ms");
              });
            }
          }
          _getCurrentLinkId() {
            return this._curAttrData.extended.urlId;
          }
          parse(e3, t3) {
            let i3, s3 = this._activeBuffer.x, r3 = this._activeBuffer.y, n3 = 0;
            const a2 = this._parseStack.paused;
            if (a2) {
              if (i3 = this._parser.parse(this._parseBuffer, this._parseStack.decodedLength, t3)) return this._logSlowResolvingAsync(i3), i3;
              s3 = this._parseStack.cursorStartX, r3 = this._parseStack.cursorStartY, this._parseStack.paused = false, e3.length > 131072 && (n3 = this._parseStack.position + 131072);
            }
            if (this._logService.logLevel <= f.LogLevelEnum.DEBUG && this._logService.debug("parsing data " + ("string" == typeof e3 ? ` "${e3}"` : ` "${Array.prototype.map.call(e3, (e4) => String.fromCharCode(e4)).join("")}"`)), this._logService.logLevel === f.LogLevelEnum.TRACE && this._logService.trace("parsing data (codes)", "string" == typeof e3 ? e3.split("").map((e4) => e4.charCodeAt(0)) : e3), this._parseBuffer.length < e3.length && this._parseBuffer.length < 131072 && (this._parseBuffer = new Uint32Array(Math.min(e3.length, 131072))), a2 || this._dirtyRowTracker.clearRange(), e3.length > 131072) for (let t4 = n3; t4 < e3.length; t4 += 131072) {
              const n4 = t4 + 131072 < e3.length ? t4 + 131072 : e3.length, a3 = "string" == typeof e3 ? this._stringDecoder.decode(e3.substring(t4, n4), this._parseBuffer) : this._utf8Decoder.decode(e3.subarray(t4, n4), this._parseBuffer);
              if (i3 = this._parser.parse(this._parseBuffer, a3)) return this._preserveStack(s3, r3, a3, t4), this._logSlowResolvingAsync(i3), i3;
            }
            else if (!a2) {
              const t4 = "string" == typeof e3 ? this._stringDecoder.decode(e3, this._parseBuffer) : this._utf8Decoder.decode(e3, this._parseBuffer);
              if (i3 = this._parser.parse(this._parseBuffer, t4)) return this._preserveStack(s3, r3, t4, 0), this._logSlowResolvingAsync(i3), i3;
            }
            this._activeBuffer.x === s3 && this._activeBuffer.y === r3 || this._onCursorMove.fire();
            const o2 = this._dirtyRowTracker.end + (this._bufferService.buffer.ybase - this._bufferService.buffer.ydisp), h2 = this._dirtyRowTracker.start + (this._bufferService.buffer.ybase - this._bufferService.buffer.ydisp);
            h2 < this._bufferService.rows && this._onRequestRefreshRows.fire({ start: Math.min(h2, this._bufferService.rows - 1), end: Math.min(o2, this._bufferService.rows - 1) });
          }
          print(e3, t3, i3) {
            let s3, r3;
            const n3 = this._charsetService.charset, a2 = this._optionsService.rawOptions.screenReaderMode, o2 = this._bufferService.cols, _2 = this._coreService.decPrivateModes.wraparound, d2 = this._coreService.modes.insertMode, f2 = this._curAttrData;
            let g2 = this._activeBuffer.lines.get(this._activeBuffer.ybase + this._activeBuffer.y);
            if (!g2) return;
            this._dirtyRowTracker.markDirty(this._activeBuffer.y), this._activeBuffer.x && i3 - t3 > 0 && 2 === g2.getWidth(this._activeBuffer.x - 1) && g2.setCellFromCodepoint(this._activeBuffer.x - 1, 0, 1, f2);
            let p2 = this._parser.precedingJoinState;
            for (let v2 = t3; v2 < i3; ++v2) {
              if (s3 = e3[v2], 173 === s3) continue;
              if (s3 < 127 && n3) {
                const e4 = n3[String.fromCharCode(s3)];
                e4 && (s3 = e4.charCodeAt(0));
              }
              const t4 = this._unicodeService.charProperties(s3, p2);
              r3 = u.UnicodeService.extractWidth(t4);
              const i4 = u.UnicodeService.extractShouldJoin(t4), b2 = i4 ? u.UnicodeService.extractWidth(p2) : 0;
              if (p2 = t4, a2 && this._onA11yChar.fire((0, h.stringFromCodePoint)(s3)), this._getCurrentLinkId() && this._oscLinkService.addLineToLink(this._getCurrentLinkId(), this._activeBuffer.ybase + this._activeBuffer.y), this._activeBuffer.x + r3 - b2 > o2) {
                if (_2) {
                  const e4 = g2;
                  let t5 = this._activeBuffer.x - b2;
                  if (this._activeBuffer.x = b2, this._activeBuffer.y++, this._activeBuffer.y === this._activeBuffer.scrollBottom + 1 ? (this._activeBuffer.y--, this._bufferService.scroll(this._eraseAttrData(), true)) : (this._activeBuffer.y >= this._bufferService.rows && (this._activeBuffer.y = this._bufferService.rows - 1), this._activeBuffer.lines.get(this._activeBuffer.ybase + this._activeBuffer.y).isWrapped = true), g2 = this._activeBuffer.lines.get(this._activeBuffer.ybase + this._activeBuffer.y), !g2) return;
                  for (b2 > 0 && g2 instanceof c.BufferLine && g2.copyCellsFrom(e4, t5, 0, b2, false); t5 < o2; ) e4.setCellFromCodepoint(t5++, 0, 1, f2);
                } else if (this._activeBuffer.x = o2 - 1, 2 === r3) continue;
              }
              if (i4 && this._activeBuffer.x) {
                const e4 = g2.getWidth(this._activeBuffer.x - 1) ? 1 : 2;
                g2.addCodepointToCell(this._activeBuffer.x - e4, s3, r3);
                for (let e5 = r3 - b2; --e5 >= 0; ) g2.setCellFromCodepoint(this._activeBuffer.x++, 0, 0, f2);
                continue;
              }
              if (d2 && (g2.insertCells(this._activeBuffer.x, r3 - b2, this._activeBuffer.getNullCell(f2)), 2 === g2.getWidth(o2 - 1) && g2.setCellFromCodepoint(o2 - 1, l.NULL_CELL_CODE, l.NULL_CELL_WIDTH, f2)), g2.setCellFromCodepoint(this._activeBuffer.x++, s3, r3, f2), r3 > 0) for (; --r3; ) g2.setCellFromCodepoint(this._activeBuffer.x++, 0, 0, f2);
            }
            this._parser.precedingJoinState = p2, this._activeBuffer.x < o2 && i3 - t3 > 0 && 0 === g2.getWidth(this._activeBuffer.x) && !g2.hasContent(this._activeBuffer.x) && g2.setCellFromCodepoint(this._activeBuffer.x, 0, 1, f2), this._dirtyRowTracker.markDirty(this._activeBuffer.y);
          }
          registerCsiHandler(e3, t3) {
            return "t" !== e3.final || e3.prefix || e3.intermediates ? this._parser.registerCsiHandler(e3, t3) : this._parser.registerCsiHandler(e3, (e4) => !C(e4.params[0], this._optionsService.rawOptions.windowOptions) || t3(e4));
          }
          registerDcsHandler(e3, t3) {
            return this._parser.registerDcsHandler(e3, new p.DcsHandler(t3));
          }
          registerEscHandler(e3, t3) {
            return this._parser.registerEscHandler(e3, t3);
          }
          registerOscHandler(e3, t3) {
            return this._parser.registerOscHandler(e3, new g.OscHandler(t3));
          }
          registerApcHandler(e3, t3) {
            return this._parser.registerApcHandler(e3, new v.ApcHandler(t3));
          }
          bell() {
            return this._onRequestBell.fire(), true;
          }
          lineFeed() {
            return this._dirtyRowTracker.markDirty(this._activeBuffer.y), this._optionsService.rawOptions.convertEol && (this._activeBuffer.x = 0), this._activeBuffer.y++, this._activeBuffer.y === this._activeBuffer.scrollBottom + 1 ? (this._activeBuffer.y--, this._bufferService.scroll(this._eraseAttrData())) : this._activeBuffer.y >= this._bufferService.rows ? this._activeBuffer.y = this._bufferService.rows - 1 : this._activeBuffer.lines.get(this._activeBuffer.ybase + this._activeBuffer.y).isWrapped = false, this._activeBuffer.x >= this._bufferService.cols && this._activeBuffer.x--, this._dirtyRowTracker.markDirty(this._activeBuffer.y), this._onLineFeed.fire(), true;
          }
          carriageReturn() {
            return this._activeBuffer.x = 0, true;
          }
          backspace() {
            if (!this._coreService.decPrivateModes.reverseWraparound) return this._restrictCursor(), this._activeBuffer.x > 0 && this._activeBuffer.x--, true;
            if (this._restrictCursor(this._bufferService.cols), this._activeBuffer.x > 0) this._activeBuffer.x--;
            else if (0 === this._activeBuffer.x && this._activeBuffer.y > this._activeBuffer.scrollTop && this._activeBuffer.y <= this._activeBuffer.scrollBottom && this._activeBuffer.lines.get(this._activeBuffer.ybase + this._activeBuffer.y)?.isWrapped) {
              this._activeBuffer.lines.get(this._activeBuffer.ybase + this._activeBuffer.y).isWrapped = false, this._activeBuffer.y--, this._activeBuffer.x = this._bufferService.cols - 1;
              const e3 = this._activeBuffer.lines.get(this._activeBuffer.ybase + this._activeBuffer.y);
              e3.hasWidth(this._activeBuffer.x) && !e3.hasContent(this._activeBuffer.x) && this._activeBuffer.x--;
            }
            return this._restrictCursor(), true;
          }
          tab() {
            if (this._activeBuffer.x >= this._bufferService.cols) return true;
            const e3 = this._activeBuffer.x;
            return this._activeBuffer.x = this._activeBuffer.nextStop(), this._optionsService.rawOptions.screenReaderMode && this._onA11yTab.fire(this._activeBuffer.x - e3), true;
          }
          shiftOut() {
            return this._charsetService.setgLevel(1), true;
          }
          shiftIn() {
            return this._charsetService.setgLevel(0), true;
          }
          _restrictCursor(e3 = this._bufferService.cols - 1) {
            this._activeBuffer.x = Math.min(e3, Math.max(0, this._activeBuffer.x)), this._activeBuffer.y = this._coreService.decPrivateModes.origin ? Math.min(this._activeBuffer.scrollBottom, Math.max(this._activeBuffer.scrollTop, this._activeBuffer.y)) : Math.min(this._bufferService.rows - 1, Math.max(0, this._activeBuffer.y)), this._dirtyRowTracker.markDirty(this._activeBuffer.y);
          }
          _setCursor(e3, t3) {
            this._dirtyRowTracker.markDirty(this._activeBuffer.y), this._coreService.decPrivateModes.origin ? (this._activeBuffer.x = e3, this._activeBuffer.y = this._activeBuffer.scrollTop + t3) : (this._activeBuffer.x = e3, this._activeBuffer.y = t3), this._restrictCursor(), this._dirtyRowTracker.markDirty(this._activeBuffer.y);
          }
          _moveCursor(e3, t3) {
            this._restrictCursor(), this._setCursor(this._activeBuffer.x + e3, this._activeBuffer.y + t3);
          }
          cursorUp(e3) {
            const t3 = this._activeBuffer.y - this._activeBuffer.scrollTop;
            return t3 >= 0 ? this._moveCursor(0, -Math.min(t3, e3.params[0] || 1)) : this._moveCursor(0, -(e3.params[0] || 1)), true;
          }
          cursorDown(e3) {
            const t3 = this._activeBuffer.scrollBottom - this._activeBuffer.y;
            return t3 >= 0 ? this._moveCursor(0, Math.min(t3, e3.params[0] || 1)) : this._moveCursor(0, e3.params[0] || 1), true;
          }
          cursorForward(e3) {
            return this._moveCursor(e3.params[0] || 1, 0), true;
          }
          cursorBackward(e3) {
            return this._moveCursor(-(e3.params[0] || 1), 0), true;
          }
          cursorNextLine(e3) {
            return this.cursorDown(e3), this._activeBuffer.x = 0, true;
          }
          cursorPrecedingLine(e3) {
            return this.cursorUp(e3), this._activeBuffer.x = 0, true;
          }
          cursorCharAbsolute(e3) {
            return this._setCursor((e3.params[0] || 1) - 1, this._activeBuffer.y), true;
          }
          cursorPosition(e3) {
            return this._setCursor(e3.length >= 2 ? (e3.params[1] || 1) - 1 : 0, (e3.params[0] || 1) - 1), true;
          }
          charPosAbsolute(e3) {
            return this._setCursor((e3.params[0] || 1) - 1, this._activeBuffer.y), true;
          }
          hPositionRelative(e3) {
            return this._moveCursor(e3.params[0] || 1, 0), true;
          }
          linePosAbsolute(e3) {
            return this._setCursor(this._activeBuffer.x, (e3.params[0] || 1) - 1), true;
          }
          vPositionRelative(e3) {
            return this._moveCursor(0, e3.params[0] || 1), true;
          }
          hVPosition(e3) {
            return this.cursorPosition(e3), true;
          }
          tabClear(e3) {
            const t3 = e3.params[0];
            return 0 === t3 ? delete this._activeBuffer.tabs[this._activeBuffer.x] : 3 === t3 && (this._activeBuffer.tabs = {}), true;
          }
          cursorForwardTab(e3) {
            if (this._activeBuffer.x >= this._bufferService.cols) return true;
            let t3 = e3.params[0] || 1;
            for (; t3--; ) this._activeBuffer.x = this._activeBuffer.nextStop();
            return true;
          }
          cursorBackwardTab(e3) {
            if (this._activeBuffer.x >= this._bufferService.cols) return true;
            let t3 = e3.params[0] || 1;
            for (; t3--; ) this._activeBuffer.x = this._activeBuffer.prevStop();
            return true;
          }
          selectProtected(e3) {
            const t3 = e3.params[0];
            return 1 === t3 && (this._curAttrData.bg |= 536870912), 2 !== t3 && 0 !== t3 || (this._curAttrData.bg &= -536870913), true;
          }
          _eraseInBufferLine(e3, t3, i3, s3 = false, r3 = false) {
            const n3 = this._activeBuffer.lines.get(this._activeBuffer.ybase + e3);
            n3 && (n3.replaceCells(t3, i3, this._activeBuffer.getNullCell(this._eraseAttrData()), r3), s3 && (n3.isWrapped = false));
          }
          _resetBufferLine(e3, t3 = false) {
            const i3 = this._activeBuffer.lines.get(this._activeBuffer.ybase + e3);
            i3 && (i3.fill(this._activeBuffer.getNullCell(this._eraseAttrData()), t3), this._bufferService.buffer.clearMarkers(this._activeBuffer.ybase + e3), i3.isWrapped = false);
          }
          eraseInDisplay(e3, t3 = false) {
            let i3;
            switch (this._restrictCursor(this._bufferService.cols), e3.params[0]) {
              case 0:
                for (i3 = this._activeBuffer.y, this._dirtyRowTracker.markDirty(i3), this._eraseInBufferLine(i3++, this._activeBuffer.x, this._bufferService.cols, 0 === this._activeBuffer.x, t3); i3 < this._bufferService.rows; i3++) this._resetBufferLine(i3, t3);
                this._dirtyRowTracker.markDirty(i3);
                break;
              case 1:
                if (i3 = this._activeBuffer.y, this._dirtyRowTracker.markDirty(i3), this._eraseInBufferLine(i3, 0, this._activeBuffer.x + 1, true, t3), this._activeBuffer.x + 1 >= this._bufferService.cols) {
                  const e5 = this._activeBuffer.lines.get(i3 + 1);
                  e5 && (e5.isWrapped = false);
                }
                for (; i3--; ) this._resetBufferLine(i3, t3);
                this._dirtyRowTracker.markDirty(0);
                break;
              case 2:
                if (this._optionsService.rawOptions.scrollOnEraseInDisplay) {
                  for (i3 = this._bufferService.rows, this._dirtyRowTracker.markRangeDirty(0, i3 - 1); i3--; ) {
                    const e5 = this._activeBuffer.lines.get(this._activeBuffer.ybase + i3);
                    if (e5?.getTrimmedLength()) break;
                  }
                  for (; i3 >= 0; i3--) this._bufferService.scroll(this._eraseAttrData());
                } else {
                  for (i3 = this._bufferService.rows, this._dirtyRowTracker.markDirty(i3 - 1); i3--; ) this._resetBufferLine(i3, t3);
                  this._dirtyRowTracker.markDirty(0);
                }
                break;
              case 3:
                const e4 = this._activeBuffer.lines.length - this._bufferService.rows;
                e4 > 0 && (this._activeBuffer.lines.trimStart(e4), this._activeBuffer.ybase = Math.max(this._activeBuffer.ybase - e4, 0), this._activeBuffer.ydisp = Math.max(this._activeBuffer.ydisp - e4, 0), this._onScroll.fire(0));
            }
            return true;
          }
          eraseInLine(e3, t3 = false) {
            switch (this._restrictCursor(this._bufferService.cols), e3.params[0]) {
              case 0:
                this._eraseInBufferLine(this._activeBuffer.y, this._activeBuffer.x, this._bufferService.cols, 0 === this._activeBuffer.x, t3);
                break;
              case 1:
                this._eraseInBufferLine(this._activeBuffer.y, 0, this._activeBuffer.x + 1, false, t3);
                break;
              case 2:
                this._eraseInBufferLine(this._activeBuffer.y, 0, this._bufferService.cols, true, t3);
            }
            return this._dirtyRowTracker.markDirty(this._activeBuffer.y), true;
          }
          insertLines(e3) {
            this._restrictCursor();
            let t3 = e3.params[0] || 1;
            if (this._activeBuffer.y > this._activeBuffer.scrollBottom || this._activeBuffer.y < this._activeBuffer.scrollTop) return true;
            const i3 = this._activeBuffer.ybase + this._activeBuffer.y, s3 = this._bufferService.rows - 1 - this._activeBuffer.scrollBottom, r3 = this._bufferService.rows - 1 + this._activeBuffer.ybase - s3 + 1;
            for (; t3--; ) this._activeBuffer.lines.splice(r3 - 1, 1), this._activeBuffer.lines.splice(i3, 0, this._activeBuffer.getBlankLine(this._eraseAttrData()));
            return this._dirtyRowTracker.markRangeDirty(this._activeBuffer.y, this._activeBuffer.scrollBottom), this._activeBuffer.x = 0, true;
          }
          deleteLines(e3) {
            this._restrictCursor();
            let t3 = e3.params[0] || 1;
            if (this._activeBuffer.y > this._activeBuffer.scrollBottom || this._activeBuffer.y < this._activeBuffer.scrollTop) return true;
            const i3 = this._activeBuffer.ybase + this._activeBuffer.y;
            let s3;
            for (s3 = this._bufferService.rows - 1 - this._activeBuffer.scrollBottom, s3 = this._bufferService.rows - 1 + this._activeBuffer.ybase - s3; t3--; ) this._activeBuffer.lines.splice(i3, 1), this._activeBuffer.lines.splice(s3, 0, this._activeBuffer.getBlankLine(this._eraseAttrData()));
            return this._dirtyRowTracker.markRangeDirty(this._activeBuffer.y, this._activeBuffer.scrollBottom), this._activeBuffer.x = 0, true;
          }
          insertChars(e3) {
            this._restrictCursor();
            const t3 = this._activeBuffer.lines.get(this._activeBuffer.ybase + this._activeBuffer.y);
            return t3 && (t3.insertCells(this._activeBuffer.x, e3.params[0] || 1, this._activeBuffer.getNullCell(this._eraseAttrData())), this._dirtyRowTracker.markDirty(this._activeBuffer.y)), true;
          }
          deleteChars(e3) {
            this._restrictCursor();
            const t3 = this._activeBuffer.lines.get(this._activeBuffer.ybase + this._activeBuffer.y);
            return t3 && (t3.deleteCells(this._activeBuffer.x, e3.params[0] || 1, this._activeBuffer.getNullCell(this._eraseAttrData())), this._dirtyRowTracker.markDirty(this._activeBuffer.y)), true;
          }
          scrollUp(e3) {
            let t3 = e3.params[0] || 1;
            for (; t3--; ) this._activeBuffer.lines.splice(this._activeBuffer.ybase + this._activeBuffer.scrollTop, 1), this._activeBuffer.lines.splice(this._activeBuffer.ybase + this._activeBuffer.scrollBottom, 0, this._activeBuffer.getBlankLine(this._eraseAttrData()));
            return this._dirtyRowTracker.markRangeDirty(this._activeBuffer.scrollTop, this._activeBuffer.scrollBottom), true;
          }
          scrollDown(e3) {
            let t3 = e3.params[0] || 1;
            for (; t3--; ) this._activeBuffer.lines.splice(this._activeBuffer.ybase + this._activeBuffer.scrollBottom, 1), this._activeBuffer.lines.splice(this._activeBuffer.ybase + this._activeBuffer.scrollTop, 0, this._activeBuffer.getBlankLine(c.DEFAULT_ATTR_DATA));
            return this._dirtyRowTracker.markRangeDirty(this._activeBuffer.scrollTop, this._activeBuffer.scrollBottom), true;
          }
          scrollLeft(e3) {
            if (this._activeBuffer.y > this._activeBuffer.scrollBottom || this._activeBuffer.y < this._activeBuffer.scrollTop) return true;
            const t3 = e3.params[0] || 1;
            for (let e4 = this._activeBuffer.scrollTop; e4 <= this._activeBuffer.scrollBottom; ++e4) {
              const i3 = this._activeBuffer.lines.get(this._activeBuffer.ybase + e4);
              i3.deleteCells(0, t3, this._activeBuffer.getNullCell(this._eraseAttrData())), i3.isWrapped = false;
            }
            return this._dirtyRowTracker.markRangeDirty(this._activeBuffer.scrollTop, this._activeBuffer.scrollBottom), true;
          }
          scrollRight(e3) {
            if (this._activeBuffer.y > this._activeBuffer.scrollBottom || this._activeBuffer.y < this._activeBuffer.scrollTop) return true;
            const t3 = e3.params[0] || 1;
            for (let e4 = this._activeBuffer.scrollTop; e4 <= this._activeBuffer.scrollBottom; ++e4) {
              const i3 = this._activeBuffer.lines.get(this._activeBuffer.ybase + e4);
              i3.insertCells(0, t3, this._activeBuffer.getNullCell(this._eraseAttrData())), i3.isWrapped = false;
            }
            return this._dirtyRowTracker.markRangeDirty(this._activeBuffer.scrollTop, this._activeBuffer.scrollBottom), true;
          }
          insertColumns(e3) {
            if (this._activeBuffer.y > this._activeBuffer.scrollBottom || this._activeBuffer.y < this._activeBuffer.scrollTop) return true;
            const t3 = e3.params[0] || 1;
            for (let e4 = this._activeBuffer.scrollTop; e4 <= this._activeBuffer.scrollBottom; ++e4) {
              const i3 = this._activeBuffer.lines.get(this._activeBuffer.ybase + e4);
              i3.insertCells(this._activeBuffer.x, t3, this._activeBuffer.getNullCell(this._eraseAttrData())), i3.isWrapped = false;
            }
            return this._dirtyRowTracker.markRangeDirty(this._activeBuffer.scrollTop, this._activeBuffer.scrollBottom), true;
          }
          deleteColumns(e3) {
            if (this._activeBuffer.y > this._activeBuffer.scrollBottom || this._activeBuffer.y < this._activeBuffer.scrollTop) return true;
            const t3 = e3.params[0] || 1;
            for (let e4 = this._activeBuffer.scrollTop; e4 <= this._activeBuffer.scrollBottom; ++e4) {
              const i3 = this._activeBuffer.lines.get(this._activeBuffer.ybase + e4);
              i3.deleteCells(this._activeBuffer.x, t3, this._activeBuffer.getNullCell(this._eraseAttrData())), i3.isWrapped = false;
            }
            return this._dirtyRowTracker.markRangeDirty(this._activeBuffer.scrollTop, this._activeBuffer.scrollBottom), true;
          }
          eraseChars(e3) {
            this._restrictCursor();
            const t3 = this._activeBuffer.lines.get(this._activeBuffer.ybase + this._activeBuffer.y);
            return t3 && (t3.replaceCells(this._activeBuffer.x, this._activeBuffer.x + (e3.params[0] || 1), this._activeBuffer.getNullCell(this._eraseAttrData())), this._dirtyRowTracker.markDirty(this._activeBuffer.y)), true;
          }
          repeatPrecedingCharacter(e3) {
            const t3 = this._parser.precedingJoinState;
            if (!t3) return true;
            const i3 = e3.params[0] || 1, s3 = u.UnicodeService.extractWidth(t3), r3 = this._activeBuffer.x - s3, n3 = this._activeBuffer.lines.get(this._activeBuffer.ybase + this._activeBuffer.y).getString(r3), a2 = new Uint32Array(n3.length * i3);
            let o2 = 0;
            for (let e4 = 0; e4 < n3.length; ) {
              const t4 = n3.codePointAt(e4) || 0;
              a2[o2++] = t4, e4 += t4 > 65535 ? 2 : 1;
            }
            let h2 = o2;
            for (let e4 = 1; e4 < i3; ++e4) a2.copyWithin(h2, 0, o2), h2 += o2;
            return this.print(a2, 0, h2), true;
          }
          sendDeviceAttributesPrimary(e3) {
            return e3.params[0] > 0 || (this._is("xterm") || this._is("rxvt-unicode") || this._is("screen") ? this._coreService.triggerDataEvent("\x1B[?1;2c") : this._is("linux") && this._coreService.triggerDataEvent("\x1B[?6c")), true;
          }
          sendDeviceAttributesSecondary(e3) {
            return e3.params[0] > 0 || (this._is("xterm") ? this._coreService.triggerDataEvent("\x1B[>0;276;0c") : this._is("rxvt-unicode") ? this._coreService.triggerDataEvent("\x1B[>85;95;0c") : this._is("linux") ? this._coreService.triggerDataEvent(e3.params[0] + "c") : this._is("screen") && this._coreService.triggerDataEvent("\x1B[>83;40003;0c")), true;
          }
          sendXtVersion(e3) {
            return e3.params[0] > 0 || this._coreService.triggerDataEvent(`\x1BP>|xterm.js(${m.XTERM_VERSION})\x1B\\`), true;
          }
          _is(e3) {
            return (this._optionsService.rawOptions.termName + "").startsWith(e3);
          }
          setMode(e3) {
            for (let t3 = 0; t3 < e3.length; t3++) switch (e3.params[t3]) {
              case 4:
                this._coreService.modes.insertMode = true;
                break;
              case 20:
                this._optionsService.options.convertEol = true;
            }
            return true;
          }
          setModePrivate(e3) {
            for (let t3 = 0; t3 < e3.length; t3++) switch (e3.params[t3]) {
              case 1:
                this._coreService.decPrivateModes.applicationCursorKeys = true;
                break;
              case 2:
                this._charsetService.setgCharset(0, n2.DEFAULT_CHARSET), this._charsetService.setgCharset(1, n2.DEFAULT_CHARSET), this._charsetService.setgCharset(2, n2.DEFAULT_CHARSET), this._charsetService.setgCharset(3, n2.DEFAULT_CHARSET);
                break;
              case 3:
                this._optionsService.rawOptions.windowOptions.setWinLines && (this._bufferService.resize(132, this._bufferService.rows), this._onRequestReset.fire());
                break;
              case 6:
                this._coreService.decPrivateModes.origin = true, this._setCursor(0, 0);
                break;
              case 7:
                this._coreService.decPrivateModes.wraparound = true;
                break;
              case 12:
                this._optionsService.rawOptions.quirks?.allowSetCursorBlink && (this._optionsService.options.cursorBlink = true);
                break;
              case 45:
                this._coreService.decPrivateModes.reverseWraparound = true;
                break;
              case 66:
                this._logService.debug("Serial port requested application keypad."), this._coreService.decPrivateModes.applicationKeypad = true, this._onRequestSyncScrollBar.fire();
                break;
              case 9:
                this._mouseStateService.activeProtocol = "X10";
                break;
              case 1e3:
                this._mouseStateService.activeProtocol = "VT200";
                break;
              case 1002:
                this._mouseStateService.activeProtocol = "DRAG";
                break;
              case 1003:
                this._mouseStateService.activeProtocol = "ANY";
                break;
              case 1004:
                this._coreService.decPrivateModes.sendFocus = true, this._onRequestSendFocus.fire();
                break;
              case 1005:
                this._logService.debug("DECSET 1005 not supported (see #2507)");
                break;
              case 1006:
                this._mouseStateService.activeEncoding = "SGR";
                break;
              case 1015:
                this._logService.debug("DECSET 1015 not supported (see #2507)");
                break;
              case 1016:
                this._mouseStateService.activeEncoding = "SGR_PIXELS";
                break;
              case 25:
                this._coreService.isCursorHidden = false;
                break;
              case 1048:
                this.saveCursor();
                break;
              case 1049:
                this.saveCursor();
              case 47:
              case 1047:
                if (this._optionsService.rawOptions.vtExtensions?.kittyKeyboard) {
                  const e4 = this._coreService.kittyKeyboard;
                  e4.mainFlags = e4.flags, e4.flags = e4.altFlags;
                }
                this._bufferService.buffers.activateAltBuffer(this._eraseAttrData()), this._coreService.isCursorInitialized = true, this._onRequestRefreshRows.fire(void 0), this._onRequestSyncScrollBar.fire();
                break;
              case 2004:
                this._coreService.decPrivateModes.bracketedPasteMode = true;
                break;
              case 2026:
                this._coreService.decPrivateModes.synchronizedOutput = true;
                break;
              case 2031:
                (this._optionsService.rawOptions.vtExtensions?.colorSchemeQuery ?? 1) && (this._coreService.decPrivateModes.colorSchemeUpdates = true);
                break;
              case 9001:
                this._optionsService.rawOptions.vtExtensions?.win32InputMode && (this._coreService.decPrivateModes.win32InputMode = true);
            }
            return true;
          }
          resetMode(e3) {
            for (let t3 = 0; t3 < e3.length; t3++) switch (e3.params[t3]) {
              case 4:
                this._coreService.modes.insertMode = false;
                break;
              case 20:
                this._optionsService.options.convertEol = false;
            }
            return true;
          }
          resetModePrivate(e3) {
            for (let t3 = 0; t3 < e3.length; t3++) switch (e3.params[t3]) {
              case 1:
                this._coreService.decPrivateModes.applicationCursorKeys = false;
                break;
              case 3:
                this._optionsService.rawOptions.windowOptions.setWinLines && (this._bufferService.resize(80, this._bufferService.rows), this._onRequestReset.fire());
                break;
              case 6:
                this._coreService.decPrivateModes.origin = false, this._setCursor(0, 0);
                break;
              case 7:
                this._coreService.decPrivateModes.wraparound = false;
                break;
              case 12:
                this._optionsService.rawOptions.quirks?.allowSetCursorBlink && (this._optionsService.options.cursorBlink = false);
                break;
              case 45:
                this._coreService.decPrivateModes.reverseWraparound = false;
                break;
              case 66:
                this._logService.debug("Switching back to normal keypad."), this._coreService.decPrivateModes.applicationKeypad = false, this._onRequestSyncScrollBar.fire();
                break;
              case 9:
              case 1e3:
              case 1002:
              case 1003:
                this._mouseStateService.activeProtocol = "NONE";
                break;
              case 1004:
                this._coreService.decPrivateModes.sendFocus = false;
                break;
              case 1005:
                this._logService.debug("DECRST 1005 not supported (see #2507)");
                break;
              case 1006:
              case 1016:
                this._mouseStateService.activeEncoding = "DEFAULT";
                break;
              case 1015:
                this._logService.debug("DECRST 1015 not supported (see #2507)");
                break;
              case 25:
                this._coreService.isCursorHidden = true;
                break;
              case 1048:
                this.restoreCursor();
                break;
              case 1049:
              case 47:
              case 1047:
                if (this._optionsService.rawOptions.vtExtensions?.kittyKeyboard) {
                  const e4 = this._coreService.kittyKeyboard;
                  e4.altFlags = e4.flags, e4.flags = e4.mainFlags;
                }
                this._bufferService.buffers.activateNormalBuffer(), 1049 === e3.params[t3] && this.restoreCursor(), this._coreService.isCursorInitialized = true, this._onRequestRefreshRows.fire(void 0), this._onRequestSyncScrollBar.fire();
                break;
              case 2004:
                this._coreService.decPrivateModes.bracketedPasteMode = false;
                break;
              case 2026:
                this._coreService.decPrivateModes.synchronizedOutput = false, this._onRequestRefreshRows.fire(void 0);
                break;
              case 2031:
                (this._optionsService.rawOptions.vtExtensions?.colorSchemeQuery ?? 1) && (this._coreService.decPrivateModes.colorSchemeUpdates = false);
                break;
              case 9001:
                this._optionsService.rawOptions.vtExtensions?.win32InputMode && (this._coreService.decPrivateModes.win32InputMode = false);
            }
            return true;
          }
          requestMode(e3, t3) {
            const i3 = this._coreService.decPrivateModes, { activeProtocol: s3, activeEncoding: r3 } = this._mouseStateService, n3 = this._coreService, { buffers: a2, cols: o2 } = this._bufferService, { active: h2, alt: c2 } = a2, l2 = this._optionsService.rawOptions, _2 = (e4, i4) => (n3.triggerDataEvent(`\x1B[${t3 ? "" : "?"}${e4};${i4}$y`), true), d2 = (e4) => e4 ? 1 : 2, f2 = e3.params[0];
            return t3 ? _2(f2, 2 === f2 ? 4 : 4 === f2 ? d2(n3.modes.insertMode) : 12 === f2 ? 3 : 20 === f2 ? d2(l2.convertEol) : 0) : 1 === f2 ? _2(f2, d2(i3.applicationCursorKeys)) : 3 === f2 ? _2(f2, l2.windowOptions.setWinLines ? 80 === o2 ? 2 : 132 === o2 ? 1 : 0 : 0) : 6 === f2 ? _2(f2, d2(i3.origin)) : 7 === f2 ? _2(f2, d2(i3.wraparound)) : 8 === f2 ? _2(f2, 3) : 9 === f2 ? _2(f2, d2("X10" === s3)) : 12 === f2 ? _2(f2, d2(l2.cursorBlink)) : 25 === f2 ? _2(f2, d2(!n3.isCursorHidden)) : 45 === f2 ? _2(f2, d2(i3.reverseWraparound)) : 66 === f2 ? _2(f2, d2(i3.applicationKeypad)) : 67 === f2 ? _2(f2, 4) : 1e3 === f2 ? _2(f2, d2("VT200" === s3)) : 1002 === f2 ? _2(f2, d2("DRAG" === s3)) : 1003 === f2 ? _2(f2, d2("ANY" === s3)) : 1004 === f2 ? _2(f2, d2(i3.sendFocus)) : 1005 === f2 ? _2(f2, 4) : 1006 === f2 ? _2(f2, d2("SGR" === r3)) : 1015 === f2 ? _2(f2, 4) : 1016 === f2 ? _2(f2, d2("SGR_PIXELS" === r3)) : 1048 === f2 ? _2(f2, 1) : 47 === f2 || 1047 === f2 || 1049 === f2 ? _2(f2, d2(h2 === c2)) : 2004 === f2 ? _2(f2, d2(i3.bracketedPasteMode)) : 2026 === f2 ? _2(f2, d2(i3.synchronizedOutput)) : 9001 === f2 && this._optionsService.rawOptions.vtExtensions?.win32InputMode ? _2(f2, d2(i3.win32InputMode)) : _2(f2, 0);
          }
          _updateAttrColor(e3, t3, i3, s3, r3) {
            return 2 === t3 ? (e3 |= 50331648, e3 &= -16777216, e3 |= d.AttributeData.fromColorRGB([i3, s3, r3])) : 5 === t3 && (e3 &= -67108864, e3 |= 33554432 | 255 & i3), e3;
          }
          _extractColor(e3, t3, i3) {
            const s3 = [0, 0, -1, 0, 0, 0];
            let r3 = 0, n3 = 0;
            do {
              if (s3[n3 + r3] = e3.params[t3 + n3], e3.hasSubParams(t3 + n3)) {
                const i4 = e3.getSubParams(t3 + n3);
                let a2 = 0;
                do {
                  5 === s3[1] && (r3 = 1), s3[n3 + a2 + 1 + r3] = i4[a2];
                } while (++a2 < i4.length && a2 + n3 + 1 + r3 < s3.length);
                break;
              }
              if (5 === s3[1] && n3 + r3 >= 2 || 2 === s3[1] && n3 + r3 >= 5) break;
              s3[1] && (r3 = 1);
            } while (++n3 + t3 < e3.length && n3 + r3 < s3.length);
            for (let e4 = 2; e4 < s3.length; ++e4) -1 === s3[e4] && (s3[e4] = 0);
            switch (s3[0]) {
              case 38:
                i3.fg = this._updateAttrColor(i3.fg, s3[1], s3[3], s3[4], s3[5]);
                break;
              case 48:
                i3.bg = this._updateAttrColor(i3.bg, s3[1], s3[3], s3[4], s3[5]);
                break;
              case 58:
                i3.extended = i3.extended.clone(), i3.extended.underlineColor = this._updateAttrColor(i3.extended.underlineColor, s3[1], s3[3], s3[4], s3[5]);
            }
            return n3;
          }
          _processUnderline(e3, t3) {
            t3.extended = t3.extended.clone(), (!~e3 || e3 > 5) && (e3 = 1), t3.extended.underlineStyle = e3, t3.fg |= 268435456, 0 === e3 && (t3.fg &= -268435457), t3.updateExtended();
          }
          _processSGR0(e3) {
            e3.fg = c.DEFAULT_ATTR_DATA.fg, e3.bg = c.DEFAULT_ATTR_DATA.bg, e3.extended = e3.extended.clone(), e3.extended.underlineStyle = 0, e3.extended.underlineColor &= -67108864, e3.updateExtended();
          }
          charAttributes(e3) {
            if (1 === e3.length && 0 === e3.params[0]) return this._processSGR0(this._curAttrData), true;
            const t3 = e3.length;
            let i3;
            const s3 = this._curAttrData;
            for (let r3 = 0; r3 < t3; r3++) i3 = e3.params[r3], i3 >= 30 && i3 <= 37 ? (s3.fg &= -67108864, s3.fg |= 16777216 | i3 - 30) : i3 >= 40 && i3 <= 47 ? (s3.bg &= -67108864, s3.bg |= 16777216 | i3 - 40) : i3 >= 90 && i3 <= 97 ? (s3.fg &= -67108864, s3.fg |= 16777224 | i3 - 90) : i3 >= 100 && i3 <= 107 ? (s3.bg &= -67108864, s3.bg |= 16777224 | i3 - 100) : 0 === i3 ? this._processSGR0(s3) : 1 === i3 ? s3.fg |= 134217728 : 3 === i3 ? s3.bg |= 67108864 : 4 === i3 ? (s3.fg |= 268435456, this._processUnderline(e3.hasSubParams(r3) ? e3.getSubParams(r3)[0] : 1, s3)) : 5 === i3 ? s3.fg |= 536870912 : 7 === i3 ? s3.fg |= 67108864 : 8 === i3 ? s3.fg |= 1073741824 : 9 === i3 ? s3.fg |= 2147483648 : 2 === i3 ? s3.bg |= 134217728 : 21 === i3 ? this._processUnderline(2, s3) : 22 === i3 ? (s3.fg &= -134217729, s3.bg &= -134217729) : 23 === i3 ? s3.bg &= -67108865 : 24 === i3 ? (s3.fg &= -268435457, this._processUnderline(0, s3)) : 25 === i3 ? s3.fg &= -536870913 : 27 === i3 ? s3.fg &= -67108865 : 28 === i3 ? s3.fg &= -1073741825 : 29 === i3 ? s3.fg &= 2147483647 : 39 === i3 ? (s3.fg &= -67108864, s3.fg |= 16777215 & c.DEFAULT_ATTR_DATA.fg) : 49 === i3 ? (s3.bg &= -67108864, s3.bg |= 16777215 & c.DEFAULT_ATTR_DATA.bg) : 38 === i3 || 48 === i3 || 58 === i3 ? r3 += this._extractColor(e3, r3, s3) : 53 === i3 ? s3.bg |= 1073741824 : 55 === i3 ? s3.bg &= -1073741825 : 221 === i3 && (this._optionsService.rawOptions.vtExtensions?.kittySgrBoldFaintControl ?? 1) ? s3.fg &= -134217729 : 222 === i3 && (this._optionsService.rawOptions.vtExtensions?.kittySgrBoldFaintControl ?? 1) ? s3.bg &= -134217729 : 59 === i3 ? (s3.extended = s3.extended.clone(), s3.extended.underlineColor = -1, s3.updateExtended()) : this._logService.debug("Unknown SGR attribute: %d.", i3);
            return true;
          }
          deviceStatus(e3) {
            switch (e3.params[0]) {
              case 5:
                this._coreService.triggerDataEvent("\x1B[0n");
                break;
              case 6:
                const e4 = this._activeBuffer.y + 1, t3 = this._activeBuffer.x + 1;
                this._coreService.triggerDataEvent(`\x1B[${e4};${t3}R`);
            }
            return true;
          }
          deviceStatusPrivate(e3) {
            switch (e3.params[0]) {
              case 6:
                const e4 = this._activeBuffer.y + 1, t3 = this._activeBuffer.x + 1;
                this._coreService.triggerDataEvent(`\x1B[?${e4};${t3}R`);
                break;
              case 15:
              case 25:
              case 26:
              case 53:
                break;
              case 996:
                (this._optionsService.rawOptions.vtExtensions?.colorSchemeQuery ?? 1) && this._onRequestColorSchemeQuery.fire();
            }
            return true;
          }
          softReset(e3) {
            return this._coreService.isCursorHidden = false, this._onRequestSyncScrollBar.fire(), this._activeBuffer.scrollTop = 0, this._activeBuffer.scrollBottom = this._bufferService.rows - 1, this._curAttrData = c.DEFAULT_ATTR_DATA.clone(), this._coreService.reset(), this._charsetService.reset(), this._activeBuffer.savedX = 0, this._activeBuffer.savedY = this._activeBuffer.ybase, this._activeBuffer.savedCurAttrData.fg = this._curAttrData.fg, this._activeBuffer.savedCurAttrData.bg = this._curAttrData.bg, this._activeBuffer.savedCharset = this._charsetService.charset, this._coreService.decPrivateModes.origin = false, true;
          }
          setCursorStyle(e3) {
            const t3 = 0 === e3.length ? 1 : e3.params[0];
            if (0 === t3) this._coreService.decPrivateModes.cursorStyle = void 0, this._coreService.decPrivateModes.cursorBlink = void 0;
            else {
              switch (t3) {
                case 1:
                case 2:
                  this._coreService.decPrivateModes.cursorStyle = "block";
                  break;
                case 3:
                case 4:
                  this._coreService.decPrivateModes.cursorStyle = "underline";
                  break;
                case 5:
                case 6:
                  this._coreService.decPrivateModes.cursorStyle = "bar";
              }
              const e4 = t3 % 2 == 1;
              this._coreService.decPrivateModes.cursorBlink = e4;
            }
            return true;
          }
          setScrollRegion(e3) {
            const t3 = e3.params[0] || 1;
            let i3;
            return (e3.length < 2 || (i3 = e3.params[1]) > this._bufferService.rows || 0 === i3) && (i3 = this._bufferService.rows), i3 > t3 && (this._activeBuffer.scrollTop = t3 - 1, this._activeBuffer.scrollBottom = i3 - 1, this._setCursor(0, 0)), true;
          }
          windowOptions(e3) {
            if (!C(e3.params[0], this._optionsService.rawOptions.windowOptions)) return true;
            const t3 = e3.length > 1 ? e3.params[1] : 0;
            switch (e3.params[0]) {
              case 14:
                2 !== t3 && this._onRequestWindowsOptionsReport.fire(w.GET_WIN_SIZE_PIXELS);
                break;
              case 16:
                this._onRequestWindowsOptionsReport.fire(w.GET_CELL_SIZE_PIXELS);
                break;
              case 18:
                this._bufferService && this._coreService.triggerDataEvent(`\x1B[8;${this._bufferService.rows};${this._bufferService.cols}t`);
                break;
              case 22:
                0 !== t3 && 2 !== t3 || (this._windowTitleStack.push(this._windowTitle), this._windowTitleStack.length > 10 && this._windowTitleStack.shift()), 0 !== t3 && 1 !== t3 || (this._iconNameStack.push(this._iconName), this._iconNameStack.length > 10 && this._iconNameStack.shift());
                break;
              case 23:
                0 !== t3 && 2 !== t3 || this._windowTitleStack.length && this.setTitle(this._windowTitleStack.pop()), 0 !== t3 && 1 !== t3 || this._iconNameStack.length && this.setIconName(this._iconNameStack.pop());
            }
            return true;
          }
          saveCursor(e3) {
            return this._activeBuffer.savedX = this._activeBuffer.x, this._activeBuffer.savedY = this._activeBuffer.ybase + this._activeBuffer.y, this._activeBuffer.savedCurAttrData.fg = this._curAttrData.fg, this._activeBuffer.savedCurAttrData.bg = this._curAttrData.bg, this._activeBuffer.savedCharset = this._charsetService.charset, this._activeBuffer.savedCharsets = this._charsetService.charsets.slice(), this._activeBuffer.savedGlevel = this._charsetService.glevel, this._activeBuffer.savedOriginMode = this._coreService.decPrivateModes.origin, this._activeBuffer.savedWraparoundMode = this._coreService.decPrivateModes.wraparound, true;
          }
          restoreCursor(e3) {
            this._activeBuffer.x = this._activeBuffer.savedX || 0, this._activeBuffer.y = Math.max(this._activeBuffer.savedY - this._activeBuffer.ybase, 0), this._curAttrData.fg = this._activeBuffer.savedCurAttrData.fg, this._curAttrData.bg = this._activeBuffer.savedCurAttrData.bg;
            for (let e4 = 0; e4 < this._activeBuffer.savedCharsets.length; e4++) this._charsetService.setgCharset(e4, this._activeBuffer.savedCharsets[e4]);
            return this._charsetService.setgLevel(this._activeBuffer.savedGlevel), this._coreService.decPrivateModes.origin = this._activeBuffer.savedOriginMode, this._coreService.decPrivateModes.wraparound = this._activeBuffer.savedWraparoundMode, this._restrictCursor(), true;
          }
          setTitle(e3) {
            return this._windowTitle = e3, this._onTitleChange.fire(e3), true;
          }
          setIconName(e3) {
            return this._iconName = e3, true;
          }
          setOrReportIndexedColor(e3) {
            const t3 = [], i3 = e3.split(";");
            for (; i3.length > 1; ) {
              const e4 = i3.shift(), s3 = i3.shift();
              if (/^\d+$/.exec(e4)) {
                const i4 = parseInt(e4);
                if (E(i4)) if ("?" === s3) t3.push({ type: 0, index: i4 });
                else {
                  const e5 = (0, b.parseColor)(s3);
                  e5 && t3.push({ type: 1, index: i4, color: e5 });
                }
              }
            }
            return t3.length && this._onColor.fire(t3), true;
          }
          setHyperlink(e3) {
            const t3 = e3.indexOf(";");
            if (-1 === t3) return true;
            const i3 = e3.slice(0, t3).trim(), s3 = e3.slice(t3 + 1);
            return s3 ? this._createHyperlink(i3, s3) : !i3.trim() && this._finishHyperlink();
          }
          _createHyperlink(e3, t3) {
            this._getCurrentLinkId() && this._finishHyperlink();
            const i3 = e3.split(":");
            let s3;
            const r3 = i3.findIndex((e4) => e4.startsWith("id="));
            return -1 !== r3 && (s3 = i3[r3].slice(3) || void 0), this._curAttrData.extended = this._curAttrData.extended.clone(), this._curAttrData.extended.urlId = this._oscLinkService.registerLink({ id: s3, uri: t3 }), this._curAttrData.updateExtended(), true;
          }
          _finishHyperlink() {
            return this._curAttrData.extended = this._curAttrData.extended.clone(), this._curAttrData.extended.urlId = 0, this._curAttrData.updateExtended(), true;
          }
          _specialColors = [256, 257, 258];
          _setOrReportSpecialColor(e3, t3) {
            const i3 = e3.split(";");
            for (let e4 = 0; e4 < i3.length && !(t3 >= this._specialColors.length); ++e4, ++t3) if ("?" === i3[e4]) this._onColor.fire([{ type: 0, index: this._specialColors[t3] }]);
            else {
              const s3 = (0, b.parseColor)(i3[e4]);
              s3 && this._onColor.fire([{ type: 1, index: this._specialColors[t3], color: s3 }]);
            }
            return true;
          }
          setOrReportFgColor(e3) {
            return this._setOrReportSpecialColor(e3, 0);
          }
          setOrReportBgColor(e3) {
            return this._setOrReportSpecialColor(e3, 1);
          }
          setOrReportCursorColor(e3) {
            return this._setOrReportSpecialColor(e3, 2);
          }
          restoreIndexedColor(e3) {
            if (!e3) return this._onColor.fire([{ type: 2 }]), true;
            const t3 = [], i3 = e3.split(";");
            for (let e4 = 0; e4 < i3.length; ++e4) if (/^\d+$/.exec(i3[e4])) {
              const s3 = parseInt(i3[e4]);
              E(s3) && t3.push({ type: 2, index: s3 });
            }
            return t3.length && this._onColor.fire(t3), true;
          }
          restoreFgColor(e3) {
            return this._onColor.fire([{ type: 2, index: 256 }]), true;
          }
          restoreBgColor(e3) {
            return this._onColor.fire([{ type: 2, index: 257 }]), true;
          }
          restoreCursorColor(e3) {
            return this._onColor.fire([{ type: 2, index: 258 }]), true;
          }
          nextLine() {
            return this._activeBuffer.x = 0, this.index(), true;
          }
          keypadApplicationMode() {
            return this._logService.debug("Serial port requested application keypad."), this._coreService.decPrivateModes.applicationKeypad = true, this._onRequestSyncScrollBar.fire(), true;
          }
          keypadNumericMode() {
            return this._logService.debug("Switching back to normal keypad."), this._coreService.decPrivateModes.applicationKeypad = false, this._onRequestSyncScrollBar.fire(), true;
          }
          selectDefaultCharset() {
            return this._charsetService.setgLevel(0), this._charsetService.setgCharset(0, n2.DEFAULT_CHARSET), true;
          }
          selectCharset(e3) {
            return 2 !== e3.length ? (this.selectDefaultCharset(), true) : ("/" === e3[0] || this._charsetService.setgCharset(y[e3[0]], n2.CHARSETS[e3[1]] ?? n2.DEFAULT_CHARSET), true);
          }
          index() {
            return this._restrictCursor(), this._activeBuffer.y++, this._activeBuffer.y === this._activeBuffer.scrollBottom + 1 ? (this._activeBuffer.y--, this._bufferService.scroll(this._eraseAttrData())) : this._activeBuffer.y >= this._bufferService.rows && (this._activeBuffer.y = this._bufferService.rows - 1), this._restrictCursor(), true;
          }
          tabSet() {
            return this._activeBuffer.tabs[this._activeBuffer.x] = true, true;
          }
          reverseIndex() {
            if (this._restrictCursor(), this._activeBuffer.y === this._activeBuffer.scrollTop) {
              const e3 = this._activeBuffer.scrollBottom - this._activeBuffer.scrollTop;
              this._activeBuffer.lines.shiftElements(this._activeBuffer.ybase + this._activeBuffer.y, e3, 1), this._activeBuffer.lines.set(this._activeBuffer.ybase + this._activeBuffer.y, this._activeBuffer.getBlankLine(this._eraseAttrData())), this._dirtyRowTracker.markRangeDirty(this._activeBuffer.scrollTop, this._activeBuffer.scrollBottom);
            } else this._activeBuffer.y--, this._restrictCursor();
            return true;
          }
          fullReset() {
            return this._parser.reset(), this._onRequestReset.fire(), true;
          }
          reset() {
            this._curAttrData = c.DEFAULT_ATTR_DATA.clone(), this._eraseAttrDataInternal = c.DEFAULT_ATTR_DATA.clone();
          }
          _eraseAttrData() {
            return this._eraseAttrDataInternal.bg &= -67108864, this._eraseAttrDataInternal.bg |= 67108863 & this._curAttrData.bg, this._eraseAttrDataInternal;
          }
          setgLevel(e3) {
            return this._charsetService.setgLevel(e3), true;
          }
          screenAlignmentPattern() {
            const e3 = new _.CellData();
            e3.content = 1 << 22 | "E".charCodeAt(0), e3.fg = this._curAttrData.fg, e3.bg = this._curAttrData.bg, this._setCursor(0, 0);
            for (let t3 = 0; t3 < this._bufferService.rows; ++t3) {
              const i3 = this._activeBuffer.ybase + this._activeBuffer.y + t3, s3 = this._activeBuffer.lines.get(i3);
              s3 && (s3.fill(e3), s3.isWrapped = false);
            }
            return this._dirtyRowTracker.markAllDirty(), this._setCursor(0, 0), true;
          }
          requestStatusString(e3, t3) {
            const i3 = this._bufferService.buffer, s3 = this._optionsService.rawOptions;
            return ((e4) => (this._coreService.triggerDataEvent(`\x1B${e4}\x1B\\`), true))('"q' === e3 ? `P1$r${this._curAttrData.isProtected() ? 1 : 0}"q` : '"p' === e3 ? 'P1$r61;1"p' : "r" === e3 ? `P1$r${i3.scrollTop + 1};${i3.scrollBottom + 1}r` : "m" === e3 ? "P1$r0m" : " q" === e3 ? `P1$r${{ block: 2, underline: 4, bar: 6 }[s3.cursorStyle] - (s3.cursorBlink ? 1 : 0)} q` : "P0$r");
          }
          markRangeDirty(e3, t3) {
            this._dirtyRowTracker.markRangeDirty(e3, t3);
          }
          kittyKeyboardSet(e3) {
            if (!this._optionsService.rawOptions.vtExtensions?.kittyKeyboard) return true;
            const t3 = e3.params[0] || 0, i3 = e3.length > 1 && e3.params[1] || 1, s3 = this._coreService.kittyKeyboard;
            switch (i3) {
              case 1:
                s3.flags = t3;
                break;
              case 2:
                s3.flags |= t3;
                break;
              case 3:
                s3.flags &= ~t3;
            }
            return true;
          }
          kittyKeyboardQuery(e3) {
            if (!this._optionsService.rawOptions.vtExtensions?.kittyKeyboard) return true;
            const t3 = this._coreService.kittyKeyboard.flags;
            return this._coreService.triggerDataEvent(`\x1B[?${t3}u`), true;
          }
          kittyKeyboardPush(e3) {
            if (!this._optionsService.rawOptions.vtExtensions?.kittyKeyboard) return true;
            const t3 = e3.params[0] || 0, i3 = this._coreService.kittyKeyboard, s3 = this._bufferService.buffer === this._bufferService.buffers.alt ? i3.altStack : i3.mainStack;
            return s3.length >= 16 && s3.shift(), s3.push(i3.flags), i3.flags = t3, true;
          }
          kittyKeyboardPop(e3) {
            if (!this._optionsService.rawOptions.vtExtensions?.kittyKeyboard) return true;
            const t3 = Math.max(1, e3.params[0] || 1), i3 = this._coreService.kittyKeyboard, s3 = this._bufferService.buffer === this._bufferService.buffers.alt ? i3.altStack : i3.mainStack;
            for (let e4 = 0; e4 < t3 && s3.length > 0; e4++) i3.flags = s3.pop();
            return 0 === s3.length && t3 > 0 && (i3.flags = 0), true;
          }
        }
        t2.InputHandler = k;
        let A = class {
          _bufferService;
          start;
          end;
          constructor(e3) {
            this._bufferService = e3, this.clearRange();
          }
          clearRange() {
            this.start = this._bufferService.buffer.y, this.end = this._bufferService.buffer.y;
          }
          markDirty(e3) {
            e3 < this.start ? this.start = e3 : e3 > this.end && (this.end = e3);
          }
          markRangeDirty(e3, t3) {
            e3 > t3 && (B = e3, e3 = t3, t3 = B), e3 < this.start && (this.start = e3), t3 > this.end && (this.end = t3);
          }
          markAllDirty() {
            this.markRangeDirty(0, this._bufferService.rows - 1);
          }
        };
        function E(e3) {
          return 0 <= e3 && e3 < 256;
        }
        A = s2([r2(0, f.IBufferService)], A);
      }, 501(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.IDecorationService = t2.IUnicodeService = t2.IOscLinkService = t2.IOptionsService = t2.ILogService = t2.LogLevelEnum = t2.IInstantiationService = t2.ICharsetService = t2.ICoreService = t2.IMouseStateService = t2.IBufferService = void 0;
        const s2 = i2(201);
        var r2;
        t2.IBufferService = (0, s2.createDecorator)("BufferService"), t2.IMouseStateService = (0, s2.createDecorator)("MouseStateService"), t2.ICoreService = (0, s2.createDecorator)("CoreService"), t2.ICharsetService = (0, s2.createDecorator)("CharsetService"), t2.IInstantiationService = (0, s2.createDecorator)("InstantiationService"), (function(e3) {
          e3[e3.TRACE = 0] = "TRACE", e3[e3.DEBUG = 1] = "DEBUG", e3[e3.INFO = 2] = "INFO", e3[e3.WARN = 3] = "WARN", e3[e3.ERROR = 4] = "ERROR", e3[e3.OFF = 5] = "OFF";
        })(r2 || (t2.LogLevelEnum = r2 = {})), t2.ILogService = (0, s2.createDecorator)("LogService"), t2.IOptionsService = (0, s2.createDecorator)("OptionsService"), t2.IOscLinkService = (0, s2.createDecorator)("OscLinkService"), t2.IUnicodeService = (0, s2.createDecorator)("UnicodeService"), t2.IDecorationService = (0, s2.createDecorator)("DecorationService");
      }, 562(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.WriteBuffer = void 0;
        const s2 = i2(812), r2 = i2(636);
        class n2 extends s2.Disposable {
          _action;
          _writeBuffer = [];
          _callbacks = [];
          _pendingData = 0;
          _bufferOffset = 0;
          _isSyncWriting = false;
          _syncCalls = 0;
          _didUserInput = false;
          _onWriteParsed = this._register(new r2.Emitter());
          onWriteParsed = this._onWriteParsed.event;
          constructor(e3) {
            super(), this._action = e3;
          }
          handleUserInput() {
            this._didUserInput = true;
          }
          flushSync() {
            if (this._isSyncWriting) return;
            let e3;
            for (this._isSyncWriting = true; e3 = this._writeBuffer.shift(); ) {
              this._action(e3);
              const t3 = this._callbacks.shift();
              t3 && t3();
            }
            this._pendingData = 0, this._bufferOffset = 2147483647, this._writeBuffer.length = 0, this._callbacks.length = 0, this._isSyncWriting = false;
          }
          writeSync(e3, t3) {
            if (void 0 !== t3 && this._syncCalls > t3) return void (this._syncCalls = 0);
            if (this._pendingData += e3.length, this._writeBuffer.push(e3), this._callbacks.push(void 0), this._syncCalls++, this._isSyncWriting) return;
            let i3;
            for (this._isSyncWriting = true; i3 = this._writeBuffer.shift(); ) {
              this._action(i3);
              const e4 = this._callbacks.shift();
              e4 && e4();
            }
            this._pendingData = 0, this._bufferOffset = 2147483647, this._isSyncWriting = false, this._syncCalls = 0;
          }
          write(e3, t3) {
            if (this._pendingData > 5e7) throw new Error("write data discarded, use flow control to avoid losing data");
            if (!this._writeBuffer.length) {
              if (this._bufferOffset = 0, this._didUserInput) return this._didUserInput = false, this._pendingData += e3.length, this._writeBuffer.push(e3), this._callbacks.push(t3), void this._innerWrite();
              setTimeout(() => this._innerWrite());
            }
            this._pendingData += e3.length, this._writeBuffer.push(e3), this._callbacks.push(t3);
          }
          _innerWrite(e3 = 0, t3 = true) {
            const i3 = e3 || performance.now();
            for (; this._writeBuffer.length > this._bufferOffset; ) {
              const e4 = this._writeBuffer[this._bufferOffset], s3 = this._action(e4, t3);
              if (s3) {
                const e5 = (e6) => performance.now() - i3 >= 12 ? setTimeout(() => this._innerWrite(0, e6)) : this._innerWrite(i3, e6);
                return void s3.catch((e6) => (queueMicrotask(() => {
                  throw e6;
                }), Promise.resolve(false))).then(e5);
              }
              const r3 = this._callbacks[this._bufferOffset];
              if (r3 && r3(), this._bufferOffset++, this._pendingData -= e4.length, performance.now() - i3 >= 12) break;
            }
            this._writeBuffer.length > this._bufferOffset ? (this._bufferOffset > 50 && (this._writeBuffer = this._writeBuffer.slice(this._bufferOffset), this._callbacks = this._callbacks.slice(this._bufferOffset), this._bufferOffset = 0), setTimeout(() => this._innerWrite())) : (this._writeBuffer.length = 0, this._callbacks.length = 0, this._pendingData = 0, this._bufferOffset = 0), this._onWriteParsed.fire();
          }
        }
        t2.WriteBuffer = n2;
      }, 607(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.ApcHandler = t2.ApcParser = void 0;
        const s2 = i2(726), r2 = [];
        t2.ApcParser = class {
          _handlers = /* @__PURE__ */ Object.create(null);
          _active = r2;
          _ident = 0;
          _handlerFb = () => {
          };
          _stack = { paused: false, loopPosition: 0, fallThrough: false };
          registerHandler(e3, t3) {
            this._handlers[e3] ??= [];
            const i3 = this._handlers[e3];
            return i3.push(t3), { dispose: () => {
              const e4 = i3.indexOf(t3);
              -1 !== e4 && i3.splice(e4, 1);
            } };
          }
          clearHandler(e3) {
            this._handlers[e3] && delete this._handlers[e3];
          }
          setHandlerFallback(e3) {
            this._handlerFb = e3;
          }
          dispose() {
            this._handlers = /* @__PURE__ */ Object.create(null), this._handlerFb = () => {
            }, this._active = r2;
          }
          reset() {
            if (this._active.length) for (let e3 = this._stack.paused ? this._stack.loopPosition - 1 : this._active.length - 1; e3 >= 0; --e3) this._active[e3].end(false);
            this._stack.paused = false, this._active = r2, this._ident = 0;
          }
          start(e3) {
            if (this.reset(), this._ident = e3, this._active = this._handlers[e3] || r2, this._active.length) for (let e4 = this._active.length - 1; e4 >= 0; e4--) this._active[e4].start();
            else this._handlerFb(this._ident, "START");
          }
          put(e3, t3, i3) {
            if (this._active.length) for (let s3 = this._active.length - 1; s3 >= 0; s3--) this._active[s3].put(e3, t3, i3);
            else this._handlerFb(this._ident, "PUT", (0, s2.utf32ToString)(e3, t3, i3));
          }
          end(e3, t3 = true) {
            if (this._active.length) {
              let i3 = false, s3 = this._active.length - 1, r3 = false;
              if (this._stack.paused && (s3 = this._stack.loopPosition - 1, i3 = t3, r3 = this._stack.fallThrough, this._stack.paused = false), !r3 && false === i3) {
                for (; s3 >= 0 && (i3 = this._active[s3].end(e3), true !== i3); s3--) if (i3 instanceof Promise) return this._stack.paused = true, this._stack.loopPosition = s3, this._stack.fallThrough = false, i3;
                s3--;
              }
              for (; s3 >= 0; s3--) if (i3 = this._active[s3].end(false), i3 instanceof Promise) return this._stack.paused = true, this._stack.loopPosition = s3, this._stack.fallThrough = true, i3;
            } else this._handlerFb(this._ident, "END", e3);
            this._active = r2, this._ident = 0;
          }
        };
        class n2 {
          _handler;
          static _payloadLimit = 1e7;
          _data = "";
          _hitLimit = false;
          constructor(e3) {
            this._handler = e3;
          }
          start() {
            this._data = "", this._hitLimit = false;
          }
          put(e3, t3, i3) {
            this._hitLimit || (this._data += (0, s2.utf32ToString)(e3, t3, i3), this._data.length > n2._payloadLimit && (this._data = "", this._hitLimit = true));
          }
          end(e3) {
            let t3 = false;
            if (this._hitLimit) t3 = false;
            else if (e3 && (t3 = this._handler(this._data), t3 instanceof Promise)) return t3.then((e4) => (this._data = "", this._hitLimit = false, e4));
            return this._data = "", this._hitLimit = false, t3;
          }
        }
        t2.ApcHandler = n2;
      }, 636(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.EventUtils = t2.Emitter = void 0;
        const s2 = i2(812);
        var r2;
        t2.Emitter = class {
          _listeners = [];
          _disposed = false;
          _event;
          get event() {
            return this._event || (this._event = (e3, t3, i3) => {
              if (this._disposed) return (0, s2.toDisposable)(() => {
              });
              const r3 = { fn: e3, thisArgs: t3 };
              this._listeners.push(r3);
              const n2 = (0, s2.toDisposable)(() => {
                const e4 = this._listeners.indexOf(r3);
                -1 !== e4 && this._listeners.splice(e4, 1);
              });
              return i3 && (Array.isArray(i3) ? i3.push(n2) : i3.add(n2)), n2;
            }), this._event;
          }
          fire(e3) {
            if (!this._disposed) switch (this._listeners.length) {
              case 0:
                return;
              case 1: {
                const { fn: t3, thisArgs: i3 } = this._listeners[0];
                return void t3.call(i3, e3);
              }
              default: {
                const t3 = this._listeners.slice();
                for (const { fn: i3, thisArgs: s3 } of t3) i3.call(s3, e3);
              }
            }
          }
          dispose() {
            this._disposed || (this._disposed = true, this._listeners.length = 0);
          }
        }, (function(e3) {
          e3.forward = function(e4, t3) {
            return e4((e5) => t3.fire(e5));
          }, e3.map = function(e4, t3) {
            return (i3, s3, r3) => e4((e5) => i3.call(s3, t3(e5)), void 0, r3);
          }, e3.any = function(...e4) {
            return (t3, i3, r3) => {
              const n2 = new s2.DisposableStore();
              for (const s3 of e4) n2.add(s3((e5) => t3.call(i3, e5)));
              return r3 && (Array.isArray(r3) ? r3.push(n2) : r3.add(n2)), n2;
            };
          }, e3.runAndSubscribe = function(e4, t3, i3) {
            return t3(i3), e4((e5) => t3(e5));
          };
        })(r2 || (t2.EventUtils = r2 = {}));
      }, 639(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.CircularList = void 0;
        const s2 = i2(812), r2 = i2(636);
        class n2 extends s2.Disposable {
          _maxLength;
          _array;
          _startIndex;
          _length;
          onDeleteEmitter = this._register(new r2.Emitter());
          onDelete = this.onDeleteEmitter.event;
          onInsertEmitter = this._register(new r2.Emitter());
          onInsert = this.onInsertEmitter.event;
          onTrimEmitter = this._register(new r2.Emitter());
          onTrim = this.onTrimEmitter.event;
          constructor(e3) {
            super(), this._maxLength = e3, this._array = new Array(this._maxLength), this._startIndex = 0, this._length = 0;
          }
          get maxLength() {
            return this._maxLength;
          }
          set maxLength(e3) {
            if (this._maxLength === e3) return;
            const t3 = new Array(e3);
            for (let i3 = 0; i3 < Math.min(e3, this.length); i3++) t3[i3] = this._array[this._getCyclicIndex(i3)];
            this._array = t3, this._maxLength = e3, this._startIndex = 0;
          }
          get length() {
            return this._length;
          }
          set length(e3) {
            if (e3 > this._length) for (let t3 = this._length; t3 < e3; t3++) this._array[t3] = void 0;
            this._length = e3;
          }
          get(e3) {
            return this._array[this._getCyclicIndex(e3)];
          }
          set(e3, t3) {
            this._array[this._getCyclicIndex(e3)] = t3;
          }
          push(e3) {
            this._array[this._getCyclicIndex(this._length)] = e3, this._length === this._maxLength ? (this._startIndex = ++this._startIndex % this._maxLength, this.onTrimEmitter.fire(1)) : this._length++;
          }
          recycle() {
            if (this._length !== this._maxLength) throw new Error("Can only recycle when the buffer is full");
            return this._startIndex = ++this._startIndex % this._maxLength, this.onTrimEmitter.fire(1), this._array[this._getCyclicIndex(this._length - 1)];
          }
          get isFull() {
            return this._length === this._maxLength;
          }
          pop() {
            return this._array[this._getCyclicIndex(this._length-- - 1)];
          }
          splice(e3, t3, ...i3) {
            if (t3) {
              for (let i4 = e3; i4 < this._length - t3; i4++) this._array[this._getCyclicIndex(i4)] = this._array[this._getCyclicIndex(i4 + t3)];
              this._length -= t3, this.onDeleteEmitter.fire({ index: e3, amount: t3 });
            }
            for (let t4 = this._length - 1; t4 >= e3; t4--) this._array[this._getCyclicIndex(t4 + i3.length)] = this._array[this._getCyclicIndex(t4)];
            for (let t4 = 0; t4 < i3.length; t4++) this._array[this._getCyclicIndex(e3 + t4)] = i3[t4];
            if (i3.length && this.onInsertEmitter.fire({ index: e3, amount: i3.length }), this._length + i3.length > this._maxLength) {
              const e4 = this._length + i3.length - this._maxLength;
              this._startIndex += e4, this._length = this._maxLength, this.onTrimEmitter.fire(e4);
            } else this._length += i3.length;
          }
          trimStart(e3) {
            e3 > this._length && (e3 = this._length), this._startIndex += e3, this._length -= e3, this.onTrimEmitter.fire(e3);
          }
          shiftElements(e3, t3, i3) {
            if (!(t3 <= 0)) {
              if (e3 < 0 || e3 >= this._length) throw new Error("start argument out of range");
              if (e3 + i3 < 0) throw new Error("Cannot shift elements in list beyond index 0");
              if (i3 > 0) {
                for (let s4 = t3 - 1; s4 >= 0; s4--) this.set(e3 + s4 + i3, this.get(e3 + s4));
                const s3 = e3 + t3 + i3 - this._length;
                if (s3 > 0) for (this._length += s3; this._length > this._maxLength; ) this._length--, this._startIndex++, this.onTrimEmitter.fire(1);
              } else for (let s3 = 0; s3 < t3; s3++) this.set(e3 + s3 + i3, this.get(e3 + s3));
            }
          }
          _getCyclicIndex(e3) {
            return (this._startIndex + e3) % this._maxLength;
          }
        }
        t2.CircularList = n2;
      }, 640(e2, t2, i2) {
        var s2 = this && this.__decorate || function(e3, t3, i3, s3) {
          var r3, n3 = arguments.length, a2 = n3 < 3 ? t3 : null === s3 ? s3 = Object.getOwnPropertyDescriptor(t3, i3) : s3;
          if ("object" == typeof Reflect && "function" == typeof Reflect.decorate) a2 = Reflect.decorate(e3, t3, i3, s3);
          else for (var o2 = e3.length - 1; o2 >= 0; o2--) (r3 = e3[o2]) && (a2 = (n3 < 3 ? r3(a2) : n3 > 3 ? r3(t3, i3, a2) : r3(t3, i3)) || a2);
          return n3 > 3 && a2 && Object.defineProperty(t3, i3, a2), a2;
        }, r2 = this && this.__param || function(e3, t3) {
          return function(i3, s3) {
            t3(i3, s3, e3);
          };
        };
        Object.defineProperty(t2, "__esModule", { value: true }), t2.BufferService = void 0;
        const n2 = i2(812), a = i2(478), o = i2(501), h = i2(636);
        let c = class extends n2.Disposable {
          serviceBrand;
          cols;
          rows;
          buffers;
          isUserScrolling = false;
          _onResize = this._register(new h.Emitter());
          onResize = this._onResize.event;
          _onScroll = this._register(new h.Emitter());
          onScroll = this._onScroll.event;
          get buffer() {
            return this.buffers.active;
          }
          _cachedBlankLine;
          constructor(e3, t3) {
            super(), this.cols = Math.max(e3.rawOptions.cols || 0, 2), this.rows = Math.max(e3.rawOptions.rows || 0, 1), this.buffers = this._register(new a.BufferSet(e3, this, t3)), this._register(this.buffers.onBufferActivate((e4) => {
              this._onScroll.fire(e4.activeBuffer.ydisp);
            }));
          }
          resize(e3, t3) {
            const i3 = this.cols !== e3, s3 = this.rows !== t3;
            this.cols = e3, this.rows = t3, this.buffers.resize(e3, t3), this._onResize.fire({ cols: e3, rows: t3, colsChanged: i3, rowsChanged: s3 });
          }
          reset() {
            this.buffers.reset(), this.isUserScrolling = false;
          }
          scroll(e3, t3 = false) {
            const i3 = this.buffer;
            let s3;
            s3 = this._cachedBlankLine, s3 && s3.length === this.cols && s3.getFg(0) === e3.fg && s3.getBg(0) === e3.bg || (s3 = i3.getBlankLine(e3, t3), this._cachedBlankLine = s3), s3.isWrapped = t3;
            const r3 = i3.ybase + i3.scrollTop, n3 = i3.ybase + i3.scrollBottom;
            if (0 === i3.scrollTop) {
              const e4 = i3.lines.isFull;
              n3 === i3.lines.length - 1 ? e4 ? i3.lines.recycle().copyFrom(s3) : i3.lines.push(s3.clone()) : i3.lines.splice(n3 + 1, 0, s3.clone()), e4 ? this.isUserScrolling && (i3.ydisp = Math.max(i3.ydisp - 1, 0)) : (i3.ybase++, this.isUserScrolling || i3.ydisp++);
            } else {
              const e4 = n3 - r3 + 1;
              i3.lines.shiftElements(r3 + 1, e4 - 1, -1), i3.lines.set(n3, s3.clone());
            }
            this.isUserScrolling || (i3.ydisp = i3.ybase), this._onScroll.fire(i3.ydisp);
          }
          scrollLines(e3, t3) {
            const i3 = this.buffer;
            if (e3 < 0) {
              if (0 === i3.ydisp) return;
              this.isUserScrolling = true;
            } else e3 + i3.ydisp >= i3.ybase && (this.isUserScrolling = false);
            const s3 = i3.ydisp;
            i3.ydisp = Math.max(Math.min(i3.ydisp + e3, i3.ybase), 0), s3 !== i3.ydisp && (t3 || this._onScroll.fire(i3.ydisp));
          }
        };
        t2.BufferService = c, t2.BufferService = c = s2([r2(0, o.IOptionsService), r2(1, o.ILogService)], c);
      }, 693(e2, t2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.parseColor = function(e3) {
          if (!e3) return;
          let t3 = e3.toLowerCase();
          if (t3.startsWith("rgb:")) {
            t3 = t3.slice(4);
            const e4 = i2.exec(t3);
            if (e4) {
              const t4 = e4[1] ? 15 : e4[4] ? 255 : e4[7] ? 4095 : 65535;
              return [Math.round(parseInt(e4[1] || e4[4] || e4[7] || e4[10], 16) / t4 * 255), Math.round(parseInt(e4[2] || e4[5] || e4[8] || e4[11], 16) / t4 * 255), Math.round(parseInt(e4[3] || e4[6] || e4[9] || e4[12], 16) / t4 * 255)];
            }
          } else if (t3.startsWith("#") && (t3 = t3.slice(1), s2.exec(t3) && [3, 6, 9, 12].includes(t3.length))) {
            const e4 = t3.length / 3, i3 = [0, 0, 0];
            for (let s3 = 0; s3 < 3; ++s3) {
              const r3 = parseInt(t3.slice(e4 * s3, e4 * s3 + e4), 16);
              i3[s3] = 1 === e4 ? r3 << 4 : 2 === e4 ? r3 : 3 === e4 ? r3 >> 4 : r3 >> 8;
            }
            return i3;
          }
        }, t2.toRgbString = function(e3, t3 = 16) {
          const [i3, s3, n2] = e3;
          return `rgb:${r2(i3, t3)}/${r2(s3, t3)}/${r2(n2, t3)}`;
        };
        const i2 = /^([\da-f])\/([\da-f])\/([\da-f])$|^([\da-f]{2})\/([\da-f]{2})\/([\da-f]{2})$|^([\da-f]{3})\/([\da-f]{3})\/([\da-f]{3})$|^([\da-f]{4})\/([\da-f]{4})\/([\da-f]{4})$/, s2 = /^[\da-f]+$/;
        function r2(e3, t3) {
          const i3 = e3.toString(16), s3 = i3.length < 2 ? "0" + i3 : i3;
          switch (t3) {
            case 4:
              return i3[0];
            case 8:
              return s3;
            case 12:
              return (s3 + s3).slice(0, 3);
            default:
              return s3 + s3;
          }
        }
      }, 701(e2, t2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.isChromeOS = t2.isLinux = t2.isWindows = t2.isMac = t2.isSafari = t2.isLegacyEdge = t2.isChrome = t2.isFirefox = t2.isNode = void 0, t2.getZoomFactor = function(e3) {
          return 1;
        }, t2.getSafariVersion = function() {
          if (!t2.isSafari) return 0;
          const e3 = i2.match(/Version\/(\d+)/);
          return null === e3 || e3.length < 2 ? 0 : parseInt(e3[1]);
        }, t2.isNode = !("undefined" == typeof process || !("title" in process) || "undefined" != typeof navigator && !navigator.userAgent.startsWith("Node.js/"));
        const i2 = t2.isNode ? "node" : navigator.userAgent, s2 = t2.isNode ? "node" : navigator.platform;
        t2.isFirefox = i2.includes("Firefox"), t2.isChrome = i2.includes("Chrome"), t2.isLegacyEdge = i2.includes("Edge"), t2.isSafari = /^((?!chrome|android).)*safari/i.test(i2), t2.isMac = ["Macintosh", "MacIntel", "MacPPC", "Mac68K"].includes(s2), t2.isWindows = ["Windows", "Win16", "Win32", "WinCE"].includes(s2), t2.isLinux = s2.indexOf("Linux") >= 0, t2.isChromeOS = /\bCrOS\b/.test(i2);
      }, 717(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.EscapeSequenceParser = t2.VT500_TRANSITION_TABLE = t2.TransitionTable = void 0;
        const s2 = i2(812), r2 = i2(262), n2 = i2(346), a = i2(823), o = i2(607);
        class h {
          table;
          constructor(e3) {
            this.table = new Uint16Array(e3);
          }
          setDefault(e3, t3) {
            this.table.fill(e3 << 8 | t3);
          }
          add(e3, t3, i3, s3) {
            this.table[t3 << 8 | e3] = i3 << 8 | s3;
          }
          addMany(e3, t3, i3, s3) {
            for (let r3 = 0; r3 < e3.length; r3++) this.table[t3 << 8 | e3[r3]] = i3 << 8 | s3;
          }
        }
        t2.TransitionTable = h;
        const c = 160;
        t2.VT500_TRANSITION_TABLE = (function() {
          const e3 = new h(4257), t3 = Array.apply(null, Array(256)).map((e4, t4) => t4), i3 = (e4, i4) => t3.slice(e4, i4), s3 = i3(32, 127), r3 = i3(0, 24);
          r3.push(25), r3.push.apply(r3, i3(28, 32));
          const n3 = i3(0, 17);
          e3.setDefault(1, 0), e3.addMany(s3, 0, 2, 0);
          for (const t4 of n3) e3.addMany([24, 26, 153, 154], t4, 3, 0), e3.addMany(i3(128, 144), t4, 3, 0), e3.addMany(i3(144, 152), t4, 3, 0), e3.add(156, t4, 0, 0), e3.add(27, t4, 11, 1), e3.add(157, t4, 4, 8), e3.addMany([152, 158], t4, 0, 7), e3.add(159, t4, 11, 14), e3.add(155, t4, 11, 3), e3.add(144, t4, 11, 9);
          return e3.addMany(r3, 0, 3, 0), e3.addMany(r3, 1, 3, 1), e3.add(127, 1, 0, 1), e3.addMany(r3, 8, 0, 8), e3.addMany(r3, 3, 3, 3), e3.add(127, 3, 0, 3), e3.addMany(r3, 4, 3, 4), e3.add(127, 4, 0, 4), e3.addMany(r3, 6, 3, 6), e3.addMany(r3, 5, 3, 5), e3.add(127, 5, 0, 5), e3.addMany(r3, 2, 3, 2), e3.add(127, 2, 0, 2), e3.add(93, 1, 4, 8), e3.addMany(s3, 8, 5, 8), e3.add(127, 8, 5, 8), e3.addMany([156, 27, 24, 26, 7], 8, 6, 0), e3.addMany(i3(28, 32), 8, 0, 8), e3.addMany([88, 94], 1, 0, 7), e3.addMany(s3, 7, 0, 7), e3.addMany(r3, 7, 0, 7), e3.add(156, 7, 0, 0), e3.add(127, 7, 0, 7), e3.add(95, 1, 11, 14), e3.addMany(r3, 14, 0, 14), e3.add(127, 14, 0, 14), e3.addMany(i3(32, 48), 14, 9, 15), e3.addMany(i3(48, 127), 14, 15, 16), e3.addMany(i3(48, 127), 15, 15, 16), e3.addMany(r3, 15, 0, 15), e3.addMany(i3(32, 48), 15, 9, 15), e3.add(127, 15, 0, 15), e3.addMany(s3, 16, 16, 16), e3.addMany(r3, 16, 0, 16), e3.addMany(i3(8, 14), 16, 16, 16), e3.add(127, 16, 0, 16), e3.addMany([27, 156, 24, 26], 16, 17, 0), e3.add(91, 1, 11, 3), e3.addMany(i3(64, 127), 3, 7, 0), e3.addMany(i3(48, 60), 3, 8, 4), e3.addMany([60, 61, 62, 63], 3, 9, 4), e3.addMany(i3(48, 60), 4, 8, 4), e3.addMany(i3(64, 127), 4, 7, 0), e3.addMany([60, 61, 62, 63], 4, 0, 6), e3.addMany(i3(32, 64), 6, 0, 6), e3.add(127, 6, 0, 6), e3.addMany(i3(64, 127), 6, 0, 0), e3.addMany(i3(32, 48), 3, 9, 5), e3.addMany(i3(32, 48), 5, 9, 5), e3.addMany(i3(48, 64), 5, 0, 6), e3.addMany(i3(64, 127), 5, 7, 0), e3.addMany(i3(32, 48), 4, 9, 5), e3.addMany(i3(32, 48), 1, 9, 2), e3.addMany(i3(32, 48), 2, 9, 2), e3.addMany(i3(48, 127), 2, 10, 0), e3.addMany(i3(48, 80), 1, 10, 0), e3.addMany(i3(81, 88), 1, 10, 0), e3.addMany([89, 90, 92], 1, 10, 0), e3.addMany(i3(96, 127), 1, 10, 0), e3.add(80, 1, 11, 9), e3.addMany(r3, 9, 0, 9), e3.add(127, 9, 0, 9), e3.addMany(i3(32, 48), 9, 9, 12), e3.addMany(i3(48, 60), 9, 8, 10), e3.addMany([60, 61, 62, 63], 9, 9, 10), e3.addMany(r3, 11, 0, 11), e3.addMany(i3(32, 128), 11, 0, 11), e3.addMany(r3, 10, 0, 10), e3.add(127, 10, 0, 10), e3.addMany(i3(48, 60), 10, 8, 10), e3.addMany([60, 61, 62, 63], 10, 0, 11), e3.addMany(i3(32, 48), 10, 9, 12), e3.addMany(r3, 12, 0, 12), e3.add(127, 12, 0, 12), e3.addMany(i3(32, 48), 12, 9, 12), e3.addMany(i3(48, 64), 12, 0, 11), e3.addMany(i3(64, 127), 12, 12, 13), e3.addMany(i3(64, 127), 10, 12, 13), e3.addMany(i3(64, 127), 9, 12, 13), e3.addMany(r3, 13, 13, 13), e3.addMany(s3, 13, 13, 13), e3.add(127, 13, 0, 13), e3.addMany([27, 156, 24, 26], 13, 14, 0), e3.add(c, 0, 2, 0), e3.add(c, 8, 5, 8), e3.add(c, 6, 0, 6), e3.add(c, 11, 0, 11), e3.add(c, 13, 13, 13), e3.add(c, 16, 16, 16), e3;
        })();
        class l extends s2.Disposable {
          _transitions;
          initialState;
          currentState;
          precedingJoinState;
          _params;
          _collect;
          _printHandler;
          _executeHandlers;
          _executeHandlersArr;
          _csiHandlers;
          _escHandlers;
          _oscParser;
          _dcsParser;
          _apcParser;
          _errorHandler;
          _printHandlerFb;
          _executeHandlerFb;
          _csiHandlerFb;
          _escHandlerFb;
          _errorHandlerFb;
          _parseStack = { state: 0, handlers: [], handlerPos: 0, transition: 0, chunkPos: 0 };
          constructor(e3 = t2.VT500_TRANSITION_TABLE) {
            super(), this._transitions = e3, this.initialState = 0, this.currentState = this.initialState, this._params = new r2.Params(), this._params.addParam(0), this._collect = 0, this.precedingJoinState = 0, this._printHandlerFb = (e4, t3, i3) => {
            }, this._executeHandlerFb = (e4) => {
            }, this._csiHandlerFb = (e4, t3) => {
            }, this._escHandlerFb = (e4) => {
            }, this._errorHandlerFb = (e4) => e4, this._printHandler = this._printHandlerFb, this._executeHandlers = /* @__PURE__ */ Object.create(null), this._executeHandlersArr = new Array(24).fill(void 0), this._csiHandlers = /* @__PURE__ */ Object.create(null), this._escHandlers = /* @__PURE__ */ Object.create(null), this._register((0, s2.toDisposable)(() => {
              this._csiHandlers = /* @__PURE__ */ Object.create(null), this._executeHandlers = /* @__PURE__ */ Object.create(null), this._executeHandlersArr = new Array(24).fill(void 0), this._escHandlers = /* @__PURE__ */ Object.create(null);
            })), this._oscParser = this._register(new n2.OscParser()), this._dcsParser = this._register(new a.DcsParser()), this._apcParser = this._register(new o.ApcParser()), this._errorHandler = this._errorHandlerFb, this.registerEscHandler({ final: "\\" }, () => true);
          }
          _identifier(e3, t3 = [64, 126]) {
            let i3 = 0;
            if (e3.prefix) {
              if (e3.prefix.length > 1) throw new Error("only one byte as prefix supported");
              if (i3 = e3.prefix.charCodeAt(0), i3 && 60 > i3 || i3 > 63) throw new Error("prefix must be in range 0x3c .. 0x3f");
            }
            if (e3.intermediates) {
              if (e3.intermediates.length > 2) throw new Error("only two bytes as intermediates are supported");
              for (let t4 = 0; t4 < e3.intermediates.length; ++t4) {
                const s4 = e3.intermediates.charCodeAt(t4);
                if (32 > s4 || s4 > 47) throw new Error("intermediate must be in range 0x20 .. 0x2f");
                i3 <<= 8, i3 |= s4;
              }
            }
            if (1 !== e3.final.length) throw new Error("final must be a single byte");
            const s3 = e3.final.charCodeAt(0);
            if (t3[0] > s3 || s3 > t3[1]) throw new Error(`final must be in range ${t3[0]} .. ${t3[1]}`);
            return i3 <<= 8, i3 |= s3, i3;
          }
          identToString(e3) {
            const t3 = [];
            for (; e3; ) t3.push(String.fromCharCode(255 & e3)), e3 >>= 8;
            return t3.reverse().join("");
          }
          setPrintHandler(e3) {
            this._printHandler = e3;
          }
          clearPrintHandler() {
            this._printHandler = this._printHandlerFb;
          }
          registerEscHandler(e3, t3) {
            const i3 = this._identifier(e3, [48, 126]);
            this._escHandlers[i3] ??= [];
            const s3 = this._escHandlers[i3];
            return s3.push(t3), { dispose: () => {
              const e4 = s3.indexOf(t3);
              -1 !== e4 && s3.splice(e4, 1);
            } };
          }
          clearEscHandler(e3) {
            this._escHandlers[this._identifier(e3, [48, 126])] && delete this._escHandlers[this._identifier(e3, [48, 126])];
          }
          setEscHandlerFallback(e3) {
            this._escHandlerFb = e3;
          }
          setExecuteHandler(e3, t3) {
            const i3 = e3.charCodeAt(0);
            this._executeHandlers[i3] = t3, i3 < 24 && (this._executeHandlersArr[i3] = t3);
          }
          clearExecuteHandler(e3) {
            const t3 = e3.charCodeAt(0);
            this._executeHandlers[t3] && delete this._executeHandlers[t3], t3 < 24 && (this._executeHandlersArr[t3] = void 0);
          }
          setExecuteHandlerFallback(e3) {
            this._executeHandlerFb = e3;
          }
          registerCsiHandler(e3, t3) {
            const i3 = this._identifier(e3);
            this._csiHandlers[i3] ??= [];
            const s3 = this._csiHandlers[i3];
            return s3.push(t3), { dispose: () => {
              const e4 = s3.indexOf(t3);
              -1 !== e4 && s3.splice(e4, 1);
            } };
          }
          clearCsiHandler(e3) {
            this._csiHandlers[this._identifier(e3)] && delete this._csiHandlers[this._identifier(e3)];
          }
          setCsiHandlerFallback(e3) {
            this._csiHandlerFb = e3;
          }
          registerDcsHandler(e3, t3) {
            return this._dcsParser.registerHandler(this._identifier(e3), t3);
          }
          clearDcsHandler(e3) {
            this._dcsParser.clearHandler(this._identifier(e3));
          }
          setDcsHandlerFallback(e3) {
            this._dcsParser.setHandlerFallback(e3);
          }
          registerOscHandler(e3, t3) {
            return this._oscParser.registerHandler(e3, t3);
          }
          clearOscHandler(e3) {
            this._oscParser.clearHandler(e3);
          }
          setOscHandlerFallback(e3) {
            this._oscParser.setHandlerFallback(e3);
          }
          registerApcHandler(e3, t3) {
            return e3.prefix = void 0, this._apcParser.registerHandler(this._identifier(e3, [48, 126]), t3);
          }
          clearApcHandler(e3) {
            e3.prefix = void 0, this._apcParser.clearHandler(this._identifier(e3, [48, 126]));
          }
          setApcHandlerFallback(e3) {
            this._apcParser.setHandlerFallback(e3);
          }
          setErrorHandler(e3) {
            this._errorHandler = e3;
          }
          clearErrorHandler() {
            this._errorHandler = this._errorHandlerFb;
          }
          reset() {
            this.currentState = this.initialState, this._oscParser.reset(), this._dcsParser.reset(), this._apcParser.reset(), this._params.resetZdm(), this._collect = 0, this.precedingJoinState = 0, 0 !== this._parseStack.state && (this._parseStack.state = 2, this._parseStack.handlers = []);
          }
          _preserveStack(e3, t3, i3, s3, r3) {
            this._parseStack.state = e3, this._parseStack.handlers = t3, this._parseStack.handlerPos = i3, this._parseStack.transition = s3, this._parseStack.chunkPos = r3;
          }
          parse(e3, t3, i3) {
            let s3, r3 = 0, n3 = 0, a2 = 0;
            if (this._parseStack.state) if (2 === this._parseStack.state) this._parseStack.state = 0, a2 = this._parseStack.chunkPos + 1;
            else {
              if (void 0 === i3 || 1 === this._parseStack.state) throw this._parseStack.state = 1, new Error("improper continuation due to previous async handler, giving up parsing");
              const t4 = this._parseStack.handlers;
              let n4 = this._parseStack.handlerPos - 1;
              switch (this._parseStack.state) {
                case 3:
                  if (false === i3 && n4 > -1) {
                    for (; n4 >= 0 && (s3 = t4[n4](this._params), true !== s3); n4--) if (s3 instanceof Promise) return this._parseStack.handlerPos = n4, s3;
                  }
                  this._parseStack.handlers = [];
                  break;
                case 4:
                  if (false === i3 && n4 > -1) {
                    for (; n4 >= 0 && (s3 = t4[n4](), true !== s3); n4--) if (s3 instanceof Promise) return this._parseStack.handlerPos = n4, s3;
                  }
                  this._parseStack.handlers = [];
                  break;
                case 6:
                  if (r3 = e3[this._parseStack.chunkPos], s3 = this._dcsParser.unhook(24 !== r3 && 26 !== r3, i3), s3) return s3;
                  27 === r3 && (this._parseStack.transition |= 1), this._params.resetZdm(), this._collect = 0;
                  break;
                case 5:
                  if (r3 = e3[this._parseStack.chunkPos], s3 = this._oscParser.end(24 !== r3 && 26 !== r3, i3), s3) return s3;
                  27 === r3 && (this._parseStack.transition |= 1), this._params.resetZdm(), this._collect = 0;
                  break;
                case 7:
                  if (r3 = e3[this._parseStack.chunkPos], s3 = this._apcParser.end(24 !== r3 && 26 !== r3, i3), s3) return s3;
                  27 === r3 && (this._parseStack.transition |= 1), this._params.resetZdm(), this._collect = 0;
              }
              this._parseStack.state = 0, a2 = this._parseStack.chunkPos + 1, this.precedingJoinState = 0, this.currentState = 255 & this._parseStack.transition;
            }
            for (let i4 = a2; i4 < t3; ++i4) if (r3 = e3[i4], r3 < 24 && this.currentState <= 6) (this._executeHandlersArr[r3] ?? this._executeHandlerFb)(r3), this.precedingJoinState = 0;
            else {
              if (27 === r3 && this.currentState < 8 && i4 + 2 < t3 && 91 === e3[i4 + 1]) {
                this._params.resetZdm(), this._collect = 0;
                let r4 = i4 + 2, a3 = e3[r4];
                a3 >= 60 && a3 <= 63 && (this._collect = a3, r4++);
                let o2 = false;
                for (; r4 < t3; r4++) if (a3 = e3[r4], a3 >= 48 && a3 <= 57) this._params.addDigit(a3 - 48);
                else if (59 === a3) this._params.addParam(0);
                else {
                  if (58 !== a3) {
                    if (a3 >= 64 && a3 <= 126) {
                      const e4 = this._csiHandlers[this._collect << 8 | a3];
                      let t4 = e4 ? e4.length - 1 : -1;
                      for (; t4 >= 0 && (s3 = e4[t4](this._params), true !== s3); t4--) if (s3 instanceof Promise) return n3 = 1792, this._preserveStack(3, e4, t4, n3, r4), s3;
                      t4 < 0 && this._csiHandlerFb(this._collect << 8 | a3, this._params), this.precedingJoinState = 0, i4 = r4, this.currentState = 0, o2 = true;
                      break;
                    }
                    break;
                  }
                  this._params.addSubParam(-1);
                }
                o2 || (i4 = r4 - 1, this.currentState = 4);
                continue;
              }
              switch (n3 = this._transitions.table[this.currentState << 8 | (r3 < c ? r3 : c)], n3 >> 8) {
                case 2:
                  let a3 = i4;
                  const o2 = t3 - 4;
                  for (; a3 < o2 && e3[++a3] >= 32 && (e3[a3] <= 126 || e3[a3] >= c) && e3[++a3] >= 32 && (e3[a3] <= 126 || e3[a3] >= c) && e3[++a3] >= 32 && (e3[a3] <= 126 || e3[a3] >= c) && e3[++a3] >= 32 && (e3[a3] <= 126 || e3[a3] >= c); ) ;
                  if (a3 >= o2) for (; a3 < t3 && e3[a3] >= 32 && (e3[a3] <= 126 || e3[a3] >= c); ) a3++;
                  this._printHandler(e3, i4, a3), i4 = a3 - 1;
                  break;
                case 3:
                  this._executeHandlers[r3] ? this._executeHandlers[r3]() : this._executeHandlerFb(r3), this.precedingJoinState = 0;
                  break;
                case 0:
                  break;
                case 1:
                  if (this._errorHandler({ position: i4, code: r3, currentState: this.currentState, collect: this._collect, params: this._params, abort: false }).abort) return;
                  break;
                case 7:
                  const h2 = this._csiHandlers[this._collect << 8 | r3];
                  let l2 = h2 ? h2.length - 1 : -1;
                  for (; l2 >= 0 && (s3 = h2[l2](this._params), true !== s3); l2--) if (s3 instanceof Promise) return this._preserveStack(3, h2, l2, n3, i4), s3;
                  l2 < 0 && this._csiHandlerFb(this._collect << 8 | r3, this._params), this.precedingJoinState = 0;
                  break;
                case 8:
                  do {
                    switch (r3) {
                      case 59:
                        this._params.addParam(0);
                        break;
                      case 58:
                        this._params.addSubParam(-1);
                        break;
                      default:
                        this._params.addDigit(r3 - 48);
                    }
                  } while (++i4 < t3 && (r3 = e3[i4]) > 47 && r3 < 60);
                  i4--;
                  break;
                case 9:
                  this._collect <<= 8, this._collect |= r3;
                  break;
                case 10:
                  const _ = this._escHandlers[this._collect << 8 | r3];
                  let d = _ ? _.length - 1 : -1;
                  for (; d >= 0 && (s3 = _[d](), true !== s3); d--) if (s3 instanceof Promise) return this._preserveStack(4, _, d, n3, i4), s3;
                  d < 0 && this._escHandlerFb(this._collect << 8 | r3), this.precedingJoinState = 0;
                  break;
                case 11:
                  this._params.resetZdm(), this._collect = 0;
                  break;
                case 12:
                  this._dcsParser.hook(this._collect << 8 | r3, this._params);
                  break;
                case 13:
                  for (let s4 = i4 + 1; ; ++s4) if (s4 >= t3 || 24 === (r3 = e3[s4]) || 26 === r3 || 27 === r3 || r3 > 127 && r3 < c) {
                    this._dcsParser.put(e3, i4, s4), i4 = s4 - 1;
                    break;
                  }
                  break;
                case 14:
                  if (s3 = this._dcsParser.unhook(24 !== r3 && 26 !== r3), s3) return this._preserveStack(6, [], 0, n3, i4), s3;
                  27 === r3 && (n3 |= 1), this._params.resetZdm(), this._collect = 0, this.precedingJoinState = 0;
                  break;
                case 4:
                  this._oscParser.start();
                  break;
                case 5:
                  for (let s4 = i4 + 1; ; s4++) if (s4 >= t3 || (r3 = e3[s4]) < 32 || r3 > 127 && r3 < c) {
                    this._oscParser.put(e3, i4, s4), i4 = s4 - 1;
                    break;
                  }
                  break;
                case 6:
                  if (s3 = this._oscParser.end(24 !== r3 && 26 !== r3), s3) return this._preserveStack(5, [], 0, n3, i4), s3;
                  27 === r3 && (n3 |= 1), this._params.resetZdm(), this._collect = 0, this.precedingJoinState = 0;
                  break;
                case 15:
                  this._apcParser.start(this._collect << 8 | r3);
                  break;
                case 16:
                  for (let s4 = i4 + 1; ; ++s4) if (!(s4 < t3 && (e3[s4] >= 32 && e3[s4] < 127 || e3[s4] >= 8 && e3[s4] < 14 || e3[s4] >= c))) {
                    this._apcParser.put(e3, i4, s4), i4 = s4 - 1;
                    break;
                  }
                  break;
                case 17:
                  if (s3 = this._apcParser.end(24 !== r3 && 26 !== r3), s3) return this._preserveStack(7, [], 0, n3, i4), s3;
                  27 === r3 && (n3 |= 1), this._params.resetZdm(), this._collect = 0, this.precedingJoinState = 0;
              }
              this.currentState = 255 & n3;
            }
          }
        }
        t2.EscapeSequenceParser = l;
      }, 726(e2, t2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.Utf8ToUtf32 = t2.StringToUtf32 = void 0, t2.stringFromCodePoint = function(e3) {
          return e3 > 65535 ? (e3 -= 65536, String.fromCharCode(55296 + (e3 >> 10)) + String.fromCharCode(e3 % 1024 + 56320)) : String.fromCharCode(e3);
        }, t2.utf32ToString = function(e3, t3 = 0, i2 = e3.length) {
          let s2 = "";
          for (let r2 = t3; r2 < i2; ++r2) {
            let t4 = e3[r2];
            t4 > 65535 ? (t4 -= 65536, s2 += String.fromCharCode(55296 + (t4 >> 10)) + String.fromCharCode(t4 % 1024 + 56320)) : s2 += String.fromCharCode(t4);
          }
          return s2;
        }, t2.StringToUtf32 = class {
          _interim = 0;
          clear() {
            this._interim = 0;
          }
          decode(e3, t3) {
            const i2 = e3.length;
            if (!i2) return 0;
            let s2 = 0, r2 = 0;
            if (this._interim) {
              const i3 = e3.charCodeAt(r2++);
              56320 <= i3 && i3 <= 57343 ? t3[s2++] = 1024 * (this._interim - 55296) + i3 - 56320 + 65536 : (t3[s2++] = this._interim, t3[s2++] = i3), this._interim = 0;
            }
            for (let n2 = r2; n2 < i2; ++n2) {
              const r3 = e3.charCodeAt(n2);
              if (55296 <= r3 && r3 <= 56319) {
                if (++n2 >= i2) return this._interim = r3, s2;
                const a = e3.charCodeAt(n2);
                56320 <= a && a <= 57343 ? t3[s2++] = 1024 * (r3 - 55296) + a - 56320 + 65536 : (t3[s2++] = r3, t3[s2++] = a);
                continue;
              }
              65279 !== r3 && (t3[s2++] = r3);
            }
            return s2;
          }
        }, t2.Utf8ToUtf32 = class {
          interim = new Uint8Array(3);
          clear() {
            this.interim.fill(0);
          }
          decode(e3, t3) {
            const i2 = e3.length;
            if (!i2) return 0;
            let s2, r2, n2, a, o = 0, h = 0, c = 0;
            if (this.interim[0]) {
              let s3 = false, r3 = this.interim[0];
              r3 &= 192 == (224 & r3) ? 31 : 224 == (240 & r3) ? 15 : 7;
              let n3, a2 = 0;
              for (; (n3 = 63 & this.interim[++a2]) && a2 < 4; ) r3 <<= 6, r3 |= n3;
              const h2 = 192 == (224 & this.interim[0]) ? 2 : 224 == (240 & this.interim[0]) ? 3 : 4, l2 = h2 - a2;
              for (; c < l2; ) {
                if (c >= i2) return 0;
                if (n3 = e3[c++], 128 != (192 & n3)) {
                  c--, s3 = true;
                  break;
                }
                this.interim[a2++] = n3, r3 <<= 6, r3 |= 63 & n3;
              }
              s3 || (2 === h2 ? r3 < 128 ? c-- : t3[o++] = r3 : 3 === h2 ? r3 < 2048 || r3 >= 55296 && r3 <= 57343 || 65279 === r3 || (t3[o++] = r3) : r3 < 65536 || r3 > 1114111 || (t3[o++] = r3)), this.interim.fill(0);
            }
            const l = i2 - 4;
            let _ = c;
            for (; _ < i2; ) {
              for (; !(!(_ < l) || 128 & (s2 = e3[_]) || 128 & (r2 = e3[_ + 1]) || 128 & (n2 = e3[_ + 2]) || 128 & (a = e3[_ + 3])); ) t3[o++] = s2, t3[o++] = r2, t3[o++] = n2, t3[o++] = a, _ += 4;
              if (s2 = e3[_++], s2 < 128) t3[o++] = s2;
              else if (192 == (224 & s2)) {
                if (_ >= i2) return this.interim[0] = s2, o;
                if (r2 = e3[_++], 128 != (192 & r2)) {
                  _--;
                  continue;
                }
                if (h = (31 & s2) << 6 | 63 & r2, h < 128) {
                  _--;
                  continue;
                }
                t3[o++] = h;
              } else if (224 == (240 & s2)) {
                if (_ >= i2) return this.interim[0] = s2, o;
                if (r2 = e3[_++], 128 != (192 & r2)) {
                  _--;
                  continue;
                }
                if (_ >= i2) return this.interim[0] = s2, this.interim[1] = r2, o;
                if (n2 = e3[_++], 128 != (192 & n2)) {
                  _--;
                  continue;
                }
                if (h = (15 & s2) << 12 | (63 & r2) << 6 | 63 & n2, h < 2048 || h >= 55296 && h <= 57343 || 65279 === h) continue;
                t3[o++] = h;
              } else if (240 == (248 & s2)) {
                if (_ >= i2) return this.interim[0] = s2, o;
                if (r2 = e3[_++], 128 != (192 & r2)) {
                  _--;
                  continue;
                }
                if (_ >= i2) return this.interim[0] = s2, this.interim[1] = r2, o;
                if (n2 = e3[_++], 128 != (192 & n2)) {
                  _--;
                  continue;
                }
                if (_ >= i2) return this.interim[0] = s2, this.interim[1] = r2, this.interim[2] = n2, o;
                if (a = e3[_++], 128 != (192 & a)) {
                  _--;
                  continue;
                }
                if (h = (7 & s2) << 18 | (63 & r2) << 12 | (63 & n2) << 6 | 63 & a, h < 65536 || h > 1114111) continue;
                t3[o++] = h;
              }
            }
            return o;
          }
        };
      }, 732(e2, t2) {
        function i2(e3, t3, i3) {
          if (t3 === e3.length - 1) return e3[t3].getTrimmedLength();
          const s2 = !e3[t3].hasContent(i3 - 1) && 1 === e3[t3].getWidth(i3 - 1), r2 = 2 === e3[t3 + 1].getWidth(0);
          return s2 && r2 ? i3 - 1 : i3;
        }
        Object.defineProperty(t2, "__esModule", { value: true }), t2.reflowLargerGetLinesToRemove = function(e3, t3, s2, r2, n2, a) {
          const o = [];
          for (let h = 0; h < e3.length - 1; h++) {
            let c = h, l = e3.get(++c);
            if (!l.isWrapped) continue;
            const _ = [e3.get(h)];
            for (; c < e3.length && l.isWrapped; ) _.push(l), l = e3.get(++c);
            if (!a && r2 >= h && r2 < c) {
              h += _.length - 1;
              continue;
            }
            let d = 0, f = i2(_, d, t3), u = 1, g = 0;
            for (; u < _.length; ) {
              const e4 = i2(_, u, t3), r3 = e4 - g, a2 = s2 - f, o2 = Math.min(r3, a2);
              _[d].copyCellsFrom(_[u], g, f, o2, false), f += o2, f === s2 && (d++, f = 0), g += o2, g === e4 && (u++, g = 0), 0 === f && 0 !== d && 2 === _[d - 1].getWidth(s2 - 1) && (_[d].copyCellsFrom(_[d - 1], s2 - 1, f++, 1, false), _[d - 1].setCell(s2 - 1, n2));
            }
            _[d].replaceCells(f, s2, n2);
            let p = 0;
            for (let e4 = _.length - 1; e4 > 0 && (e4 > d || 0 === _[e4].getTrimmedLength()); e4--) p++;
            p > 0 && (o.push(h + _.length - p), o.push(p)), h += _.length - 1;
          }
          return o;
        }, t2.reflowLargerCreateNewLayout = function(e3, t3) {
          const i3 = [];
          let s2 = 0, r2 = t3[s2], n2 = 0;
          for (let a = 0; a < e3.length; a++) if (r2 === a) {
            const i4 = t3[++s2];
            e3.onDeleteEmitter.fire({ index: a - n2, amount: i4 }), a += i4 - 1, n2 += i4, r2 = t3[++s2];
          } else i3.push(a);
          return { layout: i3, countRemoved: n2 };
        }, t2.reflowLargerApplyNewLayout = function(e3, t3) {
          const i3 = [];
          for (let s2 = 0; s2 < t3.length; s2++) i3.push(e3.get(t3[s2]));
          for (let t4 = 0; t4 < i3.length; t4++) e3.set(t4, i3[t4]);
          e3.length = t3.length;
        }, t2.reflowSmallerGetNewLineLengths = function(e3, t3, s2) {
          const r2 = [], n2 = e3.map((s3, r3) => i2(e3, r3, t3)).reduce((e4, t4) => e4 + t4);
          let a = 0, o = 0, h = 0;
          for (; h < n2; ) {
            if (n2 - h < s2) {
              r2.push(n2 - h);
              break;
            }
            a += s2;
            const c = i2(e3, o, t3);
            a > c && (a -= c, o++);
            const l = 2 === e3[o].getWidth(a - 1);
            l && a--;
            const _ = l ? s2 - 1 : s2;
            r2.push(_), h += _;
          }
          return r2;
        }, t2.getWrappedLineTrimmedLength = i2;
      }, 746(e2, t2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.CharsetService = void 0, t2.CharsetService = class {
          serviceBrand;
          charset;
          glevel = 0;
          _charsets = [];
          get charsets() {
            return this._charsets;
          }
          reset() {
            this.charset = void 0, this._charsets = [], this.glevel = 0;
          }
          setgLevel(e3) {
            this.glevel = e3, this.charset = this._charsets[e3];
          }
          setgCharset(e3, t3) {
            this._charsets[e3] = t3, this.glevel === e3 && (this.charset = t3);
          }
        };
      }, 760(e2, t2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.DEFAULT_CHARSET = t2.CHARSETS = void 0, t2.CHARSETS = {}, t2.DEFAULT_CHARSET = t2.CHARSETS.B, t2.CHARSETS[0] = { "`": "\u25C6", a: "\u2592", b: "\u2409", c: "\u240C", d: "\u240D", e: "\u240A", f: "\xB0", g: "\xB1", h: "\u2424", i: "\u240B", j: "\u2518", k: "\u2510", l: "\u250C", m: "\u2514", n: "\u253C", o: "\u23BA", p: "\u23BB", q: "\u2500", r: "\u23BC", s: "\u23BD", t: "\u251C", u: "\u2524", v: "\u2534", w: "\u252C", x: "\u2502", y: "\u2264", z: "\u2265", "{": "\u03C0", "|": "\u2260", "}": "\xA3", "~": "\xB7" }, t2.CHARSETS.A = { "#": "\xA3" }, t2.CHARSETS.B = void 0, t2.CHARSETS[4] = { "#": "\xA3", "@": "\xBE", "[": "ij", "\\": "\xBD", "]": "|", "{": "\xA8", "|": "f", "}": "\xBC", "~": "\xB4" }, t2.CHARSETS.C = t2.CHARSETS[5] = { "[": "\xC4", "\\": "\xD6", "]": "\xC5", "^": "\xDC", "`": "\xE9", "{": "\xE4", "|": "\xF6", "}": "\xE5", "~": "\xFC" }, t2.CHARSETS.R = { "#": "\xA3", "@": "\xE0", "[": "\xB0", "\\": "\xE7", "]": "\xA7", "{": "\xE9", "|": "\xF9", "}": "\xE8", "~": "\xA8" }, t2.CHARSETS.Q = { "@": "\xE0", "[": "\xE2", "\\": "\xE7", "]": "\xEA", "^": "\xEE", "`": "\xF4", "{": "\xE9", "|": "\xF9", "}": "\xE8", "~": "\xFB" }, t2.CHARSETS.K = { "@": "\xA7", "[": "\xC4", "\\": "\xD6", "]": "\xDC", "{": "\xE4", "|": "\xF6", "}": "\xFC", "~": "\xDF" }, t2.CHARSETS.Y = { "#": "\xA3", "@": "\xA7", "[": "\xB0", "\\": "\xE7", "]": "\xE9", "`": "\xF9", "{": "\xE0", "|": "\xF2", "}": "\xE8", "~": "\xEC" }, t2.CHARSETS.E = t2.CHARSETS[6] = { "@": "\xC4", "[": "\xC6", "\\": "\xD8", "]": "\xC5", "^": "\xDC", "`": "\xE4", "{": "\xE6", "|": "\xF8", "}": "\xE5", "~": "\xFC" }, t2.CHARSETS.Z = { "#": "\xA3", "@": "\xA7", "[": "\xA1", "\\": "\xD1", "]": "\xBF", "{": "\xB0", "|": "\xF1", "}": "\xE7" }, t2.CHARSETS.H = t2.CHARSETS[7] = { "@": "\xC9", "[": "\xC4", "\\": "\xD6", "]": "\xC5", "^": "\xDC", "`": "\xE9", "{": "\xE4", "|": "\xF6", "}": "\xE5", "~": "\xFC" }, t2.CHARSETS["="] = { "#": "\xF9", "@": "\xE0", "[": "\xE9", "\\": "\xE7", "]": "\xEA", "^": "\xEE", _: "\xE8", "`": "\xF4", "{": "\xE4", "|": "\xF6", "}": "\xFC", "~": "\xFB" };
      }, 777(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.CoreTerminal = void 0;
        const s2 = i2(501), r2 = i2(25), n2 = i2(276), a = i2(640), o = i2(56), h = i2(71), c = i2(240), l = i2(415), _ = i2(746), d = i2(882), f = i2(486), u = i2(562), g = i2(811), p = i2(636), v = i2(812);
        let b = false;
        class S extends v.Disposable {
          _instantiationService;
          _bufferService;
          _logService;
          _charsetService;
          _oscLinkService;
          mouseStateService;
          coreService;
          unicodeService;
          optionsService;
          _inputHandler;
          _writeBuffer;
          _windowsWrappingHeuristics = this._register(new v.MutableDisposable());
          _onBinary = this._register(new p.Emitter());
          onBinary = this._onBinary.event;
          _onData = this._register(new p.Emitter());
          onData = this._onData.event;
          _onLineFeed = this._register(new p.Emitter());
          onLineFeed = this._onLineFeed.event;
          _onRender = this._register(new p.Emitter());
          onRender = this._onRender.event;
          _onResize = this._register(new p.Emitter());
          onResize = this._onResize.event;
          _onWriteParsed = this._register(new p.Emitter());
          onWriteParsed = this._onWriteParsed.event;
          _onScrollApi;
          _onScroll = this._register(new p.Emitter());
          get onScroll() {
            return this._onScrollApi || (this._onScrollApi = this._register(new p.Emitter()), this._onScroll.event((e3) => {
              this._onScrollApi?.fire(e3.position);
            })), this._onScrollApi.event;
          }
          get cols() {
            return this._bufferService.cols;
          }
          get rows() {
            return this._bufferService.rows;
          }
          get buffers() {
            return this._bufferService.buffers;
          }
          get options() {
            return this.optionsService.options;
          }
          set options(e3) {
            for (const t3 in e3) this.optionsService.options[t3] = e3[t3];
          }
          constructor(e3) {
            super(), this._instantiationService = new r2.InstantiationService(), this.optionsService = this._register(new o.OptionsService(e3)), this._instantiationService.setService(s2.IOptionsService, this.optionsService), this._logService = this._register(this._instantiationService.createInstance(n2.LogService)), this._instantiationService.setService(s2.ILogService, this._logService), this._bufferService = this._register(this._instantiationService.createInstance(a.BufferService)), this._instantiationService.setService(s2.IBufferService, this._bufferService), this.coreService = this._register(this._instantiationService.createInstance(h.CoreService)), this._instantiationService.setService(s2.ICoreService, this.coreService), this.mouseStateService = this._register(this._instantiationService.createInstance(c.MouseStateService)), this._instantiationService.setService(s2.IMouseStateService, this.mouseStateService), this.unicodeService = this._register(this._instantiationService.createInstance(l.UnicodeService)), this._instantiationService.setService(s2.IUnicodeService, this.unicodeService), this._charsetService = this._instantiationService.createInstance(_.CharsetService), this._instantiationService.setService(s2.ICharsetService, this._charsetService), this._oscLinkService = this._instantiationService.createInstance(g.OscLinkService), this._instantiationService.setService(s2.IOscLinkService, this._oscLinkService), this._inputHandler = this._register(new f.InputHandler(this._bufferService, this._charsetService, this.coreService, this._logService, this.optionsService, this._oscLinkService, this.mouseStateService, this.unicodeService)), this._register(p.EventUtils.forward(this._inputHandler.onLineFeed, this._onLineFeed)), this._register(p.EventUtils.forward(this._bufferService.onResize, this._onResize)), this._register(p.EventUtils.forward(this.coreService.onData, this._onData)), this._register(p.EventUtils.forward(this.coreService.onBinary, this._onBinary)), this._register(this.coreService.onRequestScrollToBottom(() => this.scrollToBottom(true))), this._register(this.coreService.onUserInput(() => this._writeBuffer.handleUserInput())), this._register(this.optionsService.onMultipleOptionChange(["windowsPty"], () => this._handleWindowsPtyOptionChange())), this._register(this._bufferService.onScroll(() => {
              this._onScroll.fire({ position: this._bufferService.buffer.ydisp }), this._inputHandler.markRangeDirty(this._bufferService.buffer.scrollTop, this._bufferService.buffer.scrollBottom);
            })), this._writeBuffer = this._register(new u.WriteBuffer((e4, t3) => this._inputHandler.parse(e4, t3))), this._register(p.EventUtils.forward(this._writeBuffer.onWriteParsed, this._onWriteParsed));
          }
          write(e3, t3) {
            this._writeBuffer.write(e3, t3);
          }
          writeSync(e3, t3) {
            this._logService.logLevel <= s2.LogLevelEnum.WARN && !b && (this._logService.warn("writeSync is unreliable and will be removed soon."), b = true), this._writeBuffer.writeSync(e3, t3);
          }
          input(e3, t3 = true) {
            this.coreService.triggerDataEvent(e3, t3);
          }
          resize(e3, t3) {
            isNaN(e3) || isNaN(t3) || (e3 = Math.max(e3, 2), t3 = Math.max(t3, 1), this._writeBuffer.flushSync(), this._bufferService.resize(e3, t3));
          }
          scroll(e3, t3 = false) {
            this._bufferService.scroll(e3, t3);
          }
          scrollLines(e3, t3) {
            this._bufferService.scrollLines(e3, t3);
          }
          scrollPages(e3) {
            this.scrollLines(e3 * (this.rows - 1));
          }
          scrollToTop() {
            this.scrollLines(-this._bufferService.buffer.ydisp);
          }
          scrollToBottom(e3) {
            this.scrollLines(this._bufferService.buffer.ybase - this._bufferService.buffer.ydisp);
          }
          scrollToLine(e3) {
            const t3 = e3 - this._bufferService.buffer.ydisp;
            0 !== t3 && this.scrollLines(t3);
          }
          registerEscHandler(e3, t3) {
            return this._inputHandler.registerEscHandler(e3, t3);
          }
          registerDcsHandler(e3, t3) {
            return this._inputHandler.registerDcsHandler(e3, t3);
          }
          registerCsiHandler(e3, t3) {
            return this._inputHandler.registerCsiHandler(e3, t3);
          }
          registerOscHandler(e3, t3) {
            return this._inputHandler.registerOscHandler(e3, t3);
          }
          registerApcHandler(e3, t3) {
            return this._inputHandler.registerApcHandler(e3, t3);
          }
          _setup() {
            this._handleWindowsPtyOptionChange();
          }
          reset() {
            this._inputHandler.reset(), this._bufferService.reset(), this._charsetService.reset(), this.coreService.reset(), this.mouseStateService.reset();
          }
          _handleWindowsPtyOptionChange() {
            let e3 = false;
            const t3 = this.optionsService.rawOptions.windowsPty;
            t3 && void 0 !== t3.buildNumber && void 0 !== t3.buildNumber && (e3 = !!("conpty" === t3.backend && t3.buildNumber < 21376)), e3 ? this._enableWindowsWrappingHeuristics() : this._windowsWrappingHeuristics.clear();
          }
          _enableWindowsWrappingHeuristics() {
            if (!this._windowsWrappingHeuristics.value) {
              const e3 = [];
              e3.push(this.onLineFeed(d.updateWindowsModeWrappedState.bind(null, this._bufferService))), e3.push(this.registerCsiHandler({ final: "H" }, () => ((0, d.updateWindowsModeWrappedState)(this._bufferService), false))), this._windowsWrappingHeuristics.value = (0, v.toDisposable)(() => {
                for (const t3 of e3) t3.dispose();
              });
            }
          }
        }
        t2.CoreTerminal = S;
      }, 793(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.BufferLineApiView = void 0;
        const s2 = i2(55);
        t2.BufferLineApiView = class {
          _line;
          constructor(e3) {
            this._line = e3;
          }
          get isWrapped() {
            return this._line.isWrapped;
          }
          get length() {
            return this._line.length;
          }
          getCell(e3, t3) {
            if (!(e3 < 0 || e3 >= this._line.length)) return t3 ? (this._line.loadCell(e3, t3), t3) : this._line.loadCell(e3, new s2.CellData());
          }
          translateToString(e3, t3, i3) {
            return this._line.translateToString(e3, t3, i3);
          }
        };
      }, 804(e2, t2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.XTERM_VERSION = void 0, t2.XTERM_VERSION = "6.0.0";
      }, 811(e2, t2, i2) {
        var s2 = this && this.__decorate || function(e3, t3, i3, s3) {
          var r3, n3 = arguments.length, a2 = n3 < 3 ? t3 : null === s3 ? s3 = Object.getOwnPropertyDescriptor(t3, i3) : s3;
          if ("object" == typeof Reflect && "function" == typeof Reflect.decorate) a2 = Reflect.decorate(e3, t3, i3, s3);
          else for (var o = e3.length - 1; o >= 0; o--) (r3 = e3[o]) && (a2 = (n3 < 3 ? r3(a2) : n3 > 3 ? r3(t3, i3, a2) : r3(t3, i3)) || a2);
          return n3 > 3 && a2 && Object.defineProperty(t3, i3, a2), a2;
        }, r2 = this && this.__param || function(e3, t3) {
          return function(i3, s3) {
            t3(i3, s3, e3);
          };
        };
        Object.defineProperty(t2, "__esModule", { value: true }), t2.OscLinkService = void 0;
        const n2 = i2(501);
        let a = class {
          _bufferService;
          serviceBrand;
          _nextId = 1;
          _entriesWithId = /* @__PURE__ */ new Map();
          _dataByLinkId = /* @__PURE__ */ new Map();
          constructor(e3) {
            this._bufferService = e3;
          }
          registerLink(e3) {
            const t3 = this._bufferService.buffer;
            if (void 0 === e3.id) {
              const i4 = t3.addMarker(t3.ybase + t3.y), s4 = { data: e3, id: this._nextId++, lines: [i4] };
              return i4.onDispose(() => this._removeMarkerFromLink(s4, i4)), this._dataByLinkId.set(s4.id, s4), s4.id;
            }
            const i3 = e3, s3 = this._getEntryIdKey(i3), r3 = this._entriesWithId.get(s3);
            if (r3) return this.addLineToLink(r3.id, t3.ybase + t3.y), r3.id;
            const n3 = t3.addMarker(t3.ybase + t3.y), a2 = { id: this._nextId++, key: this._getEntryIdKey(i3), data: i3, lines: [n3] };
            return n3.onDispose(() => this._removeMarkerFromLink(a2, n3)), this._entriesWithId.set(a2.key, a2), this._dataByLinkId.set(a2.id, a2), a2.id;
          }
          addLineToLink(e3, t3) {
            const i3 = this._dataByLinkId.get(e3);
            if (i3 && i3.lines.every((e4) => e4.line !== t3)) {
              const e4 = this._bufferService.buffer.addMarker(t3);
              i3.lines.push(e4), e4.onDispose(() => this._removeMarkerFromLink(i3, e4));
            }
          }
          getLinkData(e3) {
            return this._dataByLinkId.get(e3)?.data;
          }
          _getEntryIdKey(e3) {
            return `${e3.id};;${e3.uri}`;
          }
          _removeMarkerFromLink(e3, t3) {
            const i3 = e3.lines.indexOf(t3);
            -1 !== i3 && (e3.lines.splice(i3, 1), 0 === e3.lines.length && (void 0 !== e3.data.id && this._entriesWithId.delete(e3.key), this._dataByLinkId.delete(e3.id)));
          }
        };
        t2.OscLinkService = a, t2.OscLinkService = a = s2([r2(0, n2.IBufferService)], a);
      }, 812(e2, t2) {
        function i2(e3) {
          return { dispose: e3 };
        }
        function s2(e3) {
          if (!e3) return e3;
          if (Array.isArray(e3)) {
            for (const t3 of e3) t3.dispose();
            return [];
          }
          return e3.dispose(), e3;
        }
        Object.defineProperty(t2, "__esModule", { value: true }), t2.MutableDisposable = t2.Disposable = t2.DisposableStore = void 0, t2.toDisposable = i2, t2.dispose = s2, t2.combinedDisposable = function(...e3) {
          return i2(() => s2(e3));
        };
        class r2 {
          _disposables = /* @__PURE__ */ new Set();
          _isDisposed = false;
          get isDisposed() {
            return this._isDisposed;
          }
          add(e3) {
            return this._isDisposed ? e3.dispose() : this._disposables.add(e3), e3;
          }
          dispose() {
            if (!this._isDisposed) {
              this._isDisposed = true;
              for (const e3 of this._disposables) e3.dispose();
              this._disposables.clear();
            }
          }
          clear() {
            for (const e3 of this._disposables) e3.dispose();
            this._disposables.clear();
          }
        }
        t2.DisposableStore = r2;
        class n2 {
          static None = Object.freeze({ dispose() {
          } });
          _store = new r2();
          dispose() {
            this._store.dispose();
          }
          _register(e3) {
            return this._store.add(e3);
          }
        }
        t2.Disposable = n2, t2.MutableDisposable = class {
          _value;
          _isDisposed = false;
          get value() {
            return this._isDisposed ? void 0 : this._value;
          }
          set value(e3) {
            this._isDisposed || e3 === this._value || (this._value?.dispose(), this._value = e3);
          }
          clear() {
            this.value = void 0;
          }
          dispose() {
            this._isDisposed = true, this._value?.dispose(), this._value = void 0;
          }
        };
      }, 823(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.DcsHandler = t2.DcsParser = void 0;
        const s2 = i2(726), r2 = i2(262), n2 = [];
        t2.DcsParser = class {
          _handlers = /* @__PURE__ */ Object.create(null);
          _active = n2;
          _ident = 0;
          _handlerFb = () => {
          };
          _stack = { paused: false, loopPosition: 0, fallThrough: false };
          dispose() {
            this._handlers = /* @__PURE__ */ Object.create(null), this._handlerFb = () => {
            }, this._active = n2;
          }
          registerHandler(e3, t3) {
            this._handlers[e3] ??= [];
            const i3 = this._handlers[e3];
            return i3.push(t3), { dispose: () => {
              const e4 = i3.indexOf(t3);
              -1 !== e4 && i3.splice(e4, 1);
            } };
          }
          clearHandler(e3) {
            this._handlers[e3] && delete this._handlers[e3];
          }
          setHandlerFallback(e3) {
            this._handlerFb = e3;
          }
          reset() {
            if (this._active.length) for (let e3 = this._stack.paused ? this._stack.loopPosition - 1 : this._active.length - 1; e3 >= 0; --e3) this._active[e3].unhook(false);
            this._stack.paused = false, this._active = n2, this._ident = 0;
          }
          hook(e3, t3) {
            if (this.reset(), this._ident = e3, this._active = this._handlers[e3] || n2, this._active.length) for (let e4 = this._active.length - 1; e4 >= 0; e4--) this._active[e4].hook(t3);
            else this._handlerFb(this._ident, "HOOK", t3);
          }
          put(e3, t3, i3) {
            if (this._active.length) for (let s3 = this._active.length - 1; s3 >= 0; s3--) this._active[s3].put(e3, t3, i3);
            else this._handlerFb(this._ident, "PUT", (0, s2.utf32ToString)(e3, t3, i3));
          }
          unhook(e3, t3 = true) {
            if (this._active.length) {
              let i3 = false, s3 = this._active.length - 1, r3 = false;
              if (this._stack.paused && (s3 = this._stack.loopPosition - 1, i3 = t3, r3 = this._stack.fallThrough, this._stack.paused = false), !r3 && false === i3) {
                for (; s3 >= 0 && (i3 = this._active[s3].unhook(e3), true !== i3); s3--) if (i3 instanceof Promise) return this._stack.paused = true, this._stack.loopPosition = s3, this._stack.fallThrough = false, i3;
                s3--;
              }
              for (; s3 >= 0; s3--) if (i3 = this._active[s3].unhook(false), i3 instanceof Promise) return this._stack.paused = true, this._stack.loopPosition = s3, this._stack.fallThrough = true, i3;
            } else this._handlerFb(this._ident, "UNHOOK", e3);
            this._active = n2, this._ident = 0;
          }
        };
        const a = new r2.Params();
        a.addParam(0);
        class o {
          _handler;
          static _payloadLimit = 1e7;
          _data = "";
          _params = a;
          _hitLimit = false;
          constructor(e3) {
            this._handler = e3;
          }
          hook(e3) {
            this._params = e3.length > 1 || e3.params[0] ? e3.clone() : a, this._data = "", this._hitLimit = false;
          }
          put(e3, t3, i3) {
            this._hitLimit || (this._data += (0, s2.utf32ToString)(e3, t3, i3), this._data.length > o._payloadLimit && (this._data = "", this._hitLimit = true));
          }
          unhook(e3) {
            let t3 = false;
            if (this._hitLimit) t3 = false;
            else if (e3 && (t3 = this._handler(this._data, this._params), t3 instanceof Promise)) return t3.then((e4) => (this._params = a, this._data = "", this._hitLimit = false, e4));
            return this._params = a, this._data = "", this._hitLimit = false, t3;
          }
        }
        t2.DcsHandler = o;
      }, 856(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.Terminal = void 0;
        const s2 = i2(107), r2 = i2(777), n2 = i2(636);
        class a extends r2.CoreTerminal {
          _onBell = this._register(new n2.Emitter());
          onBell = this._onBell.event;
          _onCursorMove = this._register(new n2.Emitter());
          onCursorMove = this._onCursorMove.event;
          _onTitleChange = this._register(new n2.Emitter());
          onTitleChange = this._onTitleChange.event;
          _onA11yCharEmitter = this._register(new n2.Emitter());
          onA11yChar = this._onA11yCharEmitter.event;
          _onA11yTabEmitter = this._register(new n2.Emitter());
          onA11yTab = this._onA11yTabEmitter.event;
          constructor(e3 = {}) {
            super(e3), this._setup(), this._register(this._inputHandler.onRequestBell(() => this.bell())), this._register(this._inputHandler.onRequestReset(() => this.reset())), this._register(n2.EventUtils.forward(this._inputHandler.onCursorMove, this._onCursorMove)), this._register(n2.EventUtils.forward(this._inputHandler.onTitleChange, this._onTitleChange)), this._register(n2.EventUtils.forward(this._inputHandler.onA11yChar, this._onA11yCharEmitter)), this._register(n2.EventUtils.forward(this._inputHandler.onA11yTab, this._onA11yTabEmitter)), this._register(n2.EventUtils.forward(n2.EventUtils.map(this._inputHandler.onRequestRefreshRows, (e4) => ({ start: e4?.start ?? 0, end: e4?.end ?? this.rows - 1 })), this._onRender));
          }
          get buffer() {
            return this.buffers.active;
          }
          get markers() {
            return this.buffer.markers;
          }
          addMarker(e3) {
            if (this.buffer === this.buffers.normal) return this.buffer.addMarker(this.buffer.ybase + this.buffer.y + e3);
          }
          bell() {
            this._onBell.fire();
          }
          input(e3, t3 = true) {
            this.coreService.triggerDataEvent(e3, t3);
          }
          resize(e3, t3) {
            e3 === this.cols && t3 === this.rows || super.resize(e3, t3);
          }
          clear() {
            if (0 !== this.buffer.ybase || 0 !== this.buffer.y) {
              this.buffer.lines.set(0, this.buffer.lines.get(this.buffer.ybase + this.buffer.y)), this.buffer.lines.length = 1, this.buffer.ydisp = 0, this.buffer.ybase = 0, this.buffer.y = 0;
              for (let e3 = 1; e3 < this.rows; e3++) this.buffer.lines.push(this.buffer.getBlankLine(s2.DEFAULT_ATTR_DATA));
              this._onScroll.fire({ position: this.buffer.ydisp });
            }
          }
          reset() {
            this.options.rows = this.rows, this.options.cols = this.cols, this._setup(), super.reset();
          }
        }
        t2.Terminal = a;
      }, 882(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.updateWindowsModeWrappedState = function(e3) {
          const t3 = e3.buffer.lines.get(e3.buffer.ybase + e3.buffer.y - 1), i3 = t3?.get(e3.cols - 1), r2 = e3.buffer.lines.get(e3.buffer.ybase + e3.buffer.y);
          r2 && i3 && (r2.isWrapped = i3[s2.CHAR_DATA_CODE_INDEX] !== s2.NULL_CELL_CODE && i3[s2.CHAR_DATA_CODE_INDEX] !== s2.WHITESPACE_CELL_CODE);
        };
        const s2 = i2(938);
      }, 938(e2, t2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.WHITESPACE_CELL_CODE = t2.WHITESPACE_CELL_WIDTH = t2.WHITESPACE_CELL_CHAR = t2.NULL_CELL_CODE = t2.NULL_CELL_WIDTH = t2.NULL_CELL_CHAR = t2.CHAR_DATA_CODE_INDEX = t2.CHAR_DATA_WIDTH_INDEX = t2.CHAR_DATA_CHAR_INDEX = t2.CHAR_DATA_ATTR_INDEX = t2.DEFAULT_EXT = t2.DEFAULT_ATTR = t2.DEFAULT_COLOR = void 0, t2.DEFAULT_COLOR = 0, t2.DEFAULT_ATTR = t2.DEFAULT_COLOR << 9 | 256, t2.DEFAULT_EXT = 0, t2.CHAR_DATA_ATTR_INDEX = 0, t2.CHAR_DATA_CHAR_INDEX = 1, t2.CHAR_DATA_WIDTH_INDEX = 2, t2.CHAR_DATA_CODE_INDEX = 3, t2.NULL_CELL_CHAR = "", t2.NULL_CELL_WIDTH = 1, t2.NULL_CELL_CODE = 0, t2.WHITESPACE_CELL_CHAR = " ", t2.WHITESPACE_CELL_WIDTH = 1, t2.WHITESPACE_CELL_CODE = 32;
      } }, t = {};
      function i(s2) {
        var r2 = t[s2];
        if (void 0 !== r2) return r2.exports;
        var n2 = t[s2] = { exports: {} };
        return e[s2].call(n2.exports, n2, n2.exports, i), n2.exports;
      }
      var s = {};
      (() => {
        var e2 = s;
        Object.defineProperty(e2, "__esModule", { value: true }), e2.Terminal = void 0;
        const t2 = i(101), r2 = i(97), n2 = i(335), a = i(856), o = i(27), h = i(812), c = ["cols", "rows"];
        class l extends h.Disposable {
          _core;
          _addonManager;
          _parser;
          _buffer;
          _publicOptions;
          constructor(e3) {
            super(), this._core = this._register(new a.Terminal(e3)), this._addonManager = this._register(new o.AddonManager()), this._publicOptions = { ...this._core.options };
            const t3 = (e4) => this._core.options[e4], i2 = (e4, t4) => {
              this._checkReadonlyOptions(e4), this._core.options[e4] = t4;
            };
            for (const e4 in this._core.options) {
              Object.defineProperty(this._publicOptions, e4, { get: () => this._core.options[e4], set: (t4) => {
                this._checkReadonlyOptions(e4), this._core.options[e4] = t4;
              } });
              const s2 = { get: t3.bind(this, e4), set: i2.bind(this, e4) };
              Object.defineProperty(this._publicOptions, e4, s2);
            }
          }
          _checkReadonlyOptions(e3) {
            if (c.includes(e3)) throw new Error(`Option "${e3}" can only be set in the constructor`);
          }
          _checkProposedApi() {
            if (!this._core.optionsService.options.allowProposedApi) throw new Error("You must set the allowProposedApi option to true to use proposed API");
          }
          get onBell() {
            return this._core.onBell;
          }
          get onBinary() {
            return this._core.onBinary;
          }
          get onCursorMove() {
            return this._core.onCursorMove;
          }
          get onData() {
            return this._core.onData;
          }
          get onLineFeed() {
            return this._core.onLineFeed;
          }
          get onRender() {
            return this._core.onRender;
          }
          get onResize() {
            return this._core.onResize;
          }
          get onScroll() {
            return this._core.onScroll;
          }
          get onTitleChange() {
            return this._core.onTitleChange;
          }
          get onWriteParsed() {
            return this._core.onWriteParsed;
          }
          get parser() {
            return this._parser ??= new r2.ParserApi(this._core), this._parser;
          }
          get unicode() {
            return this._checkProposedApi(), new n2.UnicodeApi(this._core);
          }
          get rows() {
            return this._core.rows;
          }
          get cols() {
            return this._core.cols;
          }
          get buffer() {
            return this._buffer ??= this._register(new t2.BufferNamespaceApi(this._core)), this._buffer;
          }
          get markers() {
            return this._core.markers;
          }
          get modes() {
            const e3 = this._core.coreService.decPrivateModes;
            let t3 = "none";
            switch (this._core.mouseStateService.activeProtocol) {
              case "X10":
                t3 = "x10";
                break;
              case "VT200":
                t3 = "vt200";
                break;
              case "DRAG":
                t3 = "drag";
                break;
              case "ANY":
                t3 = "any";
            }
            return { applicationCursorKeysMode: e3.applicationCursorKeys, applicationKeypadMode: e3.applicationKeypad, bracketedPasteMode: e3.bracketedPasteMode, insertMode: this._core.coreService.modes.insertMode, mouseTrackingMode: t3, originMode: e3.origin, reverseWraparoundMode: e3.reverseWraparound, sendFocusMode: e3.sendFocus, showCursor: !this._core.coreService.isCursorHidden, synchronizedOutputMode: e3.synchronizedOutput, win32InputMode: e3.win32InputMode, wraparoundMode: e3.wraparound };
          }
          get options() {
            return this._publicOptions;
          }
          set options(e3) {
            for (const t3 in e3) this._publicOptions[t3] = e3[t3];
          }
          input(e3, t3 = true) {
            this._core.input(e3, t3);
          }
          resize(e3, t3) {
            this._verifyIntegers(e3, t3), this._core.resize(e3, t3);
          }
          registerMarker(e3 = 0) {
            return this._verifyIntegers(e3), this._core.addMarker(e3);
          }
          addMarker(e3) {
            return this.registerMarker(e3);
          }
          dispose() {
            super.dispose();
          }
          scrollLines(e3) {
            this._verifyIntegers(e3), this._core.scrollLines(e3);
          }
          scrollPages(e3) {
            this._verifyIntegers(e3), this._core.scrollPages(e3);
          }
          scrollToTop() {
            this._core.scrollToTop();
          }
          scrollToBottom() {
            this._core.scrollToBottom();
          }
          scrollToLine(e3) {
            this._verifyIntegers(e3), this._core.scrollToLine(e3);
          }
          clear() {
            this._core.clear();
          }
          write(e3, t3) {
            this._core.write(e3, t3);
          }
          writeln(e3, t3) {
            this._core.write(e3), this._core.write("\r\n", t3);
          }
          reset() {
            this._core.reset();
          }
          loadAddon(e3) {
            this._addonManager.loadAddon(this, e3);
          }
          _verifyIntegers(...e3) {
            for (const t3 of e3) if (t3 === 1 / 0 || isNaN(t3) || t3 % 1 != 0) throw new Error("This API only accepts integers");
          }
        }
        e2.Terminal = l;
      })();
      var r = exports2;
      for (var n in s) r[n] = s[n];
      s.__esModule && Object.defineProperty(r, "__esModule", { value: true });
    })();
  }
});

// node_modules/.pnpm/@xterm+addon-unicode11@0.10.0-beta.220_@xterm+xterm@6.1.0-beta.220/node_modules/@xterm/addon-unicode11/lib/addon-unicode11.js
var require_addon_unicode11 = __commonJS({
  "node_modules/.pnpm/@xterm+addon-unicode11@0.10.0-beta.220_@xterm+xterm@6.1.0-beta.220/node_modules/@xterm/addon-unicode11/lib/addon-unicode11.js"(exports2, module2) {
    !(function(e, t) {
      "object" == typeof exports2 && "object" == typeof module2 ? module2.exports = t() : "function" == typeof define && define.amd ? define([], t) : "object" == typeof exports2 ? exports2.Unicode11Addon = t() : e.Unicode11Addon = t();
    })(globalThis, () => (() => {
      "use strict";
      var e = { 384(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.UnicodeV11 = void 0;
        const s2 = i2(765), r = [[768, 879], [1155, 1161], [1425, 1469], [1471, 1471], [1473, 1474], [1476, 1477], [1479, 1479], [1536, 1541], [1552, 1562], [1564, 1564], [1611, 1631], [1648, 1648], [1750, 1757], [1759, 1764], [1767, 1768], [1770, 1773], [1807, 1807], [1809, 1809], [1840, 1866], [1958, 1968], [2027, 2035], [2045, 2045], [2070, 2073], [2075, 2083], [2085, 2087], [2089, 2093], [2137, 2139], [2259, 2306], [2362, 2362], [2364, 2364], [2369, 2376], [2381, 2381], [2385, 2391], [2402, 2403], [2433, 2433], [2492, 2492], [2497, 2500], [2509, 2509], [2530, 2531], [2558, 2558], [2561, 2562], [2620, 2620], [2625, 2626], [2631, 2632], [2635, 2637], [2641, 2641], [2672, 2673], [2677, 2677], [2689, 2690], [2748, 2748], [2753, 2757], [2759, 2760], [2765, 2765], [2786, 2787], [2810, 2815], [2817, 2817], [2876, 2876], [2879, 2879], [2881, 2884], [2893, 2893], [2902, 2902], [2914, 2915], [2946, 2946], [3008, 3008], [3021, 3021], [3072, 3072], [3076, 3076], [3134, 3136], [3142, 3144], [3146, 3149], [3157, 3158], [3170, 3171], [3201, 3201], [3260, 3260], [3263, 3263], [3270, 3270], [3276, 3277], [3298, 3299], [3328, 3329], [3387, 3388], [3393, 3396], [3405, 3405], [3426, 3427], [3530, 3530], [3538, 3540], [3542, 3542], [3633, 3633], [3636, 3642], [3655, 3662], [3761, 3761], [3764, 3772], [3784, 3789], [3864, 3865], [3893, 3893], [3895, 3895], [3897, 3897], [3953, 3966], [3968, 3972], [3974, 3975], [3981, 3991], [3993, 4028], [4038, 4038], [4141, 4144], [4146, 4151], [4153, 4154], [4157, 4158], [4184, 4185], [4190, 4192], [4209, 4212], [4226, 4226], [4229, 4230], [4237, 4237], [4253, 4253], [4448, 4607], [4957, 4959], [5906, 5908], [5938, 5940], [5970, 5971], [6002, 6003], [6068, 6069], [6071, 6077], [6086, 6086], [6089, 6099], [6109, 6109], [6155, 6158], [6277, 6278], [6313, 6313], [6432, 6434], [6439, 6440], [6450, 6450], [6457, 6459], [6679, 6680], [6683, 6683], [6742, 6742], [6744, 6750], [6752, 6752], [6754, 6754], [6757, 6764], [6771, 6780], [6783, 6783], [6832, 6846], [6912, 6915], [6964, 6964], [6966, 6970], [6972, 6972], [6978, 6978], [7019, 7027], [7040, 7041], [7074, 7077], [7080, 7081], [7083, 7085], [7142, 7142], [7144, 7145], [7149, 7149], [7151, 7153], [7212, 7219], [7222, 7223], [7376, 7378], [7380, 7392], [7394, 7400], [7405, 7405], [7412, 7412], [7416, 7417], [7616, 7673], [7675, 7679], [8203, 8207], [8234, 8238], [8288, 8292], [8294, 8303], [8400, 8432], [11503, 11505], [11647, 11647], [11744, 11775], [12330, 12333], [12441, 12442], [42607, 42610], [42612, 42621], [42654, 42655], [42736, 42737], [43010, 43010], [43014, 43014], [43019, 43019], [43045, 43046], [43204, 43205], [43232, 43249], [43263, 43263], [43302, 43309], [43335, 43345], [43392, 43394], [43443, 43443], [43446, 43449], [43452, 43453], [43493, 43493], [43561, 43566], [43569, 43570], [43573, 43574], [43587, 43587], [43596, 43596], [43644, 43644], [43696, 43696], [43698, 43700], [43703, 43704], [43710, 43711], [43713, 43713], [43756, 43757], [43766, 43766], [44005, 44005], [44008, 44008], [44013, 44013], [64286, 64286], [65024, 65039], [65056, 65071], [65279, 65279], [65529, 65531]], o = [[66045, 66045], [66272, 66272], [66422, 66426], [68097, 68099], [68101, 68102], [68108, 68111], [68152, 68154], [68159, 68159], [68325, 68326], [68900, 68903], [69446, 69456], [69633, 69633], [69688, 69702], [69759, 69761], [69811, 69814], [69817, 69818], [69821, 69821], [69837, 69837], [69888, 69890], [69927, 69931], [69933, 69940], [70003, 70003], [70016, 70017], [70070, 70078], [70089, 70092], [70191, 70193], [70196, 70196], [70198, 70199], [70206, 70206], [70367, 70367], [70371, 70378], [70400, 70401], [70459, 70460], [70464, 70464], [70502, 70508], [70512, 70516], [70712, 70719], [70722, 70724], [70726, 70726], [70750, 70750], [70835, 70840], [70842, 70842], [70847, 70848], [70850, 70851], [71090, 71093], [71100, 71101], [71103, 71104], [71132, 71133], [71219, 71226], [71229, 71229], [71231, 71232], [71339, 71339], [71341, 71341], [71344, 71349], [71351, 71351], [71453, 71455], [71458, 71461], [71463, 71467], [71727, 71735], [71737, 71738], [72148, 72151], [72154, 72155], [72160, 72160], [72193, 72202], [72243, 72248], [72251, 72254], [72263, 72263], [72273, 72278], [72281, 72283], [72330, 72342], [72344, 72345], [72752, 72758], [72760, 72765], [72767, 72767], [72850, 72871], [72874, 72880], [72882, 72883], [72885, 72886], [73009, 73014], [73018, 73018], [73020, 73021], [73023, 73029], [73031, 73031], [73104, 73105], [73109, 73109], [73111, 73111], [73459, 73460], [78896, 78904], [92912, 92916], [92976, 92982], [94031, 94031], [94095, 94098], [113821, 113822], [113824, 113827], [119143, 119145], [119155, 119170], [119173, 119179], [119210, 119213], [119362, 119364], [121344, 121398], [121403, 121452], [121461, 121461], [121476, 121476], [121499, 121503], [121505, 121519], [122880, 122886], [122888, 122904], [122907, 122913], [122915, 122916], [122918, 122922], [123184, 123190], [123628, 123631], [125136, 125142], [125252, 125258], [917505, 917505], [917536, 917631], [917760, 917999]], n = [[4352, 4447], [8986, 8987], [9001, 9002], [9193, 9196], [9200, 9200], [9203, 9203], [9725, 9726], [9748, 9749], [9800, 9811], [9855, 9855], [9875, 9875], [9889, 9889], [9898, 9899], [9917, 9918], [9924, 9925], [9934, 9934], [9940, 9940], [9962, 9962], [9970, 9971], [9973, 9973], [9978, 9978], [9981, 9981], [9989, 9989], [9994, 9995], [10024, 10024], [10060, 10060], [10062, 10062], [10067, 10069], [10071, 10071], [10133, 10135], [10160, 10160], [10175, 10175], [11035, 11036], [11088, 11088], [11093, 11093], [11904, 11929], [11931, 12019], [12032, 12245], [12272, 12283], [12288, 12329], [12334, 12350], [12353, 12438], [12443, 12543], [12549, 12591], [12593, 12686], [12688, 12730], [12736, 12771], [12784, 12830], [12832, 12871], [12880, 19903], [19968, 42124], [42128, 42182], [43360, 43388], [44032, 55203], [63744, 64255], [65040, 65049], [65072, 65106], [65108, 65126], [65128, 65131], [65281, 65376], [65504, 65510]], d = [[94176, 94179], [94208, 100343], [100352, 101106], [110592, 110878], [110928, 110930], [110948, 110951], [110960, 111355], [126980, 126980], [127183, 127183], [127374, 127374], [127377, 127386], [127488, 127490], [127504, 127547], [127552, 127560], [127568, 127569], [127584, 127589], [127744, 127776], [127789, 127797], [127799, 127868], [127870, 127891], [127904, 127946], [127951, 127955], [127968, 127984], [127988, 127988], [127992, 128062], [128064, 128064], [128066, 128252], [128255, 128317], [128331, 128334], [128336, 128359], [128378, 128378], [128405, 128406], [128420, 128420], [128507, 128591], [128640, 128709], [128716, 128716], [128720, 128722], [128725, 128725], [128747, 128748], [128756, 128762], [128992, 129003], [129293, 129393], [129395, 129398], [129402, 129442], [129445, 129450], [129454, 129482], [129485, 129535], [129648, 129651], [129656, 129658], [129664, 129666], [129680, 129685], [131072, 196605], [196608, 262141]];
        let c;
        function l(e3, t3) {
          let i3, s3 = 0, r2 = t3.length - 1;
          if (e3 < t3[0][0] || e3 > t3[r2][1]) return false;
          for (; r2 >= s3; ) if (i3 = s3 + r2 >> 1, e3 > t3[i3][1]) s3 = i3 + 1;
          else {
            if (!(e3 < t3[i3][0])) return true;
            r2 = i3 - 1;
          }
          return false;
        }
        t2.UnicodeV11 = class {
          version = "11";
          constructor() {
            if (!c) {
              c = new Uint8Array(65536), c.fill(1), c[0] = 0, c.fill(0, 1, 32), c.fill(0, 127, 160);
              for (let e3 = 0; e3 < r.length; ++e3) c.fill(0, r[e3][0], r[e3][1] + 1);
              for (let e3 = 0; e3 < n.length; ++e3) c.fill(2, n[e3][0], n[e3][1] + 1);
            }
          }
          wcwidth(e3) {
            return e3 < 32 ? 0 : e3 < 127 ? 1 : e3 < 65536 ? c[e3] : l(e3, o) ? 0 : l(e3, d) ? 2 : 1;
          }
          charProperties(e3, t3) {
            let i3 = this.wcwidth(e3), r2 = 0 === i3 && 0 !== t3;
            if (r2) {
              const e4 = s2.UnicodeService.extractWidth(t3);
              0 === e4 ? r2 = false : e4 > i3 && (i3 = e4);
            }
            return s2.UnicodeService.createPropertyValue(0, i3, r2);
          }
        };
      }, 414(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.EventUtils = t2.Emitter = void 0;
        const s2 = i2(426);
        var r;
        t2.Emitter = class {
          _listeners = [];
          _disposed = false;
          _event;
          get event() {
            return this._event || (this._event = (e3, t3, i3) => {
              if (this._disposed) return (0, s2.toDisposable)(() => {
              });
              const r2 = { fn: e3, thisArgs: t3 };
              this._listeners.push(r2);
              const o = (0, s2.toDisposable)(() => {
                const e4 = this._listeners.indexOf(r2);
                -1 !== e4 && this._listeners.splice(e4, 1);
              });
              return i3 && (Array.isArray(i3) ? i3.push(o) : i3.add(o)), o;
            }), this._event;
          }
          fire(e3) {
            if (!this._disposed) switch (this._listeners.length) {
              case 0:
                return;
              case 1: {
                const { fn: t3, thisArgs: i3 } = this._listeners[0];
                return void t3.call(i3, e3);
              }
              default: {
                const t3 = this._listeners.slice();
                for (const { fn: i3, thisArgs: s3 } of t3) i3.call(s3, e3);
              }
            }
          }
          dispose() {
            this._disposed || (this._disposed = true, this._listeners.length = 0);
          }
        }, (function(e3) {
          e3.forward = function(e4, t3) {
            return e4((e5) => t3.fire(e5));
          }, e3.map = function(e4, t3) {
            return (i3, s3, r2) => e4((e5) => i3.call(s3, t3(e5)), void 0, r2);
          }, e3.any = function(...e4) {
            return (t3, i3, r2) => {
              const o = new s2.DisposableStore();
              for (const s3 of e4) o.add(s3((e5) => t3.call(i3, e5)));
              return r2 && (Array.isArray(r2) ? r2.push(o) : r2.add(o)), o;
            };
          }, e3.runAndSubscribe = function(e4, t3, i3) {
            return t3(i3), e4((e5) => t3(e5));
          };
        })(r || (t2.EventUtils = r = {}));
      }, 426(e2, t2) {
        function i2(e3) {
          return { dispose: e3 };
        }
        function s2(e3) {
          if (!e3) return e3;
          if (Array.isArray(e3)) {
            for (const t3 of e3) t3.dispose();
            return [];
          }
          return e3.dispose(), e3;
        }
        Object.defineProperty(t2, "__esModule", { value: true }), t2.MutableDisposable = t2.Disposable = t2.DisposableStore = void 0, t2.toDisposable = i2, t2.dispose = s2, t2.combinedDisposable = function(...e3) {
          return i2(() => s2(e3));
        };
        class r {
          _disposables = /* @__PURE__ */ new Set();
          _isDisposed = false;
          get isDisposed() {
            return this._isDisposed;
          }
          add(e3) {
            return this._isDisposed ? e3.dispose() : this._disposables.add(e3), e3;
          }
          dispose() {
            if (!this._isDisposed) {
              this._isDisposed = true;
              for (const e3 of this._disposables) e3.dispose();
              this._disposables.clear();
            }
          }
          clear() {
            for (const e3 of this._disposables) e3.dispose();
            this._disposables.clear();
          }
        }
        t2.DisposableStore = r;
        class o {
          static None = Object.freeze({ dispose() {
          } });
          _store = new r();
          dispose() {
            this._store.dispose();
          }
          _register(e3) {
            return this._store.add(e3);
          }
        }
        t2.Disposable = o, t2.MutableDisposable = class {
          _value;
          _isDisposed = false;
          get value() {
            return this._isDisposed ? void 0 : this._value;
          }
          set value(e3) {
            this._isDisposed || e3 === this._value || (this._value?.dispose(), this._value = e3);
          }
          clear() {
            this.value = void 0;
          }
          dispose() {
            this._isDisposed = true, this._value?.dispose(), this._value = void 0;
          }
        };
      }, 546(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.UnicodeV6 = void 0;
        const s2 = i2(765), r = [[768, 879], [1155, 1158], [1160, 1161], [1425, 1469], [1471, 1471], [1473, 1474], [1476, 1477], [1479, 1479], [1536, 1539], [1552, 1557], [1611, 1630], [1648, 1648], [1750, 1764], [1767, 1768], [1770, 1773], [1807, 1807], [1809, 1809], [1840, 1866], [1958, 1968], [2027, 2035], [2305, 2306], [2364, 2364], [2369, 2376], [2381, 2381], [2385, 2388], [2402, 2403], [2433, 2433], [2492, 2492], [2497, 2500], [2509, 2509], [2530, 2531], [2561, 2562], [2620, 2620], [2625, 2626], [2631, 2632], [2635, 2637], [2672, 2673], [2689, 2690], [2748, 2748], [2753, 2757], [2759, 2760], [2765, 2765], [2786, 2787], [2817, 2817], [2876, 2876], [2879, 2879], [2881, 2883], [2893, 2893], [2902, 2902], [2946, 2946], [3008, 3008], [3021, 3021], [3134, 3136], [3142, 3144], [3146, 3149], [3157, 3158], [3260, 3260], [3263, 3263], [3270, 3270], [3276, 3277], [3298, 3299], [3393, 3395], [3405, 3405], [3530, 3530], [3538, 3540], [3542, 3542], [3633, 3633], [3636, 3642], [3655, 3662], [3761, 3761], [3764, 3769], [3771, 3772], [3784, 3789], [3864, 3865], [3893, 3893], [3895, 3895], [3897, 3897], [3953, 3966], [3968, 3972], [3974, 3975], [3984, 3991], [3993, 4028], [4038, 4038], [4141, 4144], [4146, 4146], [4150, 4151], [4153, 4153], [4184, 4185], [4448, 4607], [4959, 4959], [5906, 5908], [5938, 5940], [5970, 5971], [6002, 6003], [6068, 6069], [6071, 6077], [6086, 6086], [6089, 6099], [6109, 6109], [6155, 6157], [6313, 6313], [6432, 6434], [6439, 6440], [6450, 6450], [6457, 6459], [6679, 6680], [6912, 6915], [6964, 6964], [6966, 6970], [6972, 6972], [6978, 6978], [7019, 7027], [7616, 7626], [7678, 7679], [8203, 8207], [8234, 8238], [8288, 8291], [8298, 8303], [8400, 8431], [12330, 12335], [12441, 12442], [43014, 43014], [43019, 43019], [43045, 43046], [64286, 64286], [65024, 65039], [65056, 65059], [65279, 65279], [65529, 65531]], o = [[68097, 68099], [68101, 68102], [68108, 68111], [68152, 68154], [68159, 68159], [119143, 119145], [119155, 119170], [119173, 119179], [119210, 119213], [119362, 119364], [917505, 917505], [917536, 917631], [917760, 917999]];
        let n;
        t2.UnicodeV6 = class {
          version = "6";
          constructor() {
            if (!n) {
              n = new Uint8Array(65536), n.fill(1), n[0] = 0, n.fill(0, 1, 32), n.fill(0, 127, 160), n.fill(2, 4352, 4448), n[9001] = 2, n[9002] = 2, n.fill(2, 11904, 42192), n[12351] = 1, n.fill(2, 44032, 55204), n.fill(2, 63744, 64256), n.fill(2, 65040, 65050), n.fill(2, 65072, 65136), n.fill(2, 65280, 65377), n.fill(2, 65504, 65511);
              for (let e3 = 0; e3 < r.length; ++e3) n.fill(0, r[e3][0], r[e3][1] + 1);
            }
          }
          wcwidth(e3) {
            return e3 < 32 ? 0 : e3 < 127 ? 1 : e3 < 65536 ? n[e3] : (function(e4, t3) {
              let i3, s3 = 0, r2 = t3.length - 1;
              if (e4 < t3[0][0] || e4 > t3[r2][1]) return false;
              for (; r2 >= s3; ) if (i3 = s3 + r2 >> 1, e4 > t3[i3][1]) s3 = i3 + 1;
              else {
                if (!(e4 < t3[i3][0])) return true;
                r2 = i3 - 1;
              }
              return false;
            })(e3, o) ? 0 : e3 >= 131072 && e3 <= 196605 || e3 >= 196608 && e3 <= 262141 ? 2 : 1;
          }
          charProperties(e3, t3) {
            let i3 = this.wcwidth(e3), r2 = 0 === i3 && 0 !== t3;
            if (r2) {
              const e4 = s2.UnicodeService.extractWidth(t3);
              0 === e4 ? r2 = false : e4 > i3 && (i3 = e4);
            }
            return s2.UnicodeService.createPropertyValue(0, i3, r2);
          }
        };
      }, 765(e2, t2, i2) {
        Object.defineProperty(t2, "__esModule", { value: true }), t2.UnicodeService = void 0;
        const s2 = i2(546), r = i2(414);
        class o {
          serviceBrand;
          _providers = /* @__PURE__ */ Object.create(null);
          _active = "";
          _activeProvider;
          _onChange = new r.Emitter();
          onChange = this._onChange.event;
          static extractShouldJoin(e3) {
            return !!(1 & e3);
          }
          static extractWidth(e3) {
            return e3 >> 1 & 3;
          }
          static extractCharKind(e3) {
            return e3 >> 3;
          }
          static createPropertyValue(e3, t3, i3 = false) {
            return (16777215 & e3) << 3 | (3 & t3) << 1 | (i3 ? 1 : 0);
          }
          constructor() {
            const e3 = new s2.UnicodeV6();
            this.register(e3), this._active = e3.version, this._activeProvider = e3;
          }
          dispose() {
            this._onChange.dispose();
          }
          get versions() {
            return Object.keys(this._providers);
          }
          get activeVersion() {
            return this._active;
          }
          set activeVersion(e3) {
            if (!this._providers[e3]) throw new Error(`unknown Unicode version "${e3}"`);
            this._active = e3, this._activeProvider = this._providers[e3], this._onChange.fire(e3);
          }
          register(e3) {
            this._providers[e3.version] = e3;
          }
          wcwidth(e3) {
            return this._activeProvider.wcwidth(e3);
          }
          getStringCellWidth(e3) {
            let t3 = 0, i3 = 0;
            const s3 = e3.length;
            for (let r2 = 0; r2 < s3; ++r2) {
              let n = e3.charCodeAt(r2);
              if (55296 <= n && n <= 56319) {
                if (++r2 >= s3) return t3 + this.wcwidth(n);
                const i4 = e3.charCodeAt(r2);
                56320 <= i4 && i4 <= 57343 ? n = 1024 * (n - 55296) + i4 - 56320 + 65536 : t3 += this.wcwidth(i4);
              }
              const d = this.charProperties(n, i3);
              let c = o.extractWidth(d);
              o.extractShouldJoin(d) && (c -= o.extractWidth(i3)), t3 += c, i3 = d;
            }
            return t3;
          }
          charProperties(e3, t3) {
            return this._activeProvider.charProperties(e3, t3);
          }
        }
        t2.UnicodeService = o;
      } }, t = {};
      function i(s2) {
        var r = t[s2];
        if (void 0 !== r) return r.exports;
        var o = t[s2] = { exports: {} };
        return e[s2](o, o.exports, i), o.exports;
      }
      var s = {};
      return (() => {
        var e2 = s;
        Object.defineProperty(e2, "__esModule", { value: true }), e2.Unicode11Addon = void 0;
        const t2 = i(384);
        e2.Unicode11Addon = class {
          activate(e3) {
            e3.unicode.register(new t2.UnicodeV11());
          }
          dispose() {
          }
        };
      })(), s;
    })());
  }
});

// packages/core/src/sessionOwner.ts
function ownerPath(sessionDir2) {
  return (0, import_path15.join)(sessionDir2, "owner.json");
}
async function readOwnerUnlocked(sessionDir2) {
  try {
    const raw = await import_fs12.promises.readFile(ownerPath(sessionDir2), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.pid !== "number" || parsed.app !== "desktop" && parsed.app !== "extension") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
async function readOwner(sessionDir2) {
  return readOwnerUnlocked(sessionDir2);
}
var import_fs12, import_path15;
var init_sessionOwner = __esm({
  "packages/core/src/sessionOwner.ts"() {
    "use strict";
    import_fs12 = require("fs");
    import_path15 = require("path");
    init_fileLock();
    init_replayPaths();
  }
});

// packages/core/src/screenReplay.ts
function validSize(v) {
  if (!v) return null;
  const { cols, rows } = v;
  return Number.isInteger(cols) && cols > 0 && Number.isInteger(rows) && rows > 0 ? { cols, rows } : null;
}
async function readReplaySize(sessionDir2) {
  try {
    return JSON.parse(await import_fs13.promises.readFile(replaySizePath(sessionDir2), "utf8"));
  } catch {
    return null;
  }
}
async function renderScreen(sessionDir2) {
  let data;
  try {
    data = await import_fs13.promises.readFile(replayLogPath(sessionDir2));
  } catch {
    return null;
  }
  if (data.length === 0) return null;
  const { cols, rows } = validSize(await readOwner(sessionDir2)) ?? validSize(await readReplaySize(sessionDir2)) ?? { cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
  const term = new import_headless.Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
  try {
    term.loadAddon(new import_addon_unicode11.Unicode11Addon());
    term.unicode.activeVersion = "11";
    await new Promise((resolve3) => {
      term.write(data, resolve3);
    });
    const buf = term.buffer.active;
    const lines = [];
    for (let i = 0; i < rows; i++) {
      const line = buf.getLine(buf.baseY + i);
      lines.push(line ? line.translateToString(true).trimEnd() : "");
    }
    while (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    return { cols, rows, text: lines.join("\n") };
  } finally {
    term.dispose();
  }
}
var import_fs13, import_headless, import_addon_unicode11, DEFAULT_COLS, DEFAULT_ROWS;
var init_screenReplay = __esm({
  "packages/core/src/screenReplay.ts"() {
    "use strict";
    import_fs13 = require("fs");
    import_headless = __toESM(require_xterm_headless());
    import_addon_unicode11 = __toESM(require_addon_unicode11());
    init_replayPaths();
    init_sessionOwner();
    DEFAULT_COLS = 120;
    DEFAULT_ROWS = 30;
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
  agentModels: () => agentModels,
  agentRead: () => agentRead,
  agentSend: () => agentSend,
  agentStart: () => agentStart,
  agentStop: () => agentStop,
  formatSubLabel: () => formatSubLabel,
  listSubs: () => listSubs,
  sessionNew: () => sessionNew
});
async function readSessions(wsDir) {
  try {
    const raw = await import_fs14.promises.readFile((0, import_path16.join)(wsDir, "workspace.json"), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.sessions) ? parsed.sessions : [];
  } catch {
    return [];
  }
}
async function readWorkspacePath(wsDir) {
  const raw = await import_fs14.promises.readFile((0, import_path16.join)(wsDir, "workspace.json"), "utf8");
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
        ...s.subModel ? { subModel: s.subModel } : {},
        ...s.subEffort ? { subEffort: s.subEffort } : {},
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
function formatSubLabel(sub, state) {
  const parts = [sub.model];
  if (sub.subModel) {
    parts.push(sub.subModel);
    if (sub.subEffort) parts.push(sub.subEffort);
  }
  if (state) parts.push(state);
  return `(${parts.join(", ")})`;
}
function rowLine(s) {
  const mark = s.unread ? "  \xB7 \uC548 \uC77D\uC740 \uBCF4\uACE0 \uC788\uC74C" : "";
  return `  ${s.name}  ${formatSubLabel(s, stateText(s))}  ${s.title}${mark}`;
}
async function agentList(wsDir, callerSessionId) {
  const subs = await listSubs(wsDir, callerSessionId);
  if (subs.length === 0) return "\uB744\uC6B4 \uC11C\uBE0C\uAC00 \uC5C6\uB2E4.";
  return [`## \uC11C\uBE0C ${subs.length}\uAC1C`, "", ...subs.map(rowLine)].join("\n");
}
function formatScreenSection(screen) {
  if (!screen || !screen.text) return "\uD654\uBA74 \uAE30\uB85D\uC774 \uC5C6\uB2E4";
  return `### \uC9C0\uAE08 \uD654\uBA74 (${screen.cols}\xD7${screen.rows})

${screen.text}`;
}
async function agentRead(wsDir, callerSessionId, name, lastNOrOpts) {
  const opts = typeof lastNOrOpts === "number" ? { lastN: lastNOrOpts } : lastNOrOpts ?? {};
  if (opts.screen && opts.lastN !== void 0) {
    throw new Error("--screen\uC740 --last\uC640 \uD568\uAED8 \uC4F0\uC9C0 \uC54A\uB294\uB2E4");
  }
  const sub = await findSub(wsDir, callerSessionId, name);
  const sessionDir2 = (0, import_path16.join)(wsDir, "sessions", sub.sessionId);
  await markReported(wsDir, sub.sessionId);
  if (opts.screen) {
    return formatScreenSection(await renderScreen(sessionDir2));
  }
  const all = await readAllTurns(sessionDir2);
  if (all.length === 0) {
    const head = `${name}: \uC544\uC9C1 \uAE30\uB85D\uB41C \uD134\uC774 \uC5C6\uB2E4.${sub.closed ? " \uC138\uC158\uC740 \uC774\uBBF8 \uB05D\uB0AC\uB2E4." : ""}`;
    return `${head}

${formatScreenSection(await renderScreen(sessionDir2))}`;
  }
  const turns = typeof opts.lastN === "number" ? all.slice(-opts.lastN) : all;
  const lines = [`## ${name} (${sub.model}) \uC758 \uAE30\uB85D \u2014 ${turns.length}\uD134, \uC624\uB798\uB41C \uAC83\uBD80\uD130`, ""];
  for (const t of turns) {
    lines.push(`[${t.completedAt || ""}]`);
    lines.push(`user: ${t.user || ""}`);
    lines.push(`assistant: ${t.assistantBody || ""}`);
    lines.push("");
  }
  const lastTurn = all[all.length - 1];
  const emptyReply = (lastTurn.assistantBody ?? "").trim() === "";
  const activeOrUnknown = sub.activity === "running" || sub.activity === "unknown";
  if (emptyReply || activeOrUnknown) {
    lines.push(formatScreenSection(await renderScreen(sessionDir2)));
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
function renderWoke(done, stuck) {
  const lines = [];
  if (done.length > 0) {
    lines.push(`## \uB05D\uB09C \uC11C\uBE0C ${done.length}\uAC1C`, "");
    for (const s of done) lines.push(`  ${s.name}  ${formatSubLabel(s)}  ${s.title}`);
    lines.push("", "`agent read <\uC774\uB984>`\uC73C\uB85C \uBCF4\uACE0\uB97C \uC77D\uB294\uB2E4.");
  }
  if (stuck.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`## \uC0C1\uD0DC\uB97C \uC54C \uC218 \uC5C6\uB294 \uC11C\uBE0C ${stuck.length}\uAC1C`, "");
    for (const s of stuck) lines.push(`  ${s.name}  ${formatSubLabel(s)}  ${s.title}`);
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
    lines.push(`  ${s.name}  ${formatSubLabel(s, stateText(s))}`);
    if (s.closed) {
      const screen = await renderScreen((0, import_path16.join)(wsDir, "sessions", s.sessionId));
      if (screen && screen.text) {
        lines.push(`    \u2014 \uC644\uB8CC \uC2E0\uD638 \uC5C6\uC774 \uB05D\uB0AC\uB2E4. \uC9C0\uAE08 \uD654\uBA74 (${screen.cols}\xD7${screen.rows}):`);
        for (const l of screen.text.split("\n")) lines.push(`      ${l}`);
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
function agentStart(sessionDir2, prompt, harnesses, isolate, opts) {
  const payload = { prompt, harnesses, isolate };
  if (opts?.models && Object.keys(opts.models).length > 0) {
    payload.models = opts.models;
  }
  if (opts?.efforts && Object.keys(opts.efforts).length > 0) {
    payload.efforts = opts.efforts;
  }
  return callHost(sessionDir2, HOST_AGENT_START, payload);
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
function sessionNew(sessionDir2, harness) {
  return callHost(sessionDir2, HOST_SESSION_NEW, harness ? { harness } : {});
}
function agentModels(sessionDir2, harnesses) {
  return callHost(
    sessionDir2,
    HOST_AGENT_MODELS,
    harnesses && harnesses.length > 0 ? { harnesses } : {}
  );
}
var import_fs14, import_path16, DEFAULT_WAIT_SEC, WAIT_POLL_MS, defaultSleep2, requestSeq;
var init_agent = __esm({
  "packages/core/src/agentCli/agent.ts"() {
    "use strict";
    import_fs14 = require("fs");
    import_path16 = require("path");
    init_turnsStore();
    init_sessionStatus();
    init_reportState();
    init_cleanup();
    init_diffMerge();
    init_screenReplay();
    init_hostRequest();
    DEFAULT_WAIT_SEC = 60;
    WAIT_POLL_MS = 1e3;
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
    for (const dirName of SKILL_DIRS) {
      const path2 = skillFilePath(agent, homeDir, dirName);
      try {
        await import_fs15.promises.unlink(path2);
        removed.push(path2);
      } catch {
        continue;
      }
      try {
        await import_fs15.promises.rmdir((0, import_path17.dirname)(path2));
      } catch {
      }
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
var import_fs15, import_path17, AGENTS2, SKILL_DIRS;
var init_uninstall = __esm({
  "packages/core/src/agentCli/uninstall.ts"() {
    "use strict";
    import_fs15 = require("fs");
    import_path17 = require("path");
    init_hookInstaller();
    init_skillInstaller();
    init_skillTemplate();
    init_cleanupSkillTemplate();
    AGENTS2 = ["claude", "codex", "agy"];
    SKILL_DIRS = [SKILL_DIR_NAME, CLEANUP_SKILL_DIR_NAME];
  }
});

// packages/core/bin/agentbridge.js
var fs6 = require("fs");
var path = require("path");
var {
  readContext: readContext2,
  readTurns: readTurns2,
  readMemory: readMemory2,
  readMemoryDoc: readMemoryDoc2,
  searchMemory: searchMemory2,
  resolveProfileIdForScope: resolveProfileIdForScope2
} = (init_read(), __toCommonJS(read_exports));
var {
  requestMemoryWrite: requestMemoryWrite2,
  resolveUpdateTarget: resolveUpdateTarget2,
  listPendingProposals: listPendingProposals2,
  resolveWithdrawTarget: resolveWithdrawTarget2,
  WriteError: WriteError2
} = (init_write(), __toCommonJS(write_exports));
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
  agentModels: agentModels2,
  sessionNew: sessionNew2,
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
  ["memory read <\uC2DD\uBCC4\uC790>", "\uD55C \uAC74\uC758 \uC804\uBB38. \uC2DD\uBCC4\uC790\uB294 <\uCE74\uD14C\uACE0\uB9AC>/<\uC2AC\uB7EC\uADF8> (--scope\uB85C \uD55C\uCABD\uB9CC)"],
  ["memory add", "\uC0C8 \uC0AC\uC2E4\uC744 \uC81C\uC548 \uD050\uC5D0 \uB123\uB294\uB2E4 (--scope \uD544\uC218 --category --title --summary --body)"],
  ["memory update <\uC2DD\uBCC4\uC790>", "\uC774\uBBF8 \uC788\uB294 \uD56D\uBAA9\uC744 \uACE0\uCE58\uB294 \uC81C\uC548 (\uAC19\uC740 \uC778\uC790, \uC548 \uC900 \uAC83\uC740 \uADF8\uB300\uB85C)"],
  ["memory pending", "\uC2B9\uC778\uC744 \uAE30\uB2E4\uB9AC\uB294 \uC81C\uC548 \uBAA9\uB85D (--scope\uB85C \uD55C\uCABD\uB9CC)"],
  ["memory withdraw <\uC81C\uC548 \uC2DD\uBCC4\uC790>", "\uB300\uAE30 \uC911\uC778 \uC81C\uC548\uC744 \uAC70\uB454\uB2E4"],
  ["status", "\uC5B4\uB514\uC5D0 \uBB34\uC5C7\uC774 \uAE54\uB824 \uC788\uB294\uC9C0\uC640 \uBC30\uC120 \uC790\uAC00 \uC9C4\uB2E8"],
  ["agent models [--harness]", "\uD558\uB2C8\uC2A4\uBCC4\uB85C \uACE0\uB97C \uC218 \uC788\uB294 \uBAA8\uB378\uACFC effort"],
  ["agent start", '\uC11C\uBE0C\uC5D0\uC774\uC804\uD2B8\uB97C \uB744\uC6B4\uB2E4 (--prompt "..." [--harness claude,codex,agy] [--model] [--effort] [--isolate])'],
  ["agent list", "\uB744\uC6B4 \uC11C\uBE0C\uC758 \uBAA9\uB85D\uACFC \uC0C1\uD0DC"],
  ["agent check", "\uB05D\uB09C \uC11C\uBE0C\uAC00 \uC788\uB294\uC9C0 \uBCF8\uB2E4 (--wait\uBA74 \uC0DD\uAE38 \uB54C\uAE4C\uC9C0, --for <\uCD08>\uB85C \uC0C1\uD55C \uC870\uC815)"],
  ["agent read <\uC774\uB984>", "\uADF8 \uC11C\uBE0C\uC758 \uAE30\uB85D \uC804\uBB38 (--last N\uC73C\uB85C \uC790\uB984, --screen\uC774\uBA74 \uC9C0\uAE08 \uD654\uBA74\uB9CC)"],
  ["agent diff <\uC774\uB984>", "\uADF8 \uC11C\uBE0C\uAC00 \uC2E4\uC81C\uB85C \uBC14\uAFBC \uAC83 (--stat\uC774\uBA74 \uC694\uC57D\uB9CC)"],
  ["agent send <\uC774\uB984>", '\uB3C4\uB294 \uC11C\uBE0C\uC5D0 \uC9C0\uCE68\uC744 \uB354 \uBCF4\uB0B8\uB2E4 (--prompt "...")'],
  ["agent merge <\uC774\uB984>", "\uADF8 \uC11C\uBE0C\uC758 \uBCC0\uACBD\uC744 \uC6D0\uBCF8\uC5D0 \uC5B9\uB294\uB2E4 (\uC804\uBD80 \uC544\uB2C8\uBA74 \uC544\uBB34\uAC83\uB3C4)"],
  ["agent stop <\uC774\uB984>", "\uC11C\uBE0C\uB97C \uB05D\uB0B8\uB2E4"],
  ["agent close <\uC774\uB984>", "\uC11C\uBE0C\uB97C \uC815\uB9AC\uD55C\uB2E4 (\uACA9\uB9AC\uC600\uC73C\uBA74 \uD3F4\uB354\uC640 \uBE0C\uB79C\uCE58\uB3C4 \uC9C0\uC6B4\uB2E4)"],
  ["agent close --round", "\uB77C\uC6B4\uB4DC\uB97C \uC815\uB9AC\uD55C\uB2E4 (\uBA38\uC9C0\uB41C \uD558\uB098\uB9CC \uB0A8\uAE30\uACE0 \uC804\uBD80)"],
  ["session new [--harness h]", "\uC0C8 \uBA54\uC778 \uC138\uC158 \uD0ED\uC744 \uC5F0\uB2E4"]
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
function harnessPairOption(flag, raw, harnesses) {
  if (raw === void 0) return void 0;
  const trimmed = raw.trim();
  if (!trimmed) fail(flag + "\uC5D0 \uAC12\uC774 \uC5C6\uB2E4");
  if (!trimmed.includes("=")) {
    if (new Set(harnesses).size > 1) {
      fail("\uD558\uB2C8\uC2A4\uAC00 \uC5EC\uB7FF\uC774\uBA74 --model\uACFC --effort\uB294 claude=opus\uCC98\uB7FC \uD558\uB2C8\uC2A4\uBCC4\uB85C \uC4F4\uB2E4");
    }
    return { [harnesses[0]]: trimmed };
  }
  const out = {};
  for (const part of trimmed.split(",")) {
    const entry = part.trim();
    if (!entry) fail(flag + "\uC758 \uC9DD \uD615\uC2DD\uC774 \uB9DE\uC9C0 \uC54A\uB294\uB2E4");
    const eq = entry.indexOf("=");
    if (eq === -1) fail(flag + "\uC758 \uC9DD \uD615\uC2DD\uC774 \uB9DE\uC9C0 \uC54A\uB294\uB2E4: " + entry);
    const h = entry.slice(0, eq).trim();
    const val = entry.slice(eq + 1).trim();
    if (!h) fail(flag + "\uC5D0 \uD558\uB2C8\uC2A4\uAC00 \uC5C6\uB2E4: " + entry);
    if (!val) fail(flag + "\uC758 " + h + " \uAC12\uC774 \uBE44\uC5B4 \uC788\uB2E4");
    if (!harnesses.includes(h)) fail(flag + "\uC758 " + h + "\uB294 --harness\uC5D0 \uC5C6\uB2E4");
    out[h] = val;
  }
  return out;
}
function scopeOption(args) {
  const v = strOption(args, "--scope");
  if (v === void 0) {
    fail("--scope\uAC00 \uC5C6\uB2E4. \uC0AC\uC6A9\uC790\uAC00 \uBAA8\uB4E0 \uD504\uB85C\uC81D\uD2B8\uC5D0 \uC801\uC6A9\uB41C\uB2E4\uACE0 \uC9C1\uC811 \uB9D0\uD55C \uAC83\uB9CC user, \uB098\uBA38\uC9C0\uB294 project\uB2E4");
  }
  if (v !== "user" && v !== "project") fail("--scope\uB294 user \uB610\uB294 project\uB2E4");
  return v;
}
function optionalScopeOption(args) {
  const v = strOption(args, "--scope");
  if (v === void 0) return void 0;
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
      if (sub === "read") {
        const id = args[1];
        if (!id || id.startsWith("--")) fail("memory read\uC5D0\uB294 \uC2DD\uBCC4\uC790\uAC00 \uC628\uB2E4 (<\uCE74\uD14C\uACE0\uB9AC>/<\uC2AC\uB7EC\uADF8>)");
        return readMemoryDoc2(storageRoot, wsDir, id, optionalScopeOption(args));
      }
      if (sub === "search") {
        const query = args.slice(1).join(" ").trim();
        if (!query) fail("memory search\uC5D0\uB294 \uC9C8\uC758\uAC00 \uC628\uB2E4");
        return searchMemory2(storageRoot, wsDir, query);
      }
      if (sub === "pending") {
        return listPendingProposals2(storageRoot, wsDir, optionalScopeOption(args));
      }
      if (sub === "withdraw") {
        const id = args[1];
        if (!id || id.startsWith("--")) fail("memory withdraw\uC5D0\uB294 \uC81C\uC548 \uC2DD\uBCC4\uC790\uAC00 \uC628\uB2E4");
        const target = await resolveWithdrawTarget2(storageRoot, wsDir, id, optionalScopeOption(args));
        return requestMemoryWrite2(sessionDir(wsDir), {
          op: "withdraw",
          scope: target.scope,
          profileId: target.profileId,
          id
        });
      }
      if (sub === "add") {
        const scope = scopeOption(args);
        const profileId = await resolveProfileIdForScope2(wsDir, scope);
        if (!profileId) fail("\uC774 \uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4\uC758 \uD504\uB85C\uC81D\uD2B8 \uC9C0\uC2DD \uC790\uB9AC\uB97C \uCC3E\uC744 \uC218 \uC5C6\uB2E4");
        return requestMemoryWrite2(sessionDir(wsDir), {
          op: "add",
          scope,
          profileId,
          category: strOption(args, "--category"),
          fields: writeFields(args)
        });
      }
      if (sub === "update") {
        const id = args[1];
        if (!id || id.startsWith("--")) fail("memory update\uC5D0\uB294 \uC2DD\uBCC4\uC790\uAC00 \uC628\uB2E4");
        const target = await resolveUpdateTarget2(storageRoot, wsDir, id, optionalScopeOption(args));
        return requestMemoryWrite2(sessionDir(wsDir), {
          op: "update",
          scope: target.scope,
          profileId: target.profileId,
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
        case "models": {
          const raw = strOption(rest, "--harness");
          const harnesses = raw ? raw.split(",").map((h) => h.trim()).filter(Boolean) : ["claude", "codex", "agy"];
          if (raw !== void 0 && harnesses.length === 0) fail("--harness\uC5D0 \uAC12\uC774 \uC5C6\uB2E4");
          return agentModels2(sessionDir(wsDir), harnesses);
        }
        case "list":
          return agentList2(wsDir, caller);
        case "read": {
          const name = nameArg();
          const screen = rest.includes("--screen");
          const hasLast = rest.includes("--last");
          if (screen && hasLast) fail("--screen\uC740 --last\uC640 \uD568\uAED8 \uC4F0\uC9C0 \uC54A\uB294\uB2E4");
          return agentRead2(wsDir, caller, name, {
            lastN: hasLast ? intOption(rest, "--last", 0) : void 0,
            screen
          });
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
          if (raw !== void 0 && harnesses.length === 0) fail("--harness\uC5D0 \uAC12\uC774 \uC5C6\uB2E4");
          const models = harnessPairOption("--model", strOption(rest, "--model"), harnesses);
          const efforts = harnessPairOption("--effort", strOption(rest, "--effort"), harnesses);
          if (efforts) {
            for (const h of Object.keys(efforts)) {
              if (!models || !models[h]) {
                fail(h + "\uC5D0 --effort\uB9CC \uC788\uB2E4. --model\uACFC \uD568\uAED8 \uC4F4\uB2E4");
              }
            }
          }
          return agentStart2(sessionDir(wsDir), prompt, harnesses, rest.includes("--isolate"), {
            models,
            efforts
          });
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
    case "session": {
      if (args[0] !== "new") return usageAndExit();
      const rest = args.slice(1);
      const caller = process.env.AGENTBRIDGE_WS_SESSION || "";
      if (!caller || caller !== path.basename(caller)) fail("\uC774 \uC138\uC158\uC758 \uC2E0\uC6D0\uC744 \uC54C \uC218 \uC5C6\uB2E4");
      const harness = strOption(rest, "--harness");
      if (harness !== void 0 && harness.includes(",")) fail("session new\uB294 \uD558\uB2C8\uC2A4\uB97C \uD558\uB098\uB9CC \uBC1B\uB294\uB2E4");
      return sessionNew2(sessionDir(wsDir), harness);
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
