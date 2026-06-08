// 세션 소유권 (V-12 / Plan 2) — 같은 세션을 두 앱(데스크탑/익스텐션)이 동시에 라이브로 열면
// 대화가 분기(평행우주)된다. owner.json으로 한 앱만 라이브를 갖게 하고, 나머지는 읽기 전용으로
// 미러링한다(미러링/이어가기 UX는 2b). 소유권 이전은 transfer-request.json 핸드셰이크로 처리.
//
// 두 파일 모두 세션 디렉토리(<storage>/workspaces/<wid>/sessions/<sid>/) 안에 둔다. 두 앱이
// 결정적 ID(V-12)로 같은 디렉토리를 가리키므로 별도 동기화 채널이 필요 없다.
// owner.json 쓰기/갱신/삭제는 파일 락(fileLock.ts)으로 보호 — 읽기는 atomic rename이라 락 불필요.

import { promises as fsp } from 'fs';
import { join } from 'path';
import { execFile } from 'child_process';
import { withFileLock, isPidAlive } from './fileLock';

export type OwnerApp = 'desktop' | 'extension';

// owner.json — 현재 이 세션을 라이브로 소유한 앱.
export interface OwnerInfo {
  app: OwnerApp;
  pid: number; // 소유 앱 프로세스 pid (데스크탑 main / 익스텐션 호스트). 생존 여부로 라이브 판정.
  acquiredAt: number; // epoch ms
  cols: number; // 소유자 터미널 크기 — 2b 읽기 전용 뷰어가 동일 크기로 렌더하기 위함.
  rows: number;
}

// transfer-request.json — 뷰어가 "채팅 이어가기"를 누르면 작성. 소유 앱이 감지해 정리·해제(2b).
export interface TransferRequest {
  requestedBy: OwnerApp;
  pid: number;
  requestedAt: number;
}

export function ownerPath(sessionDir: string): string {
  return join(sessionDir, 'owner.json');
}

export function transferRequestPath(sessionDir: string): string {
  return join(sessionDir, 'transfer-request.json');
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value), 'utf8');
  await fsp.rename(tmp, filePath);
}

async function readOwnerUnlocked(sessionDir: string): Promise<OwnerInfo | null> {
  try {
    const raw = await fsp.readFile(ownerPath(sessionDir), 'utf8');
    const parsed = JSON.parse(raw) as OwnerInfo;
    if (typeof parsed.pid !== 'number' || (parsed.app !== 'desktop' && parsed.app !== 'extension')) {
      return null; // 스키마 불일치 — 주인 없음으로 취급
    }
    return parsed;
  } catch {
    return null; // 미존재 또는 파싱 실패 — 주인 없음 (pid 검증이 최종 안전망)
  }
}

// 라이브 세션 시작/복구 시 호출 — owner.json 작성 (파일 락 보호).
// 주의: 기존 소유자를 검사하지 않고 덮어쓴다. 호출자는 먼저 isSessionOwned()로 확인할 것.
// (2b 소유권 이전: 직전 소유 앱이 release한 뒤 요청 앱이 acquire하는 핸드셰이크. 정상 종료로
//  owner.json이 stale로 남은 경우도 핸드셰이크 없이 바로 acquire = 덮어쓰기가 정상 동작.)
export async function acquireOwnership(
  sessionDir: string,
  info: { app: OwnerApp; cols: number; rows: number },
): Promise<void> {
  await withFileLock(sessionDir, async () => {
    const owner: OwnerInfo = {
      app: info.app,
      pid: process.pid,
      acquiredAt: Date.now(),
      cols: info.cols,
      rows: info.rows,
    };
    await writeJsonAtomic(ownerPath(sessionDir), owner);
  });
}

// PTY resize 시 호출 — cols/rows만 갱신. owner.json이 없으면 no-op (이미 해제됨).
export async function updateOwnerSize(sessionDir: string, cols: number, rows: number): Promise<void> {
  await withFileLock(sessionDir, async () => {
    const current = await readOwnerUnlocked(sessionDir);
    if (!current) return;
    await writeJsonAtomic(ownerPath(sessionDir), { ...current, cols, rows });
  });
}

// 정상 종료 시 호출 — owner.json 삭제 (파일 락 보호). 이미 없으면 no-op.
export async function releaseOwnership(sessionDir: string): Promise<void> {
  await withFileLock(sessionDir, async () => {
    await fsp.rm(ownerPath(sessionDir), { force: true });
  });
}

