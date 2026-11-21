import { strict as assert } from 'assert';
import { filterLaunchArgs } from '@agentbridge/core';

describe('실행 인자 거르기 (0.10.0 spec/01 §4)', () => {
  it('막지 않는 옵션은 그대로 둔다', () => {
    assert.deepEqual(
      filterLaunchArgs('claude', ['--remote-control', '--add-dir', '/x']),
      { kept: ['--remote-control', '--add-dir', '/x'], dropped: [] },
    );
  });

  it('값 있는 금지 옵션은 값까지 뺀다', () => {
    assert.deepEqual(
      filterLaunchArgs('claude', ['--model', 'opus', '--remote-control']),
      { kept: ['--remote-control'], dropped: ['--model', 'opus'] },
    );
  });

  it('=값 형식은 그 원소만 뺀다', () => {
    assert.deepEqual(
      filterLaunchArgs('claude', ['--model=opus', '--remote-control']),
      { kept: ['--remote-control'], dropped: ['--model=opus'] },
    );
  });

  it('선택 값은 낱말일 때만 먹는다', () => {
    assert.deepEqual(
      filterLaunchArgs('claude', ['--resume', 'abc', '--resume', '--rc']),
      { kept: ['--rc'], dropped: ['--resume', 'abc', '--resume'] },
    );
  });

  it('값 없는 금지 옵션은 그것만 뺀다', () => {
    assert.deepEqual(
      filterLaunchArgs('claude', ['-c', '--remote-control']),
      { kept: ['--remote-control'], dropped: ['-c'] },
    );
  });

  it('혼자 있는 낱말은 뺀다', () => {
    assert.deepEqual(
      filterLaunchArgs('codex', ['resume', '--search']),
      { kept: ['--search'], dropped: ['resume'] },
    );
  });

  it('옵션 뒤 낱말은 값으로 둔다', () => {
    assert.deepEqual(
      filterLaunchArgs('codex', ['-s', 'workspace-write']),
      { kept: ['-s', 'workspace-write'], dropped: [] },
    );
  });

  it('--와 그 뒤를 모두 뺀다', () => {
    assert.deepEqual(
      filterLaunchArgs('claude', ['--verbose', '--', 'hi', '--x']),
      { kept: ['--verbose'], dropped: ['--', 'hi', '--x'] },
    );
  });

  it('codex -c 금지 키 네 형식', () => {
    const args = [
      '-c',
      'model="o3"',
      '-cmodel_provider=x',
      '--config',
      'model_reasoning_effort=high',
      '--config=sandbox_workspace_write.writable_roots=["/a"]',
    ];
    assert.deepEqual(
      filterLaunchArgs('codex', args),
      { kept: [], dropped: args },
    );
  });

  it('codex -c 다른 키는 남긴다', () => {
    const args = ['-c', 'model_verbosity="low"', '-c', 'shell_environment_policy.inherit=all'];
    assert.deepEqual(
      filterLaunchArgs('codex', args),
      { kept: args, dropped: [] },
    );
  });

  it('claude -c는 continue다', () => {
    assert.deepEqual(
      filterLaunchArgs('claude', ['-c', 'x']),
      { kept: [], dropped: ['-c', 'x'] },
    );
  });

  it('agy 금지 옵션', () => {
    assert.deepEqual(
      filterLaunchArgs('agy', ['--effort', 'high', '-i', 'go', '--remote-control']),
      { kept: ['--remote-control'], dropped: ['--effort', 'high', '-i', 'go'] },
    );
  });
});
