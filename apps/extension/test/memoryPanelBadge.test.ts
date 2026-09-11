// 대기 제안 뱃지.
//
// IDE는 웹뷰 뷰의 뱃지를 undefined로 되돌려도 화면에서 걷어내지 않는다 — workbench의
// WebviewViewPane.updateBadge는 값이 있을 때만 activity를 새로 걸고, TreeView 쪽에는 있는
// else clear()가 없다. 그래서 마지막으로 보인 숫자가 그대로 남는다.
// 액티비티 바는 뱃지 숫자의 합이 0이면 아무것도 그리지 않으므로, 0은 undefined가 아니라
// value 0짜리 뱃지로 보낸다 — 그러면 새 activity가 이전 것을 밀어내면서 화면이 비워진다.
import { strict as assert } from 'assert';
import { MemoryPanelProvider } from '../src/views/memoryPanel';

type Badge = { value: number; tooltip?: string } | undefined;

function fakeView() {
  return {
    badge: undefined as Badge,
    webview: {
      cspSource: 'vscode-webview://stub',
      options: {},
      html: '',
      onDidReceiveMessage: () => ({ dispose: () => { /* noop */ } }),
      postMessage: () => Promise.resolve(true),
    },
    onDidChangeVisibility: () => ({ dispose: () => { /* noop */ } }),
    visible: true,
  };
}

function provider() {
  const storage = { get: () => undefined, update: async () => undefined };
  const profile = {
    attach: () => { /* noop */ },
    handleMessage: async () => false,
    css: () => '',
    bodyHtml: () => '',
    script: () => '',
  };
  return new MemoryPanelProvider(storage as never, profile as never);
}

function resolve(p: MemoryPanelProvider, view: ReturnType<typeof fakeView>): void {
  p.resolveWebviewView(view as never, {} as never, {} as never);
}

describe('views/memoryPanel 제안 뱃지', () => {
  it('대기 제안이 있으면 그 수를 건다', () => {
    const p = provider();
    const v = fakeView();
    resolve(p, v);
    p.setBadge(3);
    assert.equal(v.badge?.value, 3);
  });

  it('0일 때 undefined가 아니라 value 0짜리 뱃지를 건다', () => {
    const p = provider();
    const v = fakeView();
    resolve(p, v);
    p.setBadge(3);
    p.setBadge(0);
    // undefined면 IDE가 화면에 남은 3을 지우지 않는다.
    assert.notEqual(v.badge, undefined, '0을 undefined로 보내면 이전 숫자가 화면에 남는다');
    assert.equal(v.badge?.value, 0);
  });

  it('숫자가 바뀔 때마다 새 값을 건다', () => {
    const p = provider();
    const v = fakeView();
    resolve(p, v);
    for (const [count, expected] of [[1, 1], [0, 0], [2, 2], [0, 0]] as const) {
      p.setBadge(count);
      assert.equal(v.badge?.value, expected);
    }
  });

  it('뷰가 살아나기 전에 들어온 수는 살아나는 순간 올린다', () => {
    const p = provider();
    p.setBadge(2);
    const v = fakeView();
    resolve(p, v);
    assert.equal(v.badge?.value, 2);
  });
});