// owner.json 스냅샷. 미존재/손상이면 null. (읽기는 락 없이 — atomic rename이라 부분 읽기 없음.)
export async function readOwner(sessionDir: string): Promise<OwnerInfo | null> {
  return readOwnerUnlocked(sessionDir);
}

export function isOwnerAlive(owner: OwnerInfo): boolean {
  return isPidAlive(owner.pid);
}

// 살아있는 pid의 프로세스 시작 시각(epoch ms). 못 구하면 null.
// macOS ps는 etimes 미지원 → lstart(절대 시각)를 LC_ALL=C로 받아 Date.parse.
function processStartTime(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      '/bin/ps',
      ['-o', 'lstart=', '-p', String(pid)],
      { env: { ...process.env, LC_ALL: 'C' } },
      (err, stdout) => {
        if (err) return resolve(null);
        const ms = Date.parse(stdout.trim());
        resolve(Number.isNaN(ms) ? null : ms);
      },
    );
  });
}

// pid 재사용 견고화 — pid 생존 + 프로세스 시작 시각 ≤ acquiredAt.
// 비정상 종료로 owner.json이 stale로 남고 OS가 그 pid를 다른 프로세스에 재배정하면,
// 재배정 프로세스는 acquiredAt 이후에 시작되므로 stale로 걸러낸다. (정상 소유자는 프로세스가
// 먼저 떠야 소유를 잡으므로 시작 시각 ≤ acquiredAt이 항상 성립. lstart 초 절삭/클럭 지터 여유로
// tolerance.) 시작 시각을 못 구하거나 구 스키마(acquiredAt 없음)면 pid-only로 폴백 — 기존 동작 보존.
const START_TIME_TOLERANCE_MS = 2000;
async function isOwnerLive(owner: OwnerInfo): Promise<boolean> {
  if (!isPidAlive(owner.pid)) return false;
  if (typeof owner.acquiredAt !== 'number') return true;
  const startedAt = await processStartTime(owner.pid);
  if (startedAt === null) return true;
  return startedAt <= owner.acquiredAt + START_TIME_TOLERANCE_MS;
}

// 세션이 현재 라이브 소유 중인가 — owner.json 존재 + 소유 프로세스 생존(pid 재사용 가드 포함).
export async function isSessionOwned(sessionDir: string): Promise<boolean> {
  const owner = await readOwnerUnlocked(sessionDir);
  return owner !== null && (await isOwnerLive(owner));
}

// *다른* 살아있는 프로세스가 이 세션을 라이브 소유 중이면 그 OwnerInfo, 아니면 null.
// (owner.json 존재 + 소유 프로세스 생존 + pid≠우리 프로세스). 데스크탑·익스텐션 양쪽이 같은
// 판정으로 외부 소유 세션 위에 PTY를 띄우는 것(대화 분기)을 막는 공용 가드. process.pid는 두
// Node 호스트 모두에서 자기 프로세스를 가리키므로 호스트 무관하게 동작한다.
export async function readForeignOwner(sessionDir: string): Promise<OwnerInfo | null> {
  const owner = await readOwnerUnlocked(sessionDir);
  if (owner && owner.pid !== process.pid && (await isOwnerLive(owner))) return owner;
  return null;
}

// ── 소유권 이전 파일 프리미티브 (핸드셰이크 로직은 2b) ──

// 뷰어 → 소유 앱: "이 세션 넘겨줘" 요청 작성.
export async function requestTransfer(sessionDir: string, requestedBy: OwnerApp): Promise<void> {
  const req: TransferRequest = { requestedBy, pid: process.pid, requestedAt: Date.now() };
  await writeJsonAtomic(transferRequestPath(sessionDir), req);
}

export async function readTransferRequest(sessionDir: string): Promise<TransferRequest | null> {
  try {
    const raw = await fsp.readFile(transferRequestPath(sessionDir), 'utf8');
    const parsed = JSON.parse(raw) as TransferRequest;
    if (parsed.requestedBy !== 'desktop' && parsed.requestedBy !== 'extension') return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function clearTransferRequest(sessionDir: string): Promise<void> {
  await fsp.rm(transferRequestPath(sessionDir), { force: true });
}
