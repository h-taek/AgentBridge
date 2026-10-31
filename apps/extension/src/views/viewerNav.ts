// 뷰어의 페이지 이동 기록과 배율 계산을 담당하는 순수 함수 (0.8.3 HTML 뷰어, spec/04 §2·§4).
//
// 웹뷰 스크립트에 Function.prototype.toString()으로 그대로 박아 넣으므로,
// 네 함수는 모듈 바깥의 상수나 다른 함수를 참조하지 않는다.

export type NavState = {
  stack: { url: string; y: number }[];
  idx: number;
  off: boolean;
  expect: number | null;
};

export type NavEvent =
  | { k: 'at'; url: string; full: boolean }
  | { k: 'off' }
  | { k: 'leave'; y: number }
  | { k: 'go'; dir: -1 | 1 };

// 이동 사건을 받아 다음 상태와 바깥에서 수행할 동작(replace, scrollTo)을 돌려준다.
// 입력 상태를 직접 고치지 않는다.
export function navStep(
  s: NavState,
  e: NavEvent,
): { s: NavState; replace?: string; scrollTo?: number } {
  const stack = s.stack.map((v) => ({ url: v.url, y: v.y }));

  if (e.k === 'at') {
    if (s.expect !== null) {
      const idx = s.expect;
      const next: NavState = { stack, idx, off: false, expect: null };
      if (e.full && stack[idx] && stack[idx].y > 0) {
        return { s: next, scrollTo: stack[idx].y };
      }
      return { s: next };
    }
    if (!s.off && s.idx >= 0 && stack[s.idx] && stack[s.idx].url === e.url) {
      return { s: { stack, idx: s.idx, off: s.off, expect: null } };
    }
    const cut = stack.slice(0, s.idx + 1);
    cut.push({ url: e.url, y: 0 });
    return { s: { stack: cut, idx: cut.length - 1, off: false, expect: null } };
  }

  if (e.k === 'off') {
    const cut = stack.slice(0, s.idx + 1);
    return { s: { stack: cut, idx: s.idx, off: true, expect: null } };
  }

  if (e.k === 'leave') {
    if (!s.off && s.idx >= 0 && stack[s.idx]) {
      stack[s.idx] = { url: stack[s.idx].url, y: e.y };
    }
    return { s: { stack, idx: s.idx, off: s.off, expect: s.expect } };
  }

  const target = e.dir === -1 ? (s.off ? s.idx : s.idx - 1) : s.off ? -1 : s.idx + 1;
  if (target < 0 || target >= stack.length) {
    return { s: { stack, idx: s.idx, off: s.off, expect: s.expect } };
  }
  return {
    s: { stack, idx: s.idx, off: s.off, expect: target },
    replace: stack[target].url,
  };
}

// 지금 상태에서 뒤로·앞으로 갈 수 있는지 판정한다.
export function navCan(s: NavState): { back: boolean; fwd: boolean } {
  return {
    back: s.off ? s.idx >= 0 : s.idx > 0,
    fwd: !s.off && s.idx < s.stack.length - 1,
  };
}

// 현재 배율에서 지정한 방향의 다음 단계 배율을 돌려준다.
export function zoomStep(cur: number, dir: -1 | 1): number {
  const steps = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200];
  if (dir === 1) {
    for (let i = 0; i < steps.length; i++) {
      if (steps[i] > cur) return steps[i];
    }
    return steps[steps.length - 1];
  }
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i] < cur) return steps[i];
  }
  return steps[0];
}

// 입력 문자열을 정수 배율(25~200)로 파싱한다. 정수가 아니면 null을 돌려준다.
export function parseZoom(text: string): number | null {
  const t = text.trim();
  if (!/^-?\d+$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isSafeInteger(n)) return null;
  return Math.max(25, Math.min(200, n));
}
