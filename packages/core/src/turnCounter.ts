// 세션의 턴 수 (0.6.0 spec/03 §2). 다섯 턴마다 훅이 기록을 명령하는데, 그 '다섯 턴'을 세는
// 자리다.
//
// 자리가 세션 폴더인 이유는 병렬 세션 때문이다. 워크스페이스에 하나 두면 탭 둘이 한 카운터를
// 밟아 서로 턴을 훔친다 — 각자 세 턴씩 했는데 한쪽이 여섯 턴째로 세는 식이다.
//
// 세는 이벤트는 종료(`Stop`)다. 주입 이벤트에서 세지 않는다 — agy의 PreInvocation은 한 턴에
// 모델 호출 수만큼 뜬다(research 03 §1-3). agy의 `executionNum`도 턴 카운터가 아니다(§2-4).
//
// 값을 못 읽거나 못 쓰는 것은 실패가 아니다. 카운터가 0으로 떨어지면 제안 블록이 안 붙을 뿐,
// 주입 자체는 그대로 나가야 한다.

import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';

// 다섯 턴이 끝난 다음 턴 머리에 붙는다. 그래서 count가 5의 배수인 턴에 명령이 나간다.
const PROPOSAL_EVERY = 5;

export function turnCountPath(sessionDir: string): string {
  return join(sessionDir, 'turn-count.json');
}

export async function readTurnCount(sessionDir: string): Promise<number> {
  if (!sessionDir) return 0;
  try {
    const raw = await fsp.readFile(turnCountPath(sessionDir), 'utf8');
    const n = (JSON.parse(raw) as { count?: unknown }).count;
    return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

// 올린 값을 낸다. 쓰기가 실패하면 0 — 호출자는 이 값으로 제안 블록만 정하므로 여기서 던지지 않는다.
export async function bumpTurnCount(sessionDir: string): Promise<number> {
  if (!sessionDir) return 0;
  const next = (await readTurnCount(sessionDir)) + 1;
  const file = turnCountPath(sessionDir);
  try {
    await fsp.mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ count: next, updatedAt: Date.now() }), 'utf8');
    await fsp.rename(tmp, file);
    return next;
  } catch {
    return 0;
  }
}

export function isProposalTurn(count: number): boolean {
  return count > 0 && count % PROPOSAL_EVERY === 0;
}
