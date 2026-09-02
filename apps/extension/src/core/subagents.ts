// 서브에이전트 스폰과 수명 (0.5.0 4단계, B-6·B-7).
//
// 서브의 수명은 탭의 수명이다(B-2). 메인이 `agent start`를 부르면 탭이 함께 뜨고, 그 탭을 닫으면
// 서브가 끝난다. 그래서 스폰 경로는 메인 세션의 것을 그대로 타고, 다른 점은 셋뿐이다 —
// 레코드에 부모와 교량 이름이 붙고, 첫 프롬프트가 기동 인자로 들어가고, 포커스를 안 뺏는다.
//
// 순서가 고정이다. **레코드를 먼저 쓰고 그다음에 띄운다.** 격리(W6)가 붙으면 이 순서가 고아
// 판정의 근거가 된다 — 레코드 없이 남은 폴더만 비정상 종료의 흔적이 된다(B-7).
//
// 패널을 만드는 일 자체는 여기서 하지 않는다. 그 배선(닫힘 처리, 트리 갱신)이 extension.ts에
// 있고 메인 세션과 같아야 하므로, 그 함수를 주입받아 부른다.

import { join } from 'path';
import { randomUUID } from 'crypto';
import { promises as fsp } from 'fs';
import {
  deriveSessionTitle,
  issueBridgeName,
  listAgentBranches,
  runSessionNaming,
  buildSessionNamePrompt,
  parseSessionName,
  HOST_AGENT_START,
  HOST_AGENT_SEND,
  HOST_AGENT_STOP,
  HOST_AGENT_CLOSE,
  HOST_AGENT_MERGE,
  addWorktree,
  isGitRepo,
  trustWorkspace,
  trustFolder,
  listMissingPaths,
  buildIsolationPreamble,
  cleanupSubagent,
  renderReceipt,
  resolveTreePath,
  findOrphanTrees,
  mergeSubagent,
  renderMerge,
  planRoundCleanup,
  type NameUsage,
  type SpawnExtras,
  type HostRequest,
  type SpawnOptions,
  type CleanupReceipt,
} from '@agentbridge/core';
import { homedir } from 'os';
import type { CliKind } from '../shared/types';
import { getActivePanel, updateSessionTabTitle } from '../views/chatPanel';
import * as workspaceStore from './workspaceStore';
import { getWorkspaceStore, getCoreEnvProbe, getLogger, resolveRefineDecision } from './coreInstances';
import * as output from '../log/output';
import { registerRepo, unregisterRepo } from './scmView';

// 서브 이름을 짓는 헤드리스 호출 상한. 메인 세션의 자동 명명과 같은 값이다 — 첫 프롬프트 하나만
// 보내는 가벼운 호출이라 짧게 잡는다.
const SUBAGENT_NAMING_TIMEOUT_MS = 20_000;

export interface SubagentDeps {
  buildOpts: (
    model: CliKind,
    cwd: string,
    workspaceId: string,
    resumeSessionId?: string,
    resumeModelSessionId?: string,
    extras?: SpawnExtras,
  ) => Promise<SpawnOptions>;
  // 메인 세션과 같은 배선으로 탭을 연다. preserveFocus는 서브에서 참이다.
  openPanel: (opts: SpawnOptions, workspaceId: string, preserveFocus: boolean) => void;
  refreshTree: () => void;
}

let deps: SubagentDeps | null = null;

export function initSubagents(d: SubagentDeps): void {
  deps = d;
}

export interface SpawnRequest {
  workspaceId: string;
  // 이 서브를 띄운 메인 세션.
  parentSessionId: string;
  // 메인이 시키는 일. 첫 턴에 한 번 들어간다.
  prompt: string;
  // 같은 프롬프트로 띄울 하니스들. 하나일 수도 여럿일 수도 있다.
  harnesses: CliKind[];
  // 참이면 서브마다 새 worktree를 만들고 거기서 띄운다 (0.5.0 B-7). 기본은 원본이다 —
  // 새 폴더에는 git이 추적하는 것만 들어가므로 그것을 채우는 비용을 매번 치른다.
  isolate?: boolean;
}

