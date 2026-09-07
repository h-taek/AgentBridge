// 0.5.0 6단계 — 도는 중인 탭을 닫을 때 물을지 말지.
//
// 웹뷰 탭의 닫기는 가로챌 수 없어서 순서가 뒤집혀 있다 — 닫힌 뒤에 묻고, 계속을 고르면 다시
// 연다(W8). 그래서 이 판정이 틀리면 사용자가 안 물어본 자리에서 세션을 잃는다.
import { strict as assert } from 'assert';
import { decideClose } from '../src/views/closeConfirm';

const base = {
  shuttingDown: false,
  deletedExternally: false,
  hasPty: true,
  turnRunning: true,
  askDisabled: false,
};

describe('closeConfirm', () => {
  it('도는 중이면 묻는다', () => {
    assert.equal(decideClose(base), 'ask');
  });

  it('도는 중이 아니면 안 묻는다 — 매번 물으면 확인 자체가 무시된다', () => {
    assert.equal(decideClose({ ...base, turnRunning: false }), 'close');
  });

  it('IDE가 내려가는 중이면 안 묻는다 — 되돌릴 자리가 없다', () => {
    assert.equal(decideClose({ ...base, shuttingDown: true }), 'close');
  });

  it('세션이 밖에서 지워졌으면 안 묻는다', () => {
    assert.equal(decideClose({ ...base, deletedExternally: true }), 'close');
  });

  it('PTY가 이미 죽었으면 안 묻는다', () => {
    assert.equal(decideClose({ ...base, hasPty: false }), 'close');
  });

  it('사용자가 이 레포에서 껐으면 도는 중이어도 안 묻는다', () => {
    assert.equal(decideClose({ ...base, askDisabled: true }), 'close');
  });
});
