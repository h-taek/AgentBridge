import { strict as assert } from 'assert';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  writeProposals, readProposals, approveProposal, discardProposal,
  readProfileDocs, getGlobalDir, DEFAULT_PROFILE_ID, type ProposalInput,
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
});
