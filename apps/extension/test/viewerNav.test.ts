// 0.8.3 HTML 뷰어 — 이동 기록과 배율 순수 함수를 검증한다.
import { strict as assert } from 'assert';
import {
  navStep,
  navCan,
  zoomStep,
  parseZoom,
  type NavState,
} from '../src/views/viewerNav';

const START: NavState = { stack: [], idx: -1, off: false, expect: null };
const at = (s: NavState, url: string, full = true): NavState =>
  navStep(s, { k: 'at', url, full }).s;

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === 'object') {
    Object.freeze(obj);
    for (const v of Object.values(obj as Record<string, unknown>)) {
      deepFreeze(v);
    }
  }
  return obj;
}

describe('views/viewerNav', () => {
  it('처음 뜬 페이지가 첫 칸이다', () => {
    const s = at(START, '/a.html');
    assert.deepEqual([s.stack.map((v) => v.url), s.idx], [['/a.html'], 0]);
    assert.deepEqual(navCan(s), { back: false, fwd: false });
  });

  it('뒤로는 이전 칸 주소로 replace하고, 뜨면 떠날 때 스크롤로 돌린다', () => {
    let s = at(START, '/a.html');
    s = navStep(s, { k: 'leave', y: 420 }).s;
    s = at(s, '/b.html');
    const r = navStep(s, { k: 'go', dir: -1 });
    assert.equal(r.replace, '/a.html');
    const back = navStep(r.s, { k: 'at', url: '/a.html', full: true });
    assert.equal(back.s.idx, 0);
    assert.equal(back.scrollTo, 420);
    assert.deepEqual(navCan(back.s), { back: false, fwd: true });
  });

  it('뒤로 간 뒤 링크로 새 페이지가 뜨면 앞으로 칸을 버린다', () => {
    let s = at(at(START, '/a.html'), '/b.html');
    const r = navStep(s, { k: 'go', dir: -1 });
    s = at(r.s, '/a.html');
    s = at(s, '/c.html');
    assert.deepEqual([s.stack.map((v) => v.url), s.idx], [['/a.html', '/c.html'], 1]);
    assert.deepEqual(navCan(s), { back: true, fwd: false });
  });

  it('같은 주소가 다시 뜨면 칸을 더하지 않는다', () => {
    let s = at(START, '/a.html');
    s = at(s, '/a.html');
    assert.equal(s.stack.length, 1);
    assert.equal(s.idx, 0);
  });

  it('off 뒤 back은 그 페이지를 연 HTML로 간다', () => {
    let s = at(at(START, '/a.html'), '/b.html');
    s = navStep(s, { k: 'off' }).s;
    assert.deepEqual(navCan(s), { back: true, fwd: false });
    assert.equal(navStep(s, { k: 'go', dir: -1 }).replace, '/b.html');
  });

  it('off는 앞으로 칸을 버린다', () => {
    let s = at(at(START, '/a.html'), '/b.html');
    s = at(navStep(s, { k: 'go', dir: -1 }).s, '/a.html');
    s = navStep(s, { k: 'off' }).s;
    assert.deepEqual(s.stack.map((v) => v.url), ['/a.html']);
    assert.deepEqual(navCan(s), { back: true, fwd: false });
  });

  it('앵커 칸은 스크롤을 돌리지 않는다', () => {
    let s = at(START, '/a.html');
    const first = navStep(s, { k: 'at', url: '/a.html#x', full: false });
    assert.equal(first.scrollTo, undefined);
    s = navStep(first.s, { k: 'leave', y: 300 }).s;
    s = at(s, '/b.html');
    const r = navStep(s, { k: 'go', dir: -1 });
    const back = navStep(r.s, { k: 'at', url: '/a.html#x', full: false });
    assert.equal(back.scrollTo, undefined);
  });

  it('입력을 고치지 않는다', () => {
    let s = deepFreeze(at(at(deepFreeze(START), '/a.html'), '/b.html'));
    s = deepFreeze(navStep(s, { k: 'leave', y: 120 }).s);
    s = deepFreeze(navStep(s, { k: 'go', dir: -1 }).s);
    s = deepFreeze(navStep(s, { k: 'at', url: '/a.html', full: true }).s);
    s = deepFreeze(navStep(s, { k: 'off' }).s);
    assert.equal(s.off, true);
  });

  it('배율 단계', () => {
    assert.equal(zoomStep(100, -1), 90);
    assert.equal(zoomStep(60, 1), 67);
    assert.equal(zoomStep(25, -1), 25);
    assert.equal(zoomStep(200, 1), 200);
  });

  it('배율 입력', () => {
    assert.equal(parseZoom('60'), 60);
    assert.equal(parseZoom(' 300 '), 200);
    assert.equal(parseZoom('10'), 25);
    assert.equal(parseZoom('abc'), null);
    assert.equal(parseZoom('12.5'), null);
  });

  it('웹뷰에 박을 수 있다 — 바깥 이름을 참조하지 않는다', () => {
    for (const f of [navStep, navCan, zoomStep, parseZoom]) {
      const g = new Function(`return (${f.toString()})`)();
      assert.equal(typeof g, 'function');
    }
    assert.equal(new Function(`return (${zoomStep.toString()})`)()(100, 1), 110);
  });
});
