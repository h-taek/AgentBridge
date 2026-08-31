// 에이전트용 CLI의 쓰기 명령들 (0.5.0 3단계 W3).
//
// 장기 기억을 대화 중인 모델이 직접 남긴다. 다만 문서로 바로 가지 않고 제안 큐로 간다 —
// 사람 승인 없이 장기 기억이 늘지 않는다는 성질은 자동 추출에서 이미 지키고 있고, 쓰는
// 주체가 바뀌었다고 풀 이유가 없다(B-5).
//
// 중복은 규칙으로 막는다. 유사도 판정을 얹지 않고, "쓰려면 먼저 전부 읽는다. 없으면 add,
// 있으면 update"를 스킬에 싣는다. 그 시점의 모델은 전체 지식과 전체 대화를 함께 들고 있다.

import { GLOBAL_CATEGORIES, type GlobalCategory, type ProposalScope } from '../shared/global';
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

export async function addMemory(
  storageRoot: string,
  profileId: string,
  scope: ProposalScope,
  category: string | undefined,
  fields: MemoryWriteFields,
): Promise<string> {
  const cat = assertCategory(category);
  for (const [name, v] of [
    ['--title', fields.title],
    ['--summary', fields.summary],
    ['--body', fields.body],
  ] as const) {
    if (!v || !v.trim()) throw new WriteError(`${name}이(가) 비어 있다`);
  }

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
