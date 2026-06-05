import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createSessionMirror,
  acquireOwnership,
  releaseOwnership,
  type MirrorSink,
} from '@agentbridge/core';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type RecordingSink = MirrorSink & { chunks: string[]; ended: boolean; alive: boolean };

function recordingSink(): RecordingSink {
  return {
    chunks: [],
    ended: false,
    alive: true,
    onData(d: string) {
      this.chunks.push(d);
    },
    onEnded() {
      this.ended = true;
    },
    isAlive() {
      return this.alive;
    },
  };
}

describe('createSessionMirror', () => {
  let dir: string;
  let replay: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'agentbridge-mirror-'));
    replay = join(dir, 'replay.log');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('start는 replay 스냅샷 전체와 라이브 owner를 반환한다', async () => {
    await fs.writeFile(replay, 'snapshot', 'utf8');
    await acquireOwnership(dir, { app: 'extension', cols: 80, rows: 24 });
    const sink = recordingSink();
    const m = createSessionMirror({ sessionDir: dir, replayPath: replay, sink, pollMs: 30 });
    const snap = await m.start();
    assert.equal(snap.replay, 'snapshot');
    assert.ok(snap.owner);
    assert.equal(snap.owner!.app, 'extension');
    assert.equal(snap.owner!.cols, 80);
    assert.equal(snap.owner!.rows, 24);
    m.stop();
  });

  it('owner.json이 없으면 owner는 null', async () => {
    await fs.writeFile(replay, 'x', 'utf8');
    const sink = recordingSink();
    const m = createSessionMirror({ sessionDir: dir, replayPath: replay, sink, pollMs: 30 });
    const snap = await m.start();
    assert.equal(snap.owner, null);
    m.stop();
  });

  it('소유 앱이 append한 새 바이트만 sink.onData로 흘린다 (스냅샷은 제외)', async () => {
    await fs.writeFile(replay, 'AAA', 'utf8');
    await acquireOwnership(dir, { app: 'extension', cols: 80, rows: 24 });
    const sink = recordingSink();
    const m = createSessionMirror({ sessionDir: dir, replayPath: replay, sink, pollMs: 30 });
    await m.start();
    await fs.appendFile(replay, 'BBB', 'utf8');
    await wait(150);
    assert.equal(sink.chunks.join(''), 'BBB');
    m.stop();
  });

  it('owner.json이 사라지면 onEnded 후 더는 흘리지 않는다', async () => {
    await fs.writeFile(replay, 'AAA', 'utf8');
    await acquireOwnership(dir, { app: 'extension', cols: 80, rows: 24 });
    const sink = recordingSink();
    const m = createSessionMirror({ sessionDir: dir, replayPath: replay, sink, pollMs: 30 });
    await m.start();
    await releaseOwnership(dir);
    await wait(150);
    assert.equal(sink.ended, true);
    const before = sink.chunks.length;
    await fs.appendFile(replay, 'late', 'utf8');
    await wait(150);
    assert.equal(sink.chunks.length, before);
    m.stop();
  });

  it('sink가 죽었으면 onData를 호출하지 않는다', async () => {
    await fs.writeFile(replay, 'AAA', 'utf8');
    await acquireOwnership(dir, { app: 'extension', cols: 80, rows: 24 });
    const sink = recordingSink();
    sink.alive = false;
    const m = createSessionMirror({ sessionDir: dir, replayPath: replay, sink, pollMs: 30 });
    await m.start();
    await fs.appendFile(replay, 'BBB', 'utf8');
    await wait(150);
    assert.equal(sink.chunks.length, 0);
    m.stop();
  });

  it('stop 후에는 새 append를 흘리지 않는다', async () => {
    await fs.writeFile(replay, 'AAA', 'utf8');
    await acquireOwnership(dir, { app: 'extension', cols: 80, rows: 24 });
    const sink = recordingSink();
    const m = createSessionMirror({ sessionDir: dir, replayPath: replay, sink, pollMs: 30 });
    await m.start();
    m.stop();
    await fs.appendFile(replay, 'BBB', 'utf8');
    await wait(150);
    assert.equal(sink.chunks.length, 0);
  });
});
