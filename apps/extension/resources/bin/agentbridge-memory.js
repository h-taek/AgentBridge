#!/usr/bin/env node
// @agentbridge-helper-version 0.6.2
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
function resolveTurnStartFile(workspaceDir, sessionId) {
  return (0, import_path.join)(workspaceDir, "sessions", sessionId, TURN_START_FILENAME);
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
    raw = await import_fs.promises.readFile(startFilePath, "utf8");
  } catch {
    return null;
  }
  return parseTurnStart(raw);
}
var import_fs, import_path, TURN_SIGNAL_FILENAME, TURN_START_FILENAME;
var init_turnSignal = __esm({
  "packages/core/src/cliAdapter/turnSignal.ts"() {
    "use strict";
    import_fs = require("fs");
    import_path = require("path");
    init_interfaces();
    init_sessionFileWatcher();
    TURN_SIGNAL_FILENAME = "turn-signal.json";
    TURN_START_FILENAME = "turn-start.json";
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

// packages/core/src/sessionStatus.ts
var sessionStatus_exports = {};
__export(sessionStatus_exports, {
  SILENCE_MS: () => SILENCE_MS,
  aggregateActivity: () => aggregateActivity,
  computeSessionActivity: () => computeSessionActivity,
  readSessionActivityInputs: () => readSessionActivityInputs
});
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
function aggregateActivity(self, children) {
  let best = self;
  for (const child of children) {
    if (PRIORITY.indexOf(child) < PRIORITY.indexOf(best)) best = child;
  }
  return best;
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
  return (0, import_path3.join)(workspaceDir, "sessions", sessionId, "replay.log");
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
var import_fs3, import_path3, SILENCE_MS, PRIORITY, defaultIo, startCache, signalCache, outputCache;
var init_sessionStatus = __esm({
  "packages/core/src/sessionStatus.ts"() {
    "use strict";
    import_fs3 = require("fs");
    import_path3 = require("path");
    init_turnSignal();
    SILENCE_MS = 6e4;
    PRIORITY = ["unknown", "running", "done", "idle"];
    defaultIo = {
      stat: (path2) => import_fs3.promises.stat(path2),
      readTurnStart,
      readTurnSignal
    };
    startCache = /* @__PURE__ */ new Map();
    signalCache = /* @__PURE__ */ new Map();
    outputCache = /* @__PURE__ */ new Map();
  }
});

// packages/core/src/globalInject.ts
var globalInject_exports = {};
__export(globalInject_exports, {
  extractInvocationNum: () => extractInvocationNum,
  extractLastUserInput: () => extractLastUserInput,
  extractPromptFromStdin: () => extractPromptFromStdin,
  extractSessionIdFromStdin: () => extractSessionIdFromStdin
});
function parseStdin(stdinRaw) {
  if (!stdinRaw || !stdinRaw.trim()) return null;
  let obj;
  try {
    obj = JSON.parse(stdinRaw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  return obj;
}
function extractSessionIdFromStdin(stdinRaw, agent) {
  const rec = parseStdin(stdinRaw);
  if (!rec) return "";
  const keys = agent === "agy" ? ["conversationId", "conversation_id"] : agent === "codex" ? ["session_id"] : [];
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}
function extractPromptFromStdin(stdinRaw, agent) {
  if (agent !== "claude" && agent !== "codex") return "";
  const rec = parseStdin(stdinRaw);
  const v = rec?.prompt;
  return typeof v === "string" ? v : "";
}
function extractInvocationNum(stdinRaw) {
  const v = parseStdin(stdinRaw)?.invocationNum;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function extractLastUserInput(jsonlText) {
  const lines = String(jsonlText || "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let rec;
    try {
      const parsed = JSON.parse(line);
      rec = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      continue;
    }
    if (!rec || rec.type !== "USER_INPUT" || rec.source !== "USER_EXPLICIT") continue;
    const content = typeof rec.content === "string" ? rec.content : "";
    const m = content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
    return (m ? m[1] : content).trim();
  }
  return "";
}
var init_globalInject = __esm({
  "packages/core/src/globalInject.ts"() {
    "use strict";
  }
});

// packages/core/src/fileLock.ts
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function tryBreakStaleLock(lockDir) {
  let meta = null;
  try {
    meta = JSON.parse(await import_fs4.promises.readFile((0, import_path4.join)(lockDir, "meta.json"), "utf8"));
  } catch {
  }
  let stale;
  if (meta) {
    stale = !isPidAlive(meta.pid) || Date.now() - meta.acquiredAt > STALE_LOCK_MS;
  } else {
    try {
      const stat = await import_fs4.promises.stat(lockDir);
      stale = Date.now() - stat.mtimeMs > STALE_LOCK_MS;
    } catch {
      return true;
    }
  }
  if (!stale) return false;
  const tmpDir = `${lockDir}.breaking.${process.pid}.${Date.now()}`;
  try {
    await import_fs4.promises.rename(lockDir, tmpDir);
  } catch {
    return false;
  }
  await import_fs4.promises.rm(tmpDir, { recursive: true, force: true });
  return true;
}
async function withFileLock(targetDir, fn) {
  const lockDir = (0, import_path4.join)(targetDir, ".lock");
  await import_fs4.promises.mkdir(targetDir, { recursive: true });
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  let acquiredAt;
  for (; ; ) {
    try {
      await import_fs4.promises.mkdir(lockDir);
      acquiredAt = Date.now();
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const broken = await tryBreakStaleLock(lockDir);
      if (!broken) {
        if (Date.now() > deadline) {
          throw new Error(`fileLock: timeout acquiring ${lockDir}`);
        }
        await new Promise((r) => setTimeout(r, RETRY_INTERVAL_MS));
      }
    }
  }
  try {
    const meta = { pid: process.pid, acquiredAt };
    await import_fs4.promises.writeFile((0, import_path4.join)(lockDir, "meta.json"), JSON.stringify(meta), "utf8");
    return await fn();
  } finally {
    await import_fs4.promises.rm(lockDir, { recursive: true, force: true });
  }
}
var import_fs4, import_path4, RETRY_INTERVAL_MS, ACQUIRE_TIMEOUT_MS, STALE_LOCK_MS;
var init_fileLock = __esm({
  "packages/core/src/fileLock.ts"() {
    "use strict";
    import_fs4 = require("fs");
    import_path4 = require("path");
    RETRY_INTERVAL_MS = 50;
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
  return (0, import_path5.join)((0, import_os.homedir)(), "agentbridge");
}
var import_os, import_path5;
var init_storageRoot = __esm({
  "packages/core/src/storageRoot.ts"() {
    "use strict";
    import_os = require("os");
    import_path5 = require("path");
  }
});

// packages/core/src/globalPaths.ts
var globalPaths_exports = {};
__export(globalPaths_exports, {
  DEFAULT_PROFILE_ID: () => DEFAULT_PROFILE_ID,
  assertProfileSegment: () => assertProfileSegment,
  getGlobalDir: () => getGlobalDir,
  profileDir: () => profileDir,
  profileDocsDir: () => profileDocsDir,
  profileIndexPath: () => profileIndexPath,
  profileMetaPath: () => profileMetaPath,
  profilesRoot: () => profilesRoot,
  projectsRoot: () => projectsRoot,
  proposalsDir: () => proposalsDir
});
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
function profileMetaPath(globalDir, profileId, scope = "user") {
  return (0, import_node_path.join)(profileDir(globalDir, profileId, scope), "profile.json");
}
function profileIndexPath(globalDir, profileId, scope = "user") {
  return (0, import_node_path.join)(profileDir(globalDir, profileId, scope), "index.md");
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
function normalizeBody(raw, title) {
  let s = raw.trim();
  const titleLine = `# ${title.trim()}`;
  if (s.startsWith(titleLine)) s = s.slice(titleLine.length).trimStart();
  if (s.startsWith("## Summary")) {
    const next = s.match(/\n(?=## )/);
    s = next ? s.slice(next.index).trimStart() : "";
  }
  return s;
}
function renderDocMarkdown(doc) {
  const summary = String(doc.summary || "").trim();
  if (!summary) throw new Error("summary is required for every durable doc");
  const body = normalizeBody(String(doc.body || ""), doc.title);
  const entries = [...new Set(doc.indexEntries.map((e) => String(e || "").trim()).filter(Boolean))];
  return [
    `# ${doc.title.trim()}`,
    "",
    "## Summary",
    "",
    summary,
    "",
    ...doc.tags && doc.tags.length > 0 ? ["## Tags", "", ...doc.tags.map((t) => `- ${t}`), ""] : [],
    ...entries.length > 0 ? ["## Index Entries", "", ...entries.map((e) => `- ${e}`), ""] : [],
    "## Details",
    "",
    body || "(no details yet)",
    ""
  ].join("\n");
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
function renderIndexMarkdown(input) {
  const lines = ["# gc-tree global context index", "", `- profile: ${input.profileId}`, ""];
  if (input.docs.length === 0) {
    lines.push("- No durable docs yet.", "");
    return lines.join("\n");
  }
  const byCategory = /* @__PURE__ */ new Map();
  for (const doc of input.docs) {
    const cat = doc.category || "general";
    if (!byCategory.has(cat)) byCategory.set(cat, /* @__PURE__ */ new Map());
    const byPath = byCategory.get(cat);
    if (!byPath.has(doc.path)) byPath.set(doc.path, []);
    const label = doc.label.trim();
    if (label && !byPath.get(doc.path).includes(label)) byPath.get(doc.path).push(label);
  }
  const cats = [...byCategory.keys()].sort((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a);
    const bi = CATEGORY_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  for (const cat of cats) {
    lines.push(`## ${CATEGORY_LABELS[cat] || cat}`, "");
    const byPath = byCategory.get(cat);
    for (const [path2, labels] of [...byPath.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`- ${path2}`);
      for (const label of labels) lines.push(`  - ${label}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
var CATEGORY_LABELS, CATEGORY_ORDER;
var init_globalMarkdown = __esm({
  "packages/core/src/globalMarkdown.ts"() {
    "use strict";
    init_global();
    CATEGORY_LABELS = {
      role: "Role",
      repos: "Repos",
      domain: "Domain",
      workflows: "Workflows",
      conventions: "Conventions",
      infra: "Infra",
      verification: "Verification",
      general: "General"
    };
    CATEGORY_ORDER = [...GLOBAL_CATEGORIES, "general"];
  }
});

// packages/core/src/globalValidate.ts
function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function unknownKeys(rec, allowed) {
  return Object.keys(rec).filter((k) => !allowed.has(k));
}
function reqStr(rec, key, subject, cap) {
  const v = rec[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`Invalid global update: ${subject}.${key} must be a non-empty string.`);
  }
  if (v.length > cap) throw new Error(`Invalid global update: ${subject}.${key} exceeds ${cap} chars.`);
  return v.trim();
}
function validateSlug(slug, subject) {
  if (slug.endsWith(".md")) throw new Error(`Invalid global update: ${subject}.slug must omit ".md".`);
  if (slug.startsWith("/") || slug.includes("\\") || slug.includes("/") || slug.split("/").includes("..") || slug.includes("..")) {
    throw new Error(`Invalid global update: ${subject}.slug must be a single leaf without "/", "\\", "..", or absolute path.`);
  }
}
function validateBody(body, subject) {
  if (/^\s*#\s+/.test(body)) throw new Error(`Invalid global update: ${subject}.body must not include the top-level markdown title; use the title field.`);
  if (/^## Summary\b/m.test(body)) throw new Error(`Invalid global update: ${subject}.body must not include ## Summary; use the summary field.`);
  if (/^## Index Entries\b/m.test(body)) throw new Error(`Invalid global update: ${subject}.body must not include ## Index Entries; use the indexEntries array.`);
}
function validateGlobalUpdateInput(input) {
  if (!isRecord(input)) throw new Error("Invalid global update: root must be an object with docs[].");
  const extra = unknownKeys(input, ROOT_KEYS);
  if (extra.length) throw new Error(`Invalid global update: unsupported root field(s): ${extra.join(", ")}.`);
  if (!Array.isArray(input.docs) || input.docs.length === 0) {
    throw new Error("Invalid global update: docs must be a non-empty array.");
  }
  input.docs.forEach((doc, i) => {
    const subject = `docs[${i}]`;
    if (!isRecord(doc)) throw new Error(`Invalid global update: ${subject} must be an object.`);
    const extraKeys = unknownKeys(doc, DOC_KEYS);
    if (extraKeys.length) {
      const hints = extraKeys.map((k) => LEGACY_HINTS[k]).filter(Boolean);
      const suffix = hints.length ? ` ${[...new Set(hints)].join("; ")}.` : "";
      throw new Error(`Invalid global update: ${subject} has unsupported field(s): ${extraKeys.join(", ")}.${suffix}`);
    }
    reqStr(doc, "title", subject, DOC_CAPS.title);
    const slug = reqStr(doc, "slug", subject, 200);
    reqStr(doc, "summary", subject, DOC_CAPS.summary);
    if (typeof doc.body !== "string") throw new Error(`Invalid global update: ${subject}.body must be a string.`);
    if (doc.body.length > DOC_CAPS.body) throw new Error(`Invalid global update: ${subject}.body exceeds ${DOC_CAPS.body} chars.`);
    const body = doc.body;
    const category = reqStr(doc, "category", subject, 50);
    if (!CATS.has(category)) {
      throw new Error(`Invalid global update: ${subject}.category must be one of ${[...CATS].join(", ")}.`);
    }
    const entries = doc.indexEntries;
    if (!Array.isArray(entries) || entries.some((e) => typeof e !== "string") || entries.map((e) => e.trim()).filter(Boolean).length === 0) {
      throw new Error(`Invalid global update: ${subject}.indexEntries must be a non-empty array of search terms.`);
    }
    if (entries.length > DOC_CAPS.indexEntries) {
      throw new Error(`Invalid global update: ${subject}.indexEntries exceeds ${DOC_CAPS.indexEntries} entries.`);
    }
    if (doc.tags !== void 0 && (!Array.isArray(doc.tags) || doc.tags.some((t) => typeof t !== "string"))) {
      throw new Error(`Invalid global update: ${subject}.tags must be an array of strings when provided.`);
    }
    validateSlug(slug, subject);
    validateBody(body, subject);
  });
}
var CATS, ROOT_KEYS, DOC_KEYS, LEGACY_HINTS;
var init_globalValidate = __esm({
  "packages/core/src/globalValidate.ts"() {
    "use strict";
    init_global();
    CATS = new Set(GLOBAL_CATEGORIES);
    ROOT_KEYS = /* @__PURE__ */ new Set(["docs"]);
    DOC_KEYS = /* @__PURE__ */ new Set(["category", "slug", "title", "summary", "body", "indexEntries", "tags"]);
    LEGACY_HINTS = {
      content: "use `body` + put search terms in `indexEntries`",
      path: "use `category` + `slug`",
      id: "use `category` + `slug`"
    };
  }
});

// packages/core/src/globalStore.ts
var globalStore_exports = {};
__export(globalStore_exports, {
  ensureDefaultProfile: () => ensureDefaultProfile,
  ensureProfile: () => ensureProfile,
  readProfileDocs: () => readProfileDocs,
  resolveProfile: () => resolveProfile,
  writeIndexFromDocs: () => writeIndexFromDocs,
  writeProfileDocs: () => writeProfileDocs
});
function resolveProfile(_workspaceId) {
  return DEFAULT_PROFILE_ID;
}
async function ensureProfile(globalDir, profileId, scope = "user") {
  await withFileLock(globalDir, async () => {
    const dir = profileDir(globalDir, profileId, scope);
    try {
      await import_node_fs.promises.stat(dir);
      return;
    } catch {
    }
    const root = scope === "project" ? projectsRoot(globalDir) : profilesRoot(globalDir);
    await import_node_fs.promises.mkdir(root, { recursive: true });
    const tmp = (0, import_node_path2.join)(root, `.tmp-${profileId}-${process.pid}-${Date.now()}`);
    await import_node_fs.promises.rm(tmp, { recursive: true, force: true });
    await import_node_fs.promises.mkdir((0, import_node_path2.join)(tmp, "docs"), { recursive: true });
    await import_node_fs.promises.mkdir((0, import_node_path2.join)(tmp, "proposals"), { recursive: true });
    const now = (/* @__PURE__ */ new Date()).toISOString();
    await import_node_fs.promises.writeFile(
      (0, import_node_path2.join)(tmp, "profile.json"),
      JSON.stringify({ version: 1, name: profileId, summary: "", createdAt: now, updatedAt: now }, null, 2) + "\n",
      "utf8"
    );
    await import_node_fs.promises.writeFile((0, import_node_path2.join)(tmp, "index.md"), renderIndexMarkdown({ profileId, docs: [] }), "utf8");
    try {
      await import_node_fs.promises.rename(tmp, dir);
    } catch {
      await import_node_fs.promises.rm(tmp, { recursive: true, force: true });
    }
  });
}
function ensureDefaultProfile(globalDir) {
  return ensureProfile(globalDir, DEFAULT_PROFILE_ID);
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
async function writeIndexFromDocs(globalDir, profileId, scope = "user") {
  const docsDir = profileDocsDir(globalDir, profileId, scope);
  await import_node_fs.promises.mkdir(docsDir, { recursive: true });
  const files = (await listDocRelPaths(docsDir)).filter((f) => !/(^|\/)index\.md$/i.test(f));
  const docs = [];
  for (const file of files) {
    const raw = await import_node_fs.promises.readFile((0, import_node_path2.join)(docsDir, file), "utf8");
    const title = extractTitle(raw) || file.replace(/\.md$/i, "");
    const category = file.includes("/") ? file.split("/")[0] : "general";
    const entries = extractIndexEntries(raw);
    const labels = entries.length > 0 ? entries : [title];
    for (const label of [...new Set(labels)]) docs.push({ category, label, path: `docs/${file}` });
  }
  docs.sort((a, b) => a.label.localeCompare(b.label));
  const indexPath = profileIndexPath(globalDir, profileId, scope);
  await import_node_fs.promises.writeFile(indexPath, renderIndexMarkdown({ profileId, docs }), "utf8");
  return { indexPath, docCount: files.length };
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
async function writeProfileDocs(globalDir, profileId, input, scope = "user") {
  validateGlobalUpdateInput(input);
  await ensureProfile(globalDir, profileId, scope);
  return withFileLock(globalDir, async () => {
    const docsDir = profileDocsDir(globalDir, profileId, scope);
    const written = [];
    for (const doc of input.docs) {
      await import_node_fs.promises.mkdir((0, import_node_path2.join)(docsDir, doc.category), { recursive: true });
      const full = (0, import_node_path2.join)(docsDir, doc.category, `${doc.slug}.md`);
      await import_node_fs.promises.writeFile(full, renderDocMarkdown(doc), "utf8");
      written.push(full);
    }
    const { indexPath } = await writeIndexFromDocs(globalDir, profileId, scope);
    return { written, indexPath };
  });
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
  gateInjectionMatches: () => gateInjectionMatches,
  injectionFloor: () => injectionFloor,
  minimumUsefulScore: () => minimumUsefulScore,
  resolveContext: () => resolveContext,
  resolveInjection: () => resolveInjection,
  scoreDoc: () => scoreDoc,
  scoreDocGroups: () => scoreDocGroups,
  tokenizeQuery: () => tokenizeQuery,
  tokenizeQueryGroups: () => tokenizeQueryGroups,
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
function groupHits(text, group) {
  return group.some((tok) => countTokenMatches(text, [tok]) > 0) ? 1 : 0;
}
function scoreDocGroups(rec, groups) {
  const fields = [
    [rec.indexEntries.join(" "), 10],
    [rec.title, 7],
    [rec.summary, 5],
    [rec.category, 2],
    [`${rec.category}/${rec.slug}`, 2],
    [rec.body, 1]
  ];
  let score = 0;
  for (const group of groups) {
    for (const [text, weight] of fields) score += groupHits(text, group) * weight;
  }
  return score;
}
function injectionFloor(tokenCount) {
  return 4 * Math.sqrt(tokenCount);
}
function gateInjectionMatches(candidates, tokenCount) {
  const floor = injectionFloor(tokenCount);
  const passed = candidates.filter((c) => c.score >= floor && c.score > 0);
  if (passed.length === 0) return [];
  const top = Math.max(...passed.map((c) => c.score));
  return passed.filter((c) => c.score >= top * RELATIVE_FLOOR).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, MAX_MATCHES);
}
async function resolveInjection(globalDir, ids, query) {
  const groups = tokenizeQueryGroups(query);
  if (groups.length === 0) return [];
  const candidates = [];
  for (const [scope, profileId] of [
    ["user", ids.user],
    ["project", ids.project]
  ]) {
    if (!profileId) continue;
    const docs = await readProfileDocs(globalDir, profileId, scope).catch(() => []);
    for (const rec of docs) {
      candidates.push({
        scope,
        category: rec.category,
        slug: rec.slug,
        title: rec.title,
        score: scoreDocGroups(rec, groups)
      });
    }
  }
  return gateInjectionMatches(candidates, groups.length);
}
var STOP_WORDS, KOREAN_PARTICLES, HANGUL, RELATIVE_FLOOR, MAX_MATCHES;
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
    RELATIVE_FLOOR = 0.6;
    MAX_MATCHES = 3;
  }
});

// packages/core/src/workspaceId.ts
function canonicalWorkspacePath(folderFsPath) {
  let canonical;
  try {
    canonical = (0, import_fs5.realpathSync)(folderFsPath);
  } catch {
    canonical = (0, import_path6.resolve)(folderFsPath);
  }
  return canonical.normalize("NFC");
}
var import_fs5, import_path6;
var init_workspaceId = __esm({
  "packages/core/src/workspaceId.ts"() {
    "use strict";
    import_fs5 = require("fs");
    import_path6 = require("path");
  }
});

// packages/core/src/gitRemote.ts
var gitRemote_exports = {};
__export(gitRemote_exports, {
  adoptPathKeyedProject: () => adoptPathKeyedProject,
  normalizeRemoteUrl: () => normalizeRemoteUrl,
  profileIdForPath: () => profileIdForPath,
  profileIdForRemote: () => profileIdForRemote,
  readOriginUrl: () => readOriginUrl,
  resolveProjectProfileId: () => resolveProjectProfileId
});
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
function adoptPathKeyedProject(projectsRootDir, cwd, resolvedId, logger) {
  const log = logger ?? noopLogger;
  const pathId = profileIdForPath(cwd);
  if (resolvedId === pathId) return;
  const from = (0, import_node_path3.join)(projectsRootDir, pathId);
  const to = (0, import_node_path3.join)(projectsRootDir, resolvedId);
  if (!(0, import_node_fs2.existsSync)(from) || (0, import_node_fs2.existsSync)(to)) return;
  try {
    (0, import_node_fs2.renameSync)(from, to);
    log.log(`gitRemote: \uACBD\uB85C \uD0A4 \uD504\uB85C\uC81D\uD2B8 \uC9C0\uC2DD\uC744 remote \uD0A4\uB85C \uC62E\uACBC\uB2E4 \u2014 ${pathId} -> ${resolvedId}`);
  } catch (err) {
    log.warn(`gitRemote: \uD504\uB85C\uC81D\uD2B8 \uC9C0\uC2DD \uC774\uC804 \uC2E4\uD328 \u2014 ${err instanceof Error ? err.message : String(err)}`);
  }
}
var import_node_child_process, import_node_crypto, import_node_fs2, import_node_path3, GIT_TIMEOUT_MS, PROFILE_DIGEST_LEN, MAX_NAME_LEN, readOriginUrl;
var init_gitRemote = __esm({
  "packages/core/src/gitRemote.ts"() {
    "use strict";
    import_node_child_process = require("node:child_process");
    import_node_crypto = require("node:crypto");
    import_node_fs2 = require("node:fs");
    import_node_path3 = require("node:path");
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

// packages/core/src/turnCounter.ts
var turnCounter_exports = {};
__export(turnCounter_exports, {
  bumpTurnCount: () => bumpTurnCount,
  isProposalTurn: () => isProposalTurn,
  readTurnCount: () => readTurnCount,
  turnCountPath: () => turnCountPath
});
function turnCountPath(sessionDir) {
  return (0, import_node_path4.join)(sessionDir, "turn-count.json");
}
async function readTurnCount(sessionDir) {
  if (!sessionDir) return 0;
  try {
    const raw = await import_node_fs3.promises.readFile(turnCountPath(sessionDir), "utf8");
    const n = JSON.parse(raw).count;
    return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}
async function bumpTurnCount(sessionDir) {
  if (!sessionDir) return 0;
  const next = await readTurnCount(sessionDir) + 1;
  const file = turnCountPath(sessionDir);
  try {
    await import_node_fs3.promises.mkdir((0, import_node_path4.dirname)(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await import_node_fs3.promises.writeFile(tmp, JSON.stringify({ count: next, updatedAt: Date.now() }), "utf8");
    await import_node_fs3.promises.rename(tmp, file);
    return next;
  } catch {
    return 0;
  }
}
function isProposalTurn(count) {
  return count > 0 && count % PROPOSAL_EVERY === 0;
}
var import_node_fs3, import_node_path4, PROPOSAL_EVERY;
var init_turnCounter = __esm({
  "packages/core/src/turnCounter.ts"() {
    "use strict";
    import_node_fs3 = require("node:fs");
    import_node_path4 = require("node:path");
    PROPOSAL_EVERY = 5;
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
- **The turn started with a list of matching entries** \u2014 \`memory read <id>\` for
  the ones that bear on the question. That list carries titles only; the bodies
  are not in your prompt
- **Before recording anything** \u2014 read first, see below

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
    memory add --scope user|project --category <c> \\
        --title "..." --summary "..." --body "..."
    memory update <id> [same flags]

Categories: role, repos, domain, workflows, conventions, infra, verification.

## Subagents

You can run other coding agents as subagents. Each gets its own session and
tab; you give it work, it reports back, you read the report.

    agent start --prompt "..." [--harness claude,codex,agy] [--isolate]
    agent list                    the subs you started, and their state
    agent check [--wait] [--for <seconds>]
    agent read <name> [--last N]  that sub's full conversation
    agent diff <name> [--stat]    what that sub actually changed
    agent send <name> --prompt "..."
    agent merge <name>            put its changes into the real folder
    agent stop <name>             end it
    agent close <name>            end it and clean up what it left
    agent close --round           clean up the round: everything but the one
                                  you merged

\`agent start\` returns the names it issued \u2014 that is what the other commands
take. Default harness is claude; pass several to run the same prompt on each.

\`--isolate\` gives the sub its own git worktree, so several subs can edit files
without colliding. Skip it for research or review \u2014 a fresh checkout has no
dependencies and no instruction files, and paying that cost buys nothing when
nothing is edited. Isolated subs must be closed with \`agent close\` when the
round is over; that removes the worktree and its branch and tells you how to
recover the work.

When a round is over \u2014 you picked a result, or the work is dropped \u2014 call
\`agent close --round\`. It removes every sub you started except the most
recently merged one, which stays because it is the branch you adopted and the
one you are most likely to keep working with. The next \`--round\` takes that one
too. Calling it is how the subs from a round stop accumulating.

Reviewing a sub means putting two things side by side: what it says it did
(\`agent read\`) and what actually changed (\`agent diff\`). One without the other
is not a review. For a sub that ran without \`--isolate\`, the diff is the whole
folder as it stands now \u2014 your own edits and the user's are in there too.

\`agent merge\` takes an isolated sub's changes out of its worktree and lays them
on the real folder. All of them or none \u2014 if it cannot apply cleanly, nothing is
touched and you get the list of files that clashed. It does not commit, does not
move history, and does not end the sub. Partial picks are not supported: read
both diffs and write the combination yourself.

A sub does not tell you when it is done. Either \`agent check --wait\`, which
returns as soon as one finishes (up to a minute, \`--for\` raises it), or go do
something else \u2014 the next turn tells you how many finished subs are unread.
Reading a report with \`agent read\` is what clears that.

A sub can also go quiet without finishing: the user interrupted its turn, or it
is stuck waiting on something. \`check\` and the next-turn line both report those
separately from finished ones. That state is what we observed, not a verdict \u2014
read the sub to see how far it got, then send it more instructions or close it.

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

\`--summary\` is the conclusion \u2014 one or two sentences, what to do. \`--body\` is
the grounds: why it was decided, what it replaces, and the user's own wording
where the wording is the point. Do not paraphrase a phrasing preference.

### What counts as evidence

Weigh what you saw, in this order:

1. **What the user said.** Repetition, corrections (scope, order, wording), an
   interruption, a "do it again" \u2014 these are the signal.
2. **Tool output.** What a command actually printed beats what anyone assumed.
3. **What you said.** Weakest. Your turns record what you tried, not what the
   user wants.

Throw away: options that were discussed and not adopted; proposals you made
that the user did not take up; anything the repository already states (its
README, CLAUDE.md, the code itself); anything that only matters until this task
ends; and a restatement of something already recorded \u2014 that is
\`memory update <id>\`, not a second entry.

Record what would change how someone works next time.

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
    SKILL_VERSION = "0.6.0";
    SKILL_DIR_NAME = "agentbridge";
  }
});

// packages/core/bin/agentbridge-memory.js
var fs4 = require("fs");
var path = require("path");
var { isUnread: isUnread2 } = (init_reportState(), __toCommonJS(reportState_exports));
var { computeSessionActivity: computeSessionActivity2, readSessionActivityInputs: readSessionActivityInputs2 } = (init_sessionStatus(), __toCommonJS(sessionStatus_exports));
var {
  extractSessionIdFromStdin: extractSessionIdFromStdin2,
  extractPromptFromStdin: extractPromptFromStdin2,
  extractInvocationNum: extractInvocationNum2,
  extractLastUserInput: extractLastUserInput2
} = (init_globalInject(), __toCommonJS(globalInject_exports));
var { resolveInjection: resolveInjection2 } = (init_globalSearch(), __toCommonJS(globalSearch_exports));
var { getGlobalDir: getGlobalDir2 } = (init_globalPaths(), __toCommonJS(globalPaths_exports));
var { resolveProfile: resolveProfile2 } = (init_globalStore(), __toCommonJS(globalStore_exports));
var { resolveProjectProfileId: resolveProjectProfileId2 } = (init_gitRemote(), __toCommonJS(gitRemote_exports));
var { bumpTurnCount: bumpTurnCount2, readTurnCount: readTurnCount2, isProposalTurn: isProposalTurn2 } = (init_turnCounter(), __toCommonJS(turnCounter_exports));
var { wrapInjectedContext: wrapInjectedContext2 } = (init_contextTag(), __toCommonJS(contextTag_exports));
var { renderRunPrefix: renderRunPrefix2 } = (init_skillTemplate(), __toCommonJS(skillTemplate_exports));
var TERMINATION_EVENTS = /* @__PURE__ */ new Set(["Stop", "StopFailure"]);
var INJECTION_EVENTS = /* @__PURE__ */ new Set(["UserPromptSubmit", "PreInvocation"]);
function writeHookError(wsDir, agent, event, message) {
  try {
    const token = process.env.AGENTBRIDGE_WS_SESSION || "";
    if (!wsDir || !token || token !== path.basename(token)) return;
    const dir = path.join(wsDir, "sessions", token);
    fs4.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, "hook-error.json");
    const tmp = out + "." + process.pid + ".tmp";
    fs4.writeFileSync(tmp, JSON.stringify({ agent, event, message: String(message), at: Date.now() }));
    fs4.renameSync(tmp, out);
  } catch {
  }
}
function sessionDirOf(wsDir) {
  const token = process.env.AGENTBRIDGE_WS_SESSION || "";
  if (!wsDir || !token || token !== path.basename(token)) return "";
  return path.join(wsDir, "sessions", token);
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
  return new Promise((resolve2) => {
    if (process.stdin.isTTY) {
      resolve2("");
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
      resolve2(data);
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
async function buildSubagentBlocks(wsDir, sessionToken) {
  const none = { unread: "", stuck: "" };
  if (!sessionToken || sessionToken !== path.basename(sessionToken)) return none;
  let sessions = [];
  try {
    sessions = JSON.parse(fs4.readFileSync(path.join(wsDir, "workspace.json"), "utf8")).sessions || [];
  } catch {
    return none;
  }
  const mine = sessions.filter(
    (s) => s.parentSessionId === sessionToken && s.agentName && !s.cleanedAt
  );
  if (mine.length === 0) return none;
  const unread = [];
  const stuck = [];
  for (const s of mine) {
    if (await isUnread2(wsDir, s.sessionId)) {
      unread.push(s.agentName);
      continue;
    }
    if (s.closedAt !== null) continue;
    try {
      const inputs = await readSessionActivityInputs2(wsDir, s.sessionId);
      if (computeSessionActivity2(inputs, Date.now()) === "unknown") stuck.push(s.agentName);
    } catch {
    }
  }
  return {
    unread: unread.length === 0 ? "" : "Read the subagent reports with `agent read <name>`. " + unread.length + " finished and " + (unread.length === 1 ? "is" : "are") + " unread (" + unread.join(", ") + ").",
    stuck: stuck.length === 0 ? "" : 'Check the stalled subagents with `agent read <name>`, then send more instructions (`agent send <name> --prompt "..."`) or close them (`agent close <name>`). ' + stuck.length + " went quiet without finishing (" + stuck.join(", ") + "). The user may have interrupted them, or they may be stuck."
  };
}
function slugCarriesTitle(slug, title) {
  const norm = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9가-힣]/g, "");
  const withoutHash = String(slug || "").replace(/-[a-z0-9]{5,10}$/, "");
  return norm(withoutHash) === norm(title);
}
function buildMatchBlock(matches) {
  if (!matches || matches.length === 0) return "";
  const one = matches.length === 1;
  const lines = [
    "Read these before you answer, with `memory read <id>`. " + matches.length + (one ? " piece of long-term memory overlaps" : " pieces of long-term memory overlap") + " this prompt. Only the titles are here \u2014 the bodies are not.",
    ""
  ];
  for (const m of matches) {
    const id = m.category + "/" + m.slug;
    lines.push("- " + id + (slugCarriesTitle(m.slug, m.title) ? "" : " \u2014 " + m.title));
  }
  lines.push(
    "",
    "These were picked by word overlap, not by judgment. If a title is unrelated to what the",
    "user is actually asking, ignore it and do not read it."
  );
  return lines.join("\n");
}
function buildProposalBlock() {
  return [
    "Look back over the last five turns. If something came up that outlives this session,",
    "do these three in order.",
    "",
    "1. Is it worth recording? Would writing it down make whoever works here next do",
    "   better? If not, do nothing. In particular, do not record options that were not",
    "   adopted, or proposals you made yourself \u2014 only what the user accepted.",
    "",
    "2. What counts as signal? What the user repeated, what they corrected (scope, order,",
    "   wording), what they interrupted, what they told you to redo. Read preferences far",
    "   more from what the user said than from what you said. Your own turns are a record",
    "   of what you tried, not evidence of what the user wants.",
    "",
    '3. Record it. Check with `memory search "<query>"` first, and only when nothing covers',
    "   it, `memory add`."
  ].join("\n");
}
function buildInstructions(storageRoot, blocks) {
  const run = renderRunPrefix2({
    execPath: process.execPath,
    cliPath: path.join(storageRoot, "bin", "agentbridge.js")
  });
  const b = blocks || {};
  const out = [];
  const push = (...lines) => out.push(...lines);
  push(
    "AgentBridge does two things: it carries working context across sessions and across",
    "coding agents, and it runs other coding agents as subagents for you. Neither is in this",
    "prompt. You have to run a command.",
    "",
    "    " + run + " <command>",
    "",
    "The commands are in section 3.",
    "",
    "",
    "## 1. Context \u2014 `context` and `memory`",
    ""
  );
  const thisTurn = [b.matchBlock, b.proposalBlock].filter(Boolean);
  if (thisTurn.length > 0) {
    push("### 1-1. Do this turn", "");
    push(thisTurn.join("\n\n"), "");
  }
  push(
    "### 1-2. When to look",
    "",
    "Look by default. Skip only these three:",
    "",
    "- Questions needing no fact from outside this conversation, like the current time or date",
    "- A one-line translation, a wording fix, a one-line shell command, plain reformatting",
    "- Questions fully answered by what was already said in this conversation",
    "",
    "Everything else, look. In particular, always look when:",
    "",
    "- You are starting work on this project this session \u2014 `context`",
    "- The user asks about the IR, the working state, or the compacted context \u2014 `context`",
    '- The user points at something from before ("\uC544\uAE4C \uADF8\uAC70", "what we decided",',
    '  "continue where we left off") \u2014 `turns --last 5`',
    "- The user tells you to check what was said in another session, another tab, or another",
    '  agent ("agy\uC5D0\uC11C \uBB50\uB77C\uACE0 \uD588\uC5B4", "\uC544\uAE4C \uADF8 \uC138\uC158", "\uCF54\uB371\uC2A4 \uCABD \uD655\uC778\uD574") \u2014 `turns --last <N>`,',
    "  with N generous",
    "- The answer turns on the rationale of a past decision, or on how this user wants things",
    '  done (style, tooling, workflow, conventions) \u2014 `memory search "<query>"`',
    "- The question is about this repository's own rules or history \u2014 `memory project`",
    "- It is ambiguous and might depend on an earlier decision \u2014 look once, cheaply",
    "",
    "When the user tells you to check the conversation record, run the command first. Do not",
    "answer from a guess, do not work around it, do not ask back which one to look at.",
    "",
    "Once at the start of the turn is not the rule. If the same error keeps coming back",
    "mid-task, or the direction feels wrong, look again then.",
    "",
    "### 1-3. What you are looking at",
    "",
    "Every conversation in this project lands in one place. Not just the window you are in:",
    "other tabs, other CLIs (claude, codex, agy) and earlier sessions all go into the same",
    "record, in time order. `turns` is that raw record; `context` is the compacted working",
    "state (the IR) built from it.",
    "",
    "So `turns` is not you re-reading your own context. Conversations you have never seen are",
    "in there. Each turn is labeled with the CLI it came from.",
    "",
    "",
    "## 2. Other agent sessions",
    ""
  );
  const subTurn = [b.subUnread, b.subStuck].filter(Boolean);
  if (subTurn.length > 0) {
    push("### 2-1. Do this turn", "");
    push(subTurn.join("\n\n"), "");
  }
  push(
    "### 2-2. What they are",
    "",
    "You can run other coding agents as subagents. Each gets its own session and tab, takes",
    "the work you give it, and leaves a report. You pick the harness \u2014 claude, codex, agy.",
    "",
    "**These are not your own built-in subagent tool. Do not use that tool.**",
    "",
    'This is what the user means by: "\uC11C\uBE0C\uC5D0\uC774\uC804\uD2B8 \uB744\uC6CC", run it in another harness, a second',
    "opinion, run several in parallel, ask another model too.",
    "",
    "A subagent does not tell you when it is done. Ask with `agent check`, or the next turn's",
    "2-1 says how many are unread. Reading one with `agent read` is what clears it.",
    "",
    "### 2-3. After a report",
    "",
    "A review is the report and the actual changes side by side. One without the other is not",
    "a review. How to see the changes, how to take them, how to run several in isolation, and",
    "how to clean up a round are in the `agentbridge` skill.",
    "",
    "",
    "## 3. Commands",
    "",
    "Reading and recording.",
    "",
    "    context                    the working state (IR) \u2014 every session, compacted",
    "    turns --last <N>           the raw conversation, every session and CLI, in order",
    '    memory search "<query>"    search user knowledge and project knowledge together',
    "    memory read <id>           one entry in full. The id is <category>/<slug>",
    "    memory project             what is durable about this repository",
    "    memory add                 propose a new fact",
    "    memory update <id>         propose a change to an entry that already exists",
    "    status                     whether the wiring is alive, when a command fails",
    "",
    "`memory add` and `memory update` go to a queue the user approves.",
    "",
    "Subagents.",
    "",
    '    agent start --prompt "..." [--harness claude,codex,agy]',
    "    agent check                how they are doing",
    "    agent read <name>          that subagent's conversation",
    '    agent send <name> --prompt "..."',
    "    agent close <name>         end it and clean up what it left",
    "",
    "`turns` and `agent read` are not the same. `turns` is every conversation in this project;",
    "`agent read <name>` is one subagent you started. When the user says to check the session",
    "conversation, that is `turns`.",
    "",
    "This is not the whole list. Arguments and procedures are in the `agentbridge` skill. Open",
    "it when you pick a scope to record into, when you check for duplicates, and for anything",
    "in 2-3.",
    "",
    "",
    "## 4. When you answer",
    "",
    "When a fact comes from long-term memory and you did not verify it this turn, say so. It",
    "is a record from an earlier time \u2014 do not state it as though it is still true today.",
    "",
    "Answer in the language the user writes in. Mixed sessions follow the most recent turn."
  );
  return out.join("\n");
}
var TRANSCRIPT_TAIL_BYTES = 256 * 1024;
function readTranscriptTail(filePath) {
  if (!filePath) return "";
  let fd = null;
  try {
    const size = fs4.statSync(filePath).size;
    const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    const len = size - start;
    if (len <= 0) return "";
    const buf = Buffer.alloc(len);
    fd = fs4.openSync(filePath, "r");
    fs4.readSync(fd, buf, 0, len, start);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try {
        fs4.closeSync(fd);
      } catch {
      }
    }
  }
}
function resolveQuery(agent, stdinRaw) {
  if (agent !== "agy") return extractPromptFromStdin2(stdinRaw, agent);
  let transcriptPath = "";
  try {
    const p = JSON.parse(stdinRaw);
    transcriptPath = p && (p.transcriptPath || p.transcript_path) || "";
  } catch {
    return "";
  }
  return extractLastUserInput2(readTranscriptTail(transcriptPath));
}
async function matchesForQuery(storageRoot, wsDir, query) {
  if (!query || !query.trim()) return [];
  let projectId = null;
  try {
    const workspacePath = JSON.parse(
      fs4.readFileSync(path.join(wsDir, "workspace.json"), "utf8")
    ).workspacePath;
    if (typeof workspacePath === "string" && workspacePath) {
      projectId = await resolveProjectProfileId2(workspacePath);
    }
  } catch {
  }
  return resolveInjection2(
    getGlobalDir2(storageRoot),
    { user: resolveProfile2(path.basename(wsDir)), project: projectId },
    query
  );
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
      return fs4.realpathSync(v);
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
      fs4.mkdirSync(dir, { recursive: true });
      const out = path.join(dir, "captured.json");
      const tmp = out + "." + process.pid + ".tmp";
      fs4.writeFileSync(
        tmp,
        JSON.stringify({
          agent: parsed.agent,
          modelSessionId: sid,
          ppid: process.ppid,
          capturedAt: Date.now()
        })
      );
      fs4.renameSync(tmp, out);
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
        fs4.mkdirSync(dir, { recursive: true });
        const out = path.join(dir, "turn-start.json");
        const tmp = out + "." + process.pid + ".tmp";
        fs4.writeFileSync(
          tmp,
          JSON.stringify({ agent: parsed.agent, event: parsed.event, sessionId: sid, at: Date.now() })
        );
        fs4.renameSync(tmp, out);
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
        fs4.mkdirSync(dir, { recursive: true });
        const out = path.join(dir, "turn-signal.json");
        const tmp = out + "." + process.pid + ".tmp";
        fs4.writeFileSync(tmp, JSON.stringify(buildTurnSignal(parsed.agent, parsed.event, payload)));
        fs4.renameSync(tmp, out);
      }
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      process.stderr.write("agentbridge-memory: turn signal write skipped \u2014 " + msg + "\n");
      writeHookError(wsDir, parsed.agent, parsed.event, "\uD134 \uC885\uB8CC \uC2E0\uD638 \uC4F0\uAE30 \uC2E4\uD328 \u2014 " + msg);
    }
    if (parsed.event === "Stop") {
      try {
        await bumpTurnCount2(sessionDirOf(wsDir));
      } catch {
      }
    }
    process.stdout.write(JSON.stringify(buildTerminationOutput(parsed.agent)));
    process.exit(0);
  }
  if (parsed.agent === "agy") {
    const n = extractInvocationNum2(stdinRaw);
    if (n !== null && n !== 0) {
      process.stdout.write(JSON.stringify(buildHookOutput(parsed.agent, parsed.event, "")));
      process.exit(0);
    }
  }
  let matchBlock = "";
  try {
    matchBlock = buildMatchBlock(
      await matchesForQuery(storageRoot, wsDir, resolveQuery(parsed.agent, stdinRaw))
    );
  } catch (e) {
    process.stderr.write("agentbridge-memory: match skipped \u2014 " + String(e && e.message ? e.message : e) + "\n");
  }
  let proposalBlock = "";
  try {
    if (isProposalTurn2(await readTurnCount2(sessionDirOf(wsDir)))) proposalBlock = buildProposalBlock();
  } catch {
  }
  let subs = { unread: "", stuck: "" };
  try {
    subs = await buildSubagentBlocks(wsDir, process.env.AGENTBRIDGE_WS_SESSION || "");
  } catch {
  }
  process.stdout.write(
    JSON.stringify(
      buildHookOutput(
        parsed.agent,
        parsed.event,
        wrapInjectedContext2(
          buildInstructions(storageRoot, {
            matchBlock,
            proposalBlock,
            subUnread: subs.unread,
            subStuck: subs.stuck
          })
        )
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
    if (!additionalContext) return {};
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
