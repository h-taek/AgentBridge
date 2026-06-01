// Agy(Antigravity) resume + 격리 cwd 잔재 청소.
//
// 저장 위치:
//   - conversations: `~/.gemini/antigravity-cli/conversations/<UUID>.pb` (protobuf)
//   - cwd→UUID 매핑: `~/.gemini/antigravity-cli/cache/last_conversations.json` (사용 안 함 — stale 가능)
//
// resume: `--conversation <UUID>`. 새 세션은 agy가 UUID 자체 생성 → spawn 후 conversations/ snapshot diff로 캡처.
//
// 잔재 청소: agy spawn은 cwd 기준으로 ~/.gemini 아래 9곳에 흔적을 남김. refine처럼 격리
// tmpdir에서 spawn하는 경우 종료 후 cleanupAgyArtifactsForCwd + rmIsolatedCwd로 정리해야 함.
// (이전엔 데스크탑 전용 구현 → 익스텐션 누락으로 잔재 누수. 2026-06-01 코어로 이동.)

import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Logger } from '../interfaces';
import { noopLogger } from '../interfaces';
import { deleteAgyNativeSession } from '../sessionRegistry';

const AGY_BASE_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli');

function getConversationsDir(): string {
  return path.join(AGY_BASE_DIR, 'conversations');
}

function getConversationFilePath(uuid: string): string {
  return path.join(getConversationsDir(), `${uuid}.pb`);
}

async function hasAgyConversationFile(modelSessionId: string): Promise<boolean> {
  try {
    const stat = await fs.stat(getConversationFilePath(modelSessionId));
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

export type ResumeResolveOptions = {
  sessionId: string | null;
  logger?: Logger;
};

export async function resolveResumeArgs(opts: ResumeResolveOptions): Promise<string[]> {
  const log = opts.logger ?? noopLogger;
  if (!opts.sessionId) {
    throw new Error(
      'agy resume — modelSessionId가 비어있습니다. 이 thread를 삭제하고 새 워크스페이스를 만드세요.',
    );
  }
  const exists = await hasAgyConversationFile(opts.sessionId);
  if (!exists) {
    throw new Error(
      `agy conversation ${opts.sessionId}을(를) ${getConversationsDir()}에서 찾을 수 없습니다 — 메시지 교환 전 닫힌 빈 세션은 agy가 영속화하지 않습니다.`,
    );
  }
  log.log(`agyResume: UUID 직접 전달 — ${opts.sessionId}`);
  return ['--conversation', opts.sessionId];
}

const UUID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.pb$/i;

export async function snapshotAgyConversations(): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const entries = await fs.readdir(getConversationsDir());
    for (const e of entries) {
      const m = UUID_RE.exec(e);
      if (m) out.add(m[1].toLowerCase());
    }
  } catch {
    /* dir 없으면 빈 set */
  }
  return out;
}

