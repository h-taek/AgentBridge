// 0.8.0 spec/02 §2 — 닫기를 취소한 탭을 닫히기 직전 자리로 되살린다.
//
// 판정이 틀리면 취소를 골라도 탭이 엉뚱한 그룹에 합쳐지거나 넓이가 사라진다(research/02 §3).
import { strict as assert } from 'assert';
import { locate, planRestore, sameSpot, type GroupSnapshot, type Place } from '../src/views/panelPlace';

const chat = (label: string) => ({ label, chat: true });
const file = (label: string) => ({ label, chat: false });
const layout = { orientation: 0, groups: [{ size: 326 }, { size: 446 }, { size: 398 }] };

describe('panelPlace', () => {
  describe('locate', () => {
    it('그룹 안 순서는 채팅이 아닌 탭까지 센다', () => {
      const groups: GroupSnapshot[] = [
        { column: 1, tabs: [file('a.ts')] },
        { column: 2, tabs: [file('README.md'), chat('s1'), file('b.ts')] },
      ];
      assert.deepEqual(locate(groups, 's1'), { column: 2, index: 1, alone: false });
    });

    it('그룹의 유일한 탭이면 alone이다', () => {
      const groups: GroupSnapshot[] = [{ column: 3, tabs: [chat('s1')] }];
      assert.deepEqual(locate(groups, 's1'), { column: 3, index: 0, alone: true });
    });

    it('같은 제목이라도 채팅이 아닌 탭은 고르지 않는다', () => {
      const groups: GroupSnapshot[] = [{ column: 1, tabs: [file('s1')] }];
      assert.equal(locate(groups, 's1'), undefined);
    });
  });

  it('자리가 바뀌는 중에 읽은 값은 같은 자리로 보지 않는다', () => {
    assert.equal(sameSpot({ column: 2, index: 0, alone: true }, undefined), false);
    assert.equal(sameSpot({ column: 2, index: 0, alone: true }, { column: 3, index: 0, alone: true }), false);
    assert.equal(sameSpot({ column: 2, index: 1, alone: false }, { column: 2, index: 1, alone: false }), true);
  });

  describe('planRestore', () => {
    const place = (p: Partial<Place>): Place => ({ column: 2, index: 0, alone: true, layout, groupCount: 3, ...p });

    it('기록이 없으면 원래 규칙으로 연다', () => {
      assert.deepEqual(planRestore(undefined, 2), { kind: 'fallback' });
    });

    it('가운데 그룹이 사라졌으면 왼쪽 이웃의 오른쪽에 끼운다', () => {
      assert.deepEqual(planRestore(place({ column: 2 }), 2), {
        kind: 'insert', neighbor: 1, side: 'right', column: 2, layout,
      });
    });

    it('맨 왼쪽 그룹이 사라졌으면 첫 그룹의 왼쪽에 끼운다', () => {
      assert.deepEqual(planRestore(place({ column: 1 }), 2), {
        kind: 'insert', neighbor: 1, side: 'left', column: 1, layout,
      });
    });

    it('그룹이 남아 있으면 레이아웃을 건드리지 않고 같은 순서에 연다', () => {
      assert.deepEqual(planRestore(place({ column: 2, index: 1, alone: false }), 3), {
        kind: 'join', column: 2, index: 1,
      });
    });

    it('혼자였어도 빈 그룹이 남아 있으면 그 그룹에 연다', () => {
      // workbench.editor.closeEmptyGroups를 끈 사용자
      assert.deepEqual(planRestore(place({ column: 2 }), 3), { kind: 'join', column: 2, index: 0 });
    });

    it('포커스 명령이 없는 아홉째 그룹부터는 원래 규칙으로 연다', () => {
      assert.deepEqual(planRestore(place({ column: 9, groupCount: 9 }), 8), { kind: 'fallback' });
    });
  });
});
