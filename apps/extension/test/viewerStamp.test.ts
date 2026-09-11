// 0.7.0 HTML 뷰어 — 서빙할 때 여는 태그에 박는 원본 줄 번호.
//
// 불변식은 둘이다. 출력의 줄 수가 입력과 같고(속성은 여는 태그 안 같은 줄에 들어간다),
// 원본에 태그가 아닌 것(주석·script·style 안의 태그 모양 문자열)에는 박지 않는다.
import { strict as assert } from 'assert';
import { stampLines } from '@agentbridge/core';

const lines = (s: string) => s.split('\n').length;
const stamps = (s: string) => s.match(/data-ab-line/g)?.length ?? 0;

describe('viewerStamp.stampLines', () => {
  it('여는 태그에 원본 줄 번호를 박는다', () => {
    const out = stampLines('<html>\n<body>\n<div class="a">x</div>\n</body>\n</html>');
    assert.match(out, /<html data-ab-line="1">/);
    assert.match(out, /<body data-ab-line="2">/);
    assert.match(out, /<div data-ab-line="3" class="a">/);
  });

  it('줄 수를 바꾸지 않는다', () => {
    const src = '<html>\n<body>\n<p>x</p>\n</body>\n</html>';
    assert.equal(lines(stampLines(src)), lines(src));
  });

  it('닫는 태그와 DOCTYPE은 건드리지 않는다', () => {
    const out = stampLines('<!DOCTYPE html>\n<p>x</p>');
    assert.ok(out.startsWith('<!DOCTYPE html>'));
    assert.equal(stamps(out), 1);
  });

  it('속성값 안의 >를 태그 끝으로 보지 않는다', () => {
    const out = stampLines('<a title="a>b" href="#">x</a>');
    assert.equal(out, '<a data-ab-line="1" title="a>b" href="#">x</a>');
  });

  it('작은따옴표 속성값 안의 >도 마찬가지다', () => {
    const out = stampLines("<a title='a>b'>x</a>");
    assert.equal(out, `<a data-ab-line="1" title='a>b'>x</a>`);
  });

  it('script 안의 태그 모양 문자열에는 안 박는다', () => {
    const out = stampLines('<script>\nconst s = "<div>";\n</script>');
    assert.equal(stamps(out), 1); // script 자신 하나뿐
    assert.match(out, /<script data-ab-line="1">/);
  });

  it('style 안과 주석 안에는 안 박는다', () => {
    const a = stampLines('<style>\na > b { color: red }\n</style>');
    assert.equal(stamps(a), 1);
    const b = stampLines('<!-- <div>숨은 것</div> -->\n<p>x</p>');
    assert.equal(stamps(b), 1);
    assert.match(b, /<p data-ab-line="2">/);
  });

  it('여러 줄짜리 주석과 script를 지나도 줄 번호가 맞는다', () => {
    const out = stampLines('<!--\n한 줄\n두 줄\n-->\n<p>x</p>');
    assert.match(out, /<p data-ab-line="5">/);
    const s = stampLines('<script>\n\n\n</script>\n<p>x</p>');
    assert.match(s, /<p data-ab-line="5">/);
  });

  it('자기 닫는 태그와 대문자 태그를 다룬다', () => {
    assert.match(stampLines('<img src="x"/>'), /<img data-ab-line="1" src="x"\/>/);
    assert.match(stampLines('<DIV>x</DIV>'), /<DIV data-ab-line="1">/);
    assert.match(stampLines('<SCRIPT>var a = "<b>";</SCRIPT>\n<p>x</p>'), /<p data-ab-line="2">/);
  });

  it('속성이 없는 태그와 공백이 있는 태그를 모두 다룬다', () => {
    assert.equal(stampLines('<br>'), '<br data-ab-line="1">');
    assert.equal(stampLines('<br />'), '<br data-ab-line="1" />');
  });

  it('여러 줄에 걸친 여는 태그는 시작 줄을 쓴다', () => {
    const out = stampLines('<div\n  class="a"\n>x</div>');
    assert.match(out, /^<div data-ab-line="1"\n/);
    assert.equal(lines(out), 3);
  });

  it('이미 박힌 태그에 두 번 박지 않는다', () => {
    const once = stampLines('<div class="a">x</div>');
    assert.equal(stampLines(once), once);
  });

  it('textarea와 title 안의 태그 모양 문자열에는 안 박는다', () => {
    assert.equal(stamps(stampLines('<title><div></title>')), 1);
    assert.equal(stamps(stampLines('<textarea><div></textarea>')), 1);
  });

  it('빈 문자열과 태그 없는 문서를 그대로 돌려준다', () => {
    assert.equal(stampLines(''), '');
    assert.equal(stampLines('그냥 글\n두 줄'), '그냥 글\n두 줄');
  });

  it('닫히지 않은 태그로 끝나도 던지지 않는다', () => {
    assert.doesNotThrow(() => stampLines('<div class="a'));
    assert.doesNotThrow(() => stampLines('<!-- 안 닫힌 주석'));
    assert.doesNotThrow(() => stampLines('<script>var a = 1;'));
  });

  it('목업 한 편을 통째로 태워도 줄 수가 그대로다', () => {
    const src = [
      '<!DOCTYPE html>',
      '<html lang="ko">',
      '<head>',
      '  <meta charset="utf-8">',
      '  <style>',
      '    .strip > .cell { color: red }',
      '  </style>',
      '</head>',
      '<body>',
      '  <div class="strip"><span>81%</span></div>',
      '  <script>',
      '    document.querySelector(".strip").innerHTML = "<i>x</i>";',
      '  </script>',
      '</body>',
      '</html>',
    ].join('\n');
    const out = stampLines(src);
    assert.equal(lines(out), lines(src));
    assert.match(out, /<div data-ab-line="10" class="strip"><span data-ab-line="10">/);
    assert.equal(stamps(out), 8); // html head meta style body div span script
  });
});
