import { strict as assert } from 'assert';
import { buildViewerPrompt, VIEWER_TEXT_MAX } from '@agentbridge/core';

const el = {
  line: 42,
  lineIsAncestor: false,
  selector: '#root > div:nth-of-type(2)',
  tag: 'div class="strip"',
  text: '남은 사용량',
};

describe('viewerPayload.buildViewerPrompt', () => {
  it('요소가 앞, 사용자 글이 뒤에 온다', () => {
    const out = buildViewerPrompt('docs/mockups/a.html', el, '이 여백을 줄여라');
    const open = out.indexOf('<agentbridge-element>');
    const close = out.indexOf('</agentbridge-element>');
    assert.ok(open === 0);
    assert.ok(close > open);
    assert.ok(out.indexOf('이 여백을 줄여라') > close);
  });

  it('다섯 줄을 채운다', () => {
    const out = buildViewerPrompt('a.html', el, 'x');
    assert.match(out, /^문서: a\.html$/m);
    assert.match(out, /^줄: 42$/m);
    assert.match(out, /^선택자: #root > div:nth-of-type\(2\)$/m);
    assert.match(out, /^태그: div class="strip"$/m);
    assert.match(out, /^텍스트: 남은 사용량$/m);
  });

  it('상위 요소의 줄이면 그렇다고 덧붙인다', () => {
    const out = buildViewerPrompt('a.html', { ...el, lineIsAncestor: true }, 'x');
    assert.match(out, /^줄: 42 \(상위 요소\)$/m);
  });

  it('개행을 접고 <를 이스케이프한다', () => {
    const out = buildViewerPrompt('a.html', { ...el, text: '첫 줄\n둘째 <b>줄</b>' }, 'x');
    assert.match(out, /^텍스트: 첫 줄\\n둘째 &lt;b>줄&lt;\/b>$/m);
  });

  it('텍스트에 길이 상한을 건다', () => {
    const out = buildViewerPrompt('a.html', { ...el, text: 'ㄱ'.repeat(500) }, 'x');
    const line = out.split('\n').find((l) => l.startsWith('텍스트: '))!;
    assert.equal(line.length, '텍스트: '.length + VIEWER_TEXT_MAX + 1); // 잘린 표시 1자
    assert.ok(line.endsWith('…'));
  });

  it('사용자 글이 비어도 요소 덩어리는 온전하다', () => {
    const out = buildViewerPrompt('a.html', el, '');
    assert.ok(out.trimEnd().endsWith('</agentbridge-element>'));
  });
});
