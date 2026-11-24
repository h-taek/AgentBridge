import { strict as assert } from 'assert';
import { buildProposalPrompt } from '@agentbridge/core';
import type { TurnRecord } from '@agentbridge/core';

const turn = (over: Partial<TurnRecord> = {}): TurnRecord => ({
  id: 't1', model: 'claude', completedAt: '2026-06-13T00:00:00Z',
  user: '나는 산문 설명을 선호해', assistantBody: '알겠습니다', toolCalls: [],
  userBytes: 10, assistantBodyBytes: 6, ...over,
} as TurnRecord);

describe('buildProposalPrompt', () => {
  it('7카테고리·제외목록·판별테스트·출력형식을 담는다', () => {
    const p = buildProposalPrompt({ turns: [turn()], existingIndex: [] });
    assert.match(p, /conventions/);
    assert.match(p, /role/);
    assert.match(p, /confidence/);
    assert.match(p, /JSON array/i);
    // 제외목록(시한부·현재작업상태 등)과 "when in doubt" 가드 존재
    assert.match(p, /when in doubt/i);
    // 언어 규칙: 출력 텍스트(title/summary/body)는 사용자 언어 추종 (IR LANGUAGE_RULE과 동형)
    assert.match(p, /## Language/);
    assert.match(p, /same language the user uses/i);
  });

  it('턴 본문과 기존 인덱스(중복방지)를 포함한다', () => {
    const p = buildProposalPrompt({
      turns: [turn({ user: '배포는 release 브랜치로' })],
      existingIndex: [{ category: 'conventions', title: 'Existing doc title' }],
    });
    assert.match(p, /release 브랜치/);
    assert.match(p, /Existing doc title/);
  });

  it('턴이 없으면 명시적으로 표기', () => {
    const p = buildProposalPrompt({ turns: [], existingIndex: [] });
    assert.match(p, /\(no turns/i);
  });

  it('출력 스키마에 indexEntries(한↔영 검색어) 생성 지시를 담는다', () => {
    const p = buildProposalPrompt({ turns: [turn()], existingIndex: [] });
    assert.match(p, /indexEntries/);
  });

  // 0.10.0 spec/01 §3 — 사용자가 정한 것 → 일반 지식 → 시점 → 범위 순서로 판단한다.
  it('판단 순서가 사용자가 정한 것, 일반 지식, 시점, 범위 순이다', () => {
    const p = buildProposalPrompt({ turns: [turn()], existingIndex: [] });
    const set = p.indexOf('1. User-set: "Did the user set this for the future?"');
    const general = p.indexOf('2. General knowledge: "Would a capable model know or do this without being told?"');
    const time = p.indexOf('3. Time:');
    const scope = p.indexOf('4. User vs project:');
    assert.ok(set > 0 && general > set && time > general && scope > time);
    assert.match(p, /does not pass here however it is phrased,\n   "from now on" included/);
    assert.match(p, /if this entry were deleted, would a capable model work any differently\?/);
    assert.match(p, /When in doubt about Test 1, treat it as not set by the user\./);
    assert.match(p, /- domain — domain knowledge and vocabulary a model would not know on its own/);
  });
});
