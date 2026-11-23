// 첫 턴이 시작된 뒤 명령 하나를 입력으로 넣는다 (SpawnOptions.commandAfterTurnStart).
//
// agy는 --remote-control을 켠 채 -i로 띄우면 첫 턴을 실행은 하되 화면에 그리지 않는다(agy 1.5.14
// 실측). 그래서 원격 컨트롤을 기동 인자로 켜지 않고, 첫 턴이 시작된 뒤 /remote-control을 넣는다.
// 그 턴이 도는 중에 넣어도 명령으로 바로 처리되고 모델 입력에는 섞이지 않는다.
//
// 시작 신호는 주입 훅이, 종료 신호는 종료 훅이 쓴다. 시작 신호를 못 받아도 종료 신호에서 넣는다.

import { dirname } from 'path';
import { promises as fs } from 'fs';
import { resolveTurnSignalFile, resolveTurnStartFile, TURN_SIGNAL_FILENAME, TURN_START_FILENAME } from '../cliAdapter/turnSignal';
import { createSessionFileWatcher, type SessionFileWatcher } from '../sessionFileWatcher';
import type { Logger } from '../interfaces';
import { noopLogger } from '../interfaces';

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

// 넣었으면 true, 신호 전에 멈췄으면 false. 새 세션에만 쓴다 — 신호 파일이 이미 있으면 바로 넣는다.
export function sendAfterTurnStart(opts: {
  workspaceDir: string;
  sessionId: string;
  text: string;
  send: (text: string) => void;
  signal: AbortSignal;
  // watch 미지원·누락 시 안전망 폴링 주기. 기본 1초.
  intervalMs?: number;
  logger?: Logger;
}): Promise<boolean> {
  const log = opts.logger ?? noopLogger;
  const startFile = resolveTurnStartFile(opts.workspaceDir, opts.sessionId);
  const endFile = resolveTurnSignalFile(opts.workspaceDir, opts.sessionId);

  return new Promise((resolve) => {
    if (opts.signal.aborted) return resolve(false);
    let done = false;
    let watcher: SessionFileWatcher | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    const finish = (sent: boolean): void => {
      if (done) return;
      done = true;
      if (timer) clearInterval(timer);
      watcher?.stop();
      opts.signal.removeEventListener('abort', onAbort);
      resolve(sent);
    };
    const onAbort = (): void => finish(false);

    const check = async (): Promise<void> => {
      if (done) return;
      if (!(await exists(startFile)) && !(await exists(endFile))) return;
      if (done || opts.signal.aborted) return;
      opts.send(opts.text);
      finish(true);
    };

    opts.signal.addEventListener('abort', onAbort, { once: true });
    watcher = createSessionFileWatcher({
      root: dirname(startFile),
      filenames: [TURN_START_FILENAME, TURN_SIGNAL_FILENAME],
      onChange: () => void check(),
      logger: { warn: (m) => log.warn(m) },
    });
    timer = setInterval(() => void check(), opts.intervalMs ?? 1000);
    void check();
  });
}
