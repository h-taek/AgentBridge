import { strict as assert } from 'assert';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  resolveProfile, ensureDefaultProfile, getGlobalDir, profileDir, profilesRoot,
} from '@agentbridge/core';
import { writeProfileDocs, profileDocsDir, profileIndexPath } from '@agentbridge/core';

async function tmpGlobal(): Promise<string> {
  const root = join(tmpdir(), `gctree-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return getGlobalDir(root); // <root>/global
}
async function exists(p: string): Promise<boolean> {
  try { await fsp.stat(p); return true; } catch { return false; }
}

describe('globalStore.ensure', () => {
  it('resolveProfile은 v1에서 항상 default', () => {
    assert.equal(resolveProfile('any-workspace-uuid'), 'default');
  });
  it('ensureDefaultProfile: profiles/default 골격 생성 (profile.json/index.md/docs/proposals)', async () => {
    const g = await tmpGlobal();
    await ensureDefaultProfile(g);
    const d = profileDir(g, 'default');
    assert.ok(await exists(join(d, 'profile.json')));
    assert.ok(await exists(join(d, 'index.md')));
    assert.ok(await exists(join(d, 'docs')));
    assert.ok(await exists(join(d, 'proposals')));
  });
  it('멱등 — 두 번 호출해도 안전', async () => {
    const g = await tmpGlobal();
    await ensureDefaultProfile(g);
    await fsp.writeFile(join(profileDir(g, 'default'), 'docs', 'marker'), 'keep', 'utf8');
    await ensureDefaultProfile(g); // 두 번째는 기존 보존
    assert.equal(await fsp.readFile(join(profileDir(g, 'default'), 'docs', 'marker'), 'utf8'), 'keep');
  });
  it('publish 후 .tmp-default-* 잔여 없음', async () => {
    const g = await tmpGlobal();
    await ensureDefaultProfile(g);
    const left = (await fsp.readdir(profilesRoot(g))).filter((n) => n.startsWith('.tmp-default-'));
    assert.deepEqual(left, []);
  });
});

describe('globalStore.write', () => {
  it('writeProfileDocs: docs/<category>/<slug>.md 기록 + 인덱스 갱신', async () => {
    const g = await tmpGlobal();
    const res = await writeProfileDocs(g, 'default', {
      docs: [
        { category: 'workflows', slug: 'git-flow', title: 'git-flow', summary: 'main 릴리스 전용', body: 'develop 통합', indexEntries: ['git-flow', '배포', 'release'] },
        { category: 'role', slug: 'solo', title: '1인 개발', summary: '혼자 만든다', body: '', indexEntries: ['solo', '1인'] },
      ],
    });
    assert.equal(res.written.length, 2);
    const docPath = join(profileDocsDir(g, 'default'), 'workflows', 'git-flow.md');
    const raw = await fsp.readFile(docPath, 'utf8');
    assert.match(raw, /^# git-flow/);
    assert.match(raw, /## Index Entries\n\n- git-flow\n- 배포\n- release/);
    const idx = await fsp.readFile(profileIndexPath(g, 'default'), 'utf8');
    assert.ok(idx.indexOf('## Role') < idx.indexOf('## Workflows')); // 카테고리 순서
    assert.match(idx, /- docs\/workflows\/git-flow\.md\n {2}- git-flow/);
  });
  it('잘못된 입력은 쓰기 전에 throw (파일 안 생김)', async () => {
    const g = await tmpGlobal();
    await assert.rejects(
      () => writeProfileDocs(g, 'default', { docs: [{ category: 'bad', slug: 's', title: 't', summary: 's', body: 'b', indexEntries: ['x'] }] } as never),
      /category must be one of/,
    );
  });
});
