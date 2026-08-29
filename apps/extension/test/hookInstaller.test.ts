// 0.5.0 A-3 — 훅은 사용자 전역 설정에 심고, 프로젝트 폴더에는 아무것도 남기지 않는다.
// 전역 자리를 건드리므로 홈 디렉토리를 임시 폴더로 주입해서 돌린다.
import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  installClaudeHooks,
  installCodexHooks,
  installAgyHooks,
  cleanupLegacyHooks,
} from '../src/core/hookInstaller';
import { initCoreForTest } from './helpers';

async function readJson(p: string): Promise<any> {
  return JSON.parse(await fs.readFile(p, 'utf8'));
}

describe('hookInstaller (전역 설치)', () => {
  let storagePath: string;
  let home: string;
  let workspaceCwd: string;

  beforeEach(async () => {
    storagePath = await fs.mkdtemp(join(tmpdir(), 'agentbridge-test-'));
    home = await fs.mkdtemp(join(tmpdir(), 'agentbridge-home-'));
    workspaceCwd = await fs.mkdtemp(join(tmpdir(), 'agentbridge-ws-'));
    initCoreForTest(storagePath, home);
  });

  afterEach(async () => {
    for (const d of [storagePath, home, workspaceCwd]) {
      await fs.rm(d, { recursive: true, force: true });
    }
  });

  it('claude 훅은 ~/.claude/settings.json의 hooks 키에 들어간다', async () => {
    const settingsFile = await installClaudeHooks();
    assert.equal(settingsFile, join(home, '.claude', 'settings.json'));
    const json = await readJson(settingsFile);
    assert.ok(Array.isArray(json.hooks.UserPromptSubmit));
    // SessionStart는 첫 턴 IR 이중 주입을 피하려고 등록하지 않는다.
    assert.equal(json.hooks.SessionStart, undefined);
  });

  it('claude settings.json의 사용자 설정과 남의 훅은 보존한다', async () => {
    const dir = join(home, '.claude');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({
        model: 'opus',
        hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'someone-else' }] }] },
      }),
      'utf8',
    );

    const json = await readJson(await installClaudeHooks());
    assert.equal(json.model, 'opus', '남의 설정 키가 사라지면 안 된다');
    const cmds = json.hooks.UserPromptSubmit.map((m: any) => m.hooks[0].command);
    assert.equal(cmds.filter((c: string) => c === 'someone-else').length, 1);
    assert.equal(cmds.filter((c: string) => c.includes('agentbridge-memory.js')).length, 1);
  });

  it('두 번 설치해도 우리 항목이 늘어나지 않는다', async () => {
    await installClaudeHooks();
    const json = await readJson(await installClaudeHooks());
    assert.equal(json.hooks.UserPromptSubmit.length, 1);
  });

  it('훅 커맨드에는 저장소 구조가 들어가지 않는다', async () => {
    const json = await readJson(await installClaudeHooks());
    const cmd: string = json.hooks.UserPromptSubmit[0].hooks[0].command;
    assert.equal(cmd.includes('--workspace'), false);
    assert.equal(cmd.includes('--user-data'), false);
    assert.equal(
      cmd.includes(join(storagePath, 'workspaces')),
      false,
      '워크스페이스 경로가 커맨드에 실리면 안 된다',
    );
    // 실행자는 node가 아니라 우리 런타임이다.
    assert.equal(/(^|;\s*)node\s/.test(cmd), false);
    assert.match(cmd, /ELECTRON_RUN_AS_NODE=1/);
    // 실행 파일·헬퍼가 없으면 조용한 무동작이 되도록 가드가 붙는다.
    assert.match(cmd, /^if \[ -x /);
  });

  it('codex 훅은 ~/.codex에 들어가고 config.toml 마커는 사용자 내용을 보존한다', async () => {
    const dir = join(home, '.codex');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      join(dir, 'config.toml'),
      '# user comment\n[user_section]\nmy_setting = "preserved"\n',
      'utf8',
    );

    const { hooksJsonPath, configTomlPath } = await installCodexHooks();
    assert.equal(hooksJsonPath, join(dir, 'hooks.json'));
    const json = await readJson(hooksJsonPath);
    assert.ok(Array.isArray(json.hooks.UserPromptSubmit));

    const toml = await fs.readFile(configTomlPath, 'utf8');
    assert.match(toml, /# AgentBridge BEGIN/);
    assert.match(toml, /hooks = true/);
    assert.match(toml, /my_setting = "preserved"/);
  });

  it('codex의 managed 고아 항목은 지우고 사용자 훅은 남긴다', async () => {
    const dir = join(home, '.codex');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      join(dir, 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: 'user-own-hook' }] },
            { hooks: [{ type: 'command', command: 'old-agentbridge' }], _agentbridge_managed: true },
          ],
        },
      }),
      'utf8',
    );

    const { hooksJsonPath } = await installCodexHooks();
    const json = await readJson(hooksJsonPath);
    assert.equal(json.hooks.SessionStart.length, 1);
    assert.equal(json.hooks.SessionStart[0].hooks[0].command, 'user-own-hook');
  });

  it('codex의 깨진 hooks.json은 백업하고 진행한다', async () => {
    const dir = join(home, '.codex');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'hooks.json'), '{not valid', 'utf8');

    await installCodexHooks();
    const entries = await fs.readdir(dir);
    assert.ok(
      entries.find((e) => e.startsWith('hooks.json.broken.')),
      `expected .broken.<ts>.bak, got: ${entries.join(', ')}`,
    );
  });

  it('agy 훅은 ~/.gemini/config/hooks.json에 이름 그룹으로 들어간다', async () => {
    const { hooksJsonPath } = await installAgyHooks();
    assert.equal(hooksJsonPath, join(home, '.gemini', 'config', 'hooks.json'));
    const json = await readJson(hooksJsonPath);
    assert.equal(json['agentbridge-memory'].enabled, true);
    assert.ok(Array.isArray(json['agentbridge-memory'].PreInvocation));
  });

  it('설치는 프로젝트 폴더에 아무것도 남기지 않는다', async () => {
    await installClaudeHooks();
    await installCodexHooks();
    await installAgyHooks();
    assert.deepEqual(await fs.readdir(workspaceCwd), []);
  });
});

