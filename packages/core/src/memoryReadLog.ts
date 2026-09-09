// `memory read` 호출 기록 (0.6.0 spec/03 §3).
//
// 무엇을 재려는 것인가 — 훅이 주입한 매치를 모델이 실제로 읽는지다. 주입 게이트의 상수
// (4×√토큰수, 최고점 60%, 상위 3건)는 사용자 지식 30건에서 잡은 값이라, 건수가 늘면 다시
// 잡아야 한다. 그때 근거가 될 것이 "무엇이 읽혔는가"다.
//
// 남기는 것은 식별자와 시각과 어느 쪽 지식인지뿐이다. 쿼리도 대화 내용도 안 남긴다. scope를
// 함께 적는 것은 식별자만으로는 자리를 못 가리기 때문이다(양쪽에 같은 이름이 설 수 있다).
//
// best-effort다. 로그를 못 써도 본문 출력은 그대로 나간다.

import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import type { ProposalScope } from './shared/global';

export function memoryReadLogPath(globalDir: string): string {
  return join(globalDir, 'memory-reads.jsonl');
}

export async function appendMemoryReadLog(
  globalDir: string,
  entries: Array<{ id: string; scope: ProposalScope }>,
): Promise<void> {
  if (entries.length === 0) return;
  const at = new Date().toISOString();
  const lines = entries.map((e) => JSON.stringify({ id: e.id, scope: e.scope, at }) + '\n').join('');
  try {
    await fsp.mkdir(globalDir, { recursive: true });
    await fsp.appendFile(memoryReadLogPath(globalDir), lines, 'utf8');
  } catch {
    /* 기록은 부수적이다 — 못 남겨도 읽기는 성립한다 */
  }
}
