import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TurnRecorder } from '../src/core/turnRecorder';
import { initCoreForTest } from './helpers';

const wid = '00000000-0000-0000-0000-000000000000';
const sid = 'test-session';

describe('TurnRecorder', () => {
  let storagePath: string;

  beforeEach(async () => {
    storagePath = await fs.mkdtemp(join(tmpdir(), 'agentbridge-test-'));
    initCoreForTest(storagePath);
  });

  afterEach(async () => {
    // dispose()는 turn flush를 fire-and-forget으로 띄운다(onTurnFlushed → updateSessionMeta).
    // V-12에서 그 갱신이 파일 락(.lock 디렉토리 생성/삭제)을 거치므로, 삭제 도중 새 항목이
    // 생겨 ENOTEMPTY가 날 수 있다 — maxRetries로 흡수.
    await fs.rm(storagePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('constructs and disposes cleanly', () => {
    const r = new TurnRecorder(wid, sid, 'claude', '/tmp');
    r.onUserInput('hel');
    r.onUserInput('lo');
    r.dispose();
    assert.ok(true);
  });

  it('preserves partial ANSI sequence across chunk boundaries (no crash)', () => {
    const r = new TurnRecorder(wid, sid, 'claude', '/tmp');
    r.onUserInput('abc\x1b');
    r.onUserInput('[A');
    r.onUserInput('def');
    r.dispose();
    assert.ok(true);
  });

  it('clears idleTimer on dispose (no hanging timers)', () => {
    const r = new TurnRecorder(wid, sid, 'claude', '/tmp');
    r.onUserInput('hello\r');
    r.onAssistantData('reply');
    r.dispose();
    assert.ok(true);
  });
});
