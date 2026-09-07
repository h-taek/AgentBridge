// 호스트 쪽 요청 처리기 (0.5.0 3단계 W6).
//
// 저장소를 감시하다 요청 파일이 생기면, **우리가 소유한 세션의 것만** 집어 처리한다.
// 세션 소유 기록(owner.json)이 이미 있으므로 선점 규칙을 새로 만들지 않는다.
//
// 이 단계의 종류는 왕복 확인 하나다. PTY를 만지는 넷은 4단계에서 여기에 종류로 붙는다.

import { promises as fsp } from 'fs';
import { join } from 'path';
import { createSessionFileWatcher, type SessionFileWatcher } from './sessionFileWatcher';
import { readOwner } from './sessionOwner';
import {
  HOST_REQUEST_FILENAME,
  claimHostRequest,
  completeHostRequest,
  hostRequestPath,
  type HostRequest,
  type HostResult,
} from './hostRequest';
import type { Logger } from './interfaces';
import { noopLogger } from './interfaces';

export type HostRequestHandlers = Record<
  string,
  (req: HostRequest, sessionDir: string) => Promise<string> | string
>;

export type HostRequestHandlerOptions = {
  storageRoot: string;
  handlers: HostRequestHandlers;
  // 이 호스트가 그 세션을 쥐고 있는지. 기본은 owner.json의 pid가 우리 것인지 본다.
  ownsSession?: (sessionDir: string) => Promise<boolean>;
  logger?: Logger;
};

async function defaultOwnsSession(sessionDir: string): Promise<boolean> {
  const owner = await readOwner(sessionDir);
  return !!owner && owner.pid === process.pid;
}

// 요청이 놓일 수 있는 세션 폴더들. 깊이가 고정이라 훑는 비용이 세션 수에 비례한다.
async function sessionDirsWithRequest(storageRoot: string): Promise<string[]> {
  const out: string[] = [];
  const workspacesRoot = join(storageRoot, 'workspaces');
  let workspaces: string[];
  try {
    workspaces = await fsp.readdir(workspacesRoot);
  } catch {
    return out;
  }
  for (const ws of workspaces) {
    const sessionsRoot = join(workspacesRoot, ws, 'sessions');
    let sessions: string[];
    try {
      sessions = await fsp.readdir(sessionsRoot);
    } catch {
      continue;
    }
    for (const sid of sessions) {
      const dir = join(sessionsRoot, sid);
      try {
        await fsp.access(hostRequestPath(dir));
        out.push(dir);
      } catch {
        /* 요청 없음 */
      }
    }
  }
  return out;
}

export function startHostRequestHandler(opts: HostRequestHandlerOptions): SessionFileWatcher {
  const log = opts.logger ?? noopLogger;
  const owns = opts.ownsSession ?? defaultOwnsSession;

  async function drain(): Promise<void> {
    for (const dir of await sessionDirsWithRequest(opts.storageRoot)) {
      if (!(await owns(dir))) continue; // 남의 세션이다 — 그 호스트가 집는다
      const req = await claimHostRequest(dir);
      if (!req) continue; // 남이 먼저 집었다
      const handler = opts.handlers[req.kind];
      let result: HostResult;
      if (!handler) {
        result = { id: req.id, ok: false, output: `알 수 없는 요청 종류: ${req.kind}`, at: Date.now() };
      } else {
        try {
          result = { id: req.id, ok: true, output: await handler(req, dir), at: Date.now() };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result = { id: req.id, ok: false, output: msg, at: Date.now() };
        }
      }
      await completeHostRequest(dir, result);
    }
  }

  return createSessionFileWatcher({
    root: opts.storageRoot,
    filenames: [HOST_REQUEST_FILENAME],
    onChange: () => {
      void drain().catch((err) => log.warn(`hostRequestHandler: ${String(err)}`));
    },
    logger: { warn: (m, e) => log.warn(`${m} ${e ? String(e) : ''}`) },
  });
}
