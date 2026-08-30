// 0.5.0 W4·W5 — 세션 트리 순수 계산부(부모·자식 분류, 행 종류, 아이콘 키, 집계값, 삭제 확인 문구).
// 근거: docs/0.5.0/plan/02_stage2_session_tree.md W4·W5, docs/0.5.0/spec/01_orca_adoption.md B-3.
import { strict as assert } from 'assert';
import type { SessionMeta } from '../src/core/sessionRegistry';
import {
  rowKindOf,
  rootSessions,
  childSessions,
  iconKey,
  visibleActivity,
  rowActivity,
  planDeleteConfirm,
} from '../src/views/sessionTreeModel';

function mkSession(overrides: Partial<SessionMeta> & { sessionId: string }): SessionMeta {
  return {
    workspaceId: 'w1',
    model: 'claude',
    name: overrides.sessionId,
    createdAt: '2026-06-25T00:00:00.000Z',
    lastActiveAt: '2026-06-25T00:00:00.000Z',
    active: true,
    ...overrides,
  };
}

describe('sessionTreeModel — 부모·자식 분류', () => {
  it('부모가 없는 세션은 최상위다', () => {
    const main = mkSession({ sessionId: 'main' });
    assert.deepEqual(rootSessions([main]), [main]);
    assert.equal(rowKindOf(main, [main]), 'session');
  });

  it('부모가 존재하면 서브 행이고, 부모의 자식 목록에 잡힌다', () => {
    const main = mkSession({ sessionId: 'main' });
    const sub = mkSession({ sessionId: 'sub', parentSessionId: 'main' });
    const all = [main, sub];

    assert.deepEqual(rootSessions(all), [main]);
    assert.equal(rowKindOf(sub, all), 'subsession');
    assert.deepEqual(childSessions(all, 'main'), [sub]);
  });

  it('없는 부모를 가리키는 레코드(고아)는 최상위로 승격한다', () => {
    const orphan = mkSession({ sessionId: 'orphan', parentSessionId: 'gone' });
    assert.deepEqual(rootSessions([orphan]), [orphan]);
    assert.equal(rowKindOf(orphan, [orphan]), 'session');
  });

  it('자기 자신을 부모로 가리키는 degenerate 레코드는 최상위로 뜨고 자기 자식이 아니다(무한루프 없음)', () => {
    const selfRef = mkSession({ sessionId: 's1', parentSessionId: 's1' });
    assert.deepEqual(rootSessions([selfRef]), [selfRef]);
    assert.equal(rowKindOf(selfRef, [selfRef]), 'session');
    assert.deepEqual(childSessions([selfRef], 's1'), []);
  });

  it('한 부모에 자식이 여럿이면 전부 잡힌다', () => {
    const main = mkSession({ sessionId: 'main' });
    const sub1 = mkSession({ sessionId: 'sub1', parentSessionId: 'main' });
    const sub2 = mkSession({ sessionId: 'sub2', parentSessionId: 'main' });
    const all = [main, sub1, sub2];
    assert.deepEqual(childSessions(all, 'main'), [sub1, sub2]);
    assert.deepEqual(rootSessions(all), [main]);
  });
});

describe('sessionTreeModel — 아이콘 키 조합', () => {
  it('idle은 접미사가 없다(기존 파일명 유지)', () => {
    assert.equal(iconKey('claude', false, 'idle'), 'claude.svg');
    assert.equal(iconKey('claude', true, 'idle'), 'claude-closed.svg');
  });

  it('상태 접미사가 붙는다', () => {
    assert.equal(iconKey('codex', false, 'running'), 'codex-running.svg');
    assert.equal(iconKey('codex', false, 'done'), 'codex-done.svg');
    assert.equal(iconKey('codex', false, 'unknown'), 'codex-unknown.svg');
  });

  it('닫힘이 상태 접미사보다 앞에 온다', () => {
    // 닫힘은 상태를 안 그린다 — 어떤 값이 들어와도 기본 원 하나다.
    assert.equal(iconKey('agy', true, 'running'), 'agy-closed.svg');
    assert.equal(iconKey('agy', true, 'done'), 'agy-closed.svg');
    assert.equal(iconKey('agy', true, 'unknown'), 'agy-closed.svg');
  });

  it('모델 3종 전부 같은 규칙을 탄다', () => {
    for (const model of ['claude', 'codex', 'agy']) {
      assert.equal(iconKey(model, false, 'idle'), `${model}.svg`);
      assert.equal(iconKey(model, true, 'idle'), `${model}-closed.svg`);
    }
  });
});

describe('sessionTreeModel — 부모 행 집계값', () => {
  it('서브 행은 자기 활동을 그대로 쓴다(자식 값 무시)', () => {
    assert.equal(rowActivity('subsession', 'idle', ['unknown', 'running']), 'idle');
  });

  it('메인 행은 자기 활동과 자식 값을 core aggregateActivity로 모은다', () => {
    assert.equal(rowActivity('session', 'idle', []), 'idle');
    assert.equal(rowActivity('session', 'idle', ['done']), 'done');
    assert.equal(rowActivity('session', 'running', ['unknown']), 'unknown');
    assert.equal(rowActivity('session', 'unknown', ['idle', 'done']), 'unknown');
  });
});

describe('sessionTreeModel — 삭제 확인 문구 조립', () => {
  it('서브 행은 항상 childCount 0', () => {
    const sub = mkSession({ sessionId: 'sub', parentSessionId: 'main' });
    assert.deepEqual(planDeleteConfirm('subsession', [sub]), {
      kind: 'subsession',
      childCount: 0,
      childNames: [],
    });
  });

  it('메인 행, 자식 0개', () => {
    assert.deepEqual(planDeleteConfirm('session', []), {
      kind: 'session',
      childCount: 0,
      childNames: [],
    });
  });

  it('메인 행, 자식 1개', () => {
    const sub = mkSession({ sessionId: 'sub', name: '서브 하나', parentSessionId: 'main' });
    assert.deepEqual(planDeleteConfirm('session', [sub]), {
      kind: 'session',
      childCount: 1,
      childNames: ['서브 하나'],
    });
  });

  it('메인 행, 자식 N개', () => {
    const sub1 = mkSession({ sessionId: 'sub1', name: '서브1', parentSessionId: 'main' });
    const sub2 = mkSession({ sessionId: 'sub2', name: '서브2', parentSessionId: 'main' });
    assert.deepEqual(planDeleteConfirm('session', [sub1, sub2]), {
      kind: 'session',
      childCount: 2,
      childNames: ['서브1', '서브2'],
    });
  });
});

describe('sessionTreeModel — 닫힌 세션의 표시 값', () => {
  it('열린 세션은 계산된 값을 그대로 쓴다', () => {
    assert.equal(visibleActivity(true, 'running'), 'running');
    assert.equal(visibleActivity(true, 'done'), 'done');
    assert.equal(visibleActivity(true, 'unknown'), 'unknown');
  });

  it('닫힌 세션은 무슨 값이 나와도 표시 없음이다', () => {
    // 도는 중에 탭을 닫으면 신호가 진행 중인 채로 남고, 끝나고 닫으면 안 본 완료로 남는다.
    // 둘 다 프로세스가 없는 상태라 표시하지 않는다.
    assert.equal(visibleActivity(false, 'running'), 'idle');
    assert.equal(visibleActivity(false, 'done'), 'idle');
    assert.equal(visibleActivity(false, 'unknown'), 'idle');
    assert.equal(visibleActivity(false, 'idle'), 'idle');
  });
});
