// 턴 종료 신호 (0.5.0 A-2) — 헬퍼가 종료 훅에서 쓰고 호스트가 읽는다.
//
// 신호는 데이터가 아니라 트리거다. "이 턴이 끝났고 transcript는 여기 있다"만 알린다.
// 내용은 호스트가 그 경로를 증분으로 읽어 가져온다. 그래서 신호를 하나 놓쳐도 다음 신호에
// 따라잡히고, 파일은 누적 없이 매번 덮어쓴다.
//
// 파일 자리는 세션 id 캡처와 같은 폴더다 — <워크스페이스>/sessions/<세션 id>/turn-signal.json.

import { promises as fs } from 'fs';
import { dirname, basename, join } from 'path';
import type { CliKind } from '../shared/cli';
import type { Logger } from '../interfaces';
import { noopLogger } from '../interfaces';
import { createSessionFileWatcher, type SessionFileWatcher } from '../sessionFileWatcher';

export const TURN_SIGNAL_FILENAME = 'turn-signal.json';

export interface TurnSignal {
  agent: CliKind;
  event: string;
  sessionId: string;
  transcriptPath: string;
  // 턴이 온전히 끝났는가. claude는 StopFailure(오류로 끊김), agy는 배경 작업이 남은 경우 false.
  complete: boolean;
  // 서브에이전트 신호 표시. 있으면 부모 턴이 아니므로 버린다.
  agentId?: string;
  terminationReason?: string;
  error?: string;
  at: number;
}

export function resolveTurnSignalFile(workspaceDir: string, sessionId: string): string {
  return join(workspaceDir, 'sessions', sessionId, TURN_SIGNAL_FILENAME);
}

function str(v: unknown): string {
  return typeof v === 'string' && v.trim() ? v : '';
}

// 신호 파일 1건 파싱. 형식이 어긋나거나 자식 신호면 null.
export function parseTurnSignal(raw: string): TurnSignal | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null; // 부분 write 중 — 다음 트리거에 재시도
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const agent = str(o.agent);
  if (agent !== 'claude' && agent !== 'codex' && agent !== 'agy') return null;
  const event = str(o.event);
  if (!event) return null;
  // 자식(서브에이전트) 종료는 부모 턴이 아니다. 여기서 거른다.
  const agentId = str(o.agentId);
  if (agentId) return null;
  const at = typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : 0;
  return {
    agent,
    event,
    sessionId: str(o.sessionId),
    transcriptPath: str(o.transcriptPath),
    complete: o.complete === true,
    terminationReason: str(o.terminationReason) || undefined,
    error: str(o.error) || undefined,
    at,
  };
}

export async function readTurnSignal(signalFilePath: string): Promise<TurnSignal | null> {
  let raw: string;
  try {
    raw = await fs.readFile(signalFilePath, 'utf8');
  } catch {
    return null; // 아직 없음
  }
  return parseTurnSignal(raw);
}

// 턴 시작 신호 (0.5.0 W1) — 헬퍼가 주입 훅에서 쓴다. 종료 신호와 같은 폴더·같은 규약(매번
// 덮어쓰기, best-effort). 내용은 트리거가 아니라 시각이 전부라 값은 넷뿐이다.
//
// 감시자는 두지 않는다. 상태 판정이 트리 갱신 주기에 맞춰 읽는다.

export const TURN_START_FILENAME = 'turn-start.json';

export interface TurnStart {
  agent: CliKind;
  event: string;
  sessionId: string;
  at: number;
}

export function resolveTurnStartFile(workspaceDir: string, sessionId: string): string {
  return join(workspaceDir, 'sessions', sessionId, TURN_START_FILENAME);
}

export function parseTurnStart(raw: string): TurnStart | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null; // 부분 write 중 — 다음 트리거에 재시도
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const agent = str(o.agent);
  if (agent !== 'claude' && agent !== 'codex' && agent !== 'agy') return null;
  const event = str(o.event);
  if (!event) return null;
  const at = typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : 0;
  return {
    agent,
    event,
    sessionId: str(o.sessionId),
    at,
  };
}

export async function readTurnStart(startFilePath: string): Promise<TurnStart | null> {
  let raw: string;
  try {
    raw = await fs.readFile(startFilePath, 'utf8');
  } catch {
    return null; // 아직 없음
  }
  return parseTurnStart(raw);
}

export interface TurnSignalWatcher {
  stop(): void;
}

