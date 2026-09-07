// 에이전트용 CLI의 쓰기 명령들 (0.5.0 3단계 W3).
//
// 장기 기억을 대화 중인 모델이 직접 남긴다. 다만 문서로 바로 가지 않고 제안 큐로 간다 —
// 사람 승인 없이 장기 기억이 늘지 않는다는 성질은 자동 추출에서 이미 지키고 있고, 쓰는
// 주체가 바뀌었다고 풀 이유가 없다(B-5).
//
// 중복은 규칙으로 막는다. 유사도 판정을 얹지 않고, "쓰려면 먼저 전부 읽는다. 없으면 add,
// 있으면 update"를 스킬에 싣는다. 그 시점의 모델은 전체 지식과 전체 대화를 함께 들고 있다.

import { GLOBAL_CATEGORIES, type GlobalCategory, type ProposalScope } from '../shared/global';
import { HOST_MEMORY_WRITE, sendHostRequest } from '../hostRequest';
import { getGlobalDir } from '../globalPaths';
import { readProfileDocs } from '../globalStore';
import { writeProposals } from '../proposalStore';
import type { SearchDocRecord } from '../globalSearch';

export type MemoryWriteFields = {
  title?: string;
  summary?: string;
  body?: string;
};

export class WriteError extends Error {}

function assertCategory(v: string | undefined): GlobalCategory {
  if (!v || !(GLOBAL_CATEGORIES as readonly string[]).includes(v)) {
    throw new WriteError(`--category는 다음 중 하나다: ${GLOBAL_CATEGORIES.join(', ')}`);
  }
  return v as GlobalCategory;
}

// 모델이 쓴 것은 추측이 아니라 단언이다. 자동 추출의 확신도와 같은 자리를 쓰되 값은 최대다.
const MODEL_WRITE_CONFIDENCE = 1;

function assertFilled(fields: MemoryWriteFields): void {
  for (const [name, v] of [
    ['--title', fields.title],
    ['--summary', fields.summary],
    ['--body', fields.body],
  ] as const) {
    if (!v || !v.trim()) throw new WriteError(`${name}이(가) 비어 있다`);
  }
}

export async function addMemory(
  storageRoot: string,
  profileId: string,
  scope: ProposalScope,
  category: string | undefined,
  fields: MemoryWriteFields,
): Promise<string> {
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
      title: fields.title!.trim(),
      summary: fields.summary!.trim(),
      body: fields.body!.trim(),
      confidence: MODEL_WRITE_CONFIDENCE,
    }],
    { existingDocTitles: docs.map((d) => ({ category: d.category, title: d.title })) },
    scope,
  );

  if (skipped.length > 0) {
    return `같은 제목이 이미 있다. 고치려면 memory update <식별자>를 쓴다.`;
  }
  return `제안 큐에 넣었다 (${written[0]!.id}). 사용자가 승인해야 지식이 된다.`;
}

// 식별자는 읽기 출력에 실린 `<카테고리>/<slug>`다. 새 체계를 만들지 않고 문서 자리를 그대로 쓴다.
function parseDocId(id: string): { category: string; slug: string } {
  const i = id.indexOf('/');
  if (i <= 0 || i === id.length - 1) {
    throw new WriteError('식별자는 <카테고리>/<slug> 형식이다. memory user로 목록을 본다');
  }
  return { category: id.slice(0, i), slug: id.slice(i + 1) };
}

export async function updateMemory(
  storageRoot: string,
  profileId: string,
  scope: ProposalScope,
  id: string,
  fields: MemoryWriteFields,
): Promise<string> {
  const { category, slug } = parseDocId(id);
  const globalDir = getGlobalDir(storageRoot);
  const docs = await readProfileDocs(globalDir, profileId, scope).catch(() => []);
  const target: SearchDocRecord | undefined = docs.find(
    (d) => d.category === category && d.slug === slug,
  );
  if (!target) throw new WriteError(`${id}에 해당하는 항목이 없다. memory user로 목록을 본다`);

  // 안 준 필드는 원래 값을 잇는다. 한 줄만 고치려고 전문을 다시 쓰게 하면 그 과정에서
  // 나머지가 바뀐다.
  const { written } = await writeProposals(
    globalDir,
    profileId,
    [{
      category: target.category as GlobalCategory,
      scope,
      title: (fields.title ?? target.title).trim(),
      summary: (fields.summary ?? target.summary).trim(),
      body: (fields.body ?? target.body).trim(),
      confidence: MODEL_WRITE_CONFIDENCE,
      ...(target.indexEntries.length ? { indexEntries: target.indexEntries } : {}),
      targetSlug: target.slug,
    }],
    { existingDocTitles: [] },
    scope,
  );

  return `고침 제안을 큐에 넣었다 (${written[0]!.id} → ${id}). 사용자가 승인해야 반영된다.`;
}

