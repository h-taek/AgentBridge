// codex·agy 새 세션 modelSessionId(thread_id/UUID) 캡처 — watch 기반 + 데드라인 제거 회귀 테스트.
//
// 핵심 보장: 캡처는 spawn 후 고정 시한이 아니라 세션(AbortSignal)이 살아있는 동안 대기하므로,
// **첫 입력이 늦게 들어와 파일이 한참 뒤에 생겨도** 잡는다. abort되면 캡처 없이 종료한다.
// (이전 버그: codex 60초 / agy 5분 데드라인이 첫 입력 전에 만료되면 영영 못 잡음.)

import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  snapshotCodexSessions,
  captureNewThreadId,
  watchForNewConversationUuid,
} from '@agentbridge/core';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// walkRolloutFiles는 today/yesterday만 스캔하므로 파일을 오늘 날짜 폴더에 둔다.
function todayDatePath(root: string): string {
  const d = new Date();
  const y = String(d.getFullYear());
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return join(root, y, m, day);
}

async function writeRollout(root: string, uuid: string): Promise<void> {
  const dir = todayDatePath(root);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, `rollout-2026-06-11T00-00-00-${uuid}.jsonl`), '{}\n', 'utf8');
}

describe('captureNewThreadId (codex)', () => {
  let root: string;
  const UUID = '019eb298-531f-7fd2-8099-a37860ee4e94';

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'agentbridge-codexcap-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('캡처 시작 한참 뒤에 생긴 rollout도 잡는다 (데드라인 없음)', async () => {
    const before = await snapshotCodexSessions(root);
    const p = captureNewThreadId(before, { sessionsRoot: root, intervalMs: 50 });
    // 첫 입력이 늦은 상황 시뮬레이션 — 과거 60초 데드라인보다는 짧지만, 즉시가 아님을 보장.
    await wait(300);
    await writeRollout(root, UUID);
    assert.equal(await p, UUID);
  });

  it('snapshot에 이미 있던 파일은 무시하고 새 파일만 잡는다', async () => {
    await writeRollout(root, '019e0000-0000-7000-8000-000000000001'); // 기존 파일
    const before = await snapshotCodexSessions(root);
    const p = captureNewThreadId(before, { sessionsRoot: root, intervalMs: 50 });
    await wait(150);
    await writeRollout(root, UUID); // 새 파일
    assert.equal(await p, UUID);
  });

  it('abort되면 캡처 없이 null', async () => {
    const before = await snapshotCodexSessions(root);
    const ctrl = new AbortController();
    const p = captureNewThreadId(before, { sessionsRoot: root, intervalMs: 50, signal: ctrl.signal });
    await wait(80);
    ctrl.abort();
    assert.equal(await p, null);
  });
});

describe('watchForNewConversationUuid (agy)', () => {
  let dir: string;
  const UUID = 'aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';

  const writeConv = (uuid: string): Promise<void> =>
    fs.writeFile(join(dir, `${uuid}.db`), 'x', 'utf8');

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'agentbridge-agycap-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('캡처 시작 한참 뒤에 생긴 conversation도 잡는다 (데드라인 없음)', async () => {
    let captured: string | null = null;
    const p = watchForNewConversationUuid({
      cwd: '/tmp/x',
      excludeUuids: new Set(),
      conversationsDir: dir,
      intervalMs: 50,
      onCaptured: (u) => {
        captured = u;
      },
    });
    await wait(300);
    await writeConv(UUID);
    await p;
    assert.equal(captured, UUID);
  });

  it('excludeUuids에 든 기존 파일은 무시하고 새 파일만 잡는다', async () => {
    const OLD = 'aaaaaaaa-bbbb-7ccc-8ddd-000000000001';
    await writeConv(OLD);
    let captured: string | null = null;
    const p = watchForNewConversationUuid({
      cwd: '/tmp/x',
      excludeUuids: new Set([OLD]),
      conversationsDir: dir,
      intervalMs: 50,
      onCaptured: (u) => {
        captured = u;
      },
    });
    await wait(150);
    await writeConv(UUID);
    await p;
    assert.equal(captured, UUID);
  });

  it('abort되면 캡처 없이 종료', async () => {
    let captured: string | null = null;
    const ctrl = new AbortController();
    const p = watchForNewConversationUuid({
      cwd: '/tmp/x',
      excludeUuids: new Set(),
      conversationsDir: dir,
      intervalMs: 50,
      abortSignal: ctrl.signal,
      onCaptured: (u) => {
        captured = u;
      },
    });
    await wait(80);
    ctrl.abort();
    await p;
    assert.equal(captured, null);
  });
});