export async function watchForNewConversationUuid(opts: {
  cwd: string;
  excludeUuids: Set<string>;
  timeoutMs?: number;
  onCaptured: (uuid: string) => void;
  abortSignal?: AbortSignal;
  logger?: Logger;
}): Promise<void> {
  const log = opts.logger ?? noopLogger;
  const start = Date.now();
  const limit = opts.timeoutMs ?? 5 * 60_000;
  const interval = 1_000;
  while (!opts.abortSignal?.aborted) {
    const elapsed = Date.now() - start;
    if (elapsed > limit) {
      log.warn(`agyResume: modelSessionId 캡처 timeout cwd=${opts.cwd} elapsed=${elapsed}`);
      return;
    }
    try {
      const entries = await fs.readdir(getConversationsDir());
      let newest: { uuid: string; mtimeMs: number } | null = null;
      for (const e of entries) {
        const m = UUID_RE.exec(e);
        if (!m) continue;
        const uuid = m[1].toLowerCase();
        if (opts.excludeUuids.has(uuid)) continue;
        try {
          const stat = await fs.stat(path.join(getConversationsDir(), e));
          if (!stat.isFile() || stat.size === 0) continue;
          if (!newest || stat.mtimeMs > newest.mtimeMs) {
            newest = { uuid, mtimeMs: stat.mtimeMs };
          }
        } catch {
          /* skip */
        }
      }
      if (newest) {
        log.log(`agyResume: modelSessionId 캡처 완료 cwd=${opts.cwd} uuid=${newest.uuid}`);
        opts.onCaptured(newest.uuid);
        return;
      }
    } catch (err) {
      log.warn(`agyResume: scan failed — ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleepWithAbort(interval, opts.abortSignal);
  }
}

// === 격리 cwd 잔재 청소 (2026-05-31 실측 기반 9종) ===
// agy spawn은 cwd → 9곳에 흔적: (1) tmpdir 자체 (2) cache/last_conversations.json 매핑
// (3) conversations/<UUID>.pb (4) brain/<UUID>/ (5) implicit/<UUID>.pb (6) log/cli-*.log
// (7) ~/.gemini/config/projects/<UUID>.json (8) ~/.gemini/history/<cwd-basename>/
// (9) settings.json trustedWorkspaces[]. (6)은 진단 가치로 보존, (1)은 rmIsolatedCwd 별도.

function getImplicitDir(): string {
  return path.join(AGY_BASE_DIR, 'implicit');
}

function getLastConversationsCachePath(): string {
  return path.join(AGY_BASE_DIR, 'cache', 'last_conversations.json');
}

function getBrainDir(): string {
  return path.join(AGY_BASE_DIR, 'brain');
}

function getGeminiHomeDir(): string {
  return path.join(os.homedir(), '.gemini');
}

// macOS tmpdir 심볼릭 링크 보정 — join(tmpdir(), …)는 `/var/folders/…`를 주지만 agy는
// 심볼릭 링크를 해석한 실제 경로(`/private/var/folders/…`)로 cwd를 기록한다
// (last_conversations.json 실측 2026-06-01). 정확 일치 조회가 항상 빗나가므로 양쪽 형태 모두 후보로.
function cwdKeyCandidates(cwd: string): string[] {
  const out = [cwd];
  if (cwd.startsWith('/var/')) out.push(`/private${cwd}`);
  else if (cwd.startsWith('/private/')) out.push(cwd.slice('/private'.length));
  return out;
}

// (2) last_conversations.json의 cwd 키 제거. atomic rewrite. 매핑돼 있던 UUID 반환.
export async function removeLastConversationsEntry(
  cwd: string,
  logger: Logger = noopLogger,
): Promise<string | null> {
  const cachePath = getLastConversationsCachePath();
  let parsed: Record<string, string>;
  try {
    const raw = await fs.readFile(cachePath, 'utf8');
    parsed = JSON.parse(raw) as Record<string, string>;
  } catch {
    return null;
  }
  let uuid: string | null = null;
  for (const key of cwdKeyCandidates(cwd)) {
    const v = parsed[key];
    if (typeof v === 'string' && v.length > 0) {
      uuid = v;
      delete parsed[key];
    }
  }
  if (!uuid) return null;
  const tmp = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(parsed, null, 2), 'utf8');
    await fs.rename(tmp, cachePath);
    logger.log(`agyResume: last_conversations.json 엔트리 제거 — cwd=${cwd} uuid=${uuid}`);
  } catch (err) {
    logger.warn(`agyResume: last_conversations.json rewrite 실패 — cwd=${cwd} err=${String(err)}`);
    await fs.unlink(tmp).catch(() => undefined);
  }
  return uuid;
}

// (4) brain/<UUID>/ 폴더 전체 삭제. antigravity 데스크탑 사이드바가 brain transcript를 참조.
export async function deleteAgyBrainFolder(uuid: string, logger: Logger = noopLogger): Promise<void> {
  const dir = path.join(getBrainDir(), uuid);
  try {
    await fs.rm(dir, { recursive: true, force: true });
    logger.log(`agyResume: brain 폴더 삭제 — ${dir}`);
  } catch (err) {
    logger.warn(`agyResume: brain 폴더 삭제 실패 — ${dir} err=${String(err)}`);
  }
}

// (5) implicit/<UUID>.pb 직접 unlink.
export async function deleteAgyImplicitFile(uuid: string, logger: Logger = noopLogger): Promise<void> {
  const file = path.join(getImplicitDir(), `${uuid}.pb`);
  try {
    await fs.unlink(file);
    logger.log(`agyResume: implicit/<UUID>.pb 삭제 — ${file}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(`agyResume: implicit/<UUID>.pb 삭제 실패 — ${file} err=${String(err)}`);
    }
  }
}

// (7) ~/.gemini/config/projects/<UUID>.json 삭제. antigravity 데스크탑 Projects 사이드바의 출처.
export async function deleteGeminiConfigProjectFile(
  uuid: string,
  logger: Logger = noopLogger,
): Promise<void> {
  const file = path.join(getGeminiHomeDir(), 'config', 'projects', `${uuid}.json`);
  try {
    await fs.unlink(file);
    logger.log(`agyResume: config/projects/<UUID>.json 삭제 — ${file}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(`agyResume: config/projects/<UUID>.json 삭제 실패 — ${file} err=${String(err)}`);
    }
  }
}

// (8) ~/.gemini/history/<cwd-basename>/ 폴더 삭제. agy가 cwd마다 history 폴더를 만듦.
export async function deleteGeminiHistoryFolderForCwd(
  cwd: string,
  logger: Logger = noopLogger,
): Promise<void> {
  const base = path.basename(cwd);
  // 안전 가드: AgentBridge가 만든 격리 cwd 패턴만 정리.
  if (!base.startsWith('agentbridge-refine-') && !base.startsWith('agentbridge-quota-probe-')) {
    return;
  }
  const dir = path.join(getGeminiHomeDir(), 'history', base);
  try {
    await fs.rm(dir, { recursive: true, force: true });
    logger.log(`agyResume: history 폴더 삭제 — ${dir}`);
  } catch (err) {
    logger.warn(`agyResume: history 폴더 삭제 실패 — ${dir} err=${String(err)}`);
  }
}

// (9) antigravity-cli/settings.json의 trustedWorkspaces[]에서 cwd 항목 제거. atomic rewrite.
//     agy가 spawn 시 cwd를 trust 목록에 자동 등록하므로 격리 cwd는 제거해야 함.
export async function removeTrustedWorkspaceEntry(
  cwd: string,
  logger: Logger = noopLogger,
): Promise<void> {
  const settingsPath = path.join(AGY_BASE_DIR, 'settings.json');
  let parsed: { trustedWorkspaces?: string[]; [k: string]: unknown };
  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    parsed = JSON.parse(raw) as { trustedWorkspaces?: string[] };
  } catch {
    return;
  }
  if (!Array.isArray(parsed.trustedWorkspaces)) return;
  const before = parsed.trustedWorkspaces.length;
  const candidates = new Set(cwdKeyCandidates(cwd));
  parsed.trustedWorkspaces = parsed.trustedWorkspaces.filter((w) => !candidates.has(w));
  if (parsed.trustedWorkspaces.length === before) return;
  const tmp = `${settingsPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(parsed, null, 2), 'utf8');
    await fs.rename(tmp, settingsPath);
    logger.log(`agyResume: settings.json trustedWorkspaces 엔트리 제거 — ${cwd}`);
  } catch (err) {
    logger.warn(`agyResume: settings.json rewrite 실패 — cwd=${cwd} err=${String(err)}`);
    await fs.unlink(tmp).catch(() => undefined);
  }
}

// 통합 헬퍼 — 격리 cwd에서의 agy spawn 종료 직후 9곳 중 8곳을 한 번에 청소 (tmpdir 자체는
// rmIsolatedCwd가 별도). UUID 기반이라 spawn 전 snapshot 불필요. 호출 순서: last_conversations.json
// 등을 atomic rewrite하므로 await 직렬 처리.
export async function cleanupAgyArtifactsForCwd(
  cwd: string,
  logger: Logger = noopLogger,
): Promise<void> {
  // (2) cache 엔트리 제거하면서 UUID 회수
  const uuid = await removeLastConversationsEntry(cwd, logger);
  if (uuid) {
    // (3) conversations/<UUID>.pb
    await deleteAgyNativeSession(uuid, logger);
    // (4) brain/<UUID>/
    await deleteAgyBrainFolder(uuid, logger);
    // (5) implicit/<UUID>.pb
    await deleteAgyImplicitFile(uuid, logger);
    // (7) config/projects/<UUID>.json
    await deleteGeminiConfigProjectFile(uuid, logger);
  }
  // (8) history/<basename>/
  await deleteGeminiHistoryFolderForCwd(cwd, logger);
  // (9) settings.json trustedWorkspaces[]
  await removeTrustedWorkspaceEntry(cwd, logger);
}

// (1) 격리 tmpdir 자체 삭제 — 호출자가 lifecycle을 알 때 사용.
export async function rmIsolatedCwd(cwd: string, logger: Logger = noopLogger): Promise<void> {
  try {
    await fs.rm(cwd, { recursive: true, force: true });
    logger.log(`agyResume: isolated tmpdir 삭제 — ${cwd}`);
  } catch (err) {
    logger.warn(`agyResume: isolated tmpdir 삭제 실패 — ${cwd} err=${String(err)}`);
  }
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
