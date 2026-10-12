import { strict as assert } from 'assert';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const out = resolve(__dirname, '../out/viewerPicker.js');

describe('viewerPicker 산출물', () => {
  it('빌드가 파일을 낸다', () => {
    assert.ok(existsSync(out), 'npm run compile을 먼저 돌린다');
  });

  it('문법 오류 없이 파싱된다', () => {
    assert.doesNotThrow(() => new Function(readFileSync(out, 'utf8')));
  });

  it('한 덩어리로 감싸여 전역 이름을 만들지 않는다', () => {
    // esbuild가 앞에 붙이는 strict 지시문 하나만 걷어내면 나머지는 IIFE 한 덩어리여야 한다.
    const src = readFileSync(out, 'utf8').trim().replace(/^["']use strict["'];?\s*/, '');
    assert.match(src, /^\(/);
  });

  it('출처가 다른 메시지를 버린다', () => {
    assert.match(readFileSync(out, 'utf8'), /\.origin !== \w+/);
  });

  it('shift+클릭은 짚지 않고 Shift를 뺀 일반 클릭으로 다시 보낸다', () => {
    const src = readFileSync(out, 'utf8');
    // 원래 클릭은 막는다 — 그대로 두면 브라우저가 링크를 새 창으로 연다.
    assert.match(src, /if \(e\.shiftKey\) \{\s*e\.preventDefault\(\);\s*e\.stopImmediatePropagation\(\);/);
    assert.match(src, /dispatchEvent\(\s*new MouseEvent\("click"/);
    // 다시 보낸 클릭이 이 리스너를 지날 때 짚지 않는다.
    assert.match(src, /if \(!agent \|\| passing\) return;/);
  });

  it('밖으로 보낼 때 targetOrigin을 준다', () => {
    assert.match(readFileSync(out, 'utf8'), /parent\.postMessage\(\w+, \w+\)/);
  });
});
