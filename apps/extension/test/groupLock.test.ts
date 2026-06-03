import { strict as assert } from 'assert';
import { createGroupLocker } from '../src/views/groupLock';

// 채팅 패널 에디터 그룹 자동 잠금 상태 머신 검증.
// 설계: docs/0.1.0/plan/02_editor_group_lock.md §4.1
describe('groupLock', () => {
  function makeDeps(): {
    calls: string[];
    warnings: string[];
    deps: { executeCommand: (cmd: string) => PromiseLike<unknown>; warn: (msg: string) => void };
  } {
    const calls: string[] = [];
    const warnings: string[] = [];
    return {
      calls,
      warnings,
      deps: {
        executeCommand: (cmd: string) => {
          calls.push(cmd);
          return Promise.resolve(undefined);
        },
        warn: (msg: string) => {
          warnings.push(msg);
        },
      },
    };
  }

  it('locks the group on first active view state', () => {
    const { calls, deps } = makeDeps();
    const locker = createGroupLocker(deps);
    locker.onViewState(true);
    assert.deepEqual(calls, ['workbench.action.lockEditorGroup']);
  });

  it('does not lock while the panel is not active', () => {
    const { calls, deps } = makeDeps();
    const locker = createGroupLocker(deps);
    locker.onViewState(false);
    locker.onViewState(false);
    assert.equal(calls.length, 0);
  });

  it('attempts the lock only once even across repeated activations', () => {
    const { calls, deps } = makeDeps();
    const locker = createGroupLocker(deps);
    locker.onViewState(true);
    locker.onViewState(false);
    locker.onViewState(true);
    locker.onViewState(true);
    assert.equal(calls.length, 1);
  });

  it('swallows command failure and logs a warning instead of throwing', async () => {
    const warnings: string[] = [];
    const locker = createGroupLocker({
      executeCommand: () => Promise.reject(new Error('command not found')),
      warn: (msg: string) => {
        warnings.push(msg);
      },
    });
    // throw가 새어나오면 이 호출 자체가 실패한다
    locker.onViewState(true);
    // 비동기 reject 처리가 돌 시간을 준다
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('command not found'));
  });
});
