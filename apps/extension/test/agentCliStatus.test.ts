import { strict as assert } from 'assert';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readStatus,
  uninstallGlobal,
  inspectGlobalHooks,
  removeGlobalHooks,
  createSkillInstaller,
  skillFilePath,
} from '@agentbridge/core';

// status와 uninstall (0.5.0 3단계 W7, B-5).
// 조회와 제거가 같은 지식을 쓴다. 남의 설정 키는 보존해야 한다 — 대상 여섯 중 절반이
// 남의 파일 안의 키 하나다.
describe('status·uninstall — 전역 설치 조회와 제거 (0.5.0 W7)', () => {
  let tmp: string;
  let home: string;
  let storageRoot: string;
  let wsDir: string;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(join(tmpdir(), 'ab-status-'));
    home = join(tmp, 'home');
    storageRoot = join(tmp, 'storage');
    wsDir = join(storageRoot, 'workspaces', 'ws-1');
    await fsp.mkdir(wsDir, { recursive: true });
  });

  afterEach(async () => {
    if (tmp) await fsp.rm(tmp, { recursive: true, force: true });
  });

  // 사용자 항목이 섞인 전역 설정 — 우리 것만 골라내는지 보려면 남의 것이 있어야 한다.
  async function seedHooks(): Promise<void> {
    await fsp.mkdir(join(home, '.claude'), { recursive: true });
    await fsp.writeFile(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({
        model: 'opus',
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: 'echo 사용자 훅' }] },
            { hooks: [{ type: 'command', command: "sh -c '/x/agentbridge-memory.js inject'" }] },
          ],
          Stop: [{ hooks: [{ type: 'command', command: '/x/agentbridge-memory.js inject' }] }],
        },
      }),
    );
    await fsp.mkdir(join(home, '.codex'), { recursive: true });
    await fsp.writeFile(
      join(home, '.codex', 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: 'echo 사용자 훅' }] },
            { hooks: [{ type: 'command', command: 'ours' }], _agentbridge_managed: true },
          ],
        },
      }),
    );
    await fsp.mkdir(join(home, '.gemini', 'config'), { recursive: true });
    await fsp.writeFile(
      join(home, '.gemini', 'config', 'hooks.json'),
      JSON.stringify({
        'user-group': { enabled: true },
        'agentbridge-memory': { enabled: true, _agentbridge_managed: true },
      }),
    );
  }

  async function seedSkills(): Promise<void> {
    const inst = createSkillInstaller({
      execPath: '/x/node',
      cliPath: join(storageRoot, 'bin', 'agentbridge.js'),
      homeDir: home,
    });
    for (const agent of ['claude', 'codex', 'agy'] as const) await inst.install(agent);
  }

  it('status — 미설치와 정상을 구분한다', async () => {
    const before = await readStatus(storageRoot, wsDir, { homeDir: home });
    assert.match(before, /안 깔림/);

    await seedHooks();
    await seedSkills();
    const after = await readStatus(storageRoot, wsDir, { homeDir: home });
    assert.doesNotMatch(after, /안 깔림/);
    assert.match(after, /깔림 \d+\.\d+\.\d+/); // 스킬 버전 — 값이 아니라 읽히는지를 본다
  });

  it('status — 설치된 CLI가 없으면 없다고 말한다', async () => {
    const out = await readStatus(storageRoot, wsDir, { homeDir: home });
    assert.match(out, /agentbridge\.js {2}없음/);
  });

  it('status — 호스트가 안 답하면 그 사실을 말하고 시한 안에 끝난다', async () => {
    const sessionDir = join(wsDir, 'sessions', 'sid-1');
    await fsp.mkdir(sessionDir, { recursive: true });
    const started = Date.now();
    const out = await readStatus(storageRoot, wsDir, { homeDir: home, sessionDir, timeoutMs: 150 });
    assert.match(out, /응답 없음/);
    assert.ok(Date.now() - started < 5000, '시한 안에 끝나야 한다');
  });

  it('uninstall — 우리 것만 걷어내고 남의 키는 보존한다', async () => {
    await seedHooks();
    await seedSkills();

    const out = await uninstallGlobal(home);
    assert.match(out, /걷어냈다/);

    const claude = JSON.parse(await fsp.readFile(join(home, '.claude', 'settings.json'), 'utf8'));
    assert.equal(claude.model, 'opus', '남의 설정 키는 그대로');
    assert.equal(claude.hooks.UserPromptSubmit.length, 1, '사용자 훅 하나만 남는다');
    assert.equal(claude.hooks.Stop, undefined, '우리 것뿐이던 이벤트는 사라진다');

    const codex = JSON.parse(await fsp.readFile(join(home, '.codex', 'hooks.json'), 'utf8'));
    assert.equal(codex.hooks.SessionStart.length, 1);

    const agy = JSON.parse(await fsp.readFile(join(home, '.gemini', 'config', 'hooks.json'), 'utf8'));
    assert.ok(agy['user-group'], '남의 그룹은 그대로');
    assert.equal(agy['agentbridge-memory'], undefined);

    for (const agent of ['claude', 'codex', 'agy'] as const) {
      await assert.rejects(fsp.access(skillFilePath(agent, home)));
    }
  });

  it('uninstall — 두 번 불러도 같은 결과다', async () => {
    await seedHooks();
    await seedSkills();
    await uninstallGlobal(home);
    const second = await uninstallGlobal(home);
    assert.match(second, /걷어낼 것이 없다/);
  });

  it('uninstall — 저장소는 건드리지 않는다', async () => {
    await seedSkills();
    await fsp.writeFile(join(wsDir, 'turns.jsonl'), '{}\n');
    await uninstallGlobal(home);
    await fsp.access(join(wsDir, 'turns.jsonl'));
  });

  it('조회와 제거가 같은 지식을 쓴다', async () => {
    await seedHooks();
    assert.deepEqual(
      (await inspectGlobalHooks(home)).map((h) => h.installed),
      [true, true, true],
    );
    await removeGlobalHooks(home);
    assert.deepEqual(
      (await inspectGlobalHooks(home)).map((h) => h.installed),
      [false, false, false],
    );
  });
});