export interface SpawnedSub {
  name: string;
  sessionId: string;
  model: CliKind;
}

// trees/ 아래에 실제로 있는 폴더. 격리(W6) 전에는 비어 있다.
async function treeFolders(workspaceId: string): Promise<string[]> {
  try {
    return await fsp.readdir(join(workspaceStore.getWorkspacePath(workspaceId), 'trees'));
  } catch {
    return [];
  }
}

// 이름이 비어 있는지 보는 세 자리 중 둘은 우리 레코드에서 온다 — 아직 정리 안 된 서브가 쓰는
// 이름과, 지금까지 쓴 이름의 마지막 사용 시각.
function nameSourcesFromSessions(
  sessions: { agentName?: string; closedAt: string | null; createdAt: string; lastChattedAt?: string }[],
): { live: string[]; usage: NameUsage[] } {
  const live: string[] = [];
  const usage: NameUsage[] = [];
  for (const s of sessions) {
    if (!s.agentName) continue;
    if (s.closedAt === null) live.push(s.agentName);
    const last = s.lastChattedAt ?? s.createdAt;
    usage.push({ name: s.agentName, lastUsedAt: Date.parse(last) || 0 });
  }
  return { live, usage };
}

// 한 번의 스폰이 쓸 이름들을 한꺼번에 발급한다. 발급이 호스트의 이 자리 하나로 모이므로
// 서브 여럿을 동시에 띄워도 같은 이름이 두 번 나가지 않는다(B-7).
async function issueNames(workspaceId: string, count: number, repoPath: string): Promise<string[]> {
  const meta = await getWorkspaceStore().loadWorkspace(workspaceId);
  const { live, usage } = nameSourcesFromSessions(meta.sessions);
  const folders = await treeFolders(workspaceId);
  let branches: string[] = [];
  try {
    branches = await listAgentBranches(repoPath);
  } catch (err) {
    // git이 없거나 저장소가 아니면 브랜치 축은 비어 있는 것으로 본다. 나머지 두 축이 남는다.
    output.warn(`subagents: 브랜치 목록 조회 실패 — ${String(err)}`);
  }

  const issued: string[] = [];
  for (let i = 0; i < count; i++) {
    const name = issueBridgeName({
      live: [...live, ...issued],
      folders,
      branches,
      usage,
    });
    issued.push(name);
  }
  return issued;
}

// 표시 이름 — 한 번의 스폰으로 묶인 서브들이 이름 하나를 공유하고 뒤에 모델명을 붙인다(B-7).
// 명명이 스폰을 막지 않도록 먼저 절단 이름으로 띄우고, 헤드리스 이름이 나오면 갱신한다.
function displayTitle(base: string, model: CliKind): string {
  return `${base}-${model}`;
}

async function renameBatch(
  workspaceId: string,
  subs: SpawnedSub[],
  base: string,
  onRenamed: (sessionId: string, title: string) => void,
): Promise<void> {
  for (const sub of subs) {
    const title = displayTitle(base, sub.model);
    try {
      await getWorkspaceStore().updateSessionMeta(workspaceId, sub.sessionId, { title });
      onRenamed(sub.sessionId, title);
    } catch {
      /* non-fatal — 절단 이름이 남는다 */
    }
  }
}

