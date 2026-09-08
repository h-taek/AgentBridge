import { strict as assert } from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { normalizeUsage, type UsageSnapshot } from '@agentbridge/core';

const FIXTURES = join(__dirname, 'fixtures', 'usage');
const load = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));

const FETCHED_AT = 1_788_000_000_000;
const win = (s: UsageSnapshot, id: 'session' | 'weekly') =>
  s.windows.find((w) => w.id === id);

describe('usage/normalize', () => {
  describe('claude', () => {
    it('five_hour와 seven_day를 session·weekly로 옮긴다', () => {
      const s = normalizeUsage('claude', load('claude'), FETCHED_AT);
      assert.equal(s.status, 'ok');
      assert.equal(win(s, 'session')!.usedPercent, 8);
      assert.equal(win(s, 'weekly')!.usedPercent, 1);
    });

    it('resets_at을 epoch ms로 바꾼다', () => {
      const s = normalizeUsage('claude', load('claude'), FETCHED_AT);
      assert.equal(win(s, 'session')!.resetsAt, Date.parse('2026-09-07T11:59:59.796092+00:00'));
      assert.equal(win(s, 'weekly')!.resetsAt, Date.parse('2026-09-14T07:59:59.796112+00:00'));
    });

    it('플랜 이름이 없으므로 null이다', () => {
      assert.equal(normalizeUsage('claude', load('claude'), FETCHED_AT).planName, null);
    });

    it('resets_at이 null이면 resetsAt도 null이다', () => {
      const raw = load('claude') as Record<string, Record<string, unknown>>;
      raw.five_hour.resets_at = null;
      assert.equal(win(normalizeUsage('claude', raw, FETCHED_AT), 'session')!.resetsAt, null);
    });
  });

  describe('codex', () => {
    it('primary·secondary window를 session·weekly로 옮긴다', () => {
      const s = normalizeUsage('codex', load('codex'), FETCHED_AT);
      assert.equal(s.status, 'ok');
      assert.equal(win(s, 'session')!.usedPercent, 4);
      assert.equal(win(s, 'weekly')!.usedPercent, 1);
    });

    it('초 단위 reset_at에 1000을 곱한다', () => {
      const s = normalizeUsage('codex', load('codex'), FETCHED_AT);
      assert.equal(win(s, 'session')!.resetsAt, 1_788_781_052_000);
      assert.equal(win(s, 'weekly')!.resetsAt, 1_789_367_852_000);
    });

    it('plan_type을 planName으로 쓴다', () => {
      assert.equal(normalizeUsage('codex', load('codex'), FETCHED_AT).planName, 'plus');
    });

    it('additional_rate_limits는 무시한다', () => {
      const s = normalizeUsage('codex', load('codex'), FETCHED_AT);
      assert.equal(s.windows.length, 2);
    });
  });

  describe('agy', () => {
    it('잔여율을 사용률로 뒤집고 소수 1자리로 반올림한다', () => {
      const s = normalizeUsage('agy', load('agy'), FETCHED_AT);
      assert.equal(s.status, 'ok');
      assert.equal(win(s, 'session')!.usedPercent, 3.7);
      assert.equal(win(s, 'weekly')!.usedPercent, 1.3);
    });

    it('resetTime을 epoch ms로 바꾼다', () => {
      const s = normalizeUsage('agy', load('agy'), FETCHED_AT);
      assert.equal(win(s, 'session')!.resetsAt, Date.parse('2026-09-07T11:37:33Z'));
    });

    it('3p-* 버킷은 싣지 않는다', () => {
      const s = normalizeUsage('agy', load('agy'), FETCHED_AT);
      assert.equal(s.windows.length, 2);
    });

    it('플랜 이름이 없으므로 null이다', () => {
      assert.equal(normalizeUsage('agy', load('agy'), FETCHED_AT).planName, null);
    });
  });

  describe('공통', () => {
    it('fetchedAt과 cli를 그대로 싣는다', () => {
      const s = normalizeUsage('codex', load('codex'), FETCHED_AT);
      assert.equal(s.fetchedAt, FETCHED_AT);
      assert.equal(s.cli, 'codex');
    });

    it('창 순서는 session 다음 weekly다', () => {
      for (const cli of ['claude', 'codex', 'agy'] as const) {
        const s = normalizeUsage(cli, load(cli), FETCHED_AT);
        assert.deepEqual(s.windows.map((w) => w.id), ['session', 'weekly'], cli);
      }
    });

    it('기대와 다른 응답은 unsupported로 끝낸다', () => {
      for (const cli of ['claude', 'codex', 'agy'] as const) {
        const s = normalizeUsage(cli, { unexpected: true }, FETCHED_AT);
        assert.equal(s.status, 'unsupported', cli);
        assert.deepEqual(s.windows, [], cli);
      }
    });

    it('응답이 객체가 아니어도 던지지 않는다', () => {
      for (const raw of [null, undefined, 'text', 42]) {
        assert.equal(normalizeUsage('claude', raw, FETCHED_AT).status, 'unsupported');
      }
    });

    it('창 하나만 읽히면 그 하나만 싣고 ok로 둔다', () => {
      const raw = load('claude') as Record<string, unknown>;
      raw.seven_day = null;
      const s = normalizeUsage('claude', raw, FETCHED_AT);
      assert.equal(s.status, 'ok');
      assert.deepEqual(s.windows.map((w) => w.id), ['session']);
    });
  });
});
