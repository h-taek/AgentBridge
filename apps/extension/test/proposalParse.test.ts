import { strict as assert } from 'assert';
import { parseProposalOutput } from '@agentbridge/core';

describe('parseProposalOutput', () => {
  it('JSON 배열을 파싱하고 유효 카테고리만 남긴다', () => {
    const text = JSON.stringify([
      { category: 'conventions', title: 'A', summary: 's', body: 'b', confidence: 0.9 },
      { category: 'not-a-category', title: 'B', summary: 's', body: 'b', confidence: 0.5 },
    ]);
    const r = parseProposalOutput(text);
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.proposals.length, 1);
      assert.equal(r.proposals[0].category, 'conventions');
    }
  });

  it('```json``` fence와 앞뒤 산문을 견딘다', () => {
    const text = 'Here are proposals:\n```json\n[{"category":"role","title":"T","summary":"s","body":"b","confidence":0.7}]\n```\nDone.';
    const r = parseProposalOutput(text);
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.proposals[0].title, 'T');
  });

  it('제목 없는 항목은 버린다', () => {
    const r = parseProposalOutput(JSON.stringify([{ category: 'role', title: '', summary: 's', body: 'b', confidence: 1 }]));
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.proposals.length, 0);
  });

  it('빈 summary + body 있음 → title로 summary를 채워 살린다', () => {
    const r = parseProposalOutput(JSON.stringify([
      { category: 'conventions', title: 'pnpm 사용', summary: '', body: '모든 repo에서 pnpm 일관 사용', confidence: 0.8 },
    ]));
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.proposals.length, 1);
      assert.equal(r.proposals[0].summary, 'pnpm 사용');
      assert.equal(r.proposals[0].body, '모든 repo에서 pnpm 일관 사용');
    }
  });

  it('빈 summary + 빈 body → 내용 없는 껍데기라 버린다', () => {
    const r = parseProposalOutput(JSON.stringify([
      { category: 'conventions', title: 'pnpm 사용', summary: '', body: '', confidence: 0.8 },
    ]));
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.proposals.length, 0);
  });

  it('빈 배열은 ok이고 제안 0개', () => {
    const r = parseProposalOutput('[]');
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.proposals.length, 0);
  });

  it('JSON이 아니면 ok:false', () => {
    assert.equal(parseProposalOutput('not json at all').ok, false);
    assert.equal(parseProposalOutput('').ok, false);
  });

  it('confidence는 0..1로 클램프, 비수치는 0.5', () => {
    const r = parseProposalOutput(JSON.stringify([
      { category: 'infra', title: 'X', summary: 's', body: 'b', confidence: 5 },
      { category: 'infra', title: 'Y', summary: 's', body: 'b', confidence: 'high' },
    ]));
    assert.ok(r.ok);
    if (r.ok) { assert.equal(r.proposals[0].confidence, 1); assert.equal(r.proposals[1].confidence, 0.5); }
  });

  it('indexEntries를 string[]로 파싱하고 trim·중복·비문자·빈값 제거(순서 보존)', () => {
    const r = parseProposalOutput(JSON.stringify([
      { category: 'infra', title: 'T', summary: 's', body: 'b', confidence: 0.9,
        indexEntries: ['  배포 ', 'deploy', '배포', 7, '', 'release'] },
    ]));
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.proposals[0].indexEntries, ['배포', 'deploy', 'release']);
  });

  it('indexEntries는 50개로 캡', () => {
    const many = Array.from({ length: 80 }, (_, i) => `kw${i}`);
    const r = parseProposalOutput(JSON.stringify([
      { category: 'infra', title: 'T', summary: 's', body: 'b', confidence: 0.9, indexEntries: many },
    ]));
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.proposals[0].indexEntries?.length, 50);
  });

  it('indexEntries가 없거나 전부 빈값이면 필드 생략(하위호환)', () => {
    const r1 = parseProposalOutput(JSON.stringify([{ category: 'infra', title: 'T', summary: 's', body: 'b', confidence: 0.9 }]));
    const r2 = parseProposalOutput(JSON.stringify([{ category: 'infra', title: 'T', summary: 's', body: 'b', confidence: 0.9, indexEntries: ['', '  '] }]));
    assert.ok(r1.ok && r2.ok);
    if (r1.ok) assert.equal(r1.proposals[0].indexEntries, undefined);
    if (r2.ok) assert.equal(r2.proposals[0].indexEntries, undefined);
  });
});
