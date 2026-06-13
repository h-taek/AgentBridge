import { strict as assert } from 'assert';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  writeProposals, readProposals, getGlobalDir, DEFAULT_PROFILE_ID,
  type ProposalInput,
} from '@agentbridge/core';

async function tmpGlobal(): Promise<string> {
  const t = await fsp.mkdtemp(join(tmpdir(), 'ab-prop-'));
  return getGlobalDir(t);
}
const P = (over: Partial<ProposalInput> = {}): ProposalInput => ({
  category: 'conventions', title: 'Use release branch', summary: 'tag before publish',
  body: 'details', confidence: 0.8, ...over,
});

describe('proposalStore', () => {
  it('제안을 쓰고 다시 읽는다(id·createdAt 봉투 부여)', async () => {
    const g = await tmpGlobal();
    const res = await writeProposals(g, DEFAULT_PROFILE_ID, [P()], { existingDocTitles: [] });
    assert.equal(res.written.length, 1);
    const all = await readProposals(g, DEFAULT_PROFILE_ID);
    assert.equal(all.length, 1);
    assert.equal(all[0].title, 'Use release branch');
    assert.ok(all[0].id && all[0].createdAt);
  });

  it('같은 (카테고리·제목) 제안은 중복 저장하지 않는다', async () => {
    const g = await tmpGlobal();
    await writeProposals(g, DEFAULT_PROFILE_ID, [P()], { existingDocTitles: [] });
    const res2 = await writeProposals(g, DEFAULT_PROFILE_ID, [P()], { existingDocTitles: [] });
    assert.equal(res2.written.length, 0);
    assert.equal(res2.skipped.length, 1);
    assert.equal((await readProposals(g, DEFAULT_PROFILE_ID)).length, 1);
  });

  it('이미 프로필 문서로 존재하는 제목은 제안하지 않는다', async () => {
    const g = await tmpGlobal();
    const res = await writeProposals(g, DEFAULT_PROFILE_ID, [P()], {
      existingDocTitles: [{ category: 'conventions', title: 'use release branch' }],
    });
    assert.equal(res.written.length, 0);
    assert.equal(res.skipped.length, 1);
  });

  it('읽을 게 없으면 빈 배열', async () => {
    const g = await tmpGlobal();
    assert.deepEqual(await readProposals(g, DEFAULT_PROFILE_ID), []);
  });
});
