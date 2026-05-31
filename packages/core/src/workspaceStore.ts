// 워크스페이스 → UUID 매핑 + workspace.json sessions[] 통합 관리.
//
// 2026-06-01 Phase 6: 데스크탑 패턴(workspace.json 내 sessions[] 배열) 채택.
// 기존 core/sessionRegistry의 sessions.json 분리 패턴 폐기. workspaceStore가
// WorkspaceMeta + 세션 메타 일체를 하나의 atomic write로 관리한다.
//
// 호스트 차이 흡수: globalStoragePath만 호스트가 결정. 디렉토리 구조는 동일.
//   <storage>/workspaces.json                  — 경로 → workspaceId 매핑
//   <storage>/workspaces/<id>/workspace.json   — 워크스페이스 메타 + sessions[]
//   <storage>/workspaces/<id>/ir.json
//   <storage>/workspaces/<id>/turns.jsonl
//   <storage>/workspaces/<id>/archive/
//   <storage>/workspaces/<id>/sessions/<sid>/  — 세션별 replay.log 등 (메타는 통합 저장)

import { randomUUID } from 'crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  copyFileSync,
  promises as fsp,
} from 'fs';
import { join } from 'path';
import { CLI_DISPLAY_NAME, type CliKind } from './shared/cli';
import { type Logger, noopLogger } from './interfaces';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Schema (데스크탑 패턴 차용) ──────────────────────────────────────

export type SessionKind = 'cli' | 'shell';

export interface SessionMeta {
  sessionId: string;
  model: CliKind;
  // CLI native session ID. null = spawn 직후 비동기 캡처 대기 / shell 세션.
  modelSessionId: string | null;
  createdAt: string;
  // 닫혔는지 여부. UI는 closedAt이 null인 세션만 "활성 탭"으로 간주. 영구 보존.
  closedAt: string | null;
  // 사용자가 지정한 탭 이름. 없으면 모델명 fallback.
  title?: string;
  // 'shell'이면 일반 터미널 — 어댑터/hook/turnRecorder/IR refine 모두 bypass.
  kind?: SessionKind;
  // 가장 최근 채팅 시점. 탭 정렬용.
  lastChattedAt?: string;
}

export interface WorkspaceMeta {
  workspaceId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  // 사용자가 지정한 cwd.
  workspacePath: string;
  sessions: SessionMeta[];
  primarySessionId: string | null;
  // compactionScheduler 락.
  compactionInProgress: { pid: number; startedAt: number } | null;
  codexHookTrust?: 'pending' | 'trusted';
}

export interface WorkspaceListEntry {
  workspaceId: string;
  title: string;
  updatedAt: string;
  workspacePath: string;
}

export type SessionUpdatePatch = Partial<{
  modelSessionId: string | null;
  closedAt: string | null;
  title: string | undefined;
  lastChattedAt: string;
}>;

export type WorkspaceUpdatePatch = Partial<{
  title: string;
  workspacePath: string;
  primarySessionId: string | null;
  compactionInProgress: WorkspaceMeta['compactionInProgress'];
  codexHookTrust: WorkspaceMeta['codexHookTrust'];
}>;

// ─── WorkspaceStore 인터페이스 ─────────────────────────────────────────

export interface WorkspaceStore {
  // UUID 매핑
  getGlobalStoragePath(): string;
  getOrCreateWorkspaceId(folderFsPath: string): string;
  getWorkspacePath(workspaceId: string): string;

  // workspace 메타
  createWorkspace(args: { workspacePath: string; title?: string; initialModel?: CliKind; initialKind?: SessionKind }): Promise<WorkspaceMeta>;
  loadWorkspace(workspaceId: string): Promise<WorkspaceMeta>;
  updateWorkspaceMeta(workspaceId: string, patch: WorkspaceUpdatePatch): Promise<void>;
  deleteWorkspace(workspaceId: string): Promise<void>;
  listWorkspaces(): Promise<WorkspaceListEntry[]>;

