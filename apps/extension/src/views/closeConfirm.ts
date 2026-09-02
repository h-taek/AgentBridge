// 도는 중인 탭을 닫을 때 물을지 말지 (0.5.0 6단계).
//
// 판정만 여기 둔다 — chatPanel은 node-pty를 물고 있어 그대로는 테스트에서 못 부른다(groupLock과
// 같은 이유). 묻는 자리와 확인 문구는 chatPanel에 남는다.

export type CloseDecision = 'close' | 'ask';

export interface CloseInput {
  // IDE나 창이 내려가는 중. 되돌릴 자리가 없다.
  shuttingDown: boolean;
  // 세션이 밖에서 지워졌다(트리 삭제 등).
  deletedExternally: boolean;
  hasPty: boolean;
  turnRunning: boolean;
  // 사용자가 이 레포에서 확인을 껐다. workspace.json에 남는다.
  askDisabled: boolean;
}

export function decideClose(input: CloseInput): CloseDecision {
  if (input.shuttingDown || input.deletedExternally || !input.hasPty) return 'close';
  if (!input.turnRunning) return 'close';
  if (input.askDisabled) return 'close';
  return 'ask';
}