// 우리가 만든 폴더이므로 신뢰를 선점한다. 필요한 것은 agy 하나다 — claude는 저장소 단위로
// 판단해 worktree가 자동 통과하고 codex는 프롬프트가 뜨지 않았다(research 02 §2). 사용자가
// 만든 폴더에서는 이 우회를 하지 않는다(A-3).
async function prepareIsolatedWorkspace(treePath: string): Promise<void> {
  const home = homedir();
  // 신뢰를 못 넣어도 스폰은 진행한다. 그 세션에서 신뢰 창이 한 번 뜰 뿐이다.
  try {
    await trustWorkspace(treePath, home);
  } catch (err) {
    output.warn(`subagents: agy 신뢰 선점 실패 — ${String(err)}`);
  }
  // claude도 필요하다. 저장소 단위로 판단해 worktree가 통과할 것으로 봤는데 라이브에서 창이
  // 떴다 — 그 화면은 단일 키를 읽으므로 첫 프롬프트가 답으로 먹힌다.
  try {
    await trustFolder(treePath, home);
  } catch (err) {
    output.warn(`subagents: claude 신뢰 선점 실패 — ${String(err)}`);
  }
}

// 새 체크아웃에 없는 것들을 첫 프롬프트 앞에 알린다(B-8). 조용히 실패하는 쪽, 즉 지침 파일이
// 없는 상황만 다룬다 — 의존성은 시끄럽게 실패하므로 에이전트가 알아서 처리한다.
async function buildPreamble(repoPath: string, treePath: string): Promise<string> {
  try {
    const missing = await listMissingPaths(repoPath);
    return buildIsolationPreamble({ parentPath: repoPath, worktreePath: treePath, missing });
  } catch (err) {
    output.warn(`subagents: 결손 목록 조회 실패 — ${String(err)}`);
    return '';
  }
}

export async function spawnSubagents(req: SpawnRequest): Promise<SpawnedSub[]> {
  if (!deps) throw new Error('subagents: 초기화되지 않았다');
  if (req.harnesses.length === 0) throw new Error('subagents: 하니스가 비어 있다');
  if (!req.prompt.trim()) throw new Error('subagents: 프롬프트가 비어 있다');

  const store = getWorkspaceStore();
  const meta = await store.loadWorkspace(req.workspaceId);
  const cwd = meta.workspacePath;

  // 격리는 worktree를 만드는 일이라 git 저장소가 아니면 성립하지 않는다. 시작하기 전에 거절해야
  // 레코드도 세션도 안 남는다 — 중간에 실패하면 트리에 아무것도 아닌 행이 남는다.
  if (req.isolate && !(await isGitRepo(cwd))) {
    throw new Error(
      `이 프로젝트는 git 저장소가 아니라 격리할 수 없다 (${cwd}). --isolate 없이 띄우거나 먼저 git init 한다.`,
    );
  }

  const names = await issueNames(req.workspaceId, req.harnesses.length, cwd);

  // 명명이 스폰을 막지 않는다. 절단 이름으로 먼저 띄우고 헤드리스 이름은 나중에 얹는다.
  const fallbackBase = deriveSessionTitle(req.prompt) ?? 'agent';

  const spawned: SpawnedSub[] = [];
  for (let i = 0; i < req.harnesses.length; i++) {
    const model = req.harnesses[i];
    const name = names[i];

    // 레코드가 먼저다. 띄우다 실패해도 레코드는 남고, 레코드 없이 뜬 서브는 없다. 격리에서는
    // 이 순서가 고아 판정의 근거가 된다 — 레코드 없이 남은 폴더만 비정상 종료의 흔적이다(B-7).
    const sessionId = randomUUID();
    await store.addSession(req.workspaceId, model, 'cli', sessionId, {
      parentSessionId: req.parentSessionId,
      agentName: name,
    });

    // 격리를 골랐으면 여기서 폴더가 생긴다. 실패하면 그 서브만 접고 나머지는 계속 띄운다 —
    // 레코드는 이미 남아 있어 다음 정리가 주워 간다.
    let workDir = cwd;
    let preamble = '';
    if (req.isolate) {
      try {
        const treePath = resolveTreePath(workspaceStore.getWorkspacePath(req.workspaceId), name);
        await addWorktree(cwd, treePath, name);
        await prepareIsolatedWorkspace(treePath);
        preamble = await buildPreamble(cwd, treePath);
        workDir = treePath;
        // 사람이 서브의 변경을 보는 자리(B-9). 기다리지 않는다 — 확장이 아직 안 켜졌으면
        // 안에서 최대 10초를 기다리는데 그동안 스폰을 붙잡아 둘 이유가 없다.
        void registerRepo(treePath);
      } catch (err) {
        // 폴더를 못 만들었으면 그 서브는 아예 없던 것이다. 레코드를 닫아 두면 트리에 아무것도
        // 아닌 행이 남고 이름도 계속 물고 있게 된다.
        output.warn(`subagents: ${name} 격리 실패 — ${String(err)}`);
        await store.deleteSession(req.workspaceId, sessionId);
        continue;
      }
    }

    const opts = await deps.buildOpts(model, workDir, req.workspaceId, sessionId, undefined, {
      initialPrompt: preamble ? `${preamble}\n\n${req.prompt}` : req.prompt,
      parentSessionId: req.parentSessionId,
      freshSession: true,
    });
    // 제목을 지금 박는 이유는 둘이다. 트리에 이름 없는 행이 잠깐 뜨는 것을 막고, 세션별 자동
    // 명명이 서브마다 따로 도는 것을 막는다(그쪽은 제목이 비어 있을 때만 돈다).
    await store.updateSessionMeta(req.workspaceId, sessionId, {
      title: displayTitle(fallbackBase, model),
    });
    opts.terminalName = displayTitle(fallbackBase, model);

    deps.openPanel(opts, req.workspaceId, true);
    spawned.push({ name, sessionId, model });
    output.log(`subagents: ${name} (${model}) 스폰 — 부모 ${req.parentSessionId.slice(0, 8)}`);
  }

  // 새 탭은 메인과 같은 에디터 그룹에 합류하므로, 포커스를 안 뺏어도 화면에 보이는 탭이
  // 서브로 바뀐다. 메인을 다시 앞으로 보낸다 — 사용자는 서브를 띄우라고 했지 보겠다고 한 것이
  // 아니다. 서브 탭은 그 그룹에 그대로 남아 있고 트리와 탭 목록에서 언제든 열 수 있다.
  getActivePanel(req.parentSessionId)?.reveal(true);

  deps.refreshTree();

  // 헤드리스 명명은 스폰 한 번에 한 번이다. 실패해도 절단 이름이 남으므로 기다리지 않는다.
  void nameBatch(req, spawned, fallbackBase);

  return spawned;
}

