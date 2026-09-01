// 서브에이전트 완료 미읽음 판정 (0.5.0 4단계 W4, B-6 "메인이 완료를 아는 법").
//
// 켜는 쪽은 이미 있다 — 종료 훅이 남기는 turn-signal.json의 `at`과 `complete`(A-2).
// 끄는 쪽만 여기서 만든다. 둘의 시각을 비교해 미읽음이 나오므로 켜고 끄는 장부를 따로
// 두지 않는다 — 같은 사실이 두 곳에 있으면 어긋났을 때 어느 쪽이 진짜인지 정하는 문제가 따라온다.
//
// 완료의 근거는 신호의 도착이 아니라 그 신호의 완료 표시다. 미완 신호(complete=false)는
// 서브를 기다리며 멈춘 지점에서도 오므로 미읽음으로 치지 않는다.

import { promises as fs } from 'fs';
import { join } from 'path';
import { resolveTurnSignalFile, readTurnSignal } from '../cliAdapter/turnSignal';

export const REPORT_READ_FILENAME = 'report-read.json';

export function resolveReportReadFile(workspaceDir: string, sessionId: string): string {
  return join(workspaceDir, 'sessions', sessionId, REPORT_READ_FILENAME);
}

interface ReportRead {
  at: number;
}

// 읽기는 어떤 실패도 조용히 0으로 떨어진다. 파일이 없거나 깨졌으면 아직 안 읽은 것으로 본다 —
// 못 읽었다고 미읽음 판정을 막으면 안 되기 때문이다.
export async function readReportReadAt(workspaceDir: string, sessionId: string): Promise<number> {
  let raw: string;
  try {
    raw = await fs.readFile(resolveReportReadFile(workspaceDir, sessionId), 'utf8');
  } catch {
    return 0;
  }
  try {
    const obj = JSON.parse(raw) as Partial<ReportRead>;
    return typeof obj.at === 'number' && Number.isFinite(obj.at) ? obj.at : 0;
  } catch {
    return 0;
  }
}

// 보고를 가져갔다고 표시한다. 이걸 쓰는 것은 `agent read` 하나뿐이다 — check는 순수 조회로
// 남고, 대기(check --wait)의 반환은 이 값을 건드리지 않는다.
export async function markReported(
  workspaceDir: string,
  sessionId: string,
  at: number = Date.now(),
): Promise<void> {
  const target = resolveReportReadFile(workspaceDir, sessionId);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.mkdir(join(workspaceDir, 'sessions', sessionId), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify({ at } satisfies ReportRead), 'utf8');
  await fs.rename(tmp, target);
}

// 그 세션에 아직 안 읽은 완료가 있는가. 신호가 없으면 미읽음이 아니다. 완료 신호의 `at`이
// 읽음 표시의 `at`보다 뒤일 때만 미읽음이다.
export async function isUnread(workspaceDir: string, sessionId: string): Promise<boolean> {
  const signal = await readTurnSignal(resolveTurnSignalFile(workspaceDir, sessionId));
  if (!signal || !signal.complete) return false;
  const readAt = await readReportReadAt(workspaceDir, sessionId);
  return signal.at > readAt;
}

// 여러 세션을 한 번에. 미읽음인 세션 id만 입력 순서 그대로 돌려준다.
export async function listUnread(workspaceDir: string, sessionIds: string[]): Promise<string[]> {
  const flags = await Promise.all(sessionIds.map((id) => isUnread(workspaceDir, id)));
  return sessionIds.filter((_, i) => flags[i]);
}
