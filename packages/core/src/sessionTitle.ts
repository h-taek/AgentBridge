// 자동 세션 이름 — 첫 user 턴으로 세션 title을 채운다(B-2 W7).
//   deriveSessionTitle: 순수 절단(공백 접기 + 코드포인트 단위 20자 + …). 슬래시 명령 등 원문 보존.
//   maybeAutoNameSession: title이 비어 있을 때만, 이름 만들 수 있는 첫 턴으로 1회 명명. 기존 title 보호.
//     이름 생성은 generateName(헤드리스 모델 호출)을 우선 시도하고, 없거나 실패·빈 값이면
//     deriveSessionTitle 절단으로 폴백한다(runSessionNaming — sessionNamePrompt.ts·refineDispatcher.ts).

import { readAllTurns } from './turnsStore';

const MAX_TITLE_CODEPOINTS = 20;

// 첫 user 텍스트 → 표시용 세션명. 공백·줄바꿈은 단일 스페이스로 접고 trim한다.
// 20 코드포인트 초과 시 자르고 … 를 붙인다(이모지가 깨지지 않게 코드포인트 단위). 이름을
// 만들 수 없으면(빈 문자열·공백만) null.
export function deriveSessionTitle(userText: string): string | null {
  const collapsed = userText.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return null;
  const points = [...collapsed];
  if (points.length <= MAX_TITLE_CODEPOINTS) return collapsed;
  return points.slice(0, MAX_TITLE_CODEPOINTS).join('') + '…';
}

// 첫 턴 원문 → 이름 한 줄(헤드리스 모델 호출). 실패·던짐·빈 값은 호출자가 폴백으로 받는다.
export type SessionNameGenerator = (userText: string) => Promise<string | null>;

export interface AutoNameSessionArgs {
  workspaceRoot: string;
  // 명명 대상 세션. turns.jsonl은 워크스페이스 내 여러 세션이 공유하므로, 이 id로 걸러야
  // 다른 세션의 첫 턴으로 잘못 명명되지 않는다(세션 간 제목 오염 방지).
  sessionId: string;
  // 현재 세션 title(수동 rename 포함). 비어 있지 않으면 명명을 건너뛴다.
  getCurrentTitle: () => Promise<string | undefined>;
  // 명명 확정 시 호출 — workspace.json sessions[].title 갱신.
  setTitle: (title: string) => Promise<void>;
  // 있으면 우선 시도하는 헤드리스 명명 생성기. 없으면 곧장 절단(deriveSessionTitle)로 명명한다.
  generateName?: SessionNameGenerator;
}

// 헤드리스 생성기를 시도하고, 없거나 실패하거나 빈 값이면 절단으로 떨어뜨린다.
// 폴백이 도는 이유: 여기서 이름을 비워 두면 title이 계속 미설정으로 남아 다음 턴마다
// 명명을 다시 시도하게 되고, 그때마다 헤드리스 모델 호출 비용이 든다.
async function resolveName(
  userText: string,
  fallback: string,
  generateName?: SessionNameGenerator,
): Promise<string> {
  if (!generateName) return fallback;
  try {
    const generated = await generateName(userText);
    if (generated && generated.trim() !== '') return generated;
  } catch {
    /* 헤드리스 실패 — 절단으로 폴백 */
  }
  return fallback;
}

// 턴 flush 시점마다 호출(turnRecorder onTurnFlushed). 이미 title이 있으면 즉시 반환하므로
// 명명은 세션당 사실상 1회(이름 만들 수 있는 첫 턴)만 일어난다.
export async function maybeAutoNameSession(args: AutoNameSessionArgs): Promise<void> {
  const current = await args.getCurrentTitle();
  if (current && current.trim() !== '') return; // 이미 명명됨(수동 포함) — 덮어쓰지 않음
  const turns = await readAllTurns(args.workspaceRoot);
  for (const turn of turns) {
    if (turn.sessionId !== args.sessionId) continue; // 이 세션의 턴만 — 공유 버퍼 내 타세션 턴 무시
    const fallback = deriveSessionTitle(turn.user);
    if (!fallback) continue; // 이 턴으로는 이름을 만들 수 없음(빈 텍스트) — 다음 턴으로
    const title = await resolveName(turn.user, fallback, args.generateName);
    await args.setTitle(title);
    return;
  }
}
