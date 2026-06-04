// 프로세스 간 파일 락 — workspace.json 등 read-modify-write를 두 앱(데스크탑/익스텐션)이
// 동시에 수행할 때 lost update를 막는다 (V-12).
//
// 방식: <targetDir>/.lock 디렉토리를 mkdir로 생성 (OS가 원자성 보장 — 먼저 만든 쪽이 임자).
// 락 내부 meta.json에 { pid, acquiredAt } 기록. 주인 프로세스가 죽었거나(STALE) 너무 오래된
// 락은 강제 해제 — 앱 강제 종료로 영원히 잠기는 일 방지.

import { promises as fsp } from 'fs';
import { join } from 'path';

const RETRY_INTERVAL_MS = 50;
const ACQUIRE_TIMEOUT_MS = 5_000;
// STALE_LOCK_MS는 반드시 ACQUIRE_TIMEOUT_MS보다 커야 한다.
// 그래야 정상 락(alive pid + 짧은 보유)이 stale로 오판되지 않는다.
const STALE_LOCK_MS = 10_000;
if (STALE_LOCK_MS <= ACQUIRE_TIMEOUT_MS) {
  throw new Error(
    `fileLock: STALE_LOCK_MS(${STALE_LOCK_MS}) must be > ACQUIRE_TIMEOUT_MS(${ACQUIRE_TIMEOUT_MS})`,
  );
}

interface LockMeta {
  pid: number;
  acquiredAt: number;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH = 없는 pid. EPERM = pid는 존재하나 다른 uid 소유(signal 불가).
    // 이 코드는 자기 pid만 기록하므로 EPERM은 사실상 발생 안 함 — 발생해도
    // "우리 것이 아닌 살아있는 pid"이므로 소유 없음(false) 처리가 맞다.
    return false;
  }
}

// stale이면 단독으로 제거 후 true, 아니면 false. 락이 이미 사라진 경우도 true.
// rename-then-rm 패턴으로 원자적 takeover: rename이 한 프로세스만 성공하므로
// 동시에 두 호출이 stale 판정을 내려도 둘 다 락을 부수는 race를 차단한다.
async function tryBreakStaleLock(lockDir: string): Promise<boolean> {
  let meta: LockMeta | null = null;
  try {
    meta = JSON.parse(await fsp.readFile(join(lockDir, 'meta.json'), 'utf8')) as LockMeta;
  } catch {
    // meta 미작성(mkdir 직후 찰나) 또는 손상 — 디렉토리 mtime 기준으로 판단
  }

  let stale: boolean;
  if (meta) {
    stale = !isPidAlive(meta.pid) || Date.now() - meta.acquiredAt > STALE_LOCK_MS;
  } else {
    try {
      const stat = await fsp.stat(lockDir);
      stale = Date.now() - stat.mtimeMs > STALE_LOCK_MS;
    } catch {
      return true; // 락이 이미 사라짐 — 재시도 가능
    }
  }

  if (!stale) return false;

  // rename은 원자적 — 성공한 프로세스만 단독으로 임시 디렉토리를 소유한다.
  // 동시에 도달한 다른 프로세스의 rename은 ENOENT(소스가 이미 사라짐)로 실패한다.
  const tmpDir = `${lockDir}.breaking.${process.pid}.${Date.now()}`;
  try {
    await fsp.rename(lockDir, tmpDir);
  } catch {
    // 다른 프로세스가 먼저 rename 성공 → 락이 곧 사라지거나 재획득됨
    return false;
  }
  // rename에 성공한 쪽만 여기 도달 — 임시 디렉토리를 정리하고 재획득 경쟁 재개
  await fsp.rm(tmpDir, { recursive: true, force: true });
  return true;
}

// targetDir의 .lock을 잡고 fn 실행. targetDir가 없으면 생성.
export async function withFileLock<T>(targetDir: string, fn: () => Promise<T>): Promise<T> {
  const lockDir = join(targetDir, '.lock');
  await fsp.mkdir(targetDir, { recursive: true });
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;

  // 락 획득 루프
  let acquiredAt: number | undefined;
  for (;;) {
    try {
      await fsp.mkdir(lockDir); // 원자적 — 성공 = 락 획득
      acquiredAt = Date.now(); // mkdir 성공 직후 캡처 — stale 타이머 기준점
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const broken = await tryBreakStaleLock(lockDir);
      if (!broken) {
        if (Date.now() > deadline) {
          throw new Error(`fileLock: timeout acquiring ${lockDir}`);
        }
        await new Promise((r) => setTimeout(r, RETRY_INTERVAL_MS));
      }
      // stale을 부쉈으면 즉시 재시도 (대기 없음)
    }
  }

  try {
    const meta: LockMeta = { pid: process.pid, acquiredAt: acquiredAt! };
    await fsp.writeFile(join(lockDir, 'meta.json'), JSON.stringify(meta), 'utf8');
    return await fn();
  } finally {
    await fsp.rm(lockDir, { recursive: true, force: true });
  }
}
