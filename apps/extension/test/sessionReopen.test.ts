// 세션을 다시 열 때(목록에서 열기·창 리로드 복원)의 cwd·parentSessionId·모델·effort (0.8.0 §5).
import { strict as assert } from 'assert';
import { existsSync, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readAllTurns, resolveTreePath } from '@agentbridge/core';
import { buildReopenOptions } from '../src/extension';
import { getWorkspaceStore } from '../src/core/coreInstances';
import { getSessions } from '../src/core/sessionRegistry';
import { registerCapture, unregisterCapture } from '../src/core/turnRecorder';
import * as workspaceStore from '../src/core/workspaceStore';
import { initCoreForTest } from './helpers';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => Promise<boolean>, timeout = 4000, step = 20): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await delay(step);
  }
  throw new Error('until() timed out');
}

describe('세션 다시 열기 · 복원 (0.8.0 §5)', () => {
  let storagePath: string;
  let home: string;
  let repoDir: string;
  let wid: string;

  beforeEach(async () => {
    storagePath = await fs.mkdtemp(join(tmpdir(), 'ab-reopen-'));
    home = await fs.mkdtemp(join(tmpdir(), 'ab-reopen-home-'));
    repoDir = await fs.mkdtemp(join(tmpdir(), 'ab-reopen-repo-'));
    initCoreForTest(storagePath, home);
    wid = workspaceStore.getOrCreateWorkspaceId(repoDir);
  });

  afterEach(async () => {
    for (const d of [storagePath, home, repoDir]) {
      await fs.rm(d, { recursive: true, force: true });
    }
  });

  it('격리 서브의 worktree가 남아 있으면 cwd가 worktree이고 parentSessionId·모델·effort를 넘긴다', async () => {
    const store = getWorkspaceStore();
    const parentSid = '11111111-1111-4111-8111-111111111111';
    const subSid = '22222222-2222-4222-8222-222222222222';
    const wsDir = workspaceStore.getWorkspacePath(wid);
    const treePath = resolveTreePath(wsDir, 'golden-gate');
    await fs.mkdir(treePath, { recursive: true });

    await store.addSession(wid, 'claude', 'cli', parentSid);
    await store.addSession(wid, 'claude', 'cli', subSid, {
      parentSessionId: parentSid,
      agentName: 'golden-gate',
      subModel: 'opus',
      subEffort: 'high',
    });
    await store.updateSessionMeta(wid, subSid, { title: 'golden-gate-claude' });

    const sessions = await getSessions(wid);
    const sub = sessions.find((s) => s.sessionId === subSid)!;
    const opts = await buildReopenOptions({
      model: sub.model,
      workspaceId: sub.workspaceId,
      sessionId: sub.sessionId,
      defaultCwd: repoDir,
      meta: sub,
    });

    assert.equal(opts.cwd, treePath);
    assert.equal(opts.parentSessionId, parentSid);
    assert.equal(opts.terminalName, 'golden-gate-claude');
    assert.equal(opts.args.includes('--'), false, '이어 열기에서는 첫 프롬프트를 넘기지 않는다');
    const modelIdx = opts.args.indexOf('--model');
    assert.notEqual(modelIdx, -1);
    assert.deepEqual(opts.args.slice(modelIdx, modelIdx + 4), ['--model', 'opus', '--effort', 'high']);

    // chatPanel.ts:579의 subagent 판정(`!!opts.parentSessionId`)에 따라 턴 기록이 서브 폴더로 간다.
    const transcript = join(storagePath, 'sub-transcript.jsonl');
    await fs.writeFile(
      transcript,
      [
        JSON.stringify({
          type: 'user',
          promptSource: 'typed',
          uuid: 'u1',
          timestamp: '2026-11-18T00:00:00.000Z',
          message: { role: 'user', content: '다시 연 뒤 턴' },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-11-18T00:00:01.000Z',
          message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '응답' }] },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    registerCapture({
      workspaceId: opts.workspaceId!,
      sessionId: opts.sessionId!,
      model: opts.model!,
      workspacePath: opts.cwd,
      signalFilePath: opts.turnSignalFilePath!,
      subagent: !!opts.parentSessionId,
    });
    try {
      await fs.writeFile(
        opts.turnSignalFilePath!,
        JSON.stringify({
          agent: 'claude',
          event: 'Stop',
          sessionId: subSid,
          transcriptPath: transcript,
          complete: true,
          at: Date.now(),
        }),
        'utf8',
      );
      const subDir = workspaceStore.getSessionDir(wid, subSid);
      await until(async () => (await readAllTurns(subDir)).length > 0);
      const subTurns = await readAllTurns(subDir);
      assert.equal(subTurns.length, 1);
      assert.equal(subTurns[0].user, '다시 연 뒤 턴');
      assert.equal(existsSync(join(wsDir, 'turns.jsonl')), false, '워크스페이스 직하에 기록이 새면 안 된다');
    } finally {
      await unregisterCapture(subSid);
    }
  });

  it('worktree가 없으면 cwd가 기본 폴더로 떨어지고 parentSessionId와 모델·effort는 유지된다', async () => {
    const store = getWorkspaceStore();
    const parentSid = '11111111-1111-4111-8111-111111111111';
    const subSid = '33333333-3333-4333-8333-333333333333';

    await store.addSession(wid, 'codex', 'cli', parentSid);
    await store.addSession(wid, 'codex', 'cli', subSid, {
      parentSessionId: parentSid,
      agentName: 'millau-viaduct',
      subModel: 'gpt-6-luna',
      subEffort: 'xhigh',
    });
    await store.updateSessionMeta(wid, subSid, {
      modelSessionId: 'thread-42',
      title: 'millau-codex',
    });

    // 창 리로드 복원 흐름 — 레지스트리(getSessions)에서 메타를 읽어 넘긴다.
    const meta = (await getSessions(wid)).find((s) => s.sessionId === subSid)!;
    const opts = await buildReopenOptions({
      model: 'codex',
      workspaceId: wid,
      sessionId: subSid,
      defaultCwd: repoDir,
      modelSessionId: meta.modelSessionId,
      meta,
    });

    assert.equal(opts.cwd, repoDir);
    assert.equal(opts.parentSessionId, parentSid);
    assert.equal(opts.terminalName, 'millau-codex');
    const mIdx = opts.args.indexOf('-m');
    assert.notEqual(mIdx, -1);
    assert.deepEqual(opts.args.slice(mIdx), [
      '-m', 'gpt-6-luna',
      '-c', 'model_reasoning_effort="xhigh"',
      'resume', 'thread-42',
    ]);
  });

  it('agy 격리 서브를 다시 열 때 --add-dir도 worktree를 가리키고 --model이 붙는다', async () => {
    const store = getWorkspaceStore();
    const parentSid = '11111111-1111-4111-8111-111111111111';
    const subSid = '44444444-4444-4444-8444-444444444444';
    const treePath = resolveTreePath(workspaceStore.getWorkspacePath(wid), 'ponte-vecchio');
    await fs.mkdir(treePath, { recursive: true });

    await store.addSession(wid, 'agy', 'cli', parentSid);
    await store.addSession(wid, 'agy', 'cli', subSid, {
      parentSessionId: parentSid,
      agentName: 'ponte-vecchio',
      subModel: 'gemini-4-hydrogen',
      subEffort: 'low',
    });

    const meta = (await getSessions(wid)).find((s) => s.sessionId === subSid)!;
    const opts = await buildReopenOptions({
      model: 'agy',
      workspaceId: wid,
      sessionId: subSid,
      defaultCwd: repoDir,
      meta,
    });

    assert.equal(opts.cwd, treePath);
    assert.equal(opts.parentSessionId, parentSid);
    assert.deepEqual(opts.args.slice(0, 4), ['--add-dir', treePath, '--model', 'gemini-4-hydrogen-low']);
    assert.equal(opts.args.includes('-i'), false);
  });

  it('칸이 없는 기존 세션은 지금과 같이 연다', async () => {
    const store = getWorkspaceStore();
    const legacySid = '55555555-5555-4555-8555-555555555555';
    await store.addSession(wid, 'claude', 'cli', legacySid);

    const meta = (await getSessions(wid)).find((s) => s.sessionId === legacySid)!;
    const opts = await buildReopenOptions({
      model: meta.model,
      workspaceId: meta.workspaceId,
      sessionId: meta.sessionId,
      defaultCwd: repoDir,
      meta,
    });

    assert.equal(opts.cwd, repoDir);
    assert.equal(opts.parentSessionId, undefined);
    assert.equal(opts.args.includes('--model'), false);
    assert.equal(opts.args.includes('--effort'), false);
  });
});
