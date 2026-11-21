// 글로벌 컨텍스트 저장소 — gc-tree store.ts 이식 + withFileLock + atomic publish.
// 락 규율: ensureDefaultProfile / writeProfileDocs는 각자 withFileLock(globalDir)를 잡는다.
import { promises as fsp } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { withFileLock } from './fileLock';
import { DEFAULT_PROFILE_ID, profileDir, profilesRoot, projectsRoot, profileDocsDir } from './globalPaths';
import { renderDocMarkdown, extractTitle, extractSummary, extractIndexEntries } from './globalMarkdown';
import { validateGlobalUpdateInput } from './globalValidate';
import type { GlobalUpdateInput, ProposalScope } from './shared/global';
import type { SearchDocRecord } from './globalSearch';

// 사용자 프로필은 계속 하나다(default). 그 옆에 서는 프로젝트 프로필은 git remote로 정해지므로
// 워크스페이스 id가 아니라 폴더 경로가 필요하다 — resolveProjectProfileId(gitRemote.ts)가 맡는다.
export function resolveProfile(_workspaceId: string): string {
  return DEFAULT_PROFILE_ID;
}

// 프로필 골격을 만든다. 이미 있으면 무손상 반환(멱등).
// tmp 디렉토리에 완성 후 atomic rename publish(§A.3) — hook이 반쯤 만들어진 프로필을 읽는 일 방지.
export async function ensureProfile(
  globalDir: string,
  profileId: string,
  scope: ProposalScope = 'user',
): Promise<void> {
  await withFileLock(globalDir, async () => {
    const dir = profileDir(globalDir, profileId, scope); // 단일 세그먼트 검증 포함
    try {
      await fsp.stat(dir);
      return; // 이미 존재
    } catch {
      /* 없음 → 생성 */
    }
    const root = scope === 'project' ? projectsRoot(globalDir) : profilesRoot(globalDir);
    await fsp.mkdir(root, { recursive: true });
    const tmp = join(root, `.tmp-${profileId}-${process.pid}-${Date.now()}`);
    await fsp.rm(tmp, { recursive: true, force: true });
    await fsp.mkdir(join(tmp, 'docs'), { recursive: true });
    await fsp.mkdir(join(tmp, 'proposals'), { recursive: true });
    const now = new Date().toISOString();
    await fsp.writeFile(
      join(tmp, 'profile.json'),
      JSON.stringify({ version: 1, name: profileId, summary: '', createdAt: now, updatedAt: now }, null, 2) + '\n',
      'utf8',
    );
    try {
      await fsp.rename(tmp, dir);
    } catch {
      // 경합 패자(이미 누군가 publish) 또는 부분 실패 — tmp 정리
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });
}

export function ensureDefaultProfile(globalDir: string): Promise<void> {
  return ensureProfile(globalDir, DEFAULT_PROFILE_ID);
}

// docs/ 하위 .md를 재귀 나열 (상대 경로). gc-tree store.ts listDocRelativePaths 이식.
async function listDocRelPaths(dir: string, prefix = ''): Promise<string[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listDocRelPaths(join(dir, entry.name), rel)));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(rel);
  }
  return files.sort();
}

// `## Details` 앞부분만 봐서 본문 예시 안의 `## Tags`나 `- pinned`가 태그로 섞이지 않게 한다.
function extractTagsBeforeDetails(markdown: string): string[] {
  const lines = String(markdown || '').split(/\r?\n/);
  let inTags = false;
  const tags: string[] = [];
  for (const line of lines) {
    if (/^## Details(?:\s|$)/.test(line)) break;
    if (/^## /.test(line)) {
      inTags = /^## Tags(?:\s|$)/.test(line);
      continue;
    }
    if (inTags) {
      const trimmed = line.trim();
      if (trimmed.startsWith('- ')) {
        const tag = trimmed.slice(2).trim();
        if (tag) tags.push(tag);
      }
    }
  }
  return tags;
}

function isPinnedTagLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('- ') && trimmed.slice(2).trim() === 'pinned';
}

