import { strict as assert } from 'assert';
import { extractQuotaPercent } from '@agentbridge/core';

// agy `/usage` "Models & Quota" 새 포맷 — 실제 CLI 1.0.8 캡처 후 코드의 ANSI_STRIP_RE로
// 스트립한 텍스트(2026-06 실측). Gemini Five Hour = 96.81% 남음 → usedPercent 3.
// Weekly(96.47%)와 Five Hour(96.81%)를 둘 다 둬서 "Five Hour를 정확히 집는지" 검증.
// 주의: 실측에서 Five Hour의 "remaining" 줄은 들여쓰기가 깨져 나온다(아래 그대로 재현).
const REAL_STRIPPED = `└ Models & Quota

  Account: htaeky@gmail.com

GEMINI MODELS
  Models within this group: Gemini Flash, Gemini Pro

  Weekly Limit
    [████████████████████░░] 96.47%
    96% remaining · Refreshes in 119h 48m

  Five Hour Limit
    [████████████████████░░] 96.81%
97% remaining · Refreshes in 3h 22m


CLAUDE AND GPT MODELS
  Models within this group: Claude Opus, Claude Sonnet, GPT-OSS

  Weekly Limit
    [██████████████████████] 100.00%
    Quota available

  Five Hour Limit
    [██████████████████████] 100.00%
    Quota available
`;

// Gemini Five Hour가 완전 미사용(100.00% / Quota available)인 변형.
const GEMINI_FULL = `GEMINI MODELS
  Models within this group: Gemini Flash, Gemini Pro

  Weekly Limit
    [██████████████████████] 100.00%
    Quota available

  Five Hour Limit
    [██████████████████████] 100.00%
    Quota available
`;

// Gemini Five Hour가 많이 소진(8.50% 남음)된 변형.
const GEMINI_LOW = `GEMINI MODELS
  Models within this group: Gemini Flash, Gemini Pro

  Weekly Limit
    [████░░] 40.00%
    40% remaining · Refreshes in 100h 0m

  Five Hour Limit
    [██░░░░] 8.50%
    9% remaining · Refreshes in 2h 0m
`;

describe('extractQuotaPercent — agy /usage 새 포맷', () => {
  it('실캡처: Gemini Five Hour 96.81% 남음 → usedPercent 3', () => {
    assert.equal(extractQuotaPercent('agy', REAL_STRIPPED), 3);
  });

  it('Weekly(96.47%)가 아니라 Five Hour(96.81%)를 집는다', () => {
    // Weekly를 잘못 집으면 round(100-96.47)=4 가 됐을 것.
    assert.notEqual(extractQuotaPercent('agy', REAL_STRIPPED), 4);
  });

  it('Gemini Five Hour 완전 미사용(100.00%) → usedPercent 0', () => {
    assert.equal(extractQuotaPercent('agy', GEMINI_FULL), 0);
  });

  it('Gemini Five Hour 8.50% 남음 → usedPercent 92', () => {
    assert.equal(extractQuotaPercent('agy', GEMINI_LOW), 92);
  });

  it('GEMINI 그룹이 없으면 null', () => {
    assert.equal(extractQuotaPercent('agy', 'no quota screen here'), null);
  });
});