// 세션 하나의 종료 신호를 계속 구독한다. 세션 id 캡처(captureSessionIdFromHook)가 첫 1건에
// 끝나는 것과 달리 이쪽은 매 턴 반복이므로 별도로 둔다.
//
// 같은 신호를 두 번 넘기지 않도록 `at`으로 거른다. 신호 자체는 트리거일 뿐이라 중복 전달이
// 치명적이진 않지만(하류가 증분 읽기 + 결정적 id dedup), 불필요한 읽기를 줄인다.
export function watchTurnSignals(opts: {
  signalFilePath: string;
  onSignal: (signal: TurnSignal) => void;
  // watch 미지원·누락 시 안전망 폴링 주기. 기본 5초.
  intervalMs?: number;
  signal: AbortSignal;
  logger?: Logger;
}): TurnSignalWatcher {
  const log = opts.logger ?? noopLogger;
  const pollMs = opts.intervalMs ?? 5000;
  const file = opts.signalFilePath;
  let lastAt = -1;
  let stopped = false;
  let watcher: SessionFileWatcher | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    watcher?.stop();
    opts.signal.removeEventListener('abort', stop);
  };

  const check = async (): Promise<void> => {
    if (stopped) return;
    const sig = await readTurnSignal(file);
    if (!sig || sig.at <= lastAt) return;
    lastAt = sig.at;
    log.log(`turnSignal: ${sig.agent} ${sig.event} (complete=${sig.complete})`);
    opts.onSignal(sig);
  };

  if (opts.signal.aborted) return { stop: () => {} };
  opts.signal.addEventListener('abort', stop, { once: true });
  // 주: OS watch(즉시성). 보조: 저빈도 폴링(watch 미지원 안전망).
  watcher = createSessionFileWatcher({
    root: dirname(file),
    filenames: [basename(file)],
    onChange: () => void check(),
    logger: { warn: (m) => log.warn(m) },
  });
  timer = setInterval(() => void check(), pollMs);
  void check();

  return { stop };
}

// ─── 훅 실행 실패 통로 (0.5.0 A-2) ────────────────────────────────────────
//
// 훅은 CLI가 띄운 별도 프로세스라 우리 쪽으로 값을 되돌릴 통로가 없다. stderr는 CLI가 삼킨다.
// 그래서 신호와 같은 방식으로 파일에 남기고 호스트가 읽는다. 폴백을 걷어낸 뒤로 훅이 값을
// 안 주는 상태를 덮어 줄 것이 없으므로, 침묵 대신 표시로 드러내는 것이 이 파일의 존재 이유다.

export const HOOK_ERROR_FILENAME = 'hook-error.json';

export interface HookError {
  agent: CliKind;
  event: string;
  message: string;
  at: number;
}

export function resolveHookErrorFile(workspaceDir: string, sessionId: string): string {
  return join(workspaceDir, 'sessions', sessionId, HOOK_ERROR_FILENAME);
}

export function parseHookError(raw: string): HookError | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const agent = str(o.agent);
  if (agent !== 'claude' && agent !== 'codex' && agent !== 'agy') return null;
  const message = str(o.message);
  if (!message) return null;
  return {
    agent,
    event: str(o.event),
    message,
    at: typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : 0,
  };
}

export function watchHookErrors(opts: {
  errorFilePath: string;
  onError: (err: HookError) => void;
  intervalMs?: number;
  signal: AbortSignal;
  logger?: Logger;
}): TurnSignalWatcher {
  const log = opts.logger ?? noopLogger;
  const pollMs = opts.intervalMs ?? 10000;
  const file = opts.errorFilePath;
  let lastAt = -1;
  let stopped = false;
  let watcher: SessionFileWatcher | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    watcher?.stop();
    opts.signal.removeEventListener('abort', stop);
  };

  const check = async (): Promise<void> => {
    if (stopped) return;
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      return;
    }
    const err = parseHookError(raw);
    if (!err || err.at <= lastAt) return;
    lastAt = err.at;
    log.warn(`hook 실행 실패 (${err.agent} ${err.event}): ${err.message}`);
    opts.onError(err);
  };

  if (opts.signal.aborted) return { stop: () => {} };
  opts.signal.addEventListener('abort', stop, { once: true });
  watcher = createSessionFileWatcher({
    root: dirname(file),
    filenames: [basename(file)],
    onChange: () => void check(),
    logger: { warn: (m) => log.warn(m) },
  });
  timer = setInterval(() => void check(), pollMs);
  void check();

  return { stop };
}
