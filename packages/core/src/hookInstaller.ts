// CLI hook 설정 파일을 작성한다 — claude의 settings.json, codex의 hooks.json/config.toml,
// agy의 hooks.json. 모두 atomic write + 사용자 콘텐츠 보존.
//
// 호스트 차이 흡수:
//   - helperPath: 번들된 agentbridge-memory.js 위치 — 호스트가 자기 번들 경로 전달
//   - globalStoragePath: hook command에 전달되는 --user-data 값
//   - workspaceClaudePath: claude settings.json이 들어갈 디렉토리(원본은 workspace storage 하위)

import { promises as fsp } from 'fs';
import { join, dirname } from 'path';
import type { CliKind } from './shared/cli';
import { quoteArg } from './shellQuote';
import { findBlockedGlobalCliConfigDir } from './cliGlobalDirs';
import type { Logger } from './interfaces';
import { noopLogger } from './interfaces';

function assertWorkspaceCwd(cwd: string, label: string): void {
  // 홈 자체 + CLI 글로벌 설정 디렉토리(~/.codex 등) 하위면 거부 — 글로벌 hook 덮어쓰기 방지.
  const blocked = findBlockedGlobalCliConfigDir(cwd);
  if (blocked) {
    throw new Error(
      `${label}: refusing to install hooks under ${blocked} — CLI global config directory. Open a project folder first.`,
    );
  }
}

type HookEventName =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreInvocation'
  | 'PostInvocation'
  | 'Stop';

const TOML_MARKER_START = '# AgentBridge BEGIN';
const TOML_MARKER_END = '# AgentBridge END';
// 데스크탑 구버전이 남긴 marker — 다음 write 때 흡수·삭제. codex TOML duplicate key 거부 회피.
const LEGACY_TOML_MARKER_START = '# AgentBridge:start';
const LEGACY_TOML_MARKER_END = '# AgentBridge:end';

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.mkdir(dirname(filePath), { recursive: true });
  await fsp.writeFile(tmp, content, 'utf8');
  await fsp.rename(tmp, filePath);
}

async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    return await fsp.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export type HookInstallerOptions = {
  // 번들된 agentbridge-memory.js 절대 경로 — 호스트가 책임지고 전달.
  helperPath: string;
  // hook command에 --user-data로 전달되는 값. 원본은 workspaceStore.getGlobalStoragePath().
  globalStoragePath: string;
  logger?: Logger;
};

export interface HookInstaller {
  installClaudeHooks(workspaceClaudeDir: string, workspaceId: string): Promise<string>;
  installCodexHooks(cwd: string, workspaceId: string): Promise<{ hooksJsonPath: string; configTomlPath: string }>;
  installAgyHooks(cwd: string, workspaceId: string): Promise<{ hooksJsonPath: string }>;
}