describe('구버전 잔재 정리', () => {
  let storagePath: string;
  let home: string;
  let cwd: string;

  beforeEach(async () => {
    storagePath = await fs.mkdtemp(join(tmpdir(), 'agentbridge-test-'));
    home = await fs.mkdtemp(join(tmpdir(), 'agentbridge-home-'));
    cwd = await fs.mkdtemp(join(tmpdir(), 'agentbridge-ws-'));
    initCoreForTest(storagePath, home);
  });

  afterEach(async () => {
    for (const d of [storagePath, home, cwd]) await fs.rm(d, { recursive: true, force: true });
  });

  it('프로젝트와 전역에 남은 우리 항목만 걷어내고 남의 것은 보존한다', async () => {
    await fs.mkdir(join(cwd, '.codex'), { recursive: true });
    await fs.writeFile(
      join(cwd, '.codex', 'hooks.json'),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: 'mine' }], _agentbridge_managed: true },
            { hooks: [{ type: 'command', command: 'theirs' }] },
          ],
        },
      }),
      'utf8',
    );
    await fs.writeFile(
      join(cwd, '.codex', 'config.toml'),
      '[user]\nkeep = 1\n\n# AgentBridge BEGIN\n[features]\nhooks = true\n# AgentBridge END\n',
      'utf8',
    );
    await fs.mkdir(join(cwd, '.agents'), { recursive: true });
    await fs.writeFile(
      join(cwd, '.agents', 'hooks.json'),
      JSON.stringify({ 'agentbridge-memory': { enabled: true }, 'someone-else': { enabled: true } }),
      'utf8',
    );
    // 구버전이 전역에 남긴 것도 대상이다 (실물로 확인된 사례).
    await fs.mkdir(join(home, '.agents'), { recursive: true });
    await fs.writeFile(
      join(home, '.agents', 'hooks.json'),
      JSON.stringify({ 'agentbridge-memory': { enabled: true }, 'orca-status': { enabled: true } }),
      'utf8',
    );

    const cleaned = await cleanupLegacyHooks(cwd);
    assert.equal(cleaned.length, 4, `정리 대상 넷이어야 한다: ${cleaned.join(', ')}`);

    const projectCodex = await readJson(join(cwd, '.codex', 'hooks.json'));
    assert.equal(projectCodex.hooks.UserPromptSubmit.length, 1);
    assert.equal(projectCodex.hooks.UserPromptSubmit[0].hooks[0].command, 'theirs');

    const toml = await fs.readFile(join(cwd, '.codex', 'config.toml'), 'utf8');
    assert.equal(toml.includes('AgentBridge'), false);
    assert.match(toml, /keep = 1/);

    const projectAgy = await readJson(join(cwd, '.agents', 'hooks.json'));
    assert.equal(projectAgy['agentbridge-memory'], undefined);
    assert.ok(projectAgy['someone-else']);

    const globalAgy = await readJson(join(home, '.agents', 'hooks.json'));
    assert.equal(globalAgy['agentbridge-memory'], undefined);
    assert.ok(globalAgy['orca-status'], '남의 전역 훅은 그대로 둔다');
  });

  it('잔재가 없으면 아무것도 하지 않는다', async () => {
    assert.deepEqual(await cleanupLegacyHooks(cwd), []);
    assert.deepEqual(await fs.readdir(cwd), []);
  });

  it('전역 설정 폴더를 작업 폴더로 받으면 거절한다', async () => {
    await assert.rejects(() => cleanupLegacyHooks(join(home, '.codex')), /refusing/i);
  });
});
