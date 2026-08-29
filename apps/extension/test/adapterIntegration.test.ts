// Integration-level smoke: exercises the full buildSpawnOptions chain end-to-end and
// asserts that hook files are on disk by the time the function resolves.
// Catches `await` chain regressions where a hook install would race against pty.spawn.

import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as claudeAdapter from '../src/core/cliAdapter/claudeAdapter';
import * as codexAdapter from '../src/core/cliAdapter/codexAdapter';
import * as agyAdapter from '../src/core/cliAdapter/agyAdapter';
import { initCoreForTest } from './helpers';

const wid = '44444444-4444-4444-4444-444444444444';

describe('adapter integration (M16 await chain regression guard)', () => {
  let storagePath: string;
  let home: string;
  let workspaceCwd: string;

  beforeEach(async () => {
    storagePath = await fs.mkdtemp(join(tmpdir(), 'agentbridge-int-'));
    home = await fs.mkdtemp(join(tmpdir(), 'agentbridge-int-home-'));
    workspaceCwd = await fs.mkdtemp(join(tmpdir(), 'agentbridge-int-ws-'));
    initCoreForTest(storagePath, home);
  });

  afterEach(async () => {
    for (const d of [storagePath, home, workspaceCwd]) {
      await fs.rm(d, { recursive: true, force: true });
    }
  });

  it('claudeAdapter.buildSpawnOptions writes global hooks BEFORE returning', async () => {
    const opts = await claudeAdapter.buildSpawnOptions(workspaceCwd, wid);
    // After the await, hooks must exist on disk — otherwise pty.spawn would race.
    const settingsFile = join(home, '.claude', 'settings.json');
    assert.ok(existsSync(settingsFile), `expected ${settingsFile} to exist after buildSpawnOptions`);
    const json = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
    assert.ok(json.hooks?.UserPromptSubmit);
    assert.equal(json.hooks?.SessionStart, undefined);
    // SpawnOptions shape
    assert.equal(opts.model, 'claude');
    assert.equal(opts.workspaceId, wid);
    // 우리 폴더는 작업 폴더 밖이라 읽기 권한을 세션 인자로 연다. --settings는 폐기됐다.
    assert.equal(opts.args.includes('--settings'), false);
    assert.ok(opts.args.includes('--add-dir'));
    assert.ok(opts.args.includes(join(storagePath, 'workspaces', wid)));
    // 첨부는 워크스페이스 폴더 밖(저장소 루트)에 있으므로 그 자리도 함께 열어야 읽힌다.
    assert.ok(
      opts.args.includes(join(storagePath, 'attachments')),
      `첨부 폴더가 안 열렸다: ${opts.args.join(' ')}`,
    );
  });

  it('codexAdapter.buildSpawnOptions writes global codex hooks BEFORE returning', async () => {
    const opts = await codexAdapter.buildSpawnOptions(workspaceCwd, wid);
    const hooksPath = join(home, '.codex', 'hooks.json');
    const tomlPath = join(home, '.codex', 'config.toml');
    assert.ok(existsSync(hooksPath), `expected ${hooksPath}`);
    assert.ok(existsSync(tomlPath), `expected ${tomlPath}`);

    const hooks = JSON.parse(await fs.readFile(hooksPath, 'utf8'));
    assert.ok(hooks.hooks?.UserPromptSubmit);
    assert.equal(hooks.hooks?.SessionStart, undefined);

    const toml = await fs.readFile(tomlPath, 'utf8');
    assert.match(toml, /# AgentBridge BEGIN[\s\S]*\[features\][\s\S]*hooks = true[\s\S]*# AgentBridge END/);

    assert.equal(opts.model, 'codex');
  });

  it('agyAdapter.buildSpawnOptions writes global agy hooks BEFORE returning', async () => {
    const opts = await agyAdapter.buildSpawnOptions(workspaceCwd, wid);
    const hooksPath = join(home, '.gemini', 'config', 'hooks.json');
    assert.ok(existsSync(hooksPath));
    const hooks = JSON.parse(await fs.readFile(hooksPath, 'utf8'));
    assert.ok(hooks['agentbridge-memory']);
    assert.equal(hooks['agentbridge-memory'].enabled, true);
    assert.ok(Array.isArray(hooks['agentbridge-memory'].PreInvocation));
    assert.equal(opts.model, 'agy');
  });

  it('preserves existing user content in the global config.toml', async () => {
    await fs.mkdir(join(home, '.codex'), { recursive: true });
    await fs.writeFile(
      join(home, '.codex', 'config.toml'),
      '# user content\n[user]\nmy_key = "preserved"\n',
      'utf8',
    );

    await codexAdapter.buildSpawnOptions(workspaceCwd, wid);
    const toml = await fs.readFile(join(home, '.codex', 'config.toml'), 'utf8');
    assert.match(toml, /my_key = "preserved"/);
    assert.match(toml, /# AgentBridge BEGIN/);
  });

  it('세 하니스 어느 것도 프로젝트 폴더에 파일을 남기지 않는다', async () => {
    await claudeAdapter.buildSpawnOptions(workspaceCwd, wid);
    await codexAdapter.buildSpawnOptions(workspaceCwd, wid);
    await agyAdapter.buildSpawnOptions(workspaceCwd, wid);
    assert.deepEqual(await fs.readdir(workspaceCwd), []);
  });

  it('claude hook command includes properly shell-quoted helper path (J1 + M16 cross-check)', async () => {
    await claudeAdapter.buildSpawnOptions(workspaceCwd, wid);
    const json = JSON.parse(await fs.readFile(join(home, '.claude', 'settings.json'), 'utf8'));
    const cmd: string = json.hooks.UserPromptSubmit[0].hooks[0].command;
    // Command should be parseable by /bin/sh -c
    assert.match(cmd, /^if \[ -x /);
    assert.match(cmd, /agentbridge-memory\.js/);
    assert.equal(cmd.includes('--workspace '), false);
    assert.match(cmd, /--agent claude/);
    assert.match(cmd, /--event UserPromptSubmit/);
    // No unescaped single-quote breakage — the quote helper should produce balanced quoting.
    const singleQuotes = (cmd.match(/'/g) ?? []).length;
    assert.equal(singleQuotes % 2, 0, `unbalanced single quotes in: ${cmd}`);
  });
});