  // 세션 관리 — sessions[]는 workspace.json 안에 통합 저장.
  addSession(workspaceId: string, model: CliKind, kind?: SessionKind): Promise<SessionMeta>;
  updateSessionMeta(workspaceId: string, sessionId: string, patch: SessionUpdatePatch): Promise<void>;
  loadSession(workspaceId: string, sessionId: string): Promise<SessionMeta>;
  deleteSession(workspaceId: string, sessionId: string): Promise<void>;

  // workspaceId 단위 read-modify-write 직렬화 — 호스트가 코어 외 부수 작업(IR/replay 등)을
  // workspace.json 갱신과 같은 임계영역에서 처리해야 할 때 사용.
  withLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T>;
}

export type WorkspaceStoreOptions = {
  logger?: Logger;
  // delete 후 호출 (attachment 청소, native session 파일 unlink 등). throw하지 않도록 caller 책임.
  onAfterDeleteSession?: (workspaceId: string, session: SessionMeta) => void | Promise<void>;
};

// ─── 구현 ──────────────────────────────────────────────────────────────

interface WorkspaceMap {
  [folderFsPath: string]: string;
}

export function createWorkspaceStore(
  globalStoragePath: string,
  opts: WorkspaceStoreOptions = {},
): WorkspaceStore {
  const log = opts.logger ?? noopLogger;
  const onAfterDeleteSession = opts.onAfterDeleteSession;
  mkdirSync(globalStoragePath, { recursive: true });
  mkdirSync(join(globalStoragePath, 'workspaces'), { recursive: true });

  // ── workspace.json read-modify-write 직렬화 mutex (workspaceId 단위) ──
  const writeMutex = new Map<string, Promise<unknown>>();
  async function withWorkspaceLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
    const prev = writeMutex.get(workspaceId) ?? Promise.resolve();
    const next: Promise<T> = prev.catch(() => undefined).then(() => fn());
    writeMutex.set(workspaceId, next);
    try {
      return await next;
    } finally {
      if (writeMutex.get(workspaceId) === next) writeMutex.delete(workspaceId);
    }
  }

  // ── workspaces.json (경로 매핑) ──
  function mapFilePath(): string {
    return join(globalStoragePath, 'workspaces.json');
  }
  function loadMap(): WorkspaceMap {
    const p = mapFilePath();
    if (!existsSync(p)) return {};
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch (err) {
      const backup = `${p}.broken.${Date.now()}.bak`;
      try {
        copyFileSync(p, backup);
        log.warn(`workspaceStore: corrupt workspaces.json backed up to ${backup}`);
      } catch {
        /* noop */
      }
      log.warn(`workspaceStore: workspaces.json reset — ${err instanceof Error ? err.message : String(err)}`);
      return {};
    }
  }
  function saveMap(map: WorkspaceMap): void {
    const p = mapFilePath();
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8');
    renameSync(tmp, p);
  }

  // ── workspace.json (메타 + sessions[]) ──
  function workspaceDir(workspaceId: string): string {
    if (!UUID_RE.test(workspaceId)) {
      throw new Error(`workspaceStore: invalid workspaceId "${workspaceId}"`);
    }
    return join(globalStoragePath, 'workspaces', workspaceId);
  }
  function workspaceMetaPath(workspaceId: string): string {
    return join(workspaceDir(workspaceId), 'workspace.json');
  }
  function sessionsDir(workspaceId: string): string {
    return join(workspaceDir(workspaceId), 'sessions');
  }
  function sessionDir(workspaceId: string, sessionId: string): string {
    return join(sessionsDir(workspaceId), sessionId);
  }

  // Phase 6.A/B 통합 직후 옛 익스텐션 데이터(`sessions.json` 분리 schema)를 안고 있는 사용자
  // 워크스페이스는 workspace.json이 `{}`로 남아 있을 수 있다. defensive fallback으로 필수
  // 필드를 채우고, 같은 디렉토리의 `sessions.json`이 있으면 한 번 흡수해서 sessions[]로 변환.
  // 흡수 후에는 정상 schema로 atomic write — 다음 호출부터는 폴백 경로 안 탐.
  type LegacySessionMeta = {
    sessionId?: unknown;
    workspaceId?: unknown;
    model?: unknown;
    name?: unknown;
    createdAt?: unknown;
    lastActiveAt?: unknown;
    active?: unknown;
    modelSessionId?: unknown;
  };

  async function tryReadLegacySessions(workspaceId: string): Promise<SessionMeta[]> {
    const p = join(workspaceDir(workspaceId), 'sessions.json');
    try {
      const raw = await fsp.readFile(p, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      const out: SessionMeta[] = [];
      for (const s of parsed as LegacySessionMeta[]) {
        if (typeof s !== 'object' || s === null) continue;
        if (typeof s.sessionId !== 'string' || !UUID_RE.test(s.sessionId)) continue;
        if (typeof s.model !== 'string') continue;
        out.push({
          sessionId: s.sessionId,
          model: s.model as CliKind,
          modelSessionId: typeof s.modelSessionId === 'string' ? s.modelSessionId : null,
          createdAt: typeof s.createdAt === 'string' ? s.createdAt : new Date().toISOString(),
          closedAt: s.active === false ? new Date().toISOString() : null,
          title: typeof s.name === 'string' ? s.name : undefined,
          kind: 'cli',
          lastChattedAt: typeof s.lastActiveAt === 'string' ? s.lastActiveAt : undefined,
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  function findPathByWorkspaceId(workspaceId: string): string | undefined {
    const map = loadMap();
    for (const [path, id] of Object.entries(map)) {
      if (id === workspaceId) return path;
    }
    return undefined;
  }

  async function readWorkspaceMeta(workspaceId: string): Promise<WorkspaceMeta> {
    const p = workspaceMetaPath(workspaceId);
    const raw = await fsp.readFile(p, 'utf8');
    const parsed = JSON.parse(raw) as Partial<WorkspaceMeta>;

    // 빈 객체 또는 workspaceId 누락 — 옛 schema 흔적. 흡수 + 정상 초기화.
    const needsRepair = !parsed.workspaceId;
    let legacySessions: SessionMeta[] = [];
    if (needsRepair) {
      legacySessions = await tryReadLegacySessions(workspaceId);
      const folderPath = findPathByWorkspaceId(workspaceId);
      const now = new Date().toISOString();
      const repaired: WorkspaceMeta = {
        workspaceId,
        title: parsed.title ?? folderPath?.split('/').pop() ?? `Workspace ${workspaceId.slice(0, 8)}`,
        createdAt: parsed.createdAt ?? legacySessions[0]?.createdAt ?? now,
        updatedAt: now,
        workspacePath: parsed.workspacePath ?? folderPath ?? '',
        sessions: legacySessions,
        primarySessionId: legacySessions.find((s) => s.closedAt === null)?.sessionId ?? legacySessions[0]?.sessionId ?? null,
        compactionInProgress: null,
        codexHookTrust: parsed.codexHookTrust,
      };
      // 옛 schema 흡수 시 atomic write — 다음 부팅부터는 fallback 안 탐.
      await writeWorkspaceMetaAtomic(repaired);
      log.log(
        `workspaceStore: repaired legacy workspace ${workspaceId.slice(0, 8)} (sessions imported=${legacySessions.length})`,
      );
      return repaired;
    }

    // 정상 schema — 누락된 보조 필드만 default.
    parsed.sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
    parsed.primarySessionId = parsed.primarySessionId ?? null;
    parsed.compactionInProgress = parsed.compactionInProgress ?? null;
    return parsed as WorkspaceMeta;
  }

  async function writeWorkspaceMetaAtomic(meta: WorkspaceMeta): Promise<void> {
    const p = workspaceMetaPath(meta.workspaceId);
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    await fsp.mkdir(workspaceDir(meta.workspaceId), { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(meta, null, 2), 'utf8');
    await fsp.rename(tmp, p);
  }

  return {
    // ── UUID 매핑 ──
    getGlobalStoragePath: () => globalStoragePath,

    getOrCreateWorkspaceId(folderFsPath: string): string {
      const map = loadMap();
      if (map[folderFsPath] && UUID_RE.test(map[folderFsPath])) {
        return map[folderFsPath];
      }
      const id = randomUUID();
      map[folderFsPath] = id;
      saveMap(map);
      mkdirSync(join(workspaceDir(id), 'sessions'), { recursive: true });
      // workspace.json 정상 초기화 — folderFsPath를 workspacePath로 사용.
      // 호스트가 별도 createWorkspace를 호출하지 않아도(예: 익스텐션) 다음 readWorkspaceMeta가
      // 빈 객체를 보지 않게 함. 옛 schema 흡수 경로는 readWorkspaceMeta의 repair fallback이 처리.
      const now = new Date().toISOString();
      const meta: WorkspaceMeta = {
        workspaceId: id,
        title: folderFsPath.split('/').pop() ?? `Workspace ${id.slice(0, 8)}`,
        createdAt: now,
        updatedAt: now,
        workspacePath: folderFsPath,
        sessions: [],
        primarySessionId: null,
        compactionInProgress: null,
      };
      const metaPath = workspaceMetaPath(id);
      const tmp = `${metaPath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf8');
      renameSync(tmp, metaPath);
      log.log(`workspaceStore: created id=${id} for ${folderFsPath}`);
      return id;
    },

    getWorkspacePath(workspaceId: string): string {
      return workspaceDir(workspaceId);
    },

    // ── workspace 메타 ──
    async createWorkspace(args) {
      const workspaceId = randomUUID();
      const now = new Date().toISOString();
      const sessions: SessionMeta[] = [];
      if (args.initialModel) {
        sessions.push({
          sessionId: randomUUID(),
          model: args.initialModel,
          modelSessionId: null,
          createdAt: now,
          closedAt: null,
          kind: args.initialKind ?? 'cli',
        });
      }
      const meta: WorkspaceMeta = {
        workspaceId,
        title: args.title ?? args.workspacePath.split('/').pop() ?? 'Workspace',
        createdAt: now,
        updatedAt: now,
        workspacePath: args.workspacePath,
        sessions,
        primarySessionId: sessions[0]?.sessionId ?? null,
        compactionInProgress: null,
      };
      await fsp.mkdir(sessionsDir(workspaceId), { recursive: true });
      for (const s of sessions) {
        await fsp.mkdir(sessionDir(workspaceId, s.sessionId), { recursive: true });
      }
      await writeWorkspaceMetaAtomic(meta);
      // workspaces.json folder→id 매핑도 같이 채워 두 진입점(createWorkspace,
      // getOrCreateWorkspaceId) 사이 storage 일관성 유지. 기존 매핑이 있으면 보존 —
      // 같은 폴더로 두 번 createWorkspace 부르면 첫 매핑만 유효 (정책: 중복 생성은 호스트 책임).
      const map = loadMap();
      if (!map[args.workspacePath]) {
        map[args.workspacePath] = workspaceId;
        saveMap(map);
      }
      return meta;
    },

    loadWorkspace: readWorkspaceMeta,

    async updateWorkspaceMeta(workspaceId, patch) {
      return withWorkspaceLock(workspaceId, async () => {
        const meta = await readWorkspaceMeta(workspaceId);
        const next: WorkspaceMeta = {
          ...meta,
          ...patch,
          workspaceId: meta.workspaceId,
          updatedAt: new Date().toISOString(),
        };
        await writeWorkspaceMetaAtomic(next);
        // workspacePath 변경 시 workspaces.json 매핑도 같은 락 안에서 갱신.
        if (patch.workspacePath !== undefined && patch.workspacePath !== meta.workspacePath) {
          const map = loadMap();
          for (const [k, v] of Object.entries(map)) {
            if (v === workspaceId) delete map[k];
          }
          map[patch.workspacePath] = workspaceId;
          saveMap(map);
        }
      });
    },

    async withLock(workspaceId, fn) {
      return withWorkspaceLock(workspaceId, fn);
    },

    async deleteWorkspace(workspaceId) {
      return withWorkspaceLock(workspaceId, async () => {
        await fsp.rm(workspaceDir(workspaceId), { recursive: true, force: true });
        const map = loadMap();
        for (const [k, v] of Object.entries(map)) {
          if (v === workspaceId) delete map[k];
        }
        saveMap(map);
      });
    },

    async listWorkspaces() {
      const root = join(globalStoragePath, 'workspaces');
      let ids: string[];
      try {
        ids = await fsp.readdir(root);
      } catch {
        return [];
      }
      const out: WorkspaceListEntry[] = [];
      for (const id of ids) {
        if (!UUID_RE.test(id)) continue;
        try {
          const m = await readWorkspaceMeta(id);
          out.push({
            workspaceId: m.workspaceId,
            title: m.title,
            updatedAt: m.updatedAt,
            workspacePath: m.workspacePath,
          });
        } catch {
          /* skip corrupt */
        }
      }
      return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    },

    // ── 세션 관리 ──
    async addSession(workspaceId, model, kind = 'cli') {
      return withWorkspaceLock(workspaceId, async () => {
        const meta = await readWorkspaceMeta(workspaceId);
        const now = new Date().toISOString();
        const session: SessionMeta = {
          sessionId: randomUUID(),
          model,
          modelSessionId: null,
          createdAt: now,
          closedAt: null,
          kind,
        };
        await fsp.mkdir(sessionDir(workspaceId, session.sessionId), { recursive: true });
        meta.sessions.push(session);
        meta.updatedAt = now;
        await writeWorkspaceMetaAtomic(meta);
        return session;
      });
    },

    async updateSessionMeta(workspaceId, sessionId, patch) {
      return withWorkspaceLock(workspaceId, async () => {
        const meta = await readWorkspaceMeta(workspaceId);
        const idx = meta.sessions.findIndex((s) => s.sessionId === sessionId);
        if (idx < 0) throw new Error(`session not found: ${sessionId}`);
        meta.sessions[idx] = { ...meta.sessions[idx], ...patch };
        meta.updatedAt = new Date().toISOString();
        await writeWorkspaceMetaAtomic(meta);
      });
    },

    async loadSession(workspaceId, sessionId) {
      const meta = await readWorkspaceMeta(workspaceId);
      const s = meta.sessions.find((x) => x.sessionId === sessionId);
      if (!s) throw new Error(`session not found: ${sessionId}`);
      return s;
    },

    async deleteSession(workspaceId, sessionId) {
      let deletedSession: SessionMeta | null = null;
      await withWorkspaceLock(workspaceId, async () => {
        const meta = await readWorkspaceMeta(workspaceId);
        const target = meta.sessions.find((s) => s.sessionId === sessionId);
        if (!target) return;
        deletedSession = target;
        meta.sessions = meta.sessions.filter((s) => s.sessionId !== sessionId);
        if (meta.primarySessionId === sessionId) meta.primarySessionId = null;
        meta.updatedAt = new Date().toISOString();
        await writeWorkspaceMetaAtomic(meta);
        await fsp.rm(sessionDir(workspaceId, sessionId), { recursive: true, force: true });
      });
      if (deletedSession && onAfterDeleteSession) {
        try {
          await onAfterDeleteSession(workspaceId, deletedSession);
        } catch (err) {
          log.warn(`workspaceStore: onAfterDeleteSession failed — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },
  };
}

// 호스트 헬퍼: 모델 → 기본 표시 이름.
export function defaultSessionTitle(model: CliKind): string {
  return CLI_DISPLAY_NAME[model];
}
