import { strict as assert } from 'assert';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  resolveProfile, ensureDefaultProfile, getGlobalDir, profileDir, profilesRoot,
} from '@agentbridge/core';
import { writeProfileDocs, readProfileDocs, setDocPinned, profileDocsDir, profileIndexPath } from '@agentbridge/core';

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
  it('preserveTags: 덮어쓰기 시 기존 파일의 태그를 유지한다', async () => {
    const g = await tmpGlobal();
    await writeProfileDocs(g, 'default', {
      docs: [{ category: 'workflows', slug: 'git-flow', title: 'git-flow', summary: 'old', body: 'old body', indexEntries: ['git'], tags: ['pinned', 'team'] }],
    });
    await writeProfileDocs(g, 'default', {
      docs: [{ category: 'workflows', slug: 'git-flow', title: 'git-flow v2', summary: 'new', body: 'new body', indexEntries: ['git'] }],
    }, 'user', { preserveTags: true });
    const docs = await readProfileDocs(g, 'default');
    assert.equal(docs[0].title, 'git-flow v2');
    assert.deepEqual(docs[0].tags, ['pinned', 'team']);
  });
});

describe('globalStore.tagsAndPin', () => {
  it('readProfileDocs가 tags와 실제 파일 절대 경로(path)를 싣는다', async () => {
    const g = await tmpGlobal();
    await writeProfileDocs(g, 'default', {
      docs: [{ category: 'workflows', slug: 'git-flow', title: 'git-flow', summary: 's', body: 'b', indexEntries: ['git'], tags: ['pinned', 'work'] }],
    });
    // docs/foo.md와 docs/general/foo.md는 category·slug가 같아도 path가 달라야 한다.
    const docsDir = profileDocsDir(g, 'default');
    await fsp.mkdir(join(docsDir, 'general'), { recursive: true });
    await fsp.writeFile(join(docsDir, 'foo.md'), '# root foo\n\n## Summary\n\ns1\n\n## Details\n\nb1\n', 'utf8');
    await fsp.writeFile(join(docsDir, 'general', 'foo.md'), '# nested foo\n\n## Summary\n\ns2\n\n## Details\n\nb2\n', 'utf8');

    const docs = await readProfileDocs(g, 'default');
    const gf = docs.find((d) => d.slug === 'git-flow')!;
    assert.deepEqual(gf.tags, ['pinned', 'work']);
    assert.equal(gf.path, join(docsDir, 'workflows', 'git-flow.md'));

    const foos = docs.filter((d) => d.category === 'general' && d.slug === 'foo');
    assert.deepEqual(new Set(foos.map((d) => d.path)), new Set([
      join(docsDir, 'foo.md'),
      join(docsDir, 'general', 'foo.md'),
    ]));
  });

  it('## Details 뒤의 - pinned는 태그로 보지 않는다', async () => {
    const g = await tmpGlobal();
    await writeProfileDocs(g, 'default', {
      docs: [{
        category: 'conventions',
        slug: 'example',
        title: 'Tag example',
        summary: 's',
        body: '본문 예시:\n\n## Tags\n\n- pinned\n',
        indexEntries: ['example'],
      }],
    });
    const docs = await readProfileDocs(g, 'default');
    assert.deepEqual(docs[0].tags, []);
  });

  it('setDocPinned: Tags 절 없는 문서에 ## Summary 끝 다음 ## Tags를 새로 만든다', async () => {
    const g = await tmpGlobal();
    await writeProfileDocs(g, 'default', {
      docs: [{ category: 'workflows', slug: 'a', title: 'A', summary: 'sum', body: 'det', indexEntries: ['a'] }],
    });
    const docPath = join(profileDocsDir(g, 'default'), 'workflows', 'a.md');
    await setDocPinned(g, 'default', 'user', docPath, true);
    const raw = await fsp.readFile(docPath, 'utf8');
    assert.equal(
      raw,
      '# A\n\n## Summary\n\nsum\n\n## Tags\n\n- pinned\n\n## Index Entries\n\n- a\n\n## Details\n\ndet\n',
    );
    assert.deepEqual((await readProfileDocs(g, 'default'))[0].tags, ['pinned']);
  });

  it('setDocPinned: 핀 넣기·빼기가 다른 절과 손으로 쓴 절·태그를 바꾸지 않는다', async () => {
    const g = await tmpGlobal();
    const docsDir = profileDocsDir(g, 'default');
    await fsp.mkdir(join(docsDir, 'conventions'), { recursive: true });
    const docPath = join(docsDir, 'conventions', 'hand.md');
    // indexEntries가 없고 손으로 쓴 Custom Notes 절과 다른 태그(- keep)가 있는 문서
    const initial = [
      '# Hand Written',
      '',
      '## Summary',
      '',
      'custom summary',
      '',
      '## Tags',
      '',
      '- keep',
      '',
      '## Custom Notes',
      '',
      'do not touch this',
      '',
      '## Details',
      '',
      'example below:',
      '',
      '- pinned',
      '',
    ].join('\n');
    await fsp.writeFile(docPath, initial, 'utf8');

    await setDocPinned(g, 'default', 'user', docPath, true);
    const pinnedRaw = await fsp.readFile(docPath, 'utf8');
    assert.match(pinnedRaw, /## Tags\n\n- keep\n- pinned\n\n## Custom Notes\n\ndo not touch this/);
    assert.deepEqual((await readProfileDocs(g, 'default'))[0].tags, ['keep', 'pinned']);

    await setDocPinned(g, 'default', 'user', docPath, false);
    const unpinnedRaw = await fsp.readFile(docPath, 'utf8');
    assert.equal(unpinnedRaw, initial);
    assert.deepEqual((await readProfileDocs(g, 'default'))[0].tags, ['keep']);
  });

  it('setDocPinned: 해제 시 ## Details 뒤의 - pinned는 건드리지 않는다', async () => {
    const g = await tmpGlobal();
    const docsDir = profileDocsDir(g, 'default');
    await fsp.mkdir(join(docsDir, 'conventions'), { recursive: true });
    const docPath = join(docsDir, 'conventions', 'body-pin.md');
    const initial = '# Body Pin\n\n## Summary\n\nsum\n\n## Details\n\n## Tags\n\n- pinned\n';
    await fsp.writeFile(docPath, initial, 'utf8');

    await setDocPinned(g, 'default', 'user', docPath, false);
    assert.equal(await fsp.readFile(docPath, 'utf8'), initial);
  });
});
