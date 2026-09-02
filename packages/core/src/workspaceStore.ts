// 워크스페이스 메타 + workspace.json sessions[] 통합 관리.
//
// 2026-06-01 Phase 6: 데스크탑 패턴(workspace.json 내 sessions[] 배열) 채택.
// 2026-06-03 V-12: 결정적 워크스페이스 ID(UUID v5) 전환 — workspaces.json 장부 제거.
//   같은 폴더 → 같은 ID가 계산으로 보장되므로 매핑 파일이 필요 없다.
//   workspace.json read-modify-write는 파일 락(fileLock.ts)으로 프로세스 간 직렬화.
//
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
  promises as fsp,
} from 'fs';
import { join } from 'path';
import { CLI_DISPLAY_NAME, type CliKind } from './shared/cli';
import { type Logger, noopLogger } from './interfaces';
import { deterministicWorkspaceId, canonicalWorkspacePath } from './workspaceId';
import { withFileLock } from './fileLock';
import { getStorageRoot } from './storageRoot';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 폴더 이름으로 쓰이는 문자열이 경로를 벗어나지 않는지 본다. 0.5.0 전에는 workspaceId의
// UUID 형식 검사가 이 역할을 겸했는데, 이름이 UUID가 아니게 되면서 명시적 검사로 갈라졌다.
function isSafeSegment(v: string): boolean {
  return v.length > 0 && v !== '.' && v !== '..' && !/[\\/\u0000]/.test(v);
}

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
  // 이 세션을 띄운 부모 세션. 없으면 메인 세션이다 (0.5.0 B-2).
  parentSessionId?: string;
  // 서브에이전트에 발급한 교량 이름. 폴더(trees/<이름>)와 브랜치(agentbridge/<이름>)와 명령이
  // 받는 id를 겸한다 (0.5.0 B-7). 메인 세션에는 없다.
  agentName?: string;
  // 정리된 시각 (0.5.0 B-7). 레코드를 보존하는 이유는 이름 재사용의 마지막 사용 시각 하나뿐이라,
  // 정리된 서브는 트리와 목록에서 빠진다 — 화면에는 열 수도 이어갈 수도 없는 행이 남지 않는다.
  cleanedAt?: string;
  // 사용자가 이 세션을 마지막으로 연 시각(ISO). 완료 표시를 끄는 기준 (0.5.0 B-2).
  lastOpenedAt?: string;
  // 이 서브의 변경을 원본에 얹은 시각 (0.5.0 B-9). 라운드 정리가 무엇을 남길지 이 값으로 정한다
  // — 가장 최근에 머지된 하나만 남는다(B-7 정리 시점 첫째).
  mergedAt?: string;
  // 라운드 정리에서 남겨진 시각 (0.5.0 B-7). 한 번 남겨진 서브는 다음 라운드 정리에서 지워진다
  // — 정리를 부르는 시점이 곧 이전 라운드가 끝났다는 선언이라, 이 표시가 없으면 새 머지가 나올
  // 때까지 그 서브가 계속 남아 상한이 안 생긴다.
  roundKeptAt?: string;
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
  // 도는 중인 탭을 닫을 때 확인을 띄우지 않는다 — 사용자가 확인 창에서 고른 값. 레포 하나에만
  // 걸린다(0.5.0 6단계). 되돌리는 자리는 명령 하나다.
  closeConfirmDisabled?: boolean;
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
  parentSessionId: string | undefined;
  lastOpenedAt: string;
  agentName: string | undefined;
  cleanedAt: string;
  mergedAt: string;
  roundKeptAt: string;
}>;

export type WorkspaceUpdatePatch = Partial<{
  title: string;
  workspacePath: string;
  primarySessionId: string | null;
  compactionInProgress: WorkspaceMeta['compactionInProgress'];
  codexHookTrust: WorkspaceMeta['codexHookTrust'];
  closeConfirmDisabled: boolean;
}>;

// ─── WorkspaceStore 인터페이스 ─────────────────────────────────────────

export interface WorkspaceStore {
  // UUID 매핑
  getGlobalStoragePath(): string;
  getOrCreateWorkspaceId(folderFsPath: string): string;
  getWorkspacePath(workspaceId: string): string;
  getSessionDir(workspaceId: string, sessionId: string): string;

