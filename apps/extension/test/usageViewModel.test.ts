// 0.6.0 사용량 조회 5단계 — 사용량 줄의 렌더 계산.
//
// 웹뷰 스크립트는 템플릿 문자열 안이라 tsc도 mocha도 안 본다. 그래서 판정할 값은 여기서 만들고
// 웹뷰는 받은 것을 그리기만 한다(memoryPanelModel과 같은 방식).
import { strict as assert } from 'assert';
import type { CliKind, UsageSnapshot, UsageWindow } from '@agentbridge/core';
import {
  buildUsageStrip,
  NARROW_BELOW_PX,
  WARN_BELOW_PERCENT,
} from '../src/views/usageViewModel';
import type { UsageMap } from '../src/core/usage/usageStore';

const NOW = 1_788_000_000_000;
const WIDE = 320;

const win = (id: UsageWindow['id'], usedPercent: number, resetsAt: number | null = null): UsageWindow =>
  ({ id, usedPercent, resetsAt });

const ok = (cli: CliKind, windows: UsageWindow[]): UsageSnapshot =>
  ({ cli, planName: null, windows, fetchedAt: NOW, status: 'ok' });

const bad = (cli: CliKind, status: UsageSnapshot['status']): UsageSnapshot =>
  ({ cli, planName: null, windows: [], fetchedAt: NOW, status });

const three: UsageMap = {
  claude: ok('claude', [win('session', 19), win('weekly', 66)]),
  codex: ok('codex', [win('session', 38)]),
  agy: ok('agy', [win('session', 55)]),
};

const meterOf = (map: UsageMap, cli: CliKind, width = WIDE) =>
  buildUsageStrip(map, width, NOW).meters.find((m) => m.cli === cli);

describe('views/usageViewModel', () => {
  describe('구성', () => {
    it('순서는 claude, codex, agy로 고정한다', () => {
      const view = buildUsageStrip(three, WIDE, NOW);
      assert.deepEqual(view.meters.map((m) => m.cli), ['claude', 'codex', 'agy']);
    });

    it('자격증명이 없어 결과에 없는 CLI는 뺀다', () => {
      const view = buildUsageStrip({ claude: three.claude }, WIDE, NOW);
      assert.deepEqual(view.meters.map((m) => m.cli), ['claude']);
      assert.equal(view.hidden, false);
    });

    it('셋 다 없으면 줄을 숨긴다', () => {
      assert.equal(buildUsageStrip({}, WIDE, NOW).hidden, true);
    });

    it('모델 색을 싣는다', () => {
      assert.equal(meterOf(three, 'claude')!.color, '#d97757');
      assert.equal(meterOf(three, 'codex')!.color, '#5d8af9');
      assert.equal(meterOf(three, 'agy')!.color, '#8e6cef');
    });
  });

  describe('잔량', () => {
    it('사용량을 잔량으로 뒤집는다', () => {
      assert.equal(meterOf(three, 'claude')!.label, '81%');
    });

    it('채움 비율은 반올림 전 값을 쓴다', () => {
      const m = meterOf({ claude: ok('claude', [win('session', 3.7)]) }, 'claude')!;
      assert.equal(m.label, '96%');
      assert.equal(m.fillRatio, 0.963);
    });

    it('5시간 창만 본다 — 주간은 알약에 안 쓴다', () => {
      const m = meterOf({ claude: ok('claude', [win('session', 19), win('weekly', 90)]) }, 'claude')!;
      assert.equal(m.label, '81%');
    });
  });

  describe('임계', () => {
    it(`잔량이 ${WARN_BELOW_PERCENT}% 미만이면 경고다`, () => {
      const m = meterOf({ agy: ok('agy', [win('session', 100 - (WARN_BELOW_PERCENT - 1))]) }, 'agy')!;
      assert.equal(m.warn, true);
    });

    it(`잔량이 정확히 ${WARN_BELOW_PERCENT}%면 경고가 아니다`, () => {
      const m = meterOf({ agy: ok('agy', [win('session', 100 - WARN_BELOW_PERCENT)]) }, 'agy')!;
      assert.equal(m.warn, false);
    });

    it('경고여도 알약 색은 모델 색 그대로다', () => {
      const m = meterOf({ agy: ok('agy', [win('session', 96)]) }, 'agy')!;
      assert.equal(m.warn, true);
      assert.equal(m.color, '#8e6cef');
    });
  });

  describe('예외 상태', () => {
    for (const status of ['unknown', 'unavailable', 'unsupported', 'unauthenticated'] as const) {
      it(`${status}면 흐린 빈 알약에 대시를 둔다`, () => {
        const m = meterOf({ claude: bad('claude', status) }, 'claude')!;
        assert.equal(m.dim, true);
        assert.equal(m.label, '—');
        assert.equal(m.fillRatio, 0);
        assert.equal(m.warn, false);
      });
    }

    it('ok인데 5시간 창이 없으면 같은 취급이다', () => {
      const m = meterOf({ claude: ok('claude', [win('weekly', 10)]) }, 'claude')!;
      assert.equal(m.dim, true);
      assert.equal(m.label, '—');
    });
  });

  describe('폭', () => {
    it(`${NARROW_BELOW_PX}px 이상이면 숫자를 옆에 둔다`, () => {
      assert.equal(buildUsageStrip(three, NARROW_BELOW_PX, NOW).mode, 'wide');
    });

    it(`${NARROW_BELOW_PX}px 미만이면 겹침으로 바꾼다`, () => {
      assert.equal(buildUsageStrip(three, NARROW_BELOW_PX - 1, NOW).mode, 'narrow');
    });
  });

  describe('툴팁', () => {
    it('주간 잔량을 함께 싣는다', () => {
      const t = meterOf(three, 'claude')!.tooltip;
      assert.equal(t.sessionRemaining, 81);
      assert.equal(t.weeklyRemaining, 34);
    });

    it('주간 창이 없으면 null이다', () => {
      assert.equal(meterOf(three, 'codex')!.tooltip.weeklyRemaining, null);
    });

    it('회복까지 남은 시간을 ms로 준다', () => {
      const map = { claude: ok('claude', [win('session', 19, NOW + 8_040_000)]) };
      assert.equal(meterOf(map, 'claude')!.tooltip.resetsInMs, 8_040_000);
    });

    it('회복 시각이 이미 지났으면 0으로 깎는다', () => {
      const map = { claude: ok('claude', [win('session', 19, NOW - 5_000)]) };
      assert.equal(meterOf(map, 'claude')!.tooltip.resetsInMs, 0);
    });

    it('회복 시각이 없으면 null이다', () => {
      assert.equal(meterOf(three, 'codex')!.tooltip.resetsInMs, null);
    });

    it('CLI 표시 이름을 싣는다', () => {
      assert.equal(meterOf(three, 'agy')!.tooltip.cliLabel, 'Antigravity');
    });
  });
});
