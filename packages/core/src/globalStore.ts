// 글로벌 컨텍스트 저장소 — gc-tree store.ts 이식 + withFileLock + atomic publish.
// 락 규율: ensureDefaultProfile / writeProfileDocs는 각자 withFileLock(globalDir)를 잡는다.
//   writeIndexFromDocs는 락 없음(호출자가 락을 쥔 상태에서만 호출) — 같은 dir 락 중첩은 self-deadlock.
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

import { withFileLock } from './fileLock';
import { DEFAULT_PROFILE_ID, profileDir, profilesRoot } from './globalPaths';
import { renderIndexMarkdown } from './globalMarkdown';

// v1: 항상 default (vNext에서 workspace→profile 매핑 도입 — §F).
export function resolveProfile(_workspaceId: string): string {
  return DEFAULT_PROFILE_ID;
}

// profiles/default 골격을 만든다. 이미 있으면 무손상 반환(멱등).
// tmp 디렉토리에 완성 후 atomic rename publish(§A.3) — hook이 반쯤 만들어진 프로필을 읽는 일 방지.
export async function ensureDefaultProfile(globalDir: string): Promise<void> {
  await withFileLock(globalDir, async () => {
    const dir = profileDir(globalDir, DEFAULT_PROFILE_ID);
    try {
      await fsp.stat(dir);
      return; // 이미 존재
    } catch {
      /* 없음 → 생성 */
    }
    await fsp.mkdir(profilesRoot(globalDir), { recursive: true });
    const tmp = join(profilesRoot(globalDir), `.tmp-default-${process.pid}-${Date.now()}`);
    await fsp.rm(tmp, { recursive: true, force: true });
    await fsp.mkdir(join(tmp, 'docs'), { recursive: true });
    await fsp.mkdir(join(tmp, 'proposals'), { recursive: true });
    const now = new Date().toISOString();
    await fsp.writeFile(
      join(tmp, 'profile.json'),
      JSON.stringify({ version: 1, name: DEFAULT_PROFILE_ID, summary: '', createdAt: now, updatedAt: now }, null, 2) + '\n',
      'utf8',
    );
    await fsp.writeFile(join(tmp, 'index.md'), renderIndexMarkdown({ profileId: DEFAULT_PROFILE_ID, docs: [] }), 'utf8');
    try {
      await fsp.rename(tmp, dir);
    } catch {
      // 경합 패자(이미 누군가 publish) 또는 부분 실패 — tmp 정리
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });
}