// ─── 호스트를 거치는 쓰기 ────────────────────────────────────────────────
//
// 쓰는 일 자체는 CLI가 할 수 있다. 그런데 그렇게 쓰면 화면이 그 사실을 모른다 — 제안 뱃지도
// 목록도 익스텐션이 들고 있고, 그쪽에서 다시 읽는 계기는 패널을 여는 것뿐이다. 쓰는 주체를
// 화면을 쥔 쪽으로 옮기면 쓰는 순간이 곧 갱신하는 순간이 된다.
//
// 겸사겸사 덮어쓰기 경합도 사라진다. 승인과 버림이 같은 파일을 다시 쓰는데, 그 둘도 익스텐션의
// 일이라 이제 한 프로세스 안에서 차례로 일어난다. (`agent merge`가 workspace.json 때문에
// 호스트를 거치는 것과 같은 이유의 다른 축이다.)

export type MemoryWriteRequest = {
  op: 'add' | 'update';
  scope: ProposalScope;
  profileId: string;
  category?: string;
  // op가 update일 때의 대상. `<카테고리>/<slug>`.
  id?: string;
  fields: MemoryWriteFields;
};

function optionalString(v: unknown, label: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new WriteError(`${label}은(는) 문자열이다`);
  return v;
}

// 봉투는 다른 프로세스에서 JSON으로 건너온다. 모양을 믿지 않고 확인한다.
//
// CLI도 보내기 전에 이것을 거친다. 잘못된 인자는 왕복 없이 그 자리에서 거절돼야 한다 —
// 호스트까지 갔다 와서 알려주면 모델은 10초를 기다린 뒤에야 오타를 안다.
export function parseMemoryWriteRequest(payload: unknown): MemoryWriteRequest {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new WriteError('쓰기 요청의 모양이 아니다');
  }
  const p = payload as Record<string, unknown>;
  if (p.op !== 'add' && p.op !== 'update') throw new WriteError(`알 수 없는 쓰기 종류다`);
  if (p.scope !== 'user' && p.scope !== 'project') throw new WriteError('--scope는 user 또는 project다');
  if (typeof p.profileId !== 'string' || !p.profileId) throw new WriteError('프로필 자리가 없다');
  const id = optionalString(p.id, 'id');
  if (p.op === 'update') {
    if (!id) throw new WriteError('고칠 항목의 식별자가 없다');
    parseDocId(id); // 형식이 아니면 여기서 거절한다
  }
  const rawFields = (p.fields ?? {}) as Record<string, unknown>;
  if (typeof rawFields !== 'object' || Array.isArray(rawFields)) throw new WriteError('필드의 모양이 아니다');
  const fields: MemoryWriteFields = {
    title: optionalString(rawFields.title, '--title'),
    summary: optionalString(rawFields.summary, '--summary'),
    body: optionalString(rawFields.body, '--body'),
  };
  // 새로 쓰는 것은 셋이 다 있어야 한다. 고치는 것은 안 준 필드를 원래 값으로 잇는다.
  let category: string | undefined = optionalString(p.category, '--category');
  if (p.op === 'add') {
    category = assertCategory(category);
    assertFilled(fields);
  }
  return { op: p.op, scope: p.scope, profileId: p.profileId, category, id, fields };
}

// 호스트 쪽. 확인된 봉투를 실제 쓰기로 옮긴다.
export function applyMemoryWrite(storageRoot: string, req: MemoryWriteRequest): Promise<string> {
  if (req.op === 'add') {
    return addMemory(storageRoot, req.profileId, req.scope, req.category, req.fields);
  }
  return updateMemory(storageRoot, req.profileId, req.scope, req.id!, req.fields);
}

// CLI 쪽. 호스트가 없으면 쓰지 않는다 — 여기서 몰래 직접 쓰면 화면과 어긋난 채로 쌓인다.
export async function requestMemoryWrite(
  sessionDir: string | undefined,
  raw: unknown,
): Promise<string> {
  const req = parseMemoryWriteRequest(raw);
  if (!sessionDir) {
    throw new WriteError('이 세션의 자리를 알 수 없어 쓰기를 넘기지 못했다. 앱 안에서 부른다.');
  }
  const result = await sendHostRequest(sessionDir, {
    id: `mem-${process.pid}-${Date.now()}`,
    kind: HOST_MEMORY_WRITE,
    at: Date.now(),
    payload: req,
  });
  // 호스트가 거절한 것은 여기서도 실패다. 성공과 같은 종료 코드로 내면 모델이 썼다고 믿는다.
  if (!result.ok) throw new WriteError(result.output);
  return result.output;
}
