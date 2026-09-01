import { strict as assert } from 'assert';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createCliAdapters,
  parseWritableRoots,
  buildWritableRootsArgs,
  renderRunPrefix,
  renderSkillMarkdown,
} from '@agentbridge/core';

// 승인과 샌드박스 기동 인자 (0.5.0 3단계 W5, B-5).
// 호출마다 승인 창이 뜨면 맥락을 모델의 자발적 호출에 건 것이 성립하지 않는다. 여는 폭은
// 하니스마다 다르고, 여는 것은 우리 명령 하나와 우리 저장소 한 폴더뿐이다.
describe('기동 인자 — 승인과 샌드박스 (0.5.0 W5)', () => {
  const execPath = '/Applications/Some IDE.app/Contents/MacOS/Electron';
  const cliPath = '/Users/x/agentbridge/bin/agentbridge.js';
  const storageRoot = '/Users/x/agentbridge';
  let home: string;

  const envProbe = {
    probe: () => ({ available: true, resolvedPath: undefined }),
    getShellEnv: () => ({}),
  } as never;

  beforeEach(async () => {
    home = await fsp.mkdtemp(join(tmpdir(), 'ab-perm-'));
  });

  afterEach(async () => {
    if (home) await fsp.rm(home, { recursive: true, force: true });
  });

  function adapters() {
    return createCliAdapters({
      envProbe,
      workspaceDir: (id) => join(storageRoot, 'workspaces', id),
      storageRoot,
      cliRunPrefix: renderRunPrefix({ execPath, cliPath }),
      homeDir: home,
    });
  }

  it('claude — 우리 명령 하나만 연다', async () => {
    const opts = await adapters().claude.buildSpawnOptions('/tmp/proj', 'ws-1');
    const i = opts.args.indexOf('--allowedTools');
    assert.notEqual(i, -1, '--allowedTools가 붙어야 한다');
    // 공백이 든 런타임 경로만 감싼다 — 감쌀 필요가 없는 것을 감싸면 모델이 치는 문자열과 어긋난다.
    assert.equal(opts.args[i + 1], `Bash('${execPath}' ${cliPath} *)`);
    // 승인 전체를 여는 인자는 붙이지 않는다.
    assert.ok(!opts.args.some((a) => a.includes('bypassPermissions') || a.includes('dangerously')));
  });

  it('claude — 허용 규칙이 스킬이 가르치는 문자열과 같은 값이다', async () => {
    const opts = await adapters().claude.buildSpawnOptions('/tmp/proj', 'ws-1');
    const rule = opts.args[opts.args.indexOf('--allowedTools') + 1]!;
    const prefix = rule.slice('Bash('.length, -' *)'.length);
    assert.ok(renderSkillMarkdown({ execPath, cliPath }).includes(prefix));
  });

  it('codex — 저장소 폴더 하나를 쓰기 허용으로 더하고 샌드박스 모드는 안 건드린다', async () => {
    const opts = await adapters().codex.buildSpawnOptions('/tmp/proj', 'ws-1');
    const i = opts.args.indexOf('-c');
    assert.notEqual(i, -1);
    assert.equal(opts.args[i + 1], `sandbox_workspace_write.writable_roots=["${storageRoot}"]`);
    assert.ok(!opts.args.includes('-s'), '샌드박스 모드는 건드리지 않는다');
    assert.ok(!opts.args.some((a) => a.includes('dangerously')));
  });

  it('codex — 사용자가 이미 설정한 쓰기 허용 폴더를 지우지 않는다', async () => {
    await fsp.mkdir(join(home, '.codex'), { recursive: true });
    await fsp.writeFile(
      join(home, '.codex', 'config.toml'),
      '[sandbox_workspace_write]\nwritable_roots = ["/Users/x/scratch"]\n',
    );
    const opts = await adapters().codex.buildSpawnOptions('/tmp/proj', 'ws-1');
    assert.equal(
      opts.args[opts.args.indexOf('-c') + 1],
      `sandbox_workspace_write.writable_roots=["/Users/x/scratch","${storageRoot}"]`,
    );
  });

  it('codex — resume에도 같은 인자가 앞에 붙는다', async () => {
    const opts = await adapters().codex.buildSpawnOptions('/tmp/proj', 'ws-1', 'sid', 'thread-1');
    assert.equal(opts.args[0], '-c');
    assert.deepEqual(opts.args.slice(2), ['resume', 'thread-1']);
  });

  it('agy — 기동 인자를 건드리지 않는다', async () => {
    const opts = await adapters().agy.buildSpawnOptions('/tmp/proj', 'ws-1');
    assert.ok(!opts.args.includes('--allowedTools'));
    assert.ok(!opts.args.includes('-c'));
    assert.ok(!opts.args.some((a) => a.includes('sandbox')));
  });

  it('설정을 못 읽으면 우리 폴더만 연다', () => {
    assert.deepEqual(parseWritableRoots('model = "o3"\n'), []);
    assert.deepEqual(buildWritableRootsArgs(storageRoot, []), [
      '-c',
      `sandbox_workspace_write.writable_roots=["${storageRoot}"]`,
    ]);
  });

  it('프로필 아래 쓰기 허용 폴더는 합치지 않는다', () => {
    const toml = '[profiles.work.sandbox_workspace_write]\nwritable_roots = ["/secret"]\n';
    assert.deepEqual(parseWritableRoots(toml), []);
  });

  it('같은 폴더를 두 번 넣지 않는다', () => {
    assert.deepEqual(buildWritableRootsArgs(storageRoot, [storageRoot]), [
      '-c',
      `sandbox_workspace_write.writable_roots=["${storageRoot}"]`,
    ]);
  });
});
