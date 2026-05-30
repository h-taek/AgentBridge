import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as workspaceStore from '../src/core/workspaceStore';
import { installClaudeHooks, installCodexHooks, installAgyHooks } from '../src/core/hookInstaller';

const wid = '33333333-3333-3333-3333-333333333333';

describe('hookInstaller', () => {
  let storagePath: string;
  let workspaceCwd: string;

  beforeEach(async () => {
    storagePath = await fs.mkdtemp(join(tmpdir(), 'agentbridge-test-'));
    workspaceCwd = await fs.mkdtemp(join(tmpdir(), 'agentbridge-ws-'));
    workspaceStore.init(storagePath);
    await fs.mkdir(join(storagePath, 'workspaces', wid, 'settings'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(storagePath, { recursive: true, force: true });
    await fs.rm(workspaceCwd, { recursive: true, force: true });
  });

  it('installClaudeHooks writes a settings json with SessionStart + UserPromptSubmit', async () => {
    const settingsFile = await installClaudeHooks(wid);
    const json = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
    assert.ok(json.hooks);
    assert.ok(Array.isArray(json.hooks.SessionStart));
    assert.ok(Array.isArray(json.hooks.UserPromptSubmit));
  });

  it('installCodexHooks merges a marker block into config.toml while preserving user content', async () => {
    const codexDir = join(workspaceCwd, '.codex');
    await fs.mkdir(codexDir, { recursive: true });
    await fs.writeFile(
      join(codexDir, 'config.toml'),
      '# user comment\n[user_section]\nmy_setting = "preserved"\n',
      'utf8',
    );

    const { configTomlPath } = await installCodexHooks(workspaceCwd, wid);
    const content = await fs.readFile(configTomlPath, 'utf8');
    assert.match(content, /# AgentBridge BEGIN/);
    assert.match(content, /# AgentBridge END/);
    assert.match(content, /\[features\]/);
    assert.match(content, /hooks = true/);
    // User content preserved.
    assert.match(content, /my_setting = "preserved"/);
  });

  it('installCodexHooks backs up a corrupt hooks.json before overwriting', async () => {
    const codexDir = join(workspaceCwd, '.codex');
    await fs.mkdir(codexDir, { recursive: true });
    await fs.writeFile(join(codexDir, 'hooks.json'), '{not valid', 'utf8');

    await installCodexHooks(workspaceCwd, wid);
    const entries = await fs.readdir(codexDir);
    const backup = entries.find(e => e.startsWith('hooks.json.broken.'));
    assert.ok(backup, `expected .broken.<ts>.bak, got: ${entries.join(', ')}`);
  });

  it('installAgyHooks writes a hooks.json with PreInvocation entry', async () => {
    const { hooksJsonPath } = await installAgyHooks(workspaceCwd, wid);
    const json = JSON.parse(await fs.readFile(hooksJsonPath, 'utf8'));
    assert.ok(json['agentbridge-memory']);
    assert.equal(json['agentbridge-memory'].enabled, true);
    assert.ok(Array.isArray(json['agentbridge-memory'].PreInvocation));
  });
});
