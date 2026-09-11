// HTML 뷰어 — 서빙할 때 여는 태그마다 원본 줄 번호를 박는다 (0.7.0 spec 3.2).
//
// 짚은 요소가 원본의 어느 것인지 알아보는 문제를, 나중에 찾지 않고 미리 표시해 두는 것으로 푼다.
// 짚기 스크립트는 `el.closest('[data-ab-line]')`로 이 값을 읽기만 한다.
//
// 불변식 둘을 깨면 기능 전체가 어긋난다.
//   - 출력의 줄 수가 입력과 같다. 속성은 여는 태그 안 같은 줄에 들어간다.
//   - 태그가 아닌 것에는 안 박는다. 주석과 script·style·textarea·title 안의 태그 모양 문자열,
//     그리고 속성값 안의 `>`가 그 자리다.
//
// 트리도 CSS 매처도 만들지 않는다. 여는 태그를 앞에서부터 훑으며 속성을 끼우는 것이 전부다 —
// 의존성을 안 넣기로 했고, 런타임에 클래스가 바뀌는 페이지에서 선택자 역추적이 틀리기 때문이다.

// 내용을 태그로 읽지 않는 요소. 여기 안쪽은 통째로 건너뛴다.
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);

const STAMP_ATTR = 'data-ab-line';

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) if (s[i] === '\n') n += 1;
  return n;
}

// `<` 바로 다음이 태그 이름인가. 아니면 그냥 글자로 쓰인 `<`다.
function tagNameAt(html: string, i: number): string {
  const first = html[i];
  if (!first || !/[a-zA-Z]/.test(first)) return '';
  let j = i + 1;
  while (j < html.length && /[a-zA-Z0-9:_.-]/.test(html[j])) j += 1;
  return html.slice(i, j);
}

// 속성 구간의 끝(`>`)을 찾는다. 따옴표 안의 `>`는 끝이 아니다 — 목업의 `title="a>b"`가 그 자리다.
// 못 찾으면 -1.
function findTagEnd(html: string, from: number): number {
  let quote = '';
  for (let i = from; i < html.length; i += 1) {
    const c = html[i];
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '>') return i;
  }
  return -1;
}

// 원시 텍스트 요소의 닫는 태그 위치(`<`의 인덱스). 못 찾으면 -1.
function findCloseTag(html: string, from: number, name: string): number {
  const want = `</${name.toLowerCase()}`;
  const hay = html.toLowerCase();
  return hay.indexOf(want, from);
}

// 원본 HTML 문자열 → 여는 태그에 `data-ab-line="<줄>"`이 박힌 문자열.
export function stampLines(html: string): string {
  let out = '';
  let i = 0;
  let line = 1;

  const take = (stop: number): void => {
    const chunk = html.slice(i, stop);
    out += chunk;
    line += countNewlines(chunk);
    i = stop;
  };

  while (i < html.length) {
    const c = html[i];

    if (c !== '<') {
      if (c === '\n') line += 1;
      out += c;
      i += 1;
      continue;
    }

    // 주석 — 안쪽은 태그가 아니다.
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      take(end === -1 ? html.length : end + 3);
      continue;
    }

    // 닫는 태그·선언(DOCTYPE)·처리 지시 — 도장 대상이 아니다.
    if (html.startsWith('</', i) || html.startsWith('<!', i) || html.startsWith('<?', i)) {
      const end = html.indexOf('>', i);
      take(end === -1 ? html.length : end + 1);
      continue;
    }

    const name = tagNameAt(html, i + 1);
    if (!name) {
      // 글자로 쓰인 `<`.
      out += c;
      i += 1;
      continue;
    }

    const end = findTagEnd(html, i + 1 + name.length);
    if (end === -1) {
      // 닫히지 않은 태그. 남은 것을 그대로 옮기고 끝낸다 — 깨진 문서라도 내용을 잃지 않는다.
      take(html.length);
      continue;
    }

    const openTag = html.slice(i, end + 1);
    const attrs = html.slice(i + 1 + name.length, end);
    // 이미 박힌 것에 두 번 박지 않는다. 같은 응답을 두 번 태우는 경로는 없지만, 박은 결과를
    // 다시 태워도 같은 값이 나와야 이 함수를 어디서 불러도 안전하다.
    out += new RegExp(`\\b${STAMP_ATTR}\\s*=`).test(attrs)
      ? openTag
      : `<${name} ${STAMP_ATTR}="${line}"${attrs}>`;
    line += countNewlines(openTag);
    i = end + 1;

    // 원시 텍스트 요소는 닫는 태그까지 통째로 건너뛴다. 안쪽의 `<div>`는 글자이지 태그가 아니다.
    if (RAW_TEXT.has(name.toLowerCase()) && !openTag.endsWith('/>')) {
      const close = findCloseTag(html, i, name);
      take(close === -1 ? html.length : close);
    }
  }

  return out;
}
