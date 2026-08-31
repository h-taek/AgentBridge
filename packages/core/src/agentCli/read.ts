// 에이전트용 CLI의 읽기 명령들 (0.5.0 3단계 W2).
//
// 맥락이 pull로 바뀌면서(B-4) 모델이 필요한 것만 골라 가져간다. 그래서 도구가 잘게 나뉜다 —
// 읽기 도구가 하나뿐이면 부를 때 뭉텅이가 돌아오고, 도구 결과도 대화에 쌓이므로 예산 문제가
// 자리만 옮긴다.
//
// 출력은 사람이 읽는 텍스트다. 소비자가 모델이라 그대로 맥락에 들어가는 편이 낫다(B-5).
// 지식 항목에는 식별자가 함께 실린다 — `memory update`가 무엇을 고칠지 지목해야 하기 때문이다.

import { promises as fsp } from 'fs';
import { join } from 'path';
import type { ProposalScope } from '../shared/global';
import type { SearchDocRecord } from '../globalSearch';
import { readIR } from '../irStore';
import { readAllTurns } from '../turnsStore';
import { readProfileDocs, resolveProfile } from '../globalStore';
import { getGlobalDir } from '../globalPaths';
import { resolveProjectProfileId } from '../gitRemote';
import { resolveContext } from '../globalSearch';
import { renderIrSections } from './irRender';

// ─── context ────────────────────────────────────────────────────────────

export async function readContext(wsDir: string): Promise<string> {
  const ir = await readIR(wsDir);
  if (!ir) return '저장된 작업 상태가 없다. 아직 압축된 맥락이 쌓이지 않았다.';
  return `## 작업 상태 (압축된 맥락)\n\n${renderIrSections(ir)}`;
}

// ─── turns ──────────────────────────────────────────────────────────────

export async function readTurns(wsDir: string, lastN: number): Promise<string> {
  const all = await readAllTurns(wsDir);
  if (all.length === 0) return '기록된 턴이 없다.';
  const turns = all.slice(-lastN);
  const lines = [`## 최근 대화 원문 (${turns.length}턴, 오래된 것부터)`, ''];
  for (const t of turns) {
    lines.push(`[${t.model || '?'} · ${t.completedAt || ''}]`);
    lines.push(`user: ${t.user || ''}`);
    lines.push(`assistant: ${t.assistantBody || ''}`);
    if (Array.isArray(t.toolCalls) && t.toolCalls.length > 0) {
      lines.push('tools:');
      for (const c of t.toolCalls) lines.push(`  - ${c.tool || '?'}(${c.arg || ''})`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

// ─── memory ─────────────────────────────────────────────────────────────

// 프로젝트 지식의 키는 정규화한 git remote다(없으면 폴더 경로). 워크스페이스 폴더는
// workspace.json이 안다 — CLI가 도는 셸의 cwd로 정하지 않는다. 에이전트가 하위 폴더로
// 옮겨 앉거나 worktree에서 도는 경우에 값이 달라지기 때문이다.
export async function resolveProfileIdForScope(
  wsDir: string,
  scope: ProposalScope,
): Promise<string | null> {
  return scope === 'project' ? resolveProjectId(wsDir) : resolveProfile(basenameOf(wsDir));
}

async function resolveProjectId(wsDir: string): Promise<string | null> {
  try {
    const raw = await fsp.readFile(join(wsDir, 'workspace.json'), 'utf8');
    const workspacePath = JSON.parse(raw)?.workspacePath;
    if (typeof workspacePath !== 'string' || !workspacePath) return null;
    return await resolveProjectProfileId(workspacePath);
  } catch {
    return null;
  }
}

function docId(rec: SearchDocRecord): string {
  return `${rec.category}/${rec.slug}`;
}

function renderDocs(docs: SearchDocRecord[], full: boolean): string {
  const byCategory = new Map<string, SearchDocRecord[]>();
  for (const d of docs) {
    if (!byCategory.has(d.category)) byCategory.set(d.category, []);
    byCategory.get(d.category)!.push(d);
  }
  const lines: string[] = [];
  for (const category of [...byCategory.keys()].sort()) {
    lines.push(`### ${category}`);
    for (const d of byCategory.get(category)!) {
      lines.push(`- ${docId(d)} — ${d.title}`);
      if (d.summary) lines.push(`  ${d.summary}`);
      if (full && d.body) lines.push(`  ${d.body.split('\n').join('\n  ')}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

const SCOPE_LABEL: Record<ProposalScope, string> = { user: '사용자 지식', project: '프로젝트 지식' };

export async function readMemory(
  storageRoot: string,
  wsDir: string,
  scope: ProposalScope,
  full: boolean,
): Promise<string> {
  const globalDir = getGlobalDir(storageRoot);
  const profileId = await resolveProfileIdForScope(wsDir, scope);
  if (!profileId) return '이 워크스페이스의 프로젝트 지식 자리를 찾을 수 없다.';

  const docs = await readProfileDocs(globalDir, profileId, scope).catch(() => []);
  if (docs.length === 0) return `${SCOPE_LABEL[scope]}이 아직 없다.`;

  const head = full
    ? `## ${SCOPE_LABEL[scope]} (${docs.length}건, 전문)`
    : `## ${SCOPE_LABEL[scope]} (${docs.length}건, 요약)\n\n줄 앞의 값이 식별자다. 전문은 --full로 본다.`;
  return `${head}\n\n${renderDocs(docs, full)}`;
}

function basenameOf(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

// ─── memory search ──────────────────────────────────────────────────────

export async function searchMemory(
  storageRoot: string,
  wsDir: string,
  query: string,
): Promise<string> {
  const globalDir = getGlobalDir(storageRoot);
  const userId = resolveProfile(basenameOf(wsDir));
  const projectId = await resolveProfileIdForScope(wsDir, 'project');

  const [user, project] = await Promise.all([
    resolveContext(globalDir, userId, query, { topN: 5 }).catch(() => []),
    projectId
      ? resolveContext(globalDir, projectId, query, { topN: 5, scope: 'project' }).catch(() => [])
      : Promise.resolve([]),
  ]);

  if (user.length === 0 && project.length === 0) return `"${query}"에 걸리는 지식이 없다.`;

  const lines = [`## "${query}" 검색 결과`, ''];
  for (const [scope, matches] of [
    ['user', user],
    ['project', project],
  ] as const) {
    if (matches.length === 0) continue;
    lines.push(`### ${SCOPE_LABEL[scope]}`);
    for (const m of matches) {
      lines.push(`- ${m.category}/${m.slug} — ${m.title}`);
      if (m.summary) lines.push(`  ${m.summary}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}