// `## Details` 앞의 `## Tags` 절에서만 `- pinned` 줄을 넣고 뺀다. 다른 절은 건드리지 않는다.
function updatePinnedInMarkdown(markdown: string, pinned: boolean): string {
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
  const lines = markdown.split(/\r?\n/);
  const detailsIdx = lines.findIndex((l) => /^## Details(?:\s|$)/.test(l));
  const limit = detailsIdx >= 0 ? detailsIdx : lines.length;

  let tagsStart = -1;
  let tagsEnd = limit;
  for (let i = 0; i < limit; i++) {
    if (/^## Tags(?:\s|$)/.test(lines[i]!)) {
      tagsStart = i;
      for (let j = i + 1; j < limit; j++) {
        if (/^## /.test(lines[j]!)) {
          tagsEnd = j;
          break;
        }
      }
      break;
    }
  }

  if (pinned) {
    if (tagsStart >= 0) {
      for (let i = tagsStart + 1; i < tagsEnd; i++) {
        if (isPinnedTagLine(lines[i]!)) return markdown;
      }
      let lastContent = -1;
      for (let i = tagsEnd - 1; i > tagsStart; i--) {
        if (lines[i]!.trim() !== '') {
          lastContent = i;
          break;
        }
      }
      if (lastContent >= 0) {
        lines.splice(lastContent + 1, 0, '- pinned');
      } else {
        const hasBlankAfterHeader = tagsStart + 1 < tagsEnd && lines[tagsStart + 1]!.trim() === '';
        if (hasBlankAfterHeader) {
          lines.splice(tagsStart + 2, 0, '- pinned', '');
        } else {
          lines.splice(tagsStart + 1, 0, '', '- pinned', '');
        }
      }
      return lines.join(eol);
    }

    // `## Tags` 절이 없으면 `## Summary` 절 끝(다음 `## ` 앞)에 새로 만든다.
    let insertAt = limit;
    const summaryIdx = lines.slice(0, limit).findIndex((l) => /^## Summary(?:\s|$)/.test(l));
    if (summaryIdx >= 0) {
      insertAt = limit;
      for (let i = summaryIdx + 1; i < limit; i++) {
        if (/^## /.test(lines[i]!)) {
          insertAt = i;
          break;
        }
      }
    }
    const block = ['## Tags', '', '- pinned', ''];
    if (insertAt > 0 && lines[insertAt - 1]!.trim() !== '') {
      block.unshift('');
    }
    lines.splice(insertAt, 0, ...block);
    return lines.join(eol);
  }

  if (tagsStart < 0) return markdown;
  const pinnedIndices: number[] = [];
  for (let i = tagsStart + 1; i < tagsEnd; i++) {
    if (isPinnedTagLine(lines[i]!)) pinnedIndices.push(i);
  }
  if (pinnedIndices.length === 0) return markdown;

  for (let k = pinnedIndices.length - 1; k >= 0; k--) {
    lines.splice(pinnedIndices[k]!, 1);
  }
  const newTagsEnd = tagsEnd - pinnedIndices.length;
  const hasRemainingContent = lines.slice(tagsStart + 1, newTagsEnd).some((l) => l.trim() !== '');
  if (!hasRemainingContent) {
    lines.splice(tagsStart, newTagsEnd - tagsStart);
  }
  return lines.join(eol);
}

// 프로필 docs/를 읽어 검색용 레코드로. 락 불요(읽기 전용).
export async function readProfileDocs(
  globalDir: string,
  profileId: string,
  scope: ProposalScope = 'user',
): Promise<SearchDocRecord[]> {
  const docsDir = profileDocsDir(globalDir, profileId, scope);
  const files = await listDocRelPaths(docsDir);
  const recs: SearchDocRecord[] = [];
  for (const file of files) {
    const fullPath = resolve(docsDir, file);
    const raw = await fsp.readFile(fullPath, 'utf8');
    const category = file.includes('/') ? file.split('/')[0]! : 'general';
    const slug = file.replace(/\.md$/i, '').split('/').slice(1).join('/') || file.replace(/\.md$/i, '');
    const detailsMatch = raw.match(/## Details\s+([\s\S]*?)$/);
    recs.push({
      category,
      slug,
      title: extractTitle(raw),
      summary: extractSummary(raw),
      indexEntries: extractIndexEntries(raw),
      body: detailsMatch?.[1]?.trim() || '',
      tags: extractTagsBeforeDetails(raw),
      path: fullPath,
    });
  }
  return recs;
}

// 검증 → 프로필 보장 → 문서 기록. 쓰기는 한 락 안에서.
export async function writeProfileDocs(
  globalDir: string,
  profileId: string,
  input: GlobalUpdateInput,
  scope: ProposalScope = 'user',
  opts?: { preserveTags?: boolean },
): Promise<{ written: string[] }> {
  validateGlobalUpdateInput(input);                 // 락 밖: 잘못된 입력이면 아무것도 안 만짐
  await ensureProfile(globalDir, profileId, scope); // 자기 락 (해제됨) — 아래 락과 중첩 아님
  return withFileLock(globalDir, async () => {
    const docsDir = profileDocsDir(globalDir, profileId, scope);
    const written: string[] = [];
    for (const doc of input.docs) {
      await fsp.mkdir(join(docsDir, doc.category), { recursive: true });
      const full = join(docsDir, doc.category, `${doc.slug}.md`);
      let docToWrite = doc;
      if (opts?.preserveTags) {
        // 잠금 안에서 덮어쓰기 직전에 읽어야 그 사이 들어온 핀 변경을 옛 태그로 덮지 않는다.
        const existingRaw = await fsp.readFile(full, 'utf8').catch(() => null);
        if (existingRaw !== null) {
          const existingTags = extractTagsBeforeDetails(existingRaw);
          if (existingTags.length > 0) {
            docToWrite = { ...doc, tags: [...new Set([...existingTags, ...(doc.tags ?? [])])] };
          }
        }
      }
      await fsp.writeFile(full, renderDocMarkdown(docToWrite), 'utf8');
      written.push(full);
    }
    return { written };
  });
}

// 문서의 `## Tags` 절에 `- pinned` 줄만 넣고 뺀다.
// writeProfileDocs를 부르면 색인 항목 검사·절 재구성으로 손으로 쓴 절이 깨지므로 파일 글자만 고친다.
export async function setDocPinned(
  globalDir: string,
  profileId: string,
  scope: ProposalScope,
  docPath: string,
  pinned: boolean,
): Promise<void> {
  const docsDir = resolve(profileDocsDir(globalDir, profileId, scope));
  const target = resolve(docPath);
  const rel = relative(docsDir, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !target.endsWith('.md')) {
    throw new Error(`Invalid docPath "${docPath}": must be a .md file inside profile docs.`);
  }
  await withFileLock(globalDir, async () => {
    const raw = await fsp.readFile(target, 'utf8');
    const next = updatePinnedInMarkdown(raw, pinned);
    if (next !== raw) {
      await fsp.writeFile(target, next, 'utf8');
    }
  });
}
