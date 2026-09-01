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
  type NameUsage,
  type HostRequest,
  type SpawnOptions,
} from '@agentbridge/core';
import type { CliKind } from '../shared/types';
import { getActivePanel, updateSessionTabTitle } from '../views/chatPanel';
import * as workspaceStore from './workspaceStore';
import { getWorkspaceStore, getCoreEnvProbe, getLogger, resolveRefineDecision } from './coreInstances';
import * as output from '../log/output';

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
    extras?: { initialPrompt?: string; parentSessionId?: string },
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

export async function spawnSubagents(req: SpawnRequest): Promise<SpawnedSub[]> {
  if (!deps) throw new Error('subagents: 초기화되지 않았다');
  if (req.harnesses.length === 0) throw new Error('subagents: 하니스가 비어 있다');
  if (!req.prompt.trim()) throw new Error('subagents: 프롬프트가 비어 있다');

  const store = getWorkspaceStore();
  const meta = await store.loadWorkspace(req.workspaceId);
  const cwd = meta.workspacePath;
  const names = await issueNames(req.workspaceId, req.harnesses.length, cwd);

  // 명명이 스폰을 막지 않는다. 절단 이름으로 먼저 띄우고 헤드리스 이름은 나중에 얹는다.
  const fallbackBase = deriveSessionTitle(req.prompt) ?? 'agent';

  const spawned: SpawnedSub[] = [];
  for (let i = 0; i < req.harnesses.length; i++) {
    const model = req.harnesses[i];
    const name = names[i];
    const opts = await deps.buildOpts(model, cwd, req.workspaceId, undefined, undefined, {
      initialPrompt: req.prompt,
      parentSessionId: req.parentSessionId,
    });

    // 레코드가 먼저다. 띄우다 실패해도 레코드는 남고, 레코드 없이 뜬 서브는 없다.
    await store.addSession(req.workspaceId, model, 'cli', opts.sessionId!, {
      parentSessionId: req.parentSessionId,
      agentName: name,
    });
    // 제목을 지금 박는 이유는 둘이다. 트리에 이름 없는 행이 잠깐 뜨는 것을 막고, 세션별 자동
    // 명명이 서브마다 따로 도는 것을 막는다(그쪽은 제목이 비어 있을 때만 돈다).
    await store.updateSessionMeta(req.workspaceId, opts.sessionId!, {
      title: displayTitle(fallbackBase, model),
    });
    opts.terminalName = displayTitle(fallbackBase, model);

    deps.openPanel(opts, req.workspaceId, true);
    spawned.push({ name, sessionId: opts.sessionId!, model });
    output.log(`subagents: ${name} (${model}) 스폰 — 부모 ${req.parentSessionId.slice(0, 8)}`);
  }

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

  const spawned = await spawnSubagents({ workspaceId, parentSessionId: sessionId, prompt, harnesses });
  const lines = [`서브 ${spawned.length}개를 띄웠다.`, ''];
  for (const s of spawned) lines.push(`  ${s.name}  (${s.model})`);
  lines.push('', '보고는 `agent check`로 확인하고 `agent read <이름>`으로 읽는다.');
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

// 정리(B-7의 여섯 단계)는 W7에서 이 자리에 들어온다. 그때까지는 끝내는 것까지만 한다 —
// 아직 만들 수 있는 worktree가 없으므로 지울 것도 없다.
async function handleClose(req: HostRequest, sessionDir: string): Promise<string> {
  return handleStop(req, sessionDir);
}

export const subagentHostHandlers = {
  [HOST_AGENT_START]: handleStart,
  [HOST_AGENT_SEND]: handleSend,
  [HOST_AGENT_STOP]: handleStop,
  [HOST_AGENT_CLOSE]: handleClose,
};
