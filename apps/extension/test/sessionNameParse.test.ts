import { strict as assert } from 'assert';
import { parseSessionName } from '@agentbridge/core';

describe('parseSessionName', () => {
  it('따옴표로 감싼 출력은 걷어낸다', () => {
    const r = parseSessionName('"로그인 버그 수정"');
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.name, '로그인 버그 수정');
  });

  it('끝 마침표는 걷어낸다', () => {
    const r = parseSessionName('로그인 버그 수정.');
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.name, '로그인 버그 수정');
  });

  it('따옴표 바깥에 붙은 마침표도 걷어낸다', () => {
    const r = parseSessionName('"로그인 버그 수정".');
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.name, '로그인 버그 수정');
  });

  it('여러 줄이면 첫 줄만 이름으로 쓴다', () => {
    const r = parseSessionName('로그인 버그 수정\n이 세션은 401 에러를 다룹니다.');
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.name, '로그인 버그 수정');
  });

  it('앞에 "제목: " 라벨이 붙어도 걷어낸다', () => {
    const r = parseSessionName('제목: 로그인 버그 수정');
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.name, '로그인 버그 수정');
  });

  it('20 코드포인트 초과면 20에서 자르고 … 를 붙인다', () => {
    const r = parseSessionName('a'.repeat(25));
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.name, 'a'.repeat(20) + '…');
  });

  it('빈 출력이면 ok:false', () => {
    assert.equal(parseSessionName('').ok, false);
    assert.equal(parseSessionName('   \n\t  ').ok, false);
    assert.equal(parseSessionName('""').ok, false);
  });

  it('이모지가 경계에 걸리면 대체문자 없이 온전히 포함하고 … 를 붙인다', () => {
    const text = 'x'.repeat(19) + '😀' + 'yyy';
    const r = parseSessionName(text);
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.name, 'x'.repeat(19) + '😀' + '…');
      assert.ok(!r.name.includes('�'), '대체문자(surrogate 분리) 없어야 함');
    }
  });
});
