import { strict as assert } from 'assert';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  writeProposals, readProposals, getGlobalDir, DEFAULT_PROFILE_ID, PROPOSAL_CAPS,
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

  it('같은 (카테고리·제목) 제안은 중복 저장하지 않고 reason=pending과 pendingId를 싣는다', async () => {
    const g = await tmpGlobal();
    const res1 = await writeProposals(g, DEFAULT_PROFILE_ID, [P()], { existingDocTitles: [] });
    const res2 = await writeProposals(g, DEFAULT_PROFILE_ID, [P()], { existingDocTitles: [] });
    assert.equal(res2.written.length, 0);
    assert.equal(res2.skipped.length, 1);
    assert.equal(res2.skipped[0].reason, 'pending');
    assert.equal(res2.skipped[0].pendingId, res1.written[0].id);
    assert.equal(res2.skipped[0].input.title, 'Use release branch');
    assert.equal((await readProposals(g, DEFAULT_PROFILE_ID)).length, 1);
  });

  it('한 번의 writeProposals 호출 안 중복도 pendingId를 싣는다', async () => {
    const g = await tmpGlobal();
    const res = await writeProposals(g, DEFAULT_PROFILE_ID, [P(), P()], { existingDocTitles: [] });
    assert.equal(res.written.length, 1);
    assert.equal(res.skipped.length, 1);
    assert.equal(res.skipped[0].reason, 'pending');
    assert.equal(res.skipped[0].pendingId, res.written[0].id);
  });

  it('slug이 충돌하는 다른 제목 두 개는 별도 파일로 공존한다(덮어쓰기 손실 방지)', async () => {
    const g = await tmpGlobal();
    // 'C# tips'·'C++ tips'는 slugify 결과가 둘 다 'c-tips'라 예전엔 같은 파일로 덮어써졌다.
    const res = await writeProposals(g, DEFAULT_PROFILE_ID, [
      P({ title: 'C# tips' }), P({ title: 'C++ tips' }),
    ], { existingDocTitles: [] });
    assert.equal(res.written.length, 2);
    assert.notEqual(res.written[0].id, res.written[1].id);
    const all = await readProposals(g, DEFAULT_PROFILE_ID);
    assert.equal(all.length, 2);
    assert.deepEqual(
      new Set(all.map((p) => p.title)),
      new Set(['C# tips', 'C++ tips']),
    );
  });

  it('이미 프로필 문서로 존재하는 제목은 제안하지 않고 reason=doc을 싣는다', async () => {
    const g = await tmpGlobal();
    const res = await writeProposals(g, DEFAULT_PROFILE_ID, [P()], {
      existingDocTitles: [{ category: 'conventions', title: 'use release branch' }],
    });
    assert.equal(res.written.length, 0);
    assert.equal(res.skipped.length, 1);
    assert.equal(res.skipped[0].reason, 'doc');
    assert.equal(res.skipped[0].pendingId, undefined);
  });

  it('maxPerPass를 넘긴 제안은 reason=cap으로 건너뛴다', async () => {
    const g = await tmpGlobal();
    const batch = Array.from({ length: PROPOSAL_CAPS.maxPerPass + 2 }, (_, i) => P({ title: `Rule ${i}` }));
    const res = await writeProposals(g, DEFAULT_PROFILE_ID, batch, { existingDocTitles: [] });
    assert.equal(res.written.length, PROPOSAL_CAPS.maxPerPass);
    assert.equal(res.skipped.length, 2);
    assert.ok(res.skipped.every((s) => s.reason === 'cap' && s.pendingId === undefined));
    assert.equal(res.skipped[0].input.title, `Rule ${PROPOSAL_CAPS.maxPerPass}`);
  });

  it('읽을 게 없으면 빈 배열', async () => {
    const g = await tmpGlobal();
    assert.deepEqual(await readProposals(g, DEFAULT_PROFILE_ID), []);
  });
});