async function nameBatch(req: SpawnRequest, spawned: SpawnedSub[], fallbackBase: string): Promise<void> {
  try {
    const choice = await runSessionNaming({
      decision: resolveRefineDecision(req.harnesses[0]),
      prompt: buildSessionNamePrompt({ userText: req.prompt }),
      envProbe: getCoreEnvProbe(),
      logger: { log: (m) => getLogger().log(m), warn: (m) => getLogger().warn(m) },
      timeoutMs: SUBAGENT_NAMING_TIMEOUT_MS,
    });
    const parsed = parseSessionName(choice.result.assistantText);
    const base = parsed.ok ? parsed.name : fallbackBase;
    if (base === fallbackBase) return;
    await renameBatch(req.workspaceId, spawned, base, updateSessionTabTitle);
    deps?.refreshTree();
  } catch (err) {
    output.warn(`subagents: 헤드리스 명명 실패 — ${String(err)}`);
  }
}

// ─── 호스트 처리기 (0.5.0 W3) ────────────────────────────────────────────
//
// CLI가 통로에 놓은 요청 넷을 여기서 받는다. 요청은 그 세션 폴더에 놓이므로 부르는 쪽이
// 누구인지는 경로가 말해준다 — 인자로 신원을 받지 않는다(B-5와 같은 규칙).

