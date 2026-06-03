import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { withFileLock } from '@agentbridge/core';

describe('fileLock', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'agentbridge-lock-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('락 안에서 fn을 실행하고 결과를 반환한다', async () => {
    const result = await withFileLock(dir, async () => 42);
    assert.equal(result, 42);
  });

  it('fn 종료 후 락 디렉토리가 제거된다', async () => {
    await withFileLock(dir, async () => undefined);
    assert.equal(existsSync(join(dir, '.lock')), false);
  });

  it('fn이 throw해도 락이 해제된다', async () => {
    await assert.rejects(
      withFileLock(dir, async () => {
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal(existsSync(join(dir, '.lock')), false);
  });

  it('두 개의 동시 임계영역이 직렬화된다 (서로 다른 스토어 인스턴스 시뮬레이션)', async () => {
    // 같은 프로세스라도 별도 withFileLock 호출끼리는 in-process mutex가 없으므로
    // 파일 락만이 직렬화를 보장한다.
    const events: string[] = [];
    await Promise.all([
      withFileLock(dir, async () => {
        events.push('A-start');
        await new Promise((r) => setTimeout(r, 100));
        events.push('A-end');
      }),
      withFileLock(dir, async () => {
        events.push('B-start');
        await new Promise((r) => setTimeout(r, 100));
        events.push('B-end');
      }),
    ]);
    // 직렬화 보장: start와 end가 교차하지 않는다 (A-start, A-end, B-start, B-end 또는 B 먼저)
    const first = events[0][0]; // 'A' or 'B'
    assert.equal(events[1][0], first, `교차 발생: ${events.join(',')}`);
  });

  it('죽은 프로세스의 stale 락을 강제 해제하고 진입한다', async () => {
    // 죽은 pid의 락을 수동으로 심어둠
    const lockDir = join(dir, '.lock');
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(
      join(lockDir, 'meta.json'),
      JSON.stringify({ pid: 999999999, acquiredAt: Date.now() }),
      'utf8',
    );
    const result = await withFileLock(dir, async () => 'entered');
    assert.equal(result, 'entered');
  });

  it('살아있는 프로세스의 락이라도 너무 오래되면(stale) 강제 해제한다', async () => {
    const lockDir = join(dir, '.lock');
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(
      join(lockDir, 'meta.json'),
      // 자기 자신 pid(살아있음) + 11초 전 timestamp
      JSON.stringify({ pid: process.pid, acquiredAt: Date.now() - 11_000 }),
      'utf8',
    );
    const result = await withFileLock(dir, async () => 'entered');
    assert.equal(result, 'entered');
  });

  it('stale 락 동시 진입 시도에도 두 임계영역이 직렬화된다', async () => {
    // 앱 강제 종료 후 stale 락이 남은 상태에서 두 프로세스(여기선 두 호출)가
    // 동시에 stale 해제를 시도해도 한 쪽만 임계영역에 진입해야 한다.
    const lockDir = join(dir, '.lock');
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(
      join(lockDir, 'meta.json'),
      JSON.stringify({ pid: 999999999, acquiredAt: Date.now() }),
      'utf8',
    );

    const events: string[] = [];
    await Promise.all([
      withFileLock(dir, async () => {
        events.push('A-start');
        await new Promise((r) => setTimeout(r, 100));
        events.push('A-end');
      }),
      withFileLock(dir, async () => {
        events.push('B-start');
        await new Promise((r) => setTimeout(r, 100));
        events.push('B-end');
      }),
    ]);
    // 직렬화 보장: start와 end가 교차하지 않는다
    const first = events[0][0]; // 'A' or 'B'
    assert.equal(events[1][0], first, `교차 발생: ${events.join(',')}`);
  });

  it('살아있는 락이 안 풀리면 타임아웃으로 throw한다', async function () {
    this.timeout(10_000);
    const lockDir = join(dir, '.lock');
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(
      join(lockDir, 'meta.json'),
      JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }),
      'utf8',
    );
    // meta.json을 계속 갱신해 stale 판정을 피함 — 진짜 살아있는 락 시뮬레이션
    const keeper = setInterval(() => {
      void fs.writeFile(
        join(lockDir, 'meta.json'),
        JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }),
        'utf8',
      );
    }, 1_000);
    try {
      await assert.rejects(withFileLock(dir, async () => 'never'), /timeout/);
    } finally {
      clearInterval(keeper);
    }
  });
});
