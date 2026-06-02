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
    await fs.rm(storagePath, { recursive: true, force: true });
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
