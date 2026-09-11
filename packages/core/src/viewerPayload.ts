// HTML 뷰어 — 짚은 요소를 프롬프트 문자열로 직렬화한다 (0.7.0 spec 3.3).
//
// 요소 정보를 <agentbridge-element> 블록으로 감싸 프롬프트 앞부분에 두고,
// 사용자가 입력한 지시문을 뒤에 둔다.
//
// 불변식:
//   - 값은 한 줄로 접고 개행과 `<`를 이스케이프한다. 구분자가 깨지는 것을 막는다.
//   - 텍스트에는 길이 상한(VIEWER_TEXT_MAX)을 적용해 프롬프트가 과도하게 길어지지 않게 한다.
//   - 상위 요소의 줄 번호를 사용한 경우 `(상위 요소)` 표시를 붙인다.

export interface PickedElement {
  line: number;
  lineIsAncestor: boolean; // 요소 자신에 도장이 없어 상위 줄을 쓴 경우
  selector: string;
  tag: string; // 태그명과 속성
  text: string;
}

export const VIEWER_TEXT_MAX = 200;

// 개행을 접고 `<`를 이스케이프한다. 구분자 블록과 줄머리 키가 깨지지 않게 한다.
function foldValue(s: string): string {
  return s.replace(/\r?\n/g, '\\n').replace(/</g, '&lt;');
}

// 짚은 요소 정보를 다섯 줄 형식의 블록으로 직렬화하고 사용자 메모를 뒤에 붙인다.
export function buildViewerPrompt(docPath: string, el: PickedElement, note: string): string {
  const lineText = el.lineIsAncestor ? `${el.line} (상위 요소)` : String(el.line);

  let foldedText = foldValue(el.text);
  if (foldedText.length > VIEWER_TEXT_MAX) {
    foldedText = foldedText.slice(0, VIEWER_TEXT_MAX) + '…';
  }

  const lines = [
    '<agentbridge-element>',
    `문서: ${foldValue(docPath)}`,
    `줄: ${lineText}`,
    `선택자: ${foldValue(el.selector)}`,
    `태그: ${foldValue(el.tag)}`,
    `텍스트: ${foldedText}`,
    '</agentbridge-element>',
  ];

  const header = lines.join('\n');
  return note ? `${header}\n${note}` : header;
}
