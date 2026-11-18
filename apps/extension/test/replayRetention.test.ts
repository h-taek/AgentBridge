import { strict as assert } from 'assert';
import { existsSync, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  REPLAY_RETENTION_MS,
  acquireOwnership,
  ownerPath,
  replayLogPath,
  replaySizePath,
  sweepOldReplayLogs,
  withFileLock,
} from '@agentbridge/core';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('replayRetention', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'agentbridge-retention-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function writeReplayLog(
    wsId: string,
    sessionId: string,
    content: string,
    mtimeMs: number,
  ): Promise<{ sessionDir: string; logPath: string }> {
    const sessionDir = join(root, 'workspaces', wsId, 'sessions', sessionId);
    await fs.mkdir(sessionDir, { recursive: true });
    const logPath = replayLogPath(sessionDir);
    await fs.writeFile(logPath, content, 'utf8');
    const sec = mtimeMs / 1000;
    await fs.utimes(logPath, sec, sec);
    return { sessionDir, logPath };
  }

  it('8일 지난 replay.log는 지우고 개수와 용량을 반환한다', async () => {
    const now = Date.now();
    const { logPath } = await writeReplayLog('ws-1', 's-old', '1234567890', now - 8 * DAY_MS);

    const res = await sweepOldReplayLogs(root, now);

    assert.deepEqual(res, { removed: 1, bytes: 10, failed: [] });
    assert.equal(existsSync(logPath), false);
  });

  it('6일 지난 replay.log와 정확히 7일 된 replay.log는 남긴다', async () => {
    const now = Date.now();
    const sixDays = await writeReplayLog('ws-1', 's-6d', 'abc', now - 6 * DAY_MS);
    const exactSevenDays = await writeReplayLog('ws-1', 's-7d', 'def', now - REPLAY_RETENTION_MS);

    const res = await sweepOldReplayLogs(root, now);

    assert.deepEqual(res, { removed: 0, bytes: 0, failed: [] });
    assert.equal(existsSync(sixDays.logPath), true);
    assert.equal(existsSync(exactSevenDays.logPath), true);
  });

  it('살아 있는 owner(지금 프로세스 pid)의 replay.log는 8일이 지나도 남긴다', async () => {
    const now = Date.now();
    const { sessionDir, logPath } = await writeReplayLog('ws-1', 's-alive', 'live-log', now - 8 * DAY_MS);
    await acquireOwnership(sessionDir, { app: 'extension', cols: 80, rows: 24 });
    // acquireOwnership은 건드리지 않지만 혹시 몰라 mtime을 8일 전으로 다시 고정한다.
    const oldSec = (now - 8 * DAY_MS) / 1000;
    await fs.utimes(logPath, oldSec, oldSec);

    const res = await sweepOldReplayLogs(root, now);

    assert.deepEqual(res, { removed: 0, bytes: 0, failed: [] });
    assert.equal(existsSync(logPath), true);
  });

  it('죽은 pid owner의 8일 지난 replay.log는 지운다', async () => {
    const now = Date.now();
    const { sessionDir, logPath } = await writeReplayLog('ws-1', 's-dead', 'stale-log', now - 8 * DAY_MS);
    await fs.writeFile(
      ownerPath(sessionDir),
      JSON.stringify({ app: 'extension', pid: 999999999, acquiredAt: now - 8 * DAY_MS, cols: 80, rows: 24 }),
      'utf8',
    );

    const res = await sweepOldReplayLogs(root, now);

    assert.deepEqual(res, { removed: 1, bytes: 9, failed: [] });
    assert.equal(existsSync(logPath), false);
    // owner.json 등 다른 파일은 지우지 않는다.
    assert.equal(existsSync(ownerPath(sessionDir)), true);
  });

  it('pid가 재사용된 stale owner(acquiredAt가 프로세스 시작 이전)의 8일 지난 replay.log는 지운다', async () => {
    const now = Date.now();
    const { sessionDir, logPath } = await writeReplayLog('ws-1', 's-reused', 'reused-log', now - 8 * DAY_MS);
    await fs.writeFile(
      ownerPath(sessionDir),
      JSON.stringify({ app: 'desktop', pid: process.pid, acquiredAt: 1, cols: 80, rows: 24 }),
      'utf8',
    );

    const res = await sweepOldReplayLogs(root, now);

    assert.deepEqual(res, { removed: 1, bytes: 10, failed: [] });
    assert.equal(existsSync(logPath), false);
  });

  it('이미 없는 파일이나 다른 창이 먼저 지워 ENOENT가 된 파일은 failed에 넣지 않는다', async () => {
    const now = Date.now();
    // 1) replay.log가 아예 없는 세션 폴더
    const emptySession = join(root, 'workspaces', 'ws-1', 'sessions', 's-empty');
    await fs.mkdir(emptySession, { recursive: true });

    // 2) pre-stat을 통과한 뒤 락을 기다리는 사이에 다른 창이 먼저 지운 경우
    const { sessionDir, logPath } = await writeReplayLog('ws-1', 's-race-rm', 'gone', now - 8 * DAY_MS);
    let releaseLock!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let lockEntered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      lockEntered = resolve;
    });

    const holder = withFileLock(sessionDir, async () => {
      lockEntered();
      await lockHeld;
      await fs.unlink(logPath);
    });
    await enteredPromise;

    const sweepPromise = sweepOldReplayLogs(root, now);
    // sweep이 pre-stat 후 락 진입을 기다릴 수 있도록 한 틱 양보 뒤 락 해제
    await new Promise((r) => setTimeout(r, 20));
    releaseLock();

    const [, res] = await Promise.all([holder, sweepPromise]);
    assert.deepEqual(res, { removed: 0, bytes: 0, failed: [] });
  });

  it('replay.log 밖의 파일은 8일이 넘어도 그대로 남긴다', async () => {
    const now = Date.now();
    const oldSec = (now - 8 * DAY_MS) / 1000;
    const { sessionDir, logPath } = await writeReplayLog('ws-1', 's-other', 'old', now - 8 * DAY_MS);
    const wsDir = join(root, 'workspaces', 'ws-1');
    const keepFiles = [
      replaySizePath(sessionDir),
      join(sessionDir, 'turns.jsonl'),
      join(sessionDir, 'other.log'),
      join(wsDir, 'workspace.json'),
      join(wsDir, 'workspace.json.123.tmp'),
      join(wsDir, 'ir.json'),
    ];
    for (const f of keepFiles) {
      await fs.writeFile(f, 'keep', 'utf8');
      await fs.utimes(f, oldSec, oldSec);
    }

    const res = await sweepOldReplayLogs(root, now);

    assert.equal(res.removed, 1);
    assert.equal(existsSync(logPath), false);
    for (const f of keepFiles) {
      assert.equal(existsSync(f), true, `파일이 남아 있어야 한다: ${f}`);
    }
  });

  it('정리와 acquireOwnership을 동시에 돌리면 소유권을 잡은 쪽 기록이 남는다', async () => {
    const now = Date.now();
    const { sessionDir, logPath } = await writeReplayLog('ws-1', 's-concurrent', 'old-data', now - 8 * DAY_MS);

    const [sweepRes] = await Promise.all([
      sweepOldReplayLogs(root, now),
      (async () => {
        // 계획 §3: 소유 표지를 먼저 남긴 뒤 기록을 연다.
        await acquireOwnership(sessionDir, { app: 'extension', cols: 80, rows: 24 });
        await fs.appendFile(logPath, 'live-output', 'utf8');
      })(),
    ]);

    assert.deepEqual(sweepRes.failed, []);
    assert.equal(existsSync(ownerPath(sessionDir)), true);
    assert.equal(existsSync(logPath), true);
    const content = await fs.readFile(logPath, 'utf8');
    assert.equal(content.includes('live-output'), true);
  });

  it('ENOENT가 아닌 삭제 오류는 경로를 failed에 넣고 다른 세션 정리는 계속한다', async () => {
    const now = Date.now();
    const { logPath: goodLog } = await writeReplayLog('ws-1', 's-good', '12345', now - 8 * DAY_MS);
    // replay.log 자리에 디렉토리를 두고 mtime을 8일 전으로 맞춰 unlink가 실패하게 만든다.
    const badDir = join(root, 'workspaces', 'ws-1', 'sessions', 's-bad');
    const badLog = replayLogPath(badDir);
    await fs.mkdir(badLog, { recursive: true });
    const oldSec = (now - 8 * DAY_MS) / 1000;
    await fs.utimes(badLog, oldSec, oldSec);

    const res = await sweepOldReplayLogs(root, now);

    assert.equal(res.removed, 1);
    assert.equal(res.bytes, 5);
    assert.deepEqual(res.failed, [badLog]);
    assert.equal(existsSync(goodLog), false);
    assert.equal(existsSync(badLog), true);
  });
});
