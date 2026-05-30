// Integration-level smoke: exercises the full buildSpawnOptions chain end-to-end and
// asserts that hook files are on disk by the time the function resolves.
// Catches `await` chain regressions where a hook install would race against pty.spawn.

import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as workspaceStore from '../src/core/workspaceStore';
import * as claudeAdapter from '../src/core/cliAdapter/claudeAdapter';
import * as codexAdapter from '../src/core/cliAdapter/codexAdapter';
import * as agyAdapter from '../src/core/cliAdapter/agyAdapter';

const wid = '44444444-4444-4444-4444-444444444444';

describe('adapter integration (M16 await chain regression guard)', () => {
  let storagePath: string;
  let workspaceCwd: string;

  beforeEach(async () => {
    storagePath = await fs.mkdtemp(join(tmpdir(), 'agentbridge-int-'));
    workspaceCwd = await fs.mkdtemp(join(tmpdir(), 'agentbridge-int-ws-'));
    workspaceStore.init(storagePath);
    await fs.mkdir(join(storagePath, 'workspaces', wid, 'settings'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(storagePath, { recursive: true, force: true });
    await fs.rm(workspaceCwd, { recursive: true, force: true });
  });

  it('claudeAdapter.buildSpawnOptions writes settings.json BEFORE returning', async () => {
    const opts = await claudeAdapter.buildSpawnOptions(workspaceCwd, wid);
    // After the await, settings must exist on disk — otherwise pty.spawn would race.
    const settingsFile = join(storagePath, 'workspaces', wid, 'settings', 'claude-settings.json');
    assert.ok(existsSync(settingsFile), `expected ${settingsFile} to exist after buildSpawnOptions`);
    const json = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
    assert.ok(json.hooks?.SessionStart);
    assert.ok(json.hooks?.UserPromptSubmit);
    // SpawnOptions shape
    assert.equal(opts.model, 'claude');
    assert.equal(opts.workspaceId, wid);
    assert.ok(opts.args.includes('--settings'));
    assert.ok(opts.args.includes(settingsFile));
  });

  it('codexAdapter.buildSpawnOptions writes .codex/hooks.json + config.toml BEFORE returning', async () => {
    const opts = await codexAdapter.buildSpawnOptions(workspaceCwd, wid);
    const hooksPath = join(workspaceCwd, '.codex', 'hooks.json');
    const tomlPath = join(workspaceCwd, '.codex', 'config.toml');
    assert.ok(existsSync(hooksPath), `expected ${hooksPath}`);
    assert.ok(existsSync(tomlPath), `expected ${tomlPath}`);

    const hooks = JSON.parse(await fs.readFile(hooksPath, 'utf8'));
    assert.ok(hooks.hooks?.SessionStart);
    assert.ok(hooks.hooks?.UserPromptSubmit);

    const toml = await fs.readFile(tomlPath, 'utf8');
    assert.match(toml, /# AgentBridge BEGIN[\s\S]*\[features\][\s\S]*hooks = true[\s\S]*# AgentBridge END/);

    assert.equal(opts.model, 'codex');
  });

  it('agyAdapter.buildSpawnOptions writes .agents/hooks.json BEFORE returning', async () => {
    const opts = await agyAdapter.buildSpawnOptions(workspaceCwd, wid);
    const hooksPath = join(workspaceCwd, '.agents', 'hooks.json');
    assert.ok(existsSync(hooksPath));
    const hooks = JSON.parse(await fs.readFile(hooksPath, 'utf8'));
    assert.ok(hooks['agentbridge-memory']);
    assert.equal(hooks['agentbridge-memory'].enabled, true);
    assert.ok(Array.isArray(hooks['agentbridge-memory'].PreInvocation));
    assert.equal(opts.model, 'agy');
  });

  it('preserves existing user content in .codex/config.toml', async () => {
    await fs.mkdir(join(workspaceCwd, '.codex'), { recursive: true });
    await fs.writeFile(
      join(workspaceCwd, '.codex', 'config.toml'),
      '# user content\n[user]\nmy_key = "preserved"\n',
      'utf8',
    );

    await codexAdapter.buildSpawnOptions(workspaceCwd, wid);
    const toml = await fs.readFile(join(workspaceCwd, '.codex', 'config.toml'), 'utf8');
    assert.match(toml, /my_key = "preserved"/);
    assert.match(toml, /# AgentBridge BEGIN/);
  });

  it('claude hook command includes properly shell-quoted helper path (J1 + M16 cross-check)', async () => {
    await claudeAdapter.buildSpawnOptions(workspaceCwd, wid);
    const settingsFile = join(storagePath, 'workspaces', wid, 'settings', 'claude-settings.json');
    const json = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
    const cmd: string = json.hooks.SessionStart[0].hooks[0].command;
    // Command should be parseable by /bin/sh -c
    assert.match(cmd, /^node /);
    assert.match(cmd, /agentbridge-memory\.js/);
    assert.match(cmd, /--workspace /);
    assert.match(cmd, /--agent claude/);
    assert.match(cmd, /--event SessionStart/);
    // No unescaped single-quote breakage — the quote helper should produce balanced quoting.
    const singleQuotes = (cmd.match(/'/g) ?? []).length;
    assert.equal(singleQuotes % 2, 0, `unbalanced single quotes in: ${cmd}`);
  });
});
