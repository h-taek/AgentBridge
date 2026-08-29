// 0.5.0 A-1 — 세션 id 미확정(pending) 구간과 소급 귀속.
// 훅이 캡처 파일을 쓰기 전에 탭이 닫히면 감시자는 죽지만 파일은 남는다. 다음에 열 때 회수한다.
import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveHookCaptureFile } from '@agentbridge/core';
import * as workspaceStore from '../src/core/workspaceStore';
import {
  getSessions,
  registerSession,
  reclaimPendingModelSessionId,
} from '../src/core/sessionRegistry';
import { initCoreForTest } from './helpers';

describe('미확정 세션 id 소급 귀속', () => {
  let storagePath: string;
  let wid: string;

  beforeEach(async () => {
    storagePath = await fs.mkdtemp(join(tmpdir(), 'agentbridge-pending-'));
    initCoreForTest(storagePath);
    wid = workspaceStore.getOrCreateWorkspaceId('/tmp/agentbridge-pending-project');
  });

  afterEach(async () => {
    await fs.rm(storagePath, { recursive: true, force: true });
  });

  async function writeCapture(sessionId: string, modelSessionId: string): Promise<void> {
    const file = resolveHookCaptureFile(workspaceStore.getWorkspacePath(wid), sessionId);
    await fs.writeFile(file, JSON.stringify({ agent: 'codex', modelSessionId }), 'utf8');
  }

  it('탭이 캡처 전에 닫혀도 세션은 목록에 남는다', async () => {
    const s = await registerSession(wid, '11111111-1111-4111-8111-111111111111', 'codex');
    assert.equal(s.modelSessionId, undefined, 'id 미확정이 정상 상태다');
    const sessions = await getSessions(wid);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sessionId, s.sessionId);
  });

  it('남아 있는 캡처 파일을 읽어 그 세션에 귀속시킨다', async () => {
    const s = await registerSession(wid, '22222222-2222-4222-8222-222222222222', 'codex');
    await writeCapture(s.sessionId, '019e-codex-thread');

    assert.equal(await reclaimPendingModelSessionId(s), '019e-codex-thread');
    // 회수 결과는 저장소에 남아 다음 열기부터는 파일을 안 봐도 된다.
    const after = (await getSessions(wid))[0];
    assert.equal(after.modelSessionId, '019e-codex-thread');
  });

  it('이미 확정된 세션은 캡처 파일을 보지 않는다', async () => {
    const s = await registerSession(wid, '33333333-3333-4333-8333-333333333333', 'codex');
    await writeCapture(s.sessionId, '나중에-쓰인-값');
    assert.equal(await reclaimPendingModelSessionId({ ...s, modelSessionId: '먼저-확정된-값' }), '먼저-확정된-값');
  });

  it('claude는 회수 대상이 아니다 — id를 우리가 발급한다', async () => {
    const s = await registerSession(wid, '44444444-4444-4444-8444-444444444444', 'claude');
    await writeCapture(s.sessionId, 'should-be-ignored');
    assert.equal(await reclaimPendingModelSessionId(s), undefined);
  });

  it('캡처 파일이 없으면 미확정 그대로 둔다', async () => {
    const s = await registerSession(wid, '55555555-5555-4555-8555-555555555555', 'agy');
    assert.equal(await reclaimPendingModelSessionId(s), undefined);
  });
});
