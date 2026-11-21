import { strict as assert } from 'assert';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createCliAdapters, type CliKind } from '@agentbridge/core';

describe('어댑터 사용자 실행 인자 (0.10.0 spec/01 §3·§4)', () => {
  const storageRoot = '/Users/x/agentbridge';
  let home: string;

  const envProbe = {
    probe: () => ({ available: true, resolvedPath: undefined }),
    getShellEnv: () => ({}),
  } as never;

  beforeEach(async () => {
    home = await fsp.mkdtemp(join(tmpdir(), 'ab-launch-'));
  });

  afterEach(async () => {
    if (home) await fsp.rm(home, { recursive: true, force: true });
  });

  function adapters(
    byKind: Partial<Record<CliKind, string[]>> = {},
    droppedCalls: Array<[CliKind, string[]]> = [],
  ) {
    return createCliAdapters({
      envProbe,
      workspaceDir: (id) => join(storageRoot, 'workspaces', id),
      storageRoot,
      homeDir: home,
      launchArgs: (kind) => byKind[kind] ?? [],
      onLaunchArgsDropped: (kind, dropped) => droppedCalls.push([kind, dropped]),
    });
  }

  it('claude 새 세션 — 사용자 인자가 맨 앞이다', async () => {
    const opts = await adapters({ claude: ['--remote-control'] }).claude.buildSpawnOptions(
      '/tmp/proj',
      'ws',
      undefined,
      { initialPrompt: 'hi' },
    );
    assert.equal(opts.args[0], '--remote-control');
    assert.equal(opts.args[1], '--session-id');
    assert.deepEqual(opts.args.slice(-2), ['--', 'hi']);
  });

  it('claude 이어 열기 — 사용자 인자가 맨 앞이다', async () => {
    const id = '11111111-1111-1111-1111-111111111111';
    const projDir = join(home, '.claude', 'projects', 'p');
    await fsp.mkdir(projDir, { recursive: true });
    await fsp.writeFile(join(projDir, `${id}.jsonl`), '', 'utf8');

    const opts = await adapters({ claude: ['--remote-control'] }).claude.buildSpawnOptions(
      '/tmp/proj',
      'ws',
      id,
    );
    assert.deepEqual(opts.args.slice(0, 3), ['--remote-control', '--resume', id]);
  });

  it('codex 이어 열기 — resume보다 앞이다', async () => {
    const opts = await adapters({ codex: ['--search'] }).codex.buildSpawnOptions(
      '/tmp/proj',
      'ws',
      'sid',
      'thread-1',
    );
    assert.equal(opts.args[0], '--search');
    assert.deepEqual(opts.args.slice(-2), ['resume', 'thread-1']);
  });

  it('agy 새 세션 — 사용자 인자가 맨 앞이다', async () => {
    const opts = await adapters({ agy: ['--remote-control'] }).agy.buildSpawnOptions(
      '/tmp/proj',
      'ws',
    );
    assert.equal(opts.args[0], '--remote-control');
    assert.ok(opts.args.includes('--dangerously-skip-permissions'));
  });

  it('금지 인자는 빼고 알린다', async () => {
    const droppedCalls: Array<[CliKind, string[]]> = [];
    const opts = await adapters(
      { claude: ['--model', 'opus', '--remote-control'] },
      droppedCalls,
    ).claude.buildSpawnOptions('/tmp/proj', 'ws');
    assert.ok(!opts.args.includes('--model'));
    assert.equal(opts.args[0], '--remote-control');
    assert.deepEqual(droppedCalls, [['claude', ['--model', 'opus']]]);
  });

  it('뺀 것이 없으면 알리지 않는다', async () => {
    const droppedCalls: Array<[CliKind, string[]]> = [];
    await adapters({ claude: ['--remote-control'] }, droppedCalls).claude.buildSpawnOptions(
      '/tmp/proj',
      'ws',
    );
    assert.equal(droppedCalls.length, 0);
  });

  it('launchArgs가 없으면 지금과 같다', async () => {
    const plain = createCliAdapters({
      envProbe,
      workspaceDir: (id) => join(storageRoot, 'workspaces', id),
      storageRoot,
      homeDir: home,
    });
    const opts = await plain.claude.buildSpawnOptions('/tmp/proj', 'ws');
    assert.equal(opts.args[0], '--session-id');
  });
});
