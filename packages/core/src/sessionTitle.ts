// 자동 세션 이름 — 첫 user 턴 텍스트를 잘라 세션 title로 채운다.
//   deriveSessionTitle: 순수 절단(공백 접기 + 코드포인트 단위 40자 + …). 슬래시 명령 등 원문 보존.
//   maybeAutoNameSession: title이 비어 있을 때만, 이름 만들 수 있는 첫 턴으로 1회 명명. 기존 title 보호.

import { readAllTurns } from './turnsStore';

const MAX_TITLE_CODEPOINTS = 40;

// 첫 user 텍스트 → 표시용 세션명. 공백·줄바꿈은 단일 스페이스로 접고 trim한다.
// 40 코드포인트 초과 시 자르고 … 를 붙인다(이모지가 깨지지 않게 코드포인트 단위). 이름을
// 만들 수 없으면(빈 문자열·공백만) null.
export function deriveSessionTitle(userText: string): string | null {
  const collapsed = userText.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return null;
  const points = [...collapsed];
  if (points.length <= MAX_TITLE_CODEPOINTS) return collapsed;
  return points.slice(0, MAX_TITLE_CODEPOINTS).join('') + '…';
}

export interface AutoNameSessionArgs {
  workspaceRoot: string;
  // 현재 세션 title(수동 rename 포함). 비어 있지 않으면 명명을 건너뛴다.
  getCurrentTitle: () => Promise<string | undefined>;
  // 명명 확정 시 호출 — workspace.json sessions[].title 갱신.
  setTitle: (title: string) => Promise<void>;
}

// 턴 flush 시점마다 호출(turnRecorder onTurnFlushed). 이미 title이 있으면 즉시 반환하므로
// 명명은 세션당 사실상 1회(이름 만들 수 있는 첫 턴)만 일어난다.
export async function maybeAutoNameSession(args: AutoNameSessionArgs): Promise<void> {
  const current = await args.getCurrentTitle();
  if (current && current.trim() !== '') return; // 이미 명명됨(수동 포함) — 덮어쓰지 않음
  const turns = await readAllTurns(args.workspaceRoot);
  for (const turn of turns) {
    const title = deriveSessionTitle(turn.user);
    if (title) {
      await args.setTitle(title);
      return;
    }
  }
}
