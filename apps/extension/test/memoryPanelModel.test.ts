// 0.5.0 6단계 — 기억 패널의 명령 접기.
//
// 웹뷰 스크립트는 템플릿 문자열 안이라 tsc도 mocha도 안 본다. 그래서 검증할 값은 호스트에서
// 만들어 넘기고, 웹뷰는 받은 것을 그리기만 한다.
import { strict as assert } from 'assert';
import { collapseCommand } from '../src/views/memoryPanelModel';

describe('collapseCommand', () => {
  it('앞 두 낱말만 남긴다', () => {
    assert.equal(collapseCommand('git status --short'), 'git status');
  });

  it('같은 도구의 다른 서브커맨드가 갈린다 — 이 규칙의 목적', () => {
    assert.equal(collapseCommand('git diff HEAD~1'), 'git diff');
    assert.notEqual(collapseCommand('git diff HEAD~1'), collapseCommand('git status --short'));
  });

  it('플래그도 낱말로 센다 — 따옴표나 경로를 구분하려 들지 않는다', () => {
    assert.equal(collapseCommand('grep -rn "showWarningMessage" apps/extension/src'), 'grep -rn');
    assert.equal(collapseCommand("sed -n '440,660p' memoryPanel.ts"), 'sed -n');
  });

  it('낱말이 둘 이하면 그대로 둔다', () => {
    assert.equal(collapseCommand('npm test'), 'npm test');
    assert.equal(collapseCommand('npm'), 'npm');
  });

  it('여러 칸 띄어쓰기와 줄바꿈에서도 낱말로 센다', () => {
    assert.equal(collapseCommand('  sed   -n   x  '), 'sed -n');
    assert.equal(collapseCommand('cd apps/extension &&\nnpm test'), 'cd apps/extension');
  });

  it('빈 문자열은 빈 문자열이다 — 없는 명령을 만들어내지 않는다', () => {
    assert.equal(collapseCommand(''), '');
    assert.equal(collapseCommand('   '), '');
  });
});