// <저장소>/workspaces/<워크스페이스 id>/sessions/<세션 id> → 둘로 가른다.
function callerFromSessionDir(sessionDir: string): { workspaceId: string; sessionId: string } {
  const parts = sessionDir.split(/[\\/]/).filter(Boolean);
  const sessionId = parts[parts.length - 1];
  const workspaceId = parts[parts.length - 3];
  if (!sessionId || !workspaceId) throw new Error(`요청 경로를 해석할 수 없다: ${sessionDir}`);
  return { workspaceId, sessionId };
}

function payloadOf(req: HostRequest): Record<string, unknown> {
  return (req.payload && typeof req.payload === 'object' ? req.payload : {}) as Record<string, unknown>;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

// 이름으로 서브를 찾는다. **부르는 세션의 자식만** 대상이다 — 남의 서브를 만질 자리가 없다.
async function findSub(
  workspaceId: string,
  parentSessionId: string,
  name: string,
): Promise<{ sessionId: string; model: CliKind }> {
  const meta = await getWorkspaceStore().loadWorkspace(workspaceId);
  const found = meta.sessions.find(
    (s) => s.agentName === name && s.parentSessionId === parentSessionId,
  );
  if (!found) throw new Error(`그런 서브가 없다: ${name}`);
  return { sessionId: found.sessionId, model: found.model };
}

async function handleStart(req: HostRequest, sessionDir: string): Promise<string> {
  const { workspaceId, sessionId } = callerFromSessionDir(sessionDir);
  const p = payloadOf(req);
  const prompt = str(p.prompt);
  if (!prompt) throw new Error('프롬프트가 비어 있다');
  const raw = Array.isArray(p.harnesses) ? p.harnesses.map(str).filter(Boolean) : [];
  const known: CliKind[] = ['claude', 'codex', 'agy'];
  const harnesses = (raw.length ? raw : [str(p.harness) || 'claude']).map((h) => {
    if (!known.includes(h as CliKind)) throw new Error(`모르는 하니스다: ${h}`);
    return h as CliKind;
  });

  const isolate = p.isolate === true;
  const spawned = await spawnSubagents({
    workspaceId,
    parentSessionId: sessionId,
    prompt,
    harnesses,
    isolate,
  });
  if (spawned.length === 0) throw new Error('서브를 하나도 띄우지 못했다');
  const lines = [
    `서브 ${spawned.length}개를 띄웠다${isolate ? ' (각자 새 worktree에서 돈다)' : ''}.`,
    '',
  ];
  for (const s of spawned) lines.push(`  ${s.name}  (${s.model})`);
  lines.push('', '보고는 `agent check`로 확인하고 `agent read <이름>`으로 읽는다.');
  if (isolate) lines.push('끝나면 `agent close <이름>`으로 정리한다 — 폴더와 브랜치가 함께 사라진다.');
  return lines.join('\n');
}

async function handleSend(req: HostRequest, sessionDir: string): Promise<string> {
  const { workspaceId, sessionId } = callerFromSessionDir(sessionDir);
  const p = payloadOf(req);
  const name = str(p.name);
  const prompt = str(p.prompt);
  if (!name) throw new Error('서브 이름이 없다');
  if (!prompt) throw new Error('프롬프트가 비어 있다');

  const sub = await findSub(workspaceId, sessionId, name);
  const panel = getActivePanel(sub.sessionId);
  if (!panel || !panel.alive) throw new Error(`${name}은 지금 도는 세션이 아니다. 탭이 닫혔으면 끝난 것이다.`);
  if (!panel.sendPrompt(prompt)) throw new Error(`${name}에 지침을 넣지 못했다`);
  return `${name}에 지침을 보냈다.`;
}

// ─── 정리 (0.5.0 W7) ─────────────────────────────────────────────────────
//
// 부르는 자리는 셋이고 들어가는 곳은 하나다 — `agent close`, 메인 세션 삭제의 캐스케이드,
// 트리의 삭제 액션. 어느 경로로 지우든 결과가 같아야 한다.
//
// 탭을 닫는 것은 여기가 아니다. 탭 닫힘은 세션을 끝낼 뿐이고 worktree는 그대로 남는다 —
// 탭이 닫혔는지는 삭제의 근거가 아니다(B-7).
export async function cleanupOne(
  workspaceId: string,
  sessionId: string,
  agentName: string,
): Promise<CleanupReceipt> {
  const store = getWorkspaceStore();
  const meta = await store.loadWorkspace(workspaceId);
  const wsDir = workspaceStore.getWorkspacePath(workspaceId);
  const treePath = resolveTreePath(wsDir, agentName);

  // 폴더를 지우기 전에 뷰에서 뗀다. 지운 뒤에 떼면 확장이 없는 경로를 들고 있는 구간이 생긴다.
  await unregisterRepo(treePath);

  return cleanupSubagent(
    { name: agentName, repoPath: meta.workspacePath, treePath },
    {
      stopSession: () => {
        const panel = getActivePanel(sessionId);
        if (panel) {
          panel.markDeleted(); // 정리가 레코드를 직접 닫으므로 패널의 닫힘 처리를 이중으로 태우지 않는다
          panel.dispose();
        }
      },
      sessionDir: workspaceStore.getSessionDir(workspaceId, sessionId),
      markClosed: async () => {
        const now = new Date().toISOString();
        await store.updateSessionMeta(workspaceId, sessionId, { closedAt: now, cleanedAt: now });
      },
    },
  );
}

// 라운드가 끝났을 때 (B-7 정리 시점 첫째). 가장 최근에 머지된 하나만 남기고 나머지를 지운다.
// 지우는 일 자체는 4단계의 정리 그대로이고 여기 얹히는 것은 부르는 규칙뿐이다.
export async function cleanupRound(
  workspaceId: string,
  parentSessionId: string,
): Promise<{ receipts: CleanupReceipt[]; kept?: string }> {
  const meta = await getWorkspaceStore().loadWorkspace(workspaceId);
  const plan = planRoundCleanup(
    meta.sessions
      .filter((s) => s.parentSessionId === parentSessionId && s.agentName)
      .map((s) => ({
        sessionId: s.sessionId,
        name: s.agentName as string,
        mergedAt: s.mergedAt,
        cleanedAt: s.cleanedAt,
        roundKeptAt: s.roundKeptAt,
      })),
  );

  const receipts: CleanupReceipt[] = [];
  for (const target of plan.remove) {
    receipts.push(await cleanupOne(workspaceId, target.sessionId, target.name));
  }
  // 남긴 것에 표시를 남긴다. 이 표시가 다음 라운드에서 그것을 지우는 근거다.
  if (plan.keep) {
    await getWorkspaceStore().updateSessionMeta(workspaceId, plan.keep.sessionId, {
      roundKeptAt: new Date().toISOString(),
    });
  }
  return { receipts, kept: plan.keep?.name };
}

// 메인 세션을 지울 때 그 아래 서브 전부. 레코드를 지우는 것은 되돌릴 수 없는 명시 행위이므로
// 함께 간다(B-7 정리 시점 둘째).
export async function cleanupChildrenOf(
  workspaceId: string,
  parentSessionId: string,
): Promise<CleanupReceipt[]> {
  const meta = await getWorkspaceStore().loadWorkspace(workspaceId);
  const children = meta.sessions.filter(
    (s) => s.parentSessionId === parentSessionId && s.agentName,
  );
  const receipts: CleanupReceipt[] = [];
  for (const child of children) {
    receipts.push(await cleanupOne(workspaceId, child.sessionId, child.agentName as string));
  }
  return receipts;
}

// 프로젝트를 열 때 도는 고아 스캔. 레코드가 아예 없는 폴더만 지운다 — 앱이 비정상 종료해
// 레코드를 못 쓴 흔적이다. 알릴 상대가 없는 시점이라 결과를 돌려주고, 보여주는 것은 호출처가
// 다음에 프로젝트를 열 때 한다(B-7 정리 시점 셋째).
export async function sweepOrphanTrees(workspaceId: string): Promise<string[]> {
  const store = getWorkspaceStore();
  const meta = await store.loadWorkspace(workspaceId);
  const wsDir = workspaceStore.getWorkspacePath(workspaceId);
  const known = meta.sessions.map((s) => s.agentName).filter((n): n is string => !!n);
  const orphans = await findOrphanTrees(wsDir, known);

  const swept: string[] = [];
  for (const name of orphans) {
    const receipt = await cleanupSubagent(
      { name, repoPath: meta.workspacePath, treePath: resolveTreePath(wsDir, name) },
      { stopSession: () => {}, markClosed: async () => {} },
    );
    if (receipt.ok) swept.push(name);
    else output.warn(`subagents: 고아 ${name} 정리 실패 — ${receipt.error}`);
  }
  return swept;
}

async function handleStop(req: HostRequest, sessionDir: string): Promise<string> {
  const { workspaceId, sessionId } = callerFromSessionDir(sessionDir);
  const name = str(payloadOf(req).name);
  if (!name) throw new Error('서브 이름이 없다');
  const sub = await findSub(workspaceId, sessionId, name);
  const panel = getActivePanel(sub.sessionId);
  if (!panel) return `${name}은 이미 끝나 있다.`;
  panel.dispose(); // 탭을 닫는 것과 같은 자리 — 어느 경로로 끝내든 결과가 같다
  deps?.refreshTree();
  return `${name}을 끝냈다.`;
}

// 머지가 호스트로 오는 이유는 PTY가 아니라 workspace.json이다 — 머지 표시의 소유자가 여기다.
// 그 표시를 라운드 정리가 읽어 무엇을 남길지 정한다(B-7 정리 시점 첫째).
async function handleMerge(req: HostRequest, sessionDir: string): Promise<string> {
  const { workspaceId, sessionId } = callerFromSessionDir(sessionDir);
  const name = str(payloadOf(req).name);
  if (!name) throw new Error('서브 이름이 없다');
  const sub = await findSub(workspaceId, sessionId, name);
  const store = getWorkspaceStore();
  const meta = await store.loadWorkspace(workspaceId);
  const wsDir = workspaceStore.getWorkspacePath(workspaceId);

  const result = await mergeSubagent(meta.workspacePath, resolveTreePath(wsDir, name));
  if (result.applied) {
    await store.updateSessionMeta(workspaceId, sub.sessionId, {
      mergedAt: new Date().toISOString(),
    });
  }
  return renderMerge(name, result);
}

async function handleClose(req: HostRequest, sessionDir: string): Promise<string> {
  const { workspaceId, sessionId } = callerFromSessionDir(sessionDir);
  if (payloadOf(req).round === true) {
    const { receipts, kept } = await cleanupRound(workspaceId, sessionId);
    deps?.refreshTree();
    if (receipts.length === 0 && !kept) return '지울 서브가 없다.';
    const lines = receipts.map(renderReceipt);
    if (kept) {
      lines.push(
        `${kept}은 남겼다 — 원본에 얹은 줄기라 이어서 시킬 수 있다. 다음 라운드를 정리할 때 함께 지워진다.`,
      );
    }
    return lines.join('\n\n');
  }
  const name = str(payloadOf(req).name);
  if (!name) throw new Error('서브 이름이 없다');
  const sub = await findSub(workspaceId, sessionId, name);
  const receipt = await cleanupOne(workspaceId, sub.sessionId, name);
  deps?.refreshTree();
  return renderReceipt(receipt);
}

export const subagentHostHandlers = {
  [HOST_AGENT_START]: handleStart,
  [HOST_AGENT_SEND]: handleSend,
  [HOST_AGENT_STOP]: handleStop,
  [HOST_AGENT_CLOSE]: handleClose,
  [HOST_AGENT_MERGE]: handleMerge,
};
