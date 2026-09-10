// 0.6.0 — 웹뷰 HTML 자체를 한 번 훑는다.
//
// 웹뷰 스크립트는 템플릿 문자열 안이라 tsc도 mocha도 안 본다. 게다가 소스를 눈으로 읽는 것으로는
// 부족하다 — 템플릿이 평가되고 나서야 깨지는 종류가 있다(작은따옴표 안에 들어간 진짜 줄바꿈으로
// 스크립트 전체가 죽은 적이 있다). 그래서 실제로 만들어진 HTML에서 스크립트를 뽑아 파서에 태운다.
import { strict as assert } from 'assert';
import { SessionsViewProvider } from '../src/views/sessionsView';

const webview = {
  cspSource: 'vscode-webview://stub',
  asWebviewUri: () => ({ toString: () => 'https://webview/assets' }),
};

function html(): string {
  const provider = new SessionsViewProvider(
    { fsPath: '/ext/assets', toString: () => 'file:///ext/assets' } as never,
    { getAll: () => ({}) } as never,
    { get: () => [], update: async () => undefined } as never,
    { open: () => undefined, rename: () => undefined, delete: () => undefined },
  );
  return (provider as unknown as { buildHtml(w: unknown): string }).buildHtml(webview);
}

function scriptBody(doc: string): string {
  const m = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(doc);
  assert.ok(m, '스크립트를 찾지 못했다');
  return m[1];
}

describe('views/sessionsView HTML', () => {
  const doc = html();

  it('스크립트가 문법 오류 없이 파싱된다', () => {
    // new Function은 파싱만 한다 — 실행하지 않으므로 DOM이 없어도 된다.
    assert.doesNotThrow(() => new Function(scriptBody(doc)));
  });

  it('스크립트가 하나뿐이다', () => {
    assert.equal(doc.split('<script').length - 1, 1);
  });

  it('채우지 못한 템플릿 자리가 남지 않는다', () => {
    assert.equal(/\$\{/.test(doc), false);
  });

  it('CSP가 nonce로 스크립트를 잠근다', () => {
    const csp = /content="([^"]+)"/.exec(doc)?.[1] ?? '';
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'nonce-[^']+'/);
    assert.equal(csp.includes("'unsafe-inline'"), false);
  });

  it('그릴 자리 넷을 모두 만든다', () => {
    for (const id of ['usage', 'list', 'tip', 'menu']) {
      assert.ok(doc.includes(`id="${id}"`), `${id}가 없다`);
    }
  });
});
