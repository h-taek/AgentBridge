// 0.7.0 HTML 뷰어 — 웹뷰 HTML 자체를 한 번 훑는다.
//
// 웹뷰 스크립트는 템플릿 문자열 안이라 tsc도 mocha도 안 본다. 소스를 눈으로 읽는 것으로는
// 부족하다 — 템플릿이 평가되고 나서야 깨지는 종류가 있다. 그래서 실제로 만들어진 HTML에서
// 스크립트를 뽑아 파서에 태운다(sessionsView.test.ts와 같은 방식).
import { strict as assert } from 'assert';
import { buildViewerHtml } from '../src/views/viewerPanel';

const build = (port?: number, src = 'http://127.0.0.1:51234/docs/a.html'): string =>
  buildViewerHtml(port, src);

function scriptBody(doc: string): string {
  const m = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(doc);
  assert.ok(m, '스크립트를 찾지 못했다');
  return m[1];
}

describe('views/viewerPanel HTML', () => {
  it('1단계 기동 화면에는 iframe이 없고 출처를 보고한다', () => {
    const doc = build(undefined);
    assert.equal(doc.includes('<iframe'), false);
    assert.match(doc, /postMessage\(\{ t: 'origin', origin: window\.origin \}\)/);
    assert.equal(/frame-src/.test(doc), false);
  });

  it('2단계 화면은 받은 포트만 frame-src에 넣는다', () => {
    const doc = build(51234);
    const csp = /content="([^"]+)"/.exec(doc)?.[1] ?? '';
    assert.match(csp, /frame-src http:\/\/127\.0\.0\.1:51234;/);
    assert.equal(csp.includes('127.0.0.1:*'), false);
    assert.match(csp, /default-src 'none'/);
    assert.equal(csp.includes("'unsafe-inline'"), false);
    assert.match(csp, /script-src 'nonce-/);
  });

  it('iframe이 서버 주소를 가리킨다', () => {
    assert.match(build(51234), /<iframe id="frame" src="http:\/\/127\.0\.0\.1:51234\/docs\/a\.html"/);
  });

  it('스크립트가 문법 오류 없이 파싱된다', () => {
    for (const doc of [build(undefined), build(51234)]) {
      assert.doesNotThrow(() => new Function(scriptBody(doc)));
    }
  });

  it('스크립트가 하나뿐이다', () => {
    assert.equal(build(51234).split('<script').length - 1, 1);
  });

  it('채우지 못한 템플릿 자리가 남지 않는다', () => {
    assert.equal(/\$\{/.test(build(51234)), false);
    assert.equal(/\$\{/.test(build(undefined)), false);
  });

  it('그릴 자리를 모두 만든다', () => {
    const doc = build(51234);
    for (const id of [
      'stage',
      'frame',
      'status',
      'toggle',
      'hint',
      'panel',
      'note',
      'detail',
      'send',
      'warn',
    ]) {
      assert.ok(doc.includes(`id="${id}"`), `${id}가 없다`);
    }
  });

  it('안에서 온 메시지와 익스텐션 메시지를 출처로 가른다', () => {
    assert.match(scriptBody(build(51234)), /e\.origin !== SERVER_ORIGIN/);
  });

  it('iframe으로 보낼 때 targetOrigin을 준다', () => {
    const body = scriptBody(build(51234));
    assert.match(body, /frame\.contentWindow\.postMessage\(msg, SERVER_ORIGIN\)/);
    assert.match(body, /ab: 'mode'/);
  });

  it('에이전트 모드는 준비 신호가 있어야 열린다', () => {
    const body = scriptBody(build(51234));
    assert.match(body, /if \(!ready\) return;/);
    assert.match(body, /ab === 'ready'/);
  });

  it('전송이 성공했을 때만 패널을 접는다', () => {
    assert.match(scriptBody(build(51234)), /if \(d\.ok\) setPanel\(false\);/);
  });

  it('인라인 패널의 열림 상태를 익스텐션에 알린다', () => {
    // 패널이 열려 있는 동안 다시 그리기를 미루는 판정이 이 신호에 걸려 있다.
    assert.match(scriptBody(build(51234)), /t: 'panel', open: open/);
  });
});
