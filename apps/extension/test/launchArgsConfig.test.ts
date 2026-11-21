import { strict as assert } from 'assert';
import { readLaunchArgs } from '../src/settings/config';
import { notifyLaunchArgsDropped } from '../src/core/notifications';
import { configValues, window as vscodeWindow } from './stubs/vscode';

describe('실행 인자 설정과 알림 (0.10.0 spec/01 §1·§4-2)', () => {
  const key = 'agentbridge.launchArgs.claude';

  afterEach(() => {
    delete configValues[key];
  });

  it('설정 배열을 그대로 돌려준다', () => {
    configValues[key] = ['--remote-control'];
    assert.deepEqual(readLaunchArgs('claude'), ['--remote-control']);
  });

  it('문자열이 아닌 원소는 버린다', () => {
    configValues[key] = ['--a', 3, null, '--b'];
    assert.deepEqual(readLaunchArgs('claude'), ['--a', '--b']);
  });

  it('배열이 아니면 빈 목록', () => {
    configValues[key] = '--a';
    assert.deepEqual(readLaunchArgs('claude'), []);
  });

  it('설정이 없으면 빈 목록', () => {
    assert.deepEqual(readLaunchArgs('claude'), []);
  });

  it('뺀 인자 알림은 같은 내용으로는 한 번만 띄운다', () => {
    const warnings: string[] = [];
    const orig = vscodeWindow.showWarningMessage;
    vscodeWindow.showWarningMessage = ((msg: string) => {
      warnings.push(msg);
      return Promise.resolve(undefined);
    }) as typeof vscodeWindow.showWarningMessage;

    try {
      notifyLaunchArgsDropped('claude', ['--model', 'opus']);
      notifyLaunchArgsDropped('claude', ['--model', 'opus']);
      notifyLaunchArgsDropped('claude', ['-c']);
      assert.equal(warnings.length, 2);
      assert.ok(warnings[0]!.includes('claude'));
      assert.ok(warnings[0]!.includes('--model opus'));
    } finally {
      vscodeWindow.showWarningMessage = orig;
    }
  });
});
