import { strict as assert } from 'assert';
import { resolveRefineDecisionFromConfig } from '@agentbridge/core';

// refine.useClaude 토글: false면 어느 정책이든 claude를 정제 후보에서 제외하고,
// 후보가 비면 off로 떨군다. 생략/true는 기존 동작(claude 허용).
describe('resolveRefineDecisionFromConfig — useClaude', () => {
  it('priority + useClaude 생략 → claude 포함 (기존 동작)', () => {
    const d = resolveRefineDecisionFromConfig(
      { policy: 'priority', fixedCli: 'agy', priorityOrder: ['agy', 'codex', 'claude'] },
      'agy',
    );
    assert.deepEqual(d, { policy: 'priority', order: ['agy', 'codex', 'claude'] });
  });

  it('priority + useClaude=false → claude 제외', () => {
    const d = resolveRefineDecisionFromConfig(
      { policy: 'priority', fixedCli: 'agy', priorityOrder: ['agy', 'codex', 'claude'], useClaude: false },
      'agy',
    );
    assert.deepEqual(d, { policy: 'priority', order: ['agy', 'codex'] });
  });

  it('priority 순서가 claude뿐 + useClaude=false → off (후보 소진)', () => {
    const d = resolveRefineDecisionFromConfig(
      { policy: 'priority', fixedCli: 'agy', priorityOrder: ['claude'], useClaude: false },
      'agy',
    );
    assert.deepEqual(d, { policy: 'off' });
  });

  it('fixed=claude + useClaude=false → off (정제 건너뜀)', () => {
    const d = resolveRefineDecisionFromConfig(
      { policy: 'fixed', fixedCli: 'claude', priorityOrder: [], useClaude: false },
      'agy',
    );
    assert.deepEqual(d, { policy: 'off' });
  });

  it('fixed=claude + useClaude=true → claude 사용', () => {
    const d = resolveRefineDecisionFromConfig(
      { policy: 'fixed', fixedCli: 'claude', priorityOrder: [], useClaude: true },
      'agy',
    );
    assert.deepEqual(d, { policy: 'fixed', cli: 'claude' });
  });

  it('active=claude + useClaude=false → off', () => {
    const d = resolveRefineDecisionFromConfig(
      { policy: 'active', fixedCli: 'agy', priorityOrder: [], useClaude: false },
      'claude',
    );
    assert.deepEqual(d, { policy: 'off' });
  });

  it('active=agy + useClaude=false → claude가 아니므로 영향 없음', () => {
    const d = resolveRefineDecisionFromConfig(
      { policy: 'active', fixedCli: 'agy', priorityOrder: [], useClaude: false },
      'agy',
    );
    assert.deepEqual(d, { policy: 'active', cli: 'agy' });
  });
});
