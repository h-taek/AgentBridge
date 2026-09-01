// 호스트 핸드셰이크 통로 (0.5.0 3단계 W6, B-5).
//
// CLI가 혼자 못 하는 일을 호스트에게 넘기는 자리다. 지금 이 통로를 타는 것은 `status`의 왕복
// 확인 하나이고, PTY를 만지는 넷(agent start·send·stop·close)은 4단계에서 종류로 더한다.
// 그래서 여기서 정하는 것은 요청 목록이 아니라 봉투다.
//
// 소켓이나 포트를 세우지 않는다. 얻는 것은 지연 없는 스트리밍인데 스트리밍할 것이 없고,
// 대신 잔재 정리와 bind 경합과 창이 둘일 때 누가 여는지를 전부 새로 정해야 한다.
//
// 요청은 세션 폴더에 놓이고 **그 세션을 소유한 호스트**만 집는다. 세션마다 소유 기록이 이미
// 있고, PTY를 만지는 요청은 그 PTY를 쥔 쪽만 처리할 수 있다. 창이 둘이면 먼저 원자적으로
// 집는 쪽이 이긴다 — 집기는 rename이라 진 쪽은 ENOENT를 받는다. 선점 규칙을 새로 만들지 않는다.
//
// 세션당 한 번에 하나만 돈다. 파일 이름을 고정으로 두고 CLI가 'wx'로 만들어 자리를 잡는다.
// 모델의 셸은 한 번에 한 명령을 돌리므로 이 제약이 실제로 걸리는 자리는 없다.

import { promises as fsp } from 'fs';
import { join } from 'path';

export const HOST_REQUEST_FILENAME = 'host-request.json';
export const HOST_RESULT_FILENAME = 'host-result.json';
const CLAIMED_FILENAME = 'host-request.claimed.json';

// 기다림에는 시한을 둔다. 호스트가 요청을 집고 그 안에서 죽으면 결과가 영영 안 오고, 시한이
// 없으면 CLI가 멈추고 모델의 턴이 안 끝나고 사용자는 멈춘 화면을 본다.
export const HOST_REQUEST_TIMEOUT_MS = 10_000;
const POLL_MS = 50;

// 이 단계의 유일한 종류. status가 배선이 실제로 도는지 확인하는 데 쓴다 — 파일이 제자리에
// 있는 것과 배선이 도는 것은 다른 사실이고, 후자를 확인하는 자리가 거기뿐이다.
export const HOST_PING = 'status-ping';

export type HostRequest = { id: string; kind: string; at: number; payload?: unknown };
export type HostResult = { id: string; ok: boolean; output: string; at: number };

export function hostRequestPath(sessionDir: string): string {
  return join(sessionDir, HOST_REQUEST_FILENAME);
}
export function hostResultPath(sessionDir: string): string {
  return join(sessionDir, HOST_RESULT_FILENAME);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value), 'utf8');
  await fsp.rename(tmp, path);
}

async function unlinkQuiet(path: string): Promise<void> {
  try {
    await fsp.unlink(path);
  } catch {
    /* 이미 없음 */
  }
}

// ─── CLI 쪽 ─────────────────────────────────────────────────────────────

export type SendOptions = {
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// 요청을 놓고 결과를 기다린다. 시한을 넘기면 실패로 끝내고 무엇을 시켰는지 출력에 남긴다 —
// 모델이 다시 부를지 판단할 수 있어야 한다.
export async function sendHostRequest(
  sessionDir: string,
  request: HostRequest,
  opts: SendOptions = {},
): Promise<HostResult> {
  const timeoutMs = opts.timeoutMs ?? HOST_REQUEST_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const reqPath = hostRequestPath(sessionDir);
  const resPath = hostResultPath(sessionDir);

  await fsp.mkdir(sessionDir, { recursive: true });
  // 앞선 요청의 결과가 남아 있으면 그것을 우리 것으로 오인한다. 자리를 잡기 전에 치운다.
  await unlinkQuiet(resPath);

  try {
    await fsp.writeFile(reqPath, JSON.stringify(request), { encoding: 'utf8', flag: 'wx' });
  } catch {
    return {
      id: request.id,
      ok: false,
      output: `다른 요청이 처리 중이다 (${request.kind}). 잠시 뒤 다시 부른다.`,
      at: now(),
    };
  }

  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const result = await readJson<HostResult>(resPath);
    if (result && result.id === request.id) {
      await unlinkQuiet(resPath);
      return result;
    }
    await sleep(POLL_MS);
  }

  // 안 집힌 요청은 우리가 치운다. 집힌 뒤 호스트가 죽은 경우의 잔재는 다음 요청이 덮는다.
  await unlinkQuiet(reqPath);
  return {
    id: request.id,
    ok: false,
    output: `호스트가 ${timeoutMs}ms 안에 답하지 않았다 (${request.kind}).`,
    at: now(),
  };
}

// ─── 호스트 쪽 ───────────────────────────────────────────────────────────

// 요청을 원자적으로 집는다. 창이 둘이면 rename에 성공한 쪽만 내용을 받는다.
export async function claimHostRequest(sessionDir: string): Promise<HostRequest | null> {
  const claimed = join(sessionDir, CLAIMED_FILENAME);
  try {
    await fsp.rename(hostRequestPath(sessionDir), claimed);
  } catch {
    return null; // 없거나 남이 먼저 집었다
  }
  const req = await readJson<HostRequest>(claimed);
  if (!req) {
    await unlinkQuiet(claimed);
    return null;
  }
  return req;
}

export async function completeHostRequest(
  sessionDir: string,
  result: HostResult,
): Promise<void> {
  await atomicWrite(hostResultPath(sessionDir), result);
  await unlinkQuiet(join(sessionDir, CLAIMED_FILENAME));
}