  // workspace 메타
  createWorkspace(args: { workspacePath: string; title?: string; initialModel?: CliKind; initialKind?: SessionKind }): Promise<WorkspaceMeta>;
  loadWorkspace(workspaceId: string): Promise<WorkspaceMeta>;
  updateWorkspaceMeta(workspaceId: string, patch: WorkspaceUpdatePatch): Promise<void>;
  deleteWorkspace(workspaceId: string): Promise<void>;
  listWorkspaces(): Promise<WorkspaceListEntry[]>;

  // 세션 관리 — sessions[]는 workspace.json 안에 통합 저장.
  // sessionId 생략 시 자체 발급. 호출처가 이미 AgentBridge 세션 ID를 발급한 경우(extension:
  // PTY/패널/webview state 키) 그 id를 넘겨 일관성 유지 — 후속 updateSessionMeta가 같은 id로
  // 매칭되게 한다 (V-04). 제공된 sessionId가 이미 있으면 기존 세션을 반환(중복 추가 방지).
  // init은 만들 때부터 붙어 있어야 하는 값이다. 서브는 레코드를 먼저 쓰고 그다음에 띄우므로
  // (0.5.0 B-7 고아 판정의 근거), 부모와 이름이 두 번째 쓰기로 뒤늦게 붙으면 그 사이에 죽은
  // 레코드가 부모 없는 메인 세션으로 남는다.
  addSession(
    workspaceId: string,
    model: CliKind,
    kind?: SessionKind,
    sessionId?: string,
    init?: { parentSessionId?: string; agentName?: string },
  ): Promise<SessionMeta>;
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
  // ⚠️ 테스트 전용 — 프로덕션 코드 사용 금지 (사용 시 V-12 재발).
  rootPathForTesting?: string;
};

// ─── 구현 ──────────────────────────────────────────────────────────────

