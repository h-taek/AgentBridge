import { strict as assert } from 'assert';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  writeProposals, readProposals, approveProposal, discardProposal,
  readProfileDocs, setDocPinned, getGlobalDir, DEFAULT_PROFILE_ID, type ProposalInput,
} from '@agentbridge/core';

async function seed(): Promise<{ globalDir: string; id: string }> {
  const root = await fsp.mkdtemp(join(tmpdir(), 'ab-appr-'));
  const globalDir = getGlobalDir(root);
  const p: ProposalInput = {
    category: 'conventions', title: 'Use release branch', summary: 'tag before publish',
    body: 'details here', confidence: 0.9,
  };
  const res = await writeProposals(globalDir, DEFAULT_PROFILE_ID, [p], { existingDocTitles: [] });
  return { globalDir, id: res.written[0].id };
}

describe('approveProposal / discardProposal', () => {
  it('승인하면 프로필 문서로 쓰고 제안을 제거한다', async () => {
    const { globalDir, id } = await seed();
    const res = await approveProposal(globalDir, DEFAULT_PROFILE_ID, id);
    assert.ok(res);
    if (res) assert.equal(res.written.length, 1);
    const docs = await readProfileDocs(globalDir, DEFAULT_PROFILE_ID);
    assert.equal(docs.length, 1);
    assert.equal(docs[0].title, 'Use release branch');
    assert.equal(docs[0].category, 'conventions');
    assert.deepEqual(await readProposals(globalDir, DEFAULT_PROFILE_ID), []); // 승인 후 제안 사라짐
  });

  it('존재하지 않는 제안 승인은 null', async () => {
    const { globalDir } = await seed();
    assert.equal(await approveProposal(globalDir, DEFAULT_PROFILE_ID, 'conventions__nope'), null);
  });

  it('버리면 제안만 제거(문서는 안 만듦)', async () => {
    const { globalDir, id } = await seed();
    assert.equal(await discardProposal(globalDir, DEFAULT_PROFILE_ID, id), true);
    assert.deepEqual(await readProposals(globalDir, DEFAULT_PROFILE_ID), []);
    assert.deepEqual(await readProfileDocs(globalDir, DEFAULT_PROFILE_ID), []);
  });

  it('없는 제안 버리기는 false', async () => {
    const { globalDir } = await seed();
    assert.equal(await discardProposal(globalDir, DEFAULT_PROFILE_ID, 'conventions__nope'), false);
  });

  it('승인 시 모델이 준 indexEntries를 문서 검색어로 쓴다', async () => {
    const root = await fsp.mkdtemp(join(tmpdir(), 'ab-appr-idx-'));
    const globalDir = getGlobalDir(root);
    const p: ProposalInput = {
      category: 'conventions', title: 'Use release branch', summary: 's', body: 'b', confidence: 0.9,
      indexEntries: ['release', '배포', 'git-flow'],
    };
    const res0 = await writeProposals(globalDir, DEFAULT_PROFILE_ID, [p], { existingDocTitles: [] });
    await approveProposal(globalDir, DEFAULT_PROFILE_ID, res0.written[0].id);
    const docs = await readProfileDocs(globalDir, DEFAULT_PROFILE_ID);
    assert.deepEqual(docs[0].indexEntries, ['release', '배포', 'git-flow']);
  });

  it('indexEntries 없는(옛) 제안은 제목을 검색어로 폴백', async () => {
    const { globalDir, id } = await seed(); // seed 제안엔 indexEntries 없음
    await approveProposal(globalDir, DEFAULT_PROFILE_ID, id);
    const docs = await readProfileDocs(globalDir, DEFAULT_PROFILE_ID);
    assert.deepEqual(docs[0].indexEntries, ['Use release branch']);
  });

  it('승인 뒤 기존 문서의 pinned 태그를 유지한다', async () => {
    const { globalDir, id } = await seed();
    await approveProposal(globalDir, DEFAULT_PROFILE_ID, id);
    const first = (await readProfileDocs(globalDir, DEFAULT_PROFILE_ID))[0];
    await setDocPinned(globalDir, DEFAULT_PROFILE_ID, 'user', first.path, true);

    // 같은 문서를 고치는(targetSlug) 제안을 다시 승인해도 pinned가 남는다.
    const upd = await writeProposals(globalDir, DEFAULT_PROFILE_ID, [{
      category: 'conventions',
      targetSlug: first.slug,
      title: 'Use release branch (updated)',
      summary: 'updated summary',
      body: 'updated details',
      confidence: 0.95,
    }], { existingDocTitles: [{ category: first.category, title: first.title }] });
    await approveProposal(globalDir, DEFAULT_PROFILE_ID, upd.written[0].id);

    const after = await readProfileDocs(globalDir, DEFAULT_PROFILE_ID);
    assert.equal(after.length, 1);
    assert.equal(after[0].title, 'Use release branch (updated)');
    assert.ok(after[0].tags.includes('pinned'));
  });

  it('승인과 핀 변경을 번갈아·동시에 돌려도 핀이 남는다', async () => {
    const { globalDir, id } = await seed();
    await approveProposal(globalDir, DEFAULT_PROFILE_ID, id);
    const first = (await readProfileDocs(globalDir, DEFAULT_PROFILE_ID))[0];

    const upd = await writeProposals(globalDir, DEFAULT_PROFILE_ID, [{
      category: 'conventions',
      targetSlug: first.slug,
      title: 'Use release branch v2',
      summary: 'v2 summary',
      body: 'v2 details',
      confidence: 0.9,
    }], { existingDocTitles: [{ category: first.category, title: first.title }] });

    // 동시에 돌려도 같은 파일 잠금으로 직렬화되어 핀과 새 내용이 모두 보존된다.
    await Promise.all([
      setDocPinned(globalDir, DEFAULT_PROFILE_ID, 'user', first.path, true),
      approveProposal(globalDir, DEFAULT_PROFILE_ID, upd.written[0].id),
    ]);

    const mid = await readProfileDocs(globalDir, DEFAULT_PROFILE_ID);
    assert.equal(mid[0].title, 'Use release branch v2');
    assert.ok(mid[0].tags.includes('pinned'));

    // 한 번 더 고침 승인을 거쳐도 pinned 유지
    const upd2 = await writeProposals(globalDir, DEFAULT_PROFILE_ID, [{
      category: 'conventions',
      targetSlug: first.slug,
      title: 'Use release branch v3',
      summary: 'v3 summary',
      body: 'v3 details',
      confidence: 0.9,
    }], { existingDocTitles: [{ category: mid[0].category, title: mid[0].title }] });
    await approveProposal(globalDir, DEFAULT_PROFILE_ID, upd2.written[0].id);

    const end = await readProfileDocs(globalDir, DEFAULT_PROFILE_ID);
    assert.equal(end[0].title, 'Use release branch v3');
    assert.ok(end[0].tags.includes('pinned'));
  });
});
