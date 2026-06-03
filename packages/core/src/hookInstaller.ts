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

// ─── hook helper 단일 설치 (V-12) ─────────────────────────────────────────
//
// 두 앱이 각자 번들 내부 경로로 hook을 설치하면, 같은 프로젝트의 hooks.json을 서로
// 다른 경로로 덮어쓰는 쟁탈전이 생긴다. helper를 ~/.agentbridge/bin/에 한 부만 설치하고
// 양쪽 hook 명령이 그 canonical 경로를 가리키게 해 쟁탈전을 없앤다.

const HELPER_VERSION_RE = /@agentbridge-helper-version (\d+\.\d+\.\d+)/;

export function getCanonicalHelperPath(storageRoot: string): string {
  return join(storageRoot, 'bin', 'agentbridge-memory.js');
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

// 번들 helper를 canonical 위치에 설치. 설치본이 더 새것이면 건드리지 않는다.
// 반환값: canonical 경로 (hook command에 사용).
export async function installHelperToCanonicalPath(
  bundledHelperPath: string,
  storageRoot: string,
  logger: Logger = noopLogger,
): Promise<string> {
  const canonical = getCanonicalHelperPath(storageRoot);
  const bundled = await fsp.readFile(bundledHelperPath, 'utf8');
  const bundledVer = HELPER_VERSION_RE.exec(bundled)?.[1] ?? '0.0.0';

  let installedVer: string | null = null;
  try {
    const installed = await fsp.readFile(canonical, 'utf8');
    installedVer = HELPER_VERSION_RE.exec(installed)?.[1] ?? '0.0.0';
  } catch {
    // 미설치
  }

  if (installedVer === null || compareSemver(bundledVer, installedVer) > 0) {
    const tmp = `${canonical}.${process.pid}.${Date.now()}.tmp`;
    await fsp.mkdir(dirname(canonical), { recursive: true });
    await fsp.writeFile(tmp, bundled, 'utf8');
    await fsp.rename(tmp, canonical);
    logger.log(`hookInstaller: helper ${bundledVer} → ${canonical} (이전: ${installedVer ?? '미설치'})`);
  }
  return canonical;
}
