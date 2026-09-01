// 호출 기록 (0.5.0 3단계 W9, B-4).
//
// 이 단계의 산출물은 기능이 아니라 숫자다 — 세 하니스가 지시문을 받고 실제로 도구를 부르는
// 비율. 읽는 경로가 우리 것이므로 누가 언제 무엇을 불렀는지 전부 기록된다.
//
// 새 저장 자리를 만들지 않는다. 워크스페이스 폴더에 한 줄씩 붙이고, 읽는 것은 분석 한 번뿐이다.
// best-effort다 — 기록에 실패했다고 명령이 실패하면 안 된다.
//
// 턴 번호를 여기서 매기지 않는다. 그 턴의 시작 시각만 함께 적고, "첫 턴에 불렀는가"는 한
// 세션의 가장 이른 시작 시각과 비교해 분석 때 가른다. 기록하는 쪽이 단순할수록 덜 틀린다.

import { appendFile, readFile } from 'fs/promises';
import { join } from 'path';

export const CALL_LOG_FILENAME = 'cli-calls.jsonl';

export type CliCall = {
  at: number;
  command: string;
  sessionId: string;
  agent: string;
  // 이 호출이 속한 턴의 시작 시각. 신호가 없으면 없음.
  turnStartAt?: number;
};

export function callLogPath(wsDir: string): string {
  return join(wsDir, CALL_LOG_FILENAME);
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// 하니스는 세션 레코드가 안다. CLI는 자기가 어느 하니스 안에서 도는지 모른다.
async function resolveAgent(wsDir: string, sessionId: string): Promise<string> {
  const ws = await readJson(join(wsDir, 'workspace.json'));
  const sessions = Array.isArray(ws?.sessions) ? (ws!.sessions as Record<string, unknown>[]) : [];
  const found = sessions.find((s) => s && s.id === sessionId);
  return typeof found?.model === 'string' ? found.model : '';
}

export async function recordCall(
  wsDir: string,
  command: string,
  sessionId: string,
  now: number = Date.now(),
): Promise<void> {
  try {
    const turnStart = sessionId
      ? await readJson(join(wsDir, 'sessions', sessionId, 'turn-start.json'))
      : null;
    const entry: CliCall = {
      at: now,
      command,
      sessionId,
      agent: sessionId ? await resolveAgent(wsDir, sessionId) : '',
      ...(typeof turnStart?.at === 'number' ? { turnStartAt: turnStart.at } : {}),
    };
    await appendFile(callLogPath(wsDir), JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    /* best-effort — 기록이 명령을 막지 않는다 */
  }
}

export async function readCalls(wsDir: string): Promise<CliCall[]> {
  let raw: string;
  try {
    raw = await readFile(callLogPath(wsDir), 'utf8');
  } catch {
    return [];
  }
  const out: CliCall[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as CliCall;
      if (typeof v?.at === 'number' && typeof v.command === 'string') out.push(v);
    } catch {
      /* skip */
    }
  }
  return out;
}