export function createHookInstaller(opts: HookInstallerOptions): HookInstaller {
  const log = opts.logger ?? noopLogger;

  function buildHookCommand(agent: CliKind, event: HookEventName, workspaceId: string): string {
    // agent/event는 코드가 정한 타입 리터럴이라 현재는 안전하나, quoteArg로 통일 (V-31 ④).
    return [
      'node',
      quoteArg(opts.helperPath),
      'inject',
      '--agent',
      quoteArg(agent),
      '--workspace',
      quoteArg(workspaceId),
      '--user-data',
      quoteArg(opts.globalStoragePath),
      '--event',
      quoteArg(event),
    ].join(' ');
  }

  // ─── claude ────────────────────────────────────────────────────────────

  interface ClaudeHookCommand {
    type: 'command';
    command: string;
  }
  interface ClaudeHookMatcher {
    matcher?: string;
    hooks: ClaudeHookCommand[];
  }
  interface ClaudeHookConfig {
    hooks?: {
      [eventName: string]: ClaudeHookMatcher[];
    };
  }

  async function installClaudeHooks(
    workspaceClaudeDir: string,
    workspaceId: string,
  ): Promise<string> {
    const settingsDir = join(workspaceClaudeDir, 'settings');
    await fsp.mkdir(settingsDir, { recursive: true });
    const settingsFile = join(settingsDir, 'claude-settings.json');

    const config: ClaudeHookConfig = {
      hooks: {
        SessionStart: [
          {
            matcher: '*',
            hooks: [
              { type: 'command', command: buildHookCommand('claude', 'SessionStart', workspaceId) },
            ],
          },
        ],
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: 'command',
                command: buildHookCommand('claude', 'UserPromptSubmit', workspaceId),
              },
            ],
          },
        ],
      },
    };

    await atomicWrite(settingsFile, JSON.stringify(config, null, 2));
    log.log(`hookInstaller: wrote claude settings ${settingsFile}`);
    return settingsFile;
  }

  // ─── codex ─────────────────────────────────────────────────────────────

  interface CodexHookEntry {
    matcher?: string;
    hooks: Array<{ type: 'command'; command: string }>;
    _agentbridge_managed?: true;
  }

  type CodexHooksRoot = {
    hooks?: Record<string, CodexHookEntry[]>;
  } & Record<string, unknown>;

  function mergeCodexHooks(
    existing: CodexHooksRoot,
    ourEntries: Record<string, CodexHookEntry>,
  ): CodexHooksRoot {
    const merged: CodexHooksRoot = { ...existing };
    const hooksMap = isObject(existing.hooks)
      ? { ...(existing.hooks as Record<string, CodexHookEntry[]>) }
      : ({} as Record<string, CodexHookEntry[]>);

    for (const [eventName, ourEntry] of Object.entries(ourEntries)) {
      const current = Array.isArray(hooksMap[eventName]) ? hooksMap[eventName] : [];
      const userEntries = current.filter((e) => !(isObject(e) && e._agentbridge_managed === true));
      hooksMap[eventName] = [...userEntries, { ...ourEntry, _agentbridge_managed: true }];
    }

    merged.hooks = hooksMap;
    return merged;
  }

  async function mergeTomlMarkerBlock(filePath: string, ourBlock: string): Promise<void> {
    const raw = (await readFileSafe(filePath)) ?? '';
    const wrapped = `${TOML_MARKER_START}\n${ourBlock}\n${TOML_MARKER_END}`;
    const escapedStart = TOML_MARKER_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedEnd = TOML_MARKER_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const blockPattern = new RegExp(`${escapedStart}[\\s\\S]*?${escapedEnd}`, 'm');
    // legacy `:start/:end` 블록 흡수 — duplicate key 거부 회피.
    const legacyStart = LEGACY_TOML_MARKER_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const legacyEnd = LEGACY_TOML_MARKER_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const legacyPattern = new RegExp(`${legacyStart}[\\s\\S]*?${legacyEnd}\\n?`, 'gm');
    const existing = raw.replace(legacyPattern, '');

    const outside = existing.replace(blockPattern, '');
    const sectionMatch = /^\[([^\]]+)\]/m.exec(ourBlock.trim());
    if (sectionMatch) {
      const header = sectionMatch[0];
      const escapedHeader = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const outsideHasSection = new RegExp(`^${escapedHeader}\\s*$`, 'm').test(outside);
      if (outsideHasSection) {
        if (blockPattern.test(existing)) {
          const cleaned = existing.replace(blockPattern, '').replace(/\n{3,}/g, '\n\n');
          await atomicWrite(filePath, cleaned.endsWith('\n') ? cleaned : cleaned + '\n');
          log.log(
            `hookInstaller: removed redundant marker block from ${filePath} (user already has ${header})`,
          );
        } else {
          log.log(
            `hookInstaller: skipping marker block — ${filePath} already has ${header}`,
          );
        }
        return;
      }
    }

    let newContent: string;
    if (blockPattern.test(existing)) {
      newContent = existing.replace(blockPattern, wrapped);
    } else if (existing.trim().length > 0) {
      newContent = existing + (existing.endsWith('\n') ? '\n' : '\n\n') + wrapped + '\n';
    } else {
      newContent = wrapped + '\n';
    }
    await atomicWrite(filePath, newContent);
  }

  async function installCodexHooks(
    cwd: string,
    workspaceId: string,
  ): Promise<{ hooksJsonPath: string; configTomlPath: string }> {
    assertWorkspaceCwd(cwd, 'installCodexHooks');
    const codexDir = join(cwd, '.codex');
    const hooksJsonPath = join(codexDir, 'hooks.json');
    const configTomlPath = join(codexDir, 'config.toml');

    const raw = await readFileSafe(hooksJsonPath);
    let existing: CodexHooksRoot = {};
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (isObject(parsed)) existing = parsed;
      } catch {
        const backup = `${hooksJsonPath}.broken.${Date.now()}.bak`;
        try {
          await fsp.writeFile(backup, raw, 'utf8');
          log.warn(`codex hooks.json parse failed — backed up to ${backup}`);
        } catch {
          /* noop */
        }
      }
    }

    const merged = mergeCodexHooks(existing, {
      SessionStart: {
        matcher: '^(start|startup|clear|resume)$',
        hooks: [{ type: 'command', command: buildHookCommand('codex', 'SessionStart', workspaceId) }],
      },
      UserPromptSubmit: {
        hooks: [
          { type: 'command', command: buildHookCommand('codex', 'UserPromptSubmit', workspaceId) },
        ],
      },
    });

    await atomicWrite(hooksJsonPath, JSON.stringify(merged, null, 2));
    await mergeTomlMarkerBlock(configTomlPath, ['[features]', 'hooks = true'].join('\n'));

    log.log(`hookInstaller: wrote codex hooks ${hooksJsonPath} + ${configTomlPath}`);
    return { hooksJsonPath, configTomlPath };
  }

  // ─── agy ──────────────────────────────────────────────────────────────

  interface AgyHookAction {
    type: 'command';
    command: string;
  }
  interface AgyHookGroup {
    enabled?: boolean;
    PreInvocation?: AgyHookAction[];
    _agentbridge_managed?: true;
  }
  type AgyHooksRoot = Record<string, AgyHookGroup>;

  async function installAgyHooks(
    cwd: string,
    workspaceId: string,
  ): Promise<{ hooksJsonPath: string }> {
    assertWorkspaceCwd(cwd, 'installAgyHooks');
    const agentsDir = join(cwd, '.agents');
    const hooksJsonPath = join(agentsDir, 'hooks.json');

    const raw = await readFileSafe(hooksJsonPath);
    let existing: AgyHooksRoot = {};
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (isObject(parsed)) existing = parsed as AgyHooksRoot;
      } catch {
        const backup = `${hooksJsonPath}.broken.${Date.now()}.bak`;
        try {
          await fsp.writeFile(backup, raw, 'utf8');
          log.warn(`agy hooks.json parse failed — backed up to ${backup}`);
        } catch {
          /* noop */
        }
      }
    }

    const merged: AgyHooksRoot = { ...existing };
    merged['agentbridge-memory'] = {
      enabled: true,
      PreInvocation: [
        { type: 'command', command: buildHookCommand('agy', 'PreInvocation', workspaceId) },
      ],
      _agentbridge_managed: true,
    };

    await atomicWrite(hooksJsonPath, JSON.stringify(merged, null, 2));
    log.log(`hookInstaller: wrote agy hooks ${hooksJsonPath}`);
    return { hooksJsonPath };
  }

  return {
    installClaudeHooks,
    installCodexHooks,
    installAgyHooks,
  };
}
