import { strict as assert } from 'assert';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  resolveProfile, ensureDefaultProfile, getGlobalDir, profileDir, profilesRoot,
} from '@agentbridge/core';

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
