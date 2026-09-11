// 0.7.0 HTML 뷰어 — 웹뷰 HTML 자체를 한 번 훑는다.
//
// 웹뷰 스크립트는 템플릿 문자열 안이라 tsc도 mocha도 안 본다. 소스를 눈으로 읽는 것으로는
// 부족하다 — 템플릿이 평가되고 나서야 깨지는 종류가 있다. 그래서 실제로 만들어진 HTML에서
// 스크립트를 뽑아 파서에 태운다(sessionsView.test.ts와 같은 방식).
import { strict as assert } from 'assert';
import { buildViewerHtml } from '../src/views/viewerPanel';

const ASSETS = {
  claude: 'https://webview/media/logos/claude.svg',
  codex: 'https://webview/media/logos/codex.svg',
  agy: 'https://webview/media/logos/agy.svg',
  brand: 'https://webview/media/icon-dark.svg',
};
const CSP = "'self' https://*.cdn";

const build = (port?: number, src = 'http://127.0.0.1:51234/docs/a.html'): string =>
  buildViewerHtml(ASSETS, CSP, port, src);

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
    const csp = /content="([^"]+)"/.exec(build(51234))?.[1] ?? '';
    assert.match(csp, /frame-src http:\/\/127\.0\.0\.1:51234;/);
    assert.equal(csp.includes('127.0.0.1:*'), false);
    assert.match(csp, /default-src 'none'/);
    assert.equal(csp.includes("'unsafe-inline'"), false);
    assert.match(csp, /script-src 'nonce-/);
  });

  it('이미지는 웹뷰 출처에서만 받는다', () => {
    // 로고를 그리려면 img-src가 필요하다. 열어 주는 것은 웹뷰 자신의 출처뿐이다.
    const csp = /content="([^"]+)"/.exec(build(51234))?.[1] ?? '';
    assert.ok(csp.includes(`img-src ${CSP};`), csp);
  });

  it('iframe이 서버 주소를 가리킨다', () => {
    assert.match(
      build(51234),
      /<iframe id="frame" src="http:\/\/127\.0\.0\.1:51234\/docs\/a\.html"/,
    );
  });

  it('두 단계 모두 브랜드 로고를 싣는다', () => {
    for (const doc of [build(undefined), build(51234)]) {
      assert.ok(doc.includes(ASSETS.brand), '브랜드 로고가 없다');
    }
  });

  it('모델 로고 셋을 스크립트가 들고 있다', () => {
    const body = scriptBody(build(51234));
    for (const url of [ASSETS.claude, ASSETS.codex, ASSETS.agy]) {
      assert.ok(body.includes(url), `${url}가 없다`);
    }
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
    const ids = [
      'stage', 'frame', 'state', 'load', 'msg', 'again',
      'panel', 'nub', 'who', 'pickbtn', 'drop', 'x', 'note', 'more', 'brief', 'detail', 'warn', 'send',
      'scrim', 'modal', 'list', 'none',
      'bar', 'sw', 'lab', 'fresh', 'why', 'sess',
    ];
    for (const id of ids) {
      assert.ok(doc.includes(`id="${id}"`), `${id}가 없다`);
    }
  });

  it('세션 선택은 우리 창으로 한다 — IDE 기본 선택창을 부르지 않는다', () => {
    const body = scriptBody(build(51234));
    assert.match(body, /t: 'pickSession'/);
    assert.match(body, /openPicker\('modal'\)/);
  });

  it('창이 열려 있는 동안만 목록 갱신을 받는다', () => {
    // 열 때 요청하고 닫을 때 끊는다. 익스텐션은 이 둘 사이에만 다시 센다.
    const body = scriptBody(build(51234));
    assert.match(body, /t: 'pickerClosed'/);
    assert.match(body, /scrim\.hidden = picker !== 'modal'/);
    assert.match(body, /drop\.hidden = picker !== 'drop'/);
  });

  it('고른 세션이 목록에서 사라지면 읽기로 돌아간다', () => {
    const body = scriptBody(build(51234));
    assert.match(body, /if \(agent\) setMode\(false\);/);
  });

  it('안에서 온 메시지와 익스텐션 메시지를 출처로 가른다', () => {
    assert.match(scriptBody(build(51234)), /e\.origin !== SERVER_ORIGIN/);
  });

  it('iframe으로 보낼 때 targetOrigin을 준다', () => {
    const body = scriptBody(build(51234));
    assert.match(body, /frame\.contentWindow\.postMessage\(m, SERVER_ORIGIN\)/);
    assert.match(body, /ab: 'mode'/);
  });

  it('에이전트 모드는 준비 신호가 있어야 열린다', () => {
    const body = scriptBody(build(51234));
    assert.match(body, /if \(!ready \|\| bar\.classList\.contains\('lock'\)\) return;/);
    assert.match(body, /ab === 'ready'/);
  });

  it('전송이 성공했을 때만 패널을 접는다', () => {
    assert.match(scriptBody(build(51234)), /if \(d\.ok\) setPanel\(false\);/);
  });

  it('인라인 패널의 열림 상태를 익스텐션에 알린다', () => {
    // 패널이 열려 있는 동안 다시 그리기를 미루는 판정이 이 신호에 걸려 있다.
    assert.match(scriptBody(build(51234)), /t: 'panel', open: open/);
  });

  it('상태 화면의 재시도가 익스텐션에 닿는다', () => {
    for (const doc of [build(undefined), build(51234)]) {
      assert.match(scriptBody(doc), /t: 'retry'/);
    }
  });
});
