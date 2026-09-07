// 세션 상태 판정 (0.5.0 W2, B-2) — 순수 판정 로직과 디스크 리더를 한 파일에 둔다.
//
// 표시는 관측한 활동이지 우리가 매기는 판정이 아니다(스펙 B-2). 재료는 시작 신호
// (turn-start.json), 종료 신호(turn-signal.json), 화면 기록(replay.log)의 mtime 셋뿐이고,
// 이 파일은 그 셋을 값 넷짜리 상태 하나로 접는 규칙과, 그 값을 세션 폴더에서 모으는 리더로
// 나뉜다. 순수 로직 쪽은 시계를 인자로 받아 테스트가 고정할 수 있게 한다.

import { promises as fs } from 'fs';
import { join } from 'path';
import {
  resolveTurnSignalFile,
  readTurnSignal,
  resolveTurnStartFile,
  readTurnStart,
} from './cliAdapter/turnSignal';

export type SessionActivity = 'idle' | 'running' | 'done' | 'unknown';

// 출력 정적 임계 — 아직 실측 전 잠정값(plan 0.5.0 W2). 여러 군데 흩지 않고 여기 하나로 둔다.
export const SILENCE_MS = 60_000;

// ─── 순수 판정 로직 ─────────────────────────────────────────────────────

export interface SessionActivityInput {
  // 마지막 턴 시작 시각(turn-start.json의 at). 시작 신호가 온 적 없으면 없음.
  startAt?: number;
  // 마지막 턴 종료 시각(turn-signal.json의 at). 종료 신호가 온 적 없으면 없음.
  endAt?: number;
  // 마지막 PTY 출력 시각(replay.log mtime). 없으면 시작 시각을 대신 쓴다.
  lastOutputAt?: number;
  // 이 세션 패널을 마지막으로 연 시각. 없으면 아직 한 번도 안 연 것으로 본다
  // (그 경우 종료가 항상 열람보다 뒤인 것으로 쳐서 done이 뜬다).
  viewedAt?: number;
}

export function computeSessionActivity(input: SessionActivityInput, now: number): SessionActivity {
  const { startAt, endAt, lastOutputAt, viewedAt } = input;

  // 시작이 없거나 종료가 시작 이상이면 턴이 도는 중이 아니다.
  const running = startAt !== undefined && (endAt === undefined || startAt > endAt);
  if (!running) {
    if (endAt !== undefined && (viewedAt === undefined || endAt > viewedAt)) return 'done';
    return 'idle';
  }

  const lastOutput = lastOutputAt ?? startAt!;
  return now - lastOutput >= SILENCE_MS ? 'unknown' : 'running';
}

const PRIORITY: SessionActivity[] = ['unknown', 'running', 'done', 'idle'];

// 부모 행의 값 = 자기 활동과 접힌 자식들 값 중 우선순위가 가장 높은 것.
export function aggregateActivity(self: SessionActivity, children: SessionActivity[]): SessionActivity {
  let best = self;
  for (const child of children) {
    if (PRIORITY.indexOf(child) < PRIORITY.indexOf(best)) best = child;
  }
  return best;
}

// ─── 디스크 리더 ────────────────────────────────────────────────────────
//
// 4초 주기로 세션 수만큼 도는 자리라 매번 세 파일을 다 읽으면 낭비다. stat으로 mtime만
// 먼저 보고, 지난번과 같으면 파일을 다시 읽지 않는다. 캐시는 프로세스 내 Map — 파일 경로가
// 키다.

interface StatLike {
  mtimeMs: number;
}

interface CacheEntry<T> {
  mtimeMs: number;
  value: T;
}

// 테스트가 stat/read 호출 횟수를 셀 수 있도록 IO를 주입 가능하게 열어 둔다. 기본값은 실제
// fs·turnSignal 리더.
export interface SessionActivityIo {
  stat: (path: string) => Promise<StatLike>;
  readTurnStart: typeof readTurnStart;
  readTurnSignal: typeof readTurnSignal;
}

const defaultIo: SessionActivityIo = {
  stat: (path) => fs.stat(path),
  readTurnStart,
  readTurnSignal,
};

const startCache = new Map<string, CacheEntry<Awaited<ReturnType<typeof readTurnStart>>>>();
const signalCache = new Map<string, CacheEntry<Awaited<ReturnType<typeof readTurnSignal>>>>();
const outputCache = new Map<string, CacheEntry<number>>();

// JSON 신호 둘(turn-start.json, turn-signal.json) 공용 — stat으로 mtime을 먼저 보고, 지난번과
// 같으면 read를 건너뛴다.
async function cachedRead<T>(
  cache: Map<string, CacheEntry<T>>,
  path: string,
  stat: SessionActivityIo['stat'],
  read: (path: string) => Promise<T>,
): Promise<T | undefined> {
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
  } catch {
    cache.delete(path); // 파일이 없어졌으면 캐시도 지운다 — 다음에 생기면 다시 읽는다
    return undefined;
  }
  const cached = cache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) return cached.value;
  const value = await read(path);
  cache.set(path, { mtimeMs, value });
  return value;
}

// replay.log는 값 자체가 mtime이라 stat 한 번이 read를 겸한다 — 별도 read 단계가 없다.
async function cachedLastOutputAt(
  cache: Map<string, CacheEntry<number>>,
  path: string,
  stat: SessionActivityIo['stat'],
): Promise<number | undefined> {
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
  } catch {
    cache.delete(path);
    return undefined;
  }
  cache.set(path, { mtimeMs, value: mtimeMs });
  return mtimeMs;
}

function resolveReplayLogFile(workspaceDir: string, sessionId: string): string {
  return join(workspaceDir, 'sessions', sessionId, 'replay.log');
}

// 세션 폴더에서 판정 입력 셋(viewedAt 제외)을 모은다. viewedAt은 세션 레코드(workspace.json)
// 쪽 값이라 이 리더의 몫이 아니다 — 호출부가 합쳐서 computeSessionActivity에 넣는다.
export async function readSessionActivityInputs(
  workspaceDir: string,
  sessionId: string,
  io: SessionActivityIo = defaultIo,
): Promise<Pick<SessionActivityInput, 'startAt' | 'endAt' | 'lastOutputAt'>> {
  const startFile = resolveTurnStartFile(workspaceDir, sessionId);
  const signalFile = resolveTurnSignalFile(workspaceDir, sessionId);
  const replayLogFile = resolveReplayLogFile(workspaceDir, sessionId);

  const [start, signal, lastOutputAt] = await Promise.all([
    cachedRead(startCache, startFile, io.stat, io.readTurnStart),
    cachedRead(signalCache, signalFile, io.stat, io.readTurnSignal),
    cachedLastOutputAt(outputCache, replayLogFile, io.stat),
  ]);

  return {
    startAt: start?.at,
    endAt: signal?.at,
    lastOutputAt,
  };
}
