// 0.6.0 — 세션 목록을 웹뷰로 옮기면서, 트리가 공짜로 해주던 것(2단 접기, 부모 집계, 순서)을
// 우리가 쥐게 됐다. 그 판정을 전부 여기 순수 함수에 두고 웹뷰는 받은 행을 그리기만 한다.
import { strict as assert } from 'assert';
import type { SessionActivity } from '@agentbridge/core';
import type { SessionMeta } from '../src/core/sessionRegistry';
import { buildSessionRows, needsTwistColumn, timeAgo } from '../src/views/sessionsViewModel';

const NOW = Date.parse('2026-09-08T12:00:00Z');

const meta = (over: Partial<SessionMeta> & { sessionId: string }): SessionMeta => ({
  workspaceId: 'ws',
  model: 'claude',
  name: over.sessionId,
  createdAt: new Date(NOW - 3_600_000).toISOString(),
  lastActiveAt: new Date(NOW - 60_000).toISOString(),
  active: true,
  ...over,
});

const build = (
  sessions: SessionMeta[],
  opts: { activity?: Record<string, SessionActivity>; collapsed?: string[] } = {},
) =>
  buildSessionRows({
    sessions,
    activityOf: (id) => opts.activity?.[id] ?? 'idle',
    collapsed: new Set(opts.collapsed ?? []),
    now: NOW,
  });

describe('views/sessionsViewModel', () => {
  // 손잡이 자리는 목록 단위로 정한다. 행마다 정하면 서브가 있는 세션과 없는 세션이 섞였을 때
  // 같은 단계인데 이름 시작점이 달라진다.
  describe('접기 손잡이 자리', () => {
    it('서브가 하나도 없으면 자리를 안 비운다', () => {
      const rows = build([meta({ sessionId: 'a' }), meta({ sessionId: 'b' })]);
      assert.equal(needsTwistColumn(rows), false);
    });

    it('서브가 하나라도 있으면 자리를 비운다 — 줄이 맞아야 한다', () => {
      const rows = build([
        meta({ sessionId: 'p' }),
        meta({ sessionId: 'c', parentSessionId: 'p' }),
        meta({ sessionId: 'l' }),
      ]);
      assert.equal(needsTwistColumn(rows), true);
    });

    it('부모를 접어 자식이 안 보여도 자리는 그대로다 — 손잡이가 거기 있다', () => {
      const rows = build(
        [meta({ sessionId: 'p' }), meta({ sessionId: 'c', parentSessionId: 'p' })],
        { collapsed: ['p'] },
      );
      assert.equal(needsTwistColumn(rows), true);
    });

    it('세션이 없으면 자리도 없다', () => {
      assert.equal(needsTwistColumn([]), false);
    });
  });

  describe('평탄화', () => {
    const parent = meta({ sessionId: 'p' });
    const child = meta({ sessionId: 'c', parentSessionId: 'p' });
    const lone = meta({ sessionId: 'l' });

    it('부모 다음에 자식이 한 단 들어가서 온다', () => {
      const rows = build([parent, child, lone]);
      assert.deepEqual(rows.map((r) => r.sessionId), ['p', 'c', 'l']);
      assert.deepEqual(rows.map((r) => r.depth), [0, 1, 0]);
    });

    it('부모를 접으면 자식이 빠진다', () => {
      const rows = build([parent, child, lone], { collapsed: ['p'] });
      assert.deepEqual(rows.map((r) => r.sessionId), ['p', 'l']);
      assert.equal(rows[0].collapsed, true);
    });

    it('자식이 있는 행만 펼침 손잡이를 갖는다', () => {
      const rows = build([parent, child, lone]);
      assert.deepEqual(rows.map((r) => r.hasChildren), [true, false, false]);
    });

    it('부모가 이 워크스페이스에 없는 고아는 최상위로 올린다', () => {
      const orphan = meta({ sessionId: 'o', parentSessionId: 'gone' });
      const rows = build([orphan]);
      assert.deepEqual(rows.map((r) => [r.sessionId, r.depth, r.kind]), [['o', 0, 'session']]);
    });

    it('자기 자신을 부모로 가리켜도 무한히 돌지 않는다', () => {
      const self = meta({ sessionId: 's', parentSessionId: 's' });
      assert.deepEqual(build([self]).map((r) => r.sessionId), ['s']);
    });

    it('원래 순서를 지킨다', () => {
      const a = meta({ sessionId: 'a' });
      const b = meta({ sessionId: 'b' });
      assert.deepEqual(build([b, a]).map((r) => r.sessionId), ['b', 'a']);
    });
  });

  describe('아이콘', () => {
    it('활동 상태를 아이콘 키에 싣는다', () => {
      const rows = build([meta({ sessionId: 'a' })], { activity: { a: 'running' } });
      assert.equal(rows[0].iconKey, 'claude-running.svg');
    });

    it('닫힌 세션은 상태를 안 그린다', () => {
      const rows = build([meta({ sessionId: 'a', active: false })], { activity: { a: 'running' } });
      assert.equal(rows[0].iconKey, 'claude-closed.svg');
      assert.equal(rows[0].closed, true);
    });

    it('접힌 부모는 자식 활동을 끌어올려 보여준다', () => {
      const parent = meta({ sessionId: 'p' });
      const child = meta({ sessionId: 'c', parentSessionId: 'p' });
      const rows = build([parent, child], { activity: { c: 'running' }, collapsed: ['p'] });
      assert.equal(rows[0].iconKey, 'claude-running.svg');
    });

    it('닫힌 자식은 부모를 물들이지 않는다', () => {
      const parent = meta({ sessionId: 'p' });
      const child = meta({ sessionId: 'c', parentSessionId: 'p', active: false });
      const rows = build([parent, child], { activity: { c: 'running' } });
      assert.equal(rows[0].iconKey, 'claude.svg');
    });

    it('모델마다 다른 아이콘을 쓴다', () => {
      const rows = build([meta({ sessionId: 'a', model: 'agy' })]);
      assert.equal(rows[0].iconKey, 'agy.svg');
    });
  });

  describe('timeAgo', () => {
    const at = (ms: number) => timeAgo(new Date(NOW - ms).toISOString(), NOW);

    it('1분 미만은 just now다', () => assert.equal(at(30_000), 'just now'));
    it('분 단위로 센다', () => assert.equal(at(5 * 60_000), '5m ago'));
    it('60분부터 시간 단위다', () => assert.equal(at(60 * 60_000), '1h ago'));
    it('24시간부터 날 단위다', () => assert.equal(at(24 * 3_600_000), '1d ago'));
    it('행에 실린다', () => {
      assert.equal(build([meta({ sessionId: 'a' })])[0].timeAgo, '1m ago');
    });
  });
});
