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
});
