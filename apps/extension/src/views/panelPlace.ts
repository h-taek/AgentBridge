// 닫기를 취소한 탭을 닫히기 직전 자리로 되살린다 (0.8.0 spec/02 §2).
//
// 판정만 여기 둔다 — chatPanel은 node-pty를 물고 있어 그대로는 테스트에서 못 부른다(closeConfirm과
// 같은 이유). 자리를 기록하고 IDE 명령을 보내는 자리는 chatPanel에 남는다.

// tabGroups.all을 그대로 옮긴 것. 그룹 순서가 곧 컬럼 순서다.
export interface GroupSnapshot {
  column: number | undefined;
  tabs: { label: string; chat: boolean }[];
}

export interface Spot {
  column: number;
  // 그룹 안 순서. 채팅이 아닌 탭까지 센다 — moveActiveEditor가 그렇게 센다.
  index: number;
  // 그룹의 유일한 탭이면 닫힐 때 그룹째 사라진다.
  alone: boolean;
}

export interface Place extends Spot {
  // vscode.getEditorLayout 결과 그대로. setEditorLayout에 다시 넘긴다.
  layout: unknown;
  groupCount: number;
}

export type RestorePlan =
  // 그룹째 사라졌다. 이웃 그룹 옆에 빈 그룹을 끼우고 레이아웃을 되돌린 뒤 그 컬럼에 연다.
  // setEditorLayout만 부르면 새 그룹이 맨 끝에 붙어 가운데·맨 왼쪽 그룹이 옆 그룹과 합쳐진다.
  | { kind: 'insert'; neighbor: number; side: 'left' | 'right'; column: number; layout: unknown }
  // 그룹이 남아 있다. 레이아웃은 건드리지 않고 그 그룹의 같은 순서에 연다.
  | { kind: 'join'; column: number; index: number }
  // 기록이 없거나 이웃 그룹에 포커스를 줄 명령이 없다. 원래 규칙으로 연다.
  | { kind: 'fallback' };

// 그룹 포커스 명령이 여덟째까지라 그 너머 자리는 다루지 않는다.
export const MAX_RESTORE_COLUMN = 8;

// 제목으로 찾는다. 같은 제목의 채팅 탭이 둘이면 앞의 것을 고른다.
export function locate(groups: GroupSnapshot[], label: string): Spot | undefined {
  for (const g of groups) {
    const index = g.tabs.findIndex((t) => t.chat && t.label === label);
    if (index >= 0 && g.column !== undefined) {
      return { column: g.column, index, alone: g.tabs.length === 1 };
    }
  }
  return undefined;
}

export function sameSpot(a: Spot | undefined, b: Spot | undefined): boolean {
  return !!a && !!b && a.column === b.column && a.index === b.index && a.alone === b.alone;
}

export function planRestore(place: Place | undefined, groupCount: number): RestorePlan {
  if (!place || place.column > MAX_RESTORE_COLUMN) return { kind: 'fallback' };
  if (place.alone && groupCount < place.groupCount) {
    return place.column === 1
      ? { kind: 'insert', neighbor: 1, side: 'left', column: 1, layout: place.layout }
      : { kind: 'insert', neighbor: place.column - 1, side: 'right', column: place.column, layout: place.layout };
  }
  return { kind: 'join', column: place.column, index: place.index };
}