export function createWorkspaceStore(opts: WorkspaceStoreOptions = {}): WorkspaceStore {
  const globalStoragePath = opts.rootPathForTesting ?? getStorageRoot();
  const log = opts.logger ?? noopLogger;
  const onAfterDeleteSession = opts.onAfterDeleteSession;
  mkdirSync(globalStoragePath, { recursive: true });
  mkdirSync(join(globalStoragePath, 'workspaces'), { recursive: true });

  // ── workspace.json read-modify-write 직렬화 ──
  // 1단계: in-process mutex (같은 인스턴스 내 직렬화 — 빠름)
  // 2단계: 파일 락 (프로세스/인스턴스 간 직렬화 — V-12)
  const writeMutex = new Map<string, Promise<unknown>>();
  async function withWorkspaceLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
    const prev = writeMutex.get(workspaceId) ?? Promise.resolve();
    const next: Promise<T> = prev
      .catch(() => undefined)
      .then(() => withFileLock(workspaceDir(workspaceId), fn));
    writeMutex.set(workspaceId, next);
    try {
      return await next;
    } finally {
      if (writeMutex.get(workspaceId) === next) writeMutex.delete(workspaceId);
    }
  }

  // ── workspace.json (메타 + sessions[]) ──
  function workspaceDir(workspaceId: string): string {
    if (!isSafeSegment(workspaceId)) {
      throw new Error(`workspaceStore: invalid workspaceId "${workspaceId}"`);
    }
    return join(globalStoragePath, 'workspaces', workspaceId);
  }
  function workspaceMetaPath(workspaceId: string): string {
    return join(workspaceDir(workspaceId), 'workspace.json');
  }

  // 폴더 이름의 다이제스트는 네 자라 같은 basename을 가진 두 저장소가 부딪힐 수 있다.
  // 부딪히면 조용히 같은 폴더를 쓰는 대신 거절한다 — 데이터 혼입이 눈에 보이는 오류가 된다.
  function assertNoDigestCollision(workspaceId: string, folderFsPath: string): void {
    let recorded: unknown;
    try {
      recorded = (JSON.parse(readFileSync(workspaceMetaPath(workspaceId), 'utf8')) as { workspacePath?: unknown })
        .workspacePath;
    } catch {
      return; // 메타를 못 읽으면 판단 근거가 없다. 기존 폴백 경로가 처리한다.
    }
    if (typeof recorded !== 'string' || recorded.length === 0) return;
    const mine = canonicalWorkspacePath(folderFsPath);
    const theirs = canonicalWorkspacePath(recorded);
    if (mine === theirs) return;
    throw new Error(
      `workspaceStore: workspace folder "${workspaceId}" already belongs to ${theirs}. ` +
        `Refusing to share it with ${mine}. Rename either project folder to get a different digest.`,
    );
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

  async function readWorkspaceMeta(workspaceId: string): Promise<WorkspaceMeta> {
    const p = workspaceMetaPath(workspaceId);
    const raw = await fsp.readFile(p, 'utf8');
    const parsed = JSON.parse(raw) as Partial<WorkspaceMeta>;

    // 빈 객체 또는 workspaceId 누락 — 옛 schema 흔적. 흡수 + 정상 초기화.
    const needsRepair = !parsed.workspaceId;
    let legacySessions: SessionMeta[] = [];
    if (needsRepair) {
      legacySessions = await tryReadLegacySessions(workspaceId);
      const folderPath = parsed.workspacePath; // 장부 제거로 역방향 조회 불가 — 파일 내 값만 사용
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
        closeConfirmDisabled: parsed.closeConfirmDisabled,
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
      const id = deterministicWorkspaceId(folderFsPath);
      const metaPath = workspaceMetaPath(id);
      // 이미 초기화된 워크스페이스면 그대로 반환.
      if (existsSync(metaPath)) {
        assertNoDigestCollision(id, folderFsPath);
        return id;
      }

      // workspace.json 초기화 — 호스트가 별도 createWorkspace를 호출하지 않아도(예: 익스텐션)
      // 다음 readWorkspaceMeta가 빈 객체를 보지 않게 함.
      // 주의: 두 호출이 동시에 이 분기에 들어올 수 있다(TOCTOU). getOrCreateWorkspaceId끼리는
      // 둘 다 같은 빈 메타를 atomic rename으로 쓰므로 무해하다. getOrCreateWorkspaceId(빈 sessions)와
      // createWorkspace(session 있음)가 같은 폴더에 동시 진입하면 빈 파일이 이기는 edge case가
      // 있으나, 익스텐션은 getOrCreate만·데스크탑은 createWorkspace만 쓰고 같은 폴더를 동시에
      // 처음 여는 경우는 없으므로 실제로 발생하지 않는다.
      mkdirSync(join(workspaceDir(id), 'sessions'), { recursive: true });
      const now = new Date().toISOString();
      const meta: WorkspaceMeta = {
        workspaceId: id,
        title: folderFsPath.split('/').pop() || id,
        createdAt: now,
        updatedAt: now,
        workspacePath: folderFsPath,
        sessions: [],
        primarySessionId: null,
        compactionInProgress: null,
      };
      const tmp = `${metaPath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf8');
      renameSync(tmp, metaPath);
      log.log(`workspaceStore: created id=${id} for ${folderFsPath}`);
      return id;
    },

    getWorkspacePath(workspaceId: string): string {
      return workspaceDir(workspaceId);
    },

    getSessionDir(workspaceId: string, sessionId: string): string {
      // 호출처 제공 id는 path.join에 그대로 쓰이므로 UUID 형식 강제 — traversal 방어.
      // (workspaceId는 sessionDir → workspaceDir에서 이미 검증)
      if (!UUID_RE.test(sessionId)) {
        throw new Error(`workspaceStore.getSessionDir: invalid sessionId "${sessionId}"`);
      }
      return sessionDir(workspaceId, sessionId);
    },

    // ── workspace 메타 ──
    async createWorkspace(args) {
      const workspaceId = deterministicWorkspaceId(args.workspacePath);
      if (existsSync(workspaceMetaPath(workspaceId))) {
        assertNoDigestCollision(workspaceId, args.workspacePath);
      }
      return withWorkspaceLock(workspaceId, async () => {
        // 결정적 ID — 같은 폴더로 재호출되면 기존 워크스페이스에 세션만 추가.
        // (데스크탑 V-23 중복 가드가 코어로 흡수됨)
        let meta: WorkspaceMeta;
        try {
          meta = await readWorkspaceMeta(workspaceId);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          // 파일 없음(ENOENT)만 새 메타 생성. 손상 파일(JSON 파싱 실패 등)은 re-throw —
          // 빈 메타로 덮어써 기존 sessions[]를 날리지 않는다.
          const now = new Date().toISOString();
          meta = {
            workspaceId,
            title: args.title ?? args.workspacePath.split('/').pop() ?? 'Workspace',
            createdAt: now,
            updatedAt: now,
            workspacePath: args.workspacePath,
            sessions: [],
            primarySessionId: null,
            compactionInProgress: null,
          };
        }

        if (args.initialModel) {
          const now = new Date().toISOString();
          const session: SessionMeta = {
            sessionId: randomUUID(),
            model: args.initialModel,
            modelSessionId: null,
            createdAt: now,
            closedAt: null,
            kind: args.initialKind ?? 'cli',
          };
          await fsp.mkdir(sessionDir(workspaceId, session.sessionId), { recursive: true });
          meta.sessions.push(session);
          if (!meta.primarySessionId) meta.primarySessionId = session.sessionId;
        }

        meta.updatedAt = new Date().toISOString();
        await fsp.mkdir(sessionsDir(workspaceId), { recursive: true });
        await writeWorkspaceMetaAtomic(meta);
        return meta;
      });
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
      });
    },

    async withLock(workspaceId, fn) {
      return withWorkspaceLock(workspaceId, fn);
    },

    async deleteWorkspace(workspaceId) {
      return withWorkspaceLock(workspaceId, async () => {
        await fsp.rm(workspaceDir(workspaceId), { recursive: true, force: true });
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
        if (!isSafeSegment(id) || id.startsWith('.')) continue;
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
    async addSession(workspaceId, model, kind = 'cli', sessionId, init) {
      const sid = sessionId ?? randomUUID();
      // 호출처 제공 id는 sessionDir(path.join)에 그대로 쓰이므로 UUID 형식 강제 — traversal 방어.
      if (!UUID_RE.test(sid)) {
        throw new Error(`workspaceStore.addSession: invalid sessionId "${sid}"`);
      }
      return withWorkspaceLock(workspaceId, async () => {
        const meta = await readWorkspaceMeta(workspaceId);
        // 같은 id가 이미 있으면 중복 추가 없이 기존 반환 (재등록 idempotent).
        const dup = meta.sessions.find((s) => s.sessionId === sid);
        if (dup) return dup;
        const now = new Date().toISOString();
        const session: SessionMeta = {
          sessionId: sid,
          model,
          modelSessionId: null,
          createdAt: now,
          closedAt: null,
          kind,
          ...(init?.parentSessionId ? { parentSessionId: init.parentSessionId } : {}),
          ...(init?.agentName ? { agentName: init.agentName } : {}),
        };
        await fsp.mkdir(sessionDir(workspaceId, sid), { recursive: true });
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
      let deletedSessions: SessionMeta[] = [];
      await withWorkspaceLock(workspaceId, async () => {
        const meta = await readWorkspaceMeta(workspaceId);
        const target = meta.sessions.find((s) => s.sessionId === sessionId);
        if (!target) return;
        // 자식·손자까지 재귀로 모은다 — 부모만 지우면 부모 없는 레코드가 남는다 (0.5.0 B-2).
        const toDelete = new Set<string>([sessionId]);
        let grew = true;
        while (grew) {
          grew = false;
          for (const s of meta.sessions) {
            if (s.parentSessionId && toDelete.has(s.parentSessionId) && !toDelete.has(s.sessionId)) {
              toDelete.add(s.sessionId);
              grew = true;
            }
          }
        }
        deletedSessions = meta.sessions.filter((s) => toDelete.has(s.sessionId));
        meta.sessions = meta.sessions.filter((s) => !toDelete.has(s.sessionId));
        if (meta.primarySessionId && toDelete.has(meta.primarySessionId)) meta.primarySessionId = null;
        meta.updatedAt = new Date().toISOString();
        await writeWorkspaceMetaAtomic(meta);
        for (const sid of toDelete) {
          await fsp.rm(sessionDir(workspaceId, sid), { recursive: true, force: true });
        }
      });
      if (onAfterDeleteSession) {
        for (const deleted of deletedSessions) {
          try {
            await onAfterDeleteSession(workspaceId, deleted);
          } catch (err) {
            log.warn(`workspaceStore: onAfterDeleteSession failed — ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    },
  };
}

// 호스트 헬퍼: 모델 → 기본 표시 이름.
export function defaultSessionTitle(model: CliKind): string {
  return CLI_DISPLAY_NAME[model];
}
