// 글로벌 컨텍스트 저장소 — gc-tree store.ts 이식 + withFileLock + atomic publish.
// 락 규율: ensureDefaultProfile / writeProfileDocs는 각자 withFileLock(globalDir)를 잡는다.
//   writeIndexFromDocs는 락 없음(호출자가 락을 쥔 상태에서만 호출) — 같은 dir 락 중첩은 self-deadlock.
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

import { withFileLock } from './fileLock';
import { DEFAULT_PROFILE_ID, profileDir, profilesRoot, projectsRoot, profileDocsDir, profileIndexPath } from './globalPaths';
import { renderIndexMarkdown, renderDocMarkdown, extractTitle, extractSummary, extractIndexEntries } from './globalMarkdown';
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
    await fsp.writeFile(join(tmp, 'index.md'), renderIndexMarkdown({ profileId, docs: [] }), 'utf8');
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

// docs/를 스캔해 index.md 재생성. ⚠️ 락 없음 — 호출자가 withFileLock(globalDir)를 쥔 상태에서만 호출.
export async function writeIndexFromDocs(
  globalDir: string,
  profileId: string,
  scope: ProposalScope = 'user',
): Promise<{ indexPath: string; docCount: number }> {
  const docsDir = profileDocsDir(globalDir, profileId, scope);
  await fsp.mkdir(docsDir, { recursive: true });
  const files = (await listDocRelPaths(docsDir)).filter((f) => !/(^|\/)index\.md$/i.test(f));
  const docs: Array<{ category: string; label: string; path: string }> = [];
  for (const file of files) {
    const raw = await fsp.readFile(join(docsDir, file), 'utf8');
    const title = extractTitle(raw) || file.replace(/\.md$/i, '');
    const category = file.includes('/') ? file.split('/')[0]! : 'general';
    const entries = extractIndexEntries(raw);
    const labels = entries.length > 0 ? entries : [title];
    for (const label of [...new Set(labels)]) docs.push({ category, label, path: `docs/${file}` });
  }
  docs.sort((a, b) => a.label.localeCompare(b.label));
  const indexPath = profileIndexPath(globalDir, profileId, scope);
  await fsp.writeFile(indexPath, renderIndexMarkdown({ profileId, docs }), 'utf8');
  return { indexPath, docCount: files.length };
}

// 프로필 docs/를 읽어 검색용 레코드로. 락 불요(읽기 전용).
export async function readProfileDocs(
  globalDir: string,
  profileId: string,
  scope: ProposalScope = 'user',
): Promise<SearchDocRecord[]> {
  const docsDir = profileDocsDir(globalDir, profileId, scope);
  const files = (await listDocRelPaths(docsDir)).filter((f) => !/(^|\/)index\.md$/i.test(f));
  const recs: SearchDocRecord[] = [];
  for (const file of files) {
    const raw = await fsp.readFile(join(docsDir, file), 'utf8');
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
    });
  }
  return recs;
}

// 검증 → 프로필 보장 → 문서 기록 → 인덱스 재생성. 쓰기/인덱스는 한 락 안에서.
export async function writeProfileDocs(
  globalDir: string,
  profileId: string,
  input: GlobalUpdateInput,
  scope: ProposalScope = 'user',
): Promise<{ written: string[]; indexPath: string }> {
  validateGlobalUpdateInput(input);                 // 락 밖: 잘못된 입력이면 아무것도 안 만짐
  await ensureProfile(globalDir, profileId, scope); // 자기 락 (해제됨) — 아래 락과 중첩 아님
  return withFileLock(globalDir, async () => {
    const docsDir = profileDocsDir(globalDir, profileId, scope);
    const written: string[] = [];
    for (const doc of input.docs) {
      await fsp.mkdir(join(docsDir, doc.category), { recursive: true });
      const full = join(docsDir, doc.category, `${doc.slug}.md`);
      await fsp.writeFile(full, renderDocMarkdown(doc), 'utf8');
      written.push(full);
    }
    const { indexPath } = await writeIndexFromDocs(globalDir, profileId, scope); // 락 보유 중 — OK
    return { written, indexPath };
  });
}
