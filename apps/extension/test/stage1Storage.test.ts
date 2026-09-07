// 0.5.0 1단계 W1 — 폴더 이름 충돌 tripwire와 옛 저장소 장기 메모리 이전.
import { strict as assert } from 'assert';
import { promises as fs, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorkspaceStore, migrateLegacyGlobalIfNeeded } from '@agentbridge/core';

describe('폴더 이름 충돌 tripwire', () => {
  it('같은 폴더 이름에 다른 원본 경로가 기록돼 있으면 거절한다', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'ab-tripwire-root-'));
    const projA = await fs.mkdtemp(join(tmpdir(), 'ab-tripwire-a-'));
    const projB = await fs.mkdtemp(join(tmpdir(), 'ab-tripwire-b-'));
    try {
      const store = createWorkspaceStore({ rootPathForTesting: root });
      const id = store.getOrCreateWorkspaceId(projA);

      // 같은 다이제스트를 가진 다른 저장소가 먼저 자리를 잡은 상황을 만든다.
      const metaPath = join(root, 'workspaces', id, 'workspace.json');
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { workspacePath: string };
      meta.workspacePath = projB;
      writeFileSync(metaPath, JSON.stringify(meta, null, 2));

      assert.throws(
        () => store.getOrCreateWorkspaceId(projA),
        /already belongs to/,
        '다른 원본 경로가 기록된 폴더를 조용히 같이 쓰면 안 된다',
      );
    } finally {
      for (const d of [root, projA, projB]) await fs.rm(d, { recursive: true, force: true });
    }
  });

  it('같은 원본 경로면 그대로 통과한다', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'ab-tripwire-ok-'));
    const proj = await fs.mkdtemp(join(tmpdir(), 'ab-tripwire-proj-'));
    try {
      const store = createWorkspaceStore({ rootPathForTesting: root });
      const first = store.getOrCreateWorkspaceId(proj);
      const second = store.getOrCreateWorkspaceId(proj);
      assert.equal(first, second);
    } finally {
      for (const d of [root, proj]) await fs.rm(d, { recursive: true, force: true });
    }
  });
});

describe('옛 저장소 장기 메모리 이전', () => {
  it('global/만 복사하고 옛 루트는 건드리지 않는다', async () => {
    const legacy = await fs.mkdtemp(join(tmpdir(), 'ab-legacy-'));
    const root = await fs.mkdtemp(join(tmpdir(), 'ab-new-'));
    try {
      const docDir = join(legacy, 'global', 'profiles', 'default', 'docs', 'conventions');
      await fs.mkdir(docDir, { recursive: true });
      await fs.writeFile(join(docDir, 'x.md'), 'keep me');
      // 워크스페이스 데이터는 복사 대상이 아니다.
      await fs.mkdir(join(legacy, 'workspaces', 'proj-abcd'), { recursive: true });
      await fs.writeFile(join(legacy, 'workspaces', 'proj-abcd', 'ir.json'), '{}');

      assert.equal(migrateLegacyGlobalIfNeeded({ root, legacyRoot: legacy }), 'copied');
      assert.equal(
        readFileSync(join(root, 'global', 'profiles', 'default', 'docs', 'conventions', 'x.md'), 'utf8'),
        'keep me',
      );
      assert.equal(await exists(join(root, 'workspaces')), false, '워크스페이스는 안 옮긴다');
      assert.equal(await exists(join(legacy, 'global')), true, '옛 루트는 남는다');
    } finally {
      for (const d of [legacy, root]) await fs.rm(d, { recursive: true, force: true });
    }
  });

  it('두 번째 호출은 덮어쓰지 않는다', async () => {
    const legacy = await fs.mkdtemp(join(tmpdir(), 'ab-legacy2-'));
    const root = await fs.mkdtemp(join(tmpdir(), 'ab-new2-'));
    try {
      await fs.mkdir(join(legacy, 'global'), { recursive: true });
      await fs.writeFile(join(legacy, 'global', 'a.md'), 'old');
      assert.equal(migrateLegacyGlobalIfNeeded({ root, legacyRoot: legacy }), 'copied');
      await fs.writeFile(join(root, 'global', 'a.md'), 'new');
      assert.equal(migrateLegacyGlobalIfNeeded({ root, legacyRoot: legacy }), 'skipped-already-present');
      assert.equal(readFileSync(join(root, 'global', 'a.md'), 'utf8'), 'new');
    } finally {
      for (const d of [legacy, root]) await fs.rm(d, { recursive: true, force: true });
    }
  });

  it('옛 저장소가 없으면 아무것도 안 한다', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'ab-new3-'));
    try {
      assert.equal(
        migrateLegacyGlobalIfNeeded({ root, legacyRoot: join(root, 'nope') }),
        'skipped-no-legacy',
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
