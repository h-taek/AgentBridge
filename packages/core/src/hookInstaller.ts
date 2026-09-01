// CLI hook 설정을 사용자 전역 설정에 심는다 (0.5.0 A-3).
//
//   claude  ~/.claude/settings.json 의 hooks 키
//   codex   ~/.codex/hooks.json + ~/.codex/config.toml 의 [features] hooks
//   agy     ~/.gemini/config/hooks.json
//
// 프로젝트 폴더에는 아무것도 쓰지 않는다. 사용자 저장소에 우리 파일을 남기지 않기 위해서이고,
// 프로젝트 레이어가 가장 약한 자리(신뢰·worktree·실행 모드에 따라 안 뜬다)라는 점도 같이 피한다.
// 구버전이 프로젝트와 전역에 남긴 우리 항목은 cleanupLegacyHooks가 걷어낸다.
//
// 커맨드에는 저장소 구조가 들어가지 않는다. 신원은 spawn 때 심는 AGENTBRIDGE_WS_DIR이 나른다.
// 그래서 프로젝트가 몇 개든 커맨드 문자열이 동일하고, 하니스당 한 벌이면 전부 덮는다.
//
// 모두 atomic write + 사용자 콘텐츠 보존. 내용이 같으면 아예 쓰지 않는다 — codex는 훅 커맨드가
// 바뀌면 신뢰를 다시 묻고, 불필요한 재작성은 그 관문을 괜히 건드린다.

import { promises as fsp } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import type { CliKind } from './shared/cli';
import { quoteArg } from './shellQuote';
import { findBlockedGlobalCliConfigDir } from './cliGlobalDirs';
import type { Logger } from './interfaces';
import { noopLogger } from './interfaces';

function assertWorkspaceCwd(cwd: string, label: string, homeDir?: string): void {
  // 홈 자체 + CLI 글로벌 설정 디렉토리(~/.codex 등) 하위면 거부.
  const blocked = findBlockedGlobalCliConfigDir(cwd, homeDir);
  if (blocked) {
    throw new Error(
      `${label}: refusing to touch ${blocked} — CLI global config directory. Open a project folder first.`,
    );
  }
}

type HookEventName =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreInvocation'
  | 'PostInvocation'
  | 'Stop'
  | 'StopFailure';

const TOML_MARKER_START = '# AgentBridge BEGIN';
const TOML_MARKER_END = '# AgentBridge END';
// 데스크탑 구버전이 남긴 marker — 다음 write 때 흡수·삭제. codex TOML duplicate key 거부 회피.
// 우리 항목의 표식. 심는 쪽과 걷어내는 쪽(uninstall)이 같은 지식을 쓴다 — 갈리면 둘 중
// 하나가 먼저 틀린다.
//
// claude settings.json의 hooks에는 이름 그룹이 없어서 커맨드 문자열로 가린다.
const CLAUDE_MARKER = 'agentbridge-memory.js';
// codex hooks.json 항목과 agy 그룹은 우리가 심은 표시를 직접 단다.
const MANAGED_FLAG = '_agentbridge_managed';
const AGY_GROUP = 'agentbridge-memory';

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
  // 설치된 agentbridge-memory.js 절대 경로 — 호스트가 책임지고 전달.
  helperPath: string;
  // 훅을 실행할 런타임 절대 경로. 설치 시점의 process.execPath다 — 사용자 PATH의 node에
  // 기대지 않는다(세 하니스 다 네이티브 바이너리라 node 없이 설치된다).
  execPath: string;
  // 전역 설정을 둘 홈 디렉토리. 테스트만 오버라이드한다.
  homeDir?: string;
  logger?: Logger;
};

export interface HookInstaller {
  installClaudeHooks(): Promise<string>;
  installCodexHooks(): Promise<{ hooksJsonPath: string; configTomlPath: string }>;
  installAgyHooks(): Promise<{ hooksJsonPath: string }>;
  // 구버전이 프로젝트 폴더와 전역에 남긴 우리 항목을 걷어낸다. 사용자 콘텐츠는 보존한다.
  cleanupLegacyHooks(cwd: string): Promise<string[]>;
}

export function createHookInstaller(opts: HookInstallerOptions): HookInstaller {
  const log = opts.logger ?? noopLogger;

  const home = opts.homeDir ?? homedir();

  // 실행 파일과 헬퍼가 없으면 조용히 아무것도 안 한다. 매 턴 에러를 띄우는 것보다 낫다 —
  // 구버전 커맨드가 `node`로 시작해 node 없는 사용자에게 매 턴 exit 127을 내던 것이 그 반례다.
  function buildHookCommand(agent: CliKind, event: HookEventName): string {
    const exec = quoteArg(opts.execPath);
    const helper = quoteArg(opts.helperPath);
    const run = [
      'ELECTRON_RUN_AS_NODE=1',
      exec,
      helper,
      'inject',
      '--agent',
      quoteArg(agent),
      '--event',
      quoteArg(event),
    ].join(' ');
    return `if [ -x ${exec} ] && [ -f ${helper} ]; then ${run}; fi`;
  }

  // 내용이 같으면 안 쓴다. 훅 커맨드가 바뀌면 codex가 신뢰를 다시 묻기 때문에,
  // 재작성 자체를 줄이는 것이 그 관문을 지키는 방법이다.
  async function writeIfChanged(filePath: string, content: string): Promise<boolean> {
    if ((await readFileSafe(filePath)) === content) return false;
    await atomicWrite(filePath, content);
    return true;
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
  // claude 훅은 사용자 전역 settings.json의 hooks 키에 들어간다. 남의 파일이므로 우리 항목만
  // 갈아끼우고 나머지는 그대로 둔다.
  function mergeClaudeHooks(
    existing: Record<string, unknown>,
    ours: Record<string, ClaudeHookMatcher>,
  ): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...existing };
    const hooks = isObject(existing.hooks) ? { ...(existing.hooks as Record<string, unknown>) } : {};

    const eventNames = new Set([...Object.keys(hooks), ...Object.keys(ours)]);
    for (const event of eventNames) {
      const prev = Array.isArray(hooks[event]) ? (hooks[event] as ClaudeHookMatcher[]) : [];
      // 우리 것으로 보이는 항목은 전부 걷어낸다 — 폐기한 이벤트에 남은 것까지 같이 사라진다.
      const others = prev.filter(
        (m) => !(m?.hooks ?? []).some((h) => typeof h?.command === 'string' && h.command.includes(CLAUDE_MARKER)),
      );
      const mine = ours[event];
      const next = mine ? [...others, mine] : others;
      if (next.length > 0) hooks[event] = next;
      else delete hooks[event];
    }

    merged.hooks = hooks;
    return merged;
  }

  async function installClaudeHooks(): Promise<string> {
    const settingsDir = join(home, '.claude');
    await fsp.mkdir(settingsDir, { recursive: true });
    const settingsFile = join(settingsDir, 'settings.json');

    const raw = await readFileSafe(settingsFile);
    let existing: Record<string, unknown> = {};
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (isObject(parsed)) existing = parsed;
      } catch {
        const backup = `${settingsFile}.broken.${Date.now()}.bak`;
        try {
          await fsp.writeFile(backup, raw, 'utf8');
          log.warn(`claude settings.json parse failed — backed up to ${backup}`);
        } catch {
          /* noop */
        }
      }
    }

    // SessionStart는 등록하지 않는다 — 세션 첫 턴에서 UserPromptSubmit와 같은 IR을 이중 주입하기 때문.
    // Stop·StopFailure는 턴 기록의 트리거다 (0.5.0 A-2). StopFailure를 빠뜨리면 API·모델 오류로
    // 끊긴 턴에 Stop이 오지 않아 그 턴이 통째로 유실된다 (research 04 §1).
    // SubagentStop은 등록하지 않는다 — 자식 종료는 부모 턴이 아니고, claude는 자식에 Stop을 쏘지 않는다.
    const merged = mergeClaudeHooks(existing, {
      UserPromptSubmit: {
        hooks: [{ type: 'command', command: buildHookCommand('claude', 'UserPromptSubmit') }],
      },
      Stop: {
        hooks: [{ type: 'command', command: buildHookCommand('claude', 'Stop') }],
      },
      StopFailure: {
        hooks: [{ type: 'command', command: buildHookCommand('claude', 'StopFailure') }],
      },
    });

    if (await writeIfChanged(settingsFile, JSON.stringify(merged, null, 2))) {
      log.log(`hookInstaller: wrote claude hooks ${settingsFile}`);
    }
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

    // 우리가 더 이상 관리하지 않는 이벤트에 남은 managed 항목을 청소한다 (예: 폐기된 SessionStart).
    // 안 하면 과거 버전이 심은 managed 훅이 hooks.json에 영영 남아 이중 주입이 계속된다.
    // 불변식: managed codex 훅 == 정확히 ourEntries.
    for (const eventName of Object.keys(hooksMap)) {
      if (eventName in ourEntries) continue;
      const arr = Array.isArray(hooksMap[eventName]) ? hooksMap[eventName] : [];
      const userOnly = arr.filter((e) => !(isObject(e) && e._agentbridge_managed === true));
      if (userOnly.length > 0) hooksMap[eventName] = userOnly;
      else delete hooksMap[eventName];
    }

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
    await writeIfChanged(filePath, newContent);
  }

  // 구버전이 프로젝트 config.toml에 남긴 우리 마커 블록을 걷어낸다(새 마커와 legacy 둘 다).
  async function removeTomlMarkerBlock(filePath: string): Promise<boolean> {
    const raw = await readFileSafe(filePath);
    if (raw === null) return false;
    const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`${esc(TOML_MARKER_START)}[\\s\\S]*?${esc(TOML_MARKER_END)}\\n?`, 'gm'),
      new RegExp(`${esc(LEGACY_TOML_MARKER_START)}[\\s\\S]*?${esc(LEGACY_TOML_MARKER_END)}\\n?`, 'gm'),
    ];
    let next = raw;
    for (const re of patterns) next = next.replace(re, '');
    if (next === raw) return false;
    next = next.replace(/\n{3,}/g, '\n\n');
    await atomicWrite(filePath, next);
    return true;
  }

  async function installCodexHooks(): Promise<{ hooksJsonPath: string; configTomlPath: string }> {
    const codexDir = join(home, '.codex');
    await fsp.mkdir(codexDir, { recursive: true });
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

    // SessionStart는 등록하지 않는다. 첫 턴 전에는 보존할 대화가 없어 그 구간의 세션 id가 하는 일이
    // 없고(research 06 §6-1), 폴더 스냅샷 폴백을 걷어낸 뒤로는 훅과 경주할 상대도 없다.
    // 세 하니스가 같은 모양이 된다 — codex·agy는 첫 턴 훅이 id를 확정한다.
    // mergeCodexHooks가 과거 버전이 심은 managed SessionStart 항목을 청소한다.
    const merged = mergeCodexHooks(existing, {
      UserPromptSubmit: {
        hooks: [{ type: 'command', command: buildHookCommand('codex', 'UserPromptSubmit') }],
      },
      // 턴 기록 트리거 (0.5.0 A-2). SubagentStop은 등록하지 않는다 — Stop 스키마에 agent_id가
      // 아예 없어 부모 턴만 온다 (research 04 §2).
      Stop: {
        hooks: [{ type: 'command', command: buildHookCommand('codex', 'Stop') }],
      },
    });

    if (await writeIfChanged(hooksJsonPath, JSON.stringify(merged, null, 2))) {
      log.log(`hookInstaller: wrote codex hooks ${hooksJsonPath}`);
    }
    await mergeTomlMarkerBlock(configTomlPath, ['[features]', 'hooks = true'].join('\n'));
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
    Stop?: AgyHookAction[];
    _agentbridge_managed?: true;
  }
  type AgyHooksRoot = Record<string, AgyHookGroup>;

  async function installAgyHooks(): Promise<{ hooksJsonPath: string }> {
    const configDir = join(home, '.gemini', 'config');
    await fsp.mkdir(configDir, { recursive: true });
    const hooksJsonPath = join(configDir, 'hooks.json');

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
    merged[AGY_GROUP] = {
      enabled: true,
      PreInvocation: [{ type: 'command', command: buildHookCommand('agy', 'PreInvocation') }],
      // 턴 기록 트리거 (0.5.0 A-2). agy에는 자식 전용 종료 이벤트가 없어 conversationId로 가른다.
      Stop: [{ type: 'command', command: buildHookCommand('agy', 'Stop') }],
      _agentbridge_managed: true,
    };

    if (await writeIfChanged(hooksJsonPath, JSON.stringify(merged, null, 2))) {
      log.log(`hookInstaller: wrote agy hooks ${hooksJsonPath}`);
    }
    return { hooksJsonPath };
  }

  // ─── 구버전 잔재 정리 ──────────────────────────────────────────────────
  //
  // 구버전은 우리 훅을 프로젝트 폴더(.codex/, .agents/)에 심었고, 전역 ~/.agents/hooks.json에
  // 남은 사례도 실물로 확인됐다. 그대로 두면 전역 훅과 함께 둘 다 로드돼 같은 맥락이 두 번
  // 주입되고 같은 턴이 두 번 기록된다. 우리 항목만 걷어내고 사용자 콘텐츠는 보존한다.

  async function removeOurJsonEntries(
    filePath: string,
    strip: (root: Record<string, unknown>) => boolean,
  ): Promise<boolean> {
    const raw = await readFileSafe(filePath);
    if (raw === null) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return false; // 못 읽는 파일은 건드리지 않는다.
    }
    if (!isObject(parsed)) return false;
    if (!strip(parsed)) return false;
    await atomicWrite(filePath, JSON.stringify(parsed, null, 2));
    return true;
  }

  // 의미 있는 내용이 하나도 없는 JSON이면 삭제. `{}`와 `{"hooks":{}}` 둘 다 대상이다.
  async function removeIfEmptyJson(filePath: string): Promise<void> {
    const raw = await readFileSafe(filePath);
    if (raw === null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // 못 읽는 파일은 건드리지 않는다
    }
    if (!isObject(parsed)) return;
    const keys = Object.keys(parsed);
    const empty =
      keys.length === 0 ||
      (keys.length === 1 && keys[0] === 'hooks' && isObject(parsed.hooks) && Object.keys(parsed.hooks).length === 0);
    if (empty) await fsp.rm(filePath, { force: true });
  }

  async function removeIfBlank(filePath: string): Promise<void> {
    const raw = await readFileSafe(filePath);
    if (raw !== null && raw.trim() === '') await fsp.rm(filePath, { force: true });
  }

  async function removeDirIfEmpty(dir: string): Promise<void> {
    try {
      if ((await fsp.readdir(dir)).length === 0) await fsp.rmdir(dir);
    } catch {
      /* 없거나 안 비었음 */
    }
  }

  async function cleanupLegacyHooks(cwd: string): Promise<string[]> {
    // cwd가 실은 하니스의 전역 설정 폴더인 경우를 막는다. 이제 이 가드가 남는 자리는
    // 설치가 아니라 정리다 — 전역 설치 경로는 우리가 직접 조립하므로 가드를 안 지나간다.
    assertWorkspaceCwd(cwd, 'cleanupLegacyHooks', home);
    const cleaned: string[] = [];

    // 프로젝트 codex — managed 항목만 제거
    const codexProject = join(cwd, '.codex', 'hooks.json');
    if (
      await removeOurJsonEntries(codexProject, (root) => {
        const hooks = isObject(root.hooks) ? (root.hooks as Record<string, unknown>) : null;
        if (!hooks) return false;
        let changed = false;
        for (const [event, list] of Object.entries(hooks)) {
          if (!Array.isArray(list)) continue;
          const kept = (list as CodexHookEntry[]).filter((e) => e?._agentbridge_managed !== true);
          if (kept.length !== list.length) {
            changed = true;
            if (kept.length > 0) hooks[event] = kept;
            else delete hooks[event];
          }
        }
        return changed;
      })
    ) {
      cleaned.push(codexProject);
    }

    // 프로젝트 agy + 전역 agy — 이름 그룹 제거
    for (const p of [join(cwd, '.agents', 'hooks.json'), join(home, '.agents', 'hooks.json')]) {
      if (
        await removeOurJsonEntries(p, (root) => {
          if (!(AGY_GROUP in root)) return false;
          delete root[AGY_GROUP];
          return true;
        })
      ) {
        cleaned.push(p);
      }
    }

    // 프로젝트 codex config.toml — 마커 블록 제거
    const codexToml = join(cwd, '.codex', 'config.toml');
    if (await removeTomlMarkerBlock(codexToml)) cleaned.push(codexToml);

    // 우리 항목을 뺀 뒤 아무것도 안 남은 껍데기는 지운다. 남겨 두면 "프로젝트 폴더에 우리 파일 0"이
    // 아니게 된다 — 라이브 검증에서 `{}`·`{"hooks":{}}`·빈 config.toml이 그대로 남는 것을 확인했다.
    // 내용이 있으면 손대지 않는다(남의 것일 수 있다).
    for (const f of [codexProject, join(cwd, '.agents', 'hooks.json')]) {
      await removeIfEmptyJson(f);
    }
    await removeIfBlank(codexToml);
    for (const d of [join(cwd, '.codex'), join(cwd, '.agents')]) {
      await removeDirIfEmpty(d);
    }

    if (cleaned.length > 0) log.log(`hookInstaller: cleaned legacy hooks — ${cleaned.join(', ')}`);
    return cleaned;
  }

  return {
    installClaudeHooks,
    installCodexHooks,
    installAgyHooks,
    cleanupLegacyHooks,
  };
}

// ─── 실행 파일 단일 설치 (V-12) ───────────────────────────────────────────
//
// 두 앱이 각자 번들 내부 경로로 hook을 설치하면, 같은 프로젝트의 hooks.json을 서로
// 다른 경로로 덮어쓰는 쟁탈전이 생긴다. 실행 파일을 <저장소 루트>/bin/에 한 부만 설치하고
// 양쪽 hook 명령이 그 canonical 경로를 가리키게 해 쟁탈전을 없앤다.

// 설치 대상은 둘이다(0.5.0 B-5). 훅 헬퍼는 커맨드가 동결이라 버전이 거의 안 오르고,
// 에이전트용 CLI는 사이클마다 자란다. 그래서 파일도 버전 마커도 따로 둔다.
export type CanonicalBin = 'helper' | 'cli';

const CANONICAL_BINS: Record<CanonicalBin, { filename: string; versionRe: RegExp }> = {
  helper: {
    filename: 'agentbridge-memory.js',
    versionRe: /@agentbridge-helper-version (\d+\.\d+\.\d+)/,
  },
  cli: {
    filename: 'agentbridge.js',
    versionRe: /@agentbridge-cli-version (\d+\.\d+\.\d+)/,
  },
};

export function getCanonicalBinPath(storageRoot: string, bin: CanonicalBin): string {
  return join(storageRoot, 'bin', CANONICAL_BINS[bin].filename);
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

// 번들 실행 파일을 canonical 위치에 설치. 설치본이 더 새것이면 건드리지 않는다.
// 반환값: canonical 경로 (hook command와 스킬 본문에 사용).
export async function installBinToCanonicalPath(
  bundledPath: string,
  storageRoot: string,
  bin: CanonicalBin,
  logger: Logger = noopLogger,
): Promise<string> {
  const versionRe = CANONICAL_BINS[bin].versionRe;
  const canonical = getCanonicalBinPath(storageRoot, bin);
  const bundled = await fsp.readFile(bundledPath, 'utf8');
  const bundledVer = versionRe.exec(bundled)?.[1] ?? '0.0.0';

  let installedVer: string | null = null;
  let installedSame = false;
  try {
    const installed = await fsp.readFile(canonical, 'utf8');
    installedVer = versionRe.exec(installed)?.[1] ?? '0.0.0';
    installedSame = installed === bundled;
  } catch {
    // 미설치
  }

  // 버전이 같은데 내용이 다르면 갱신한다. 마커를 올리는 것을 잊으면 헬퍼 수정이 조용히
  // 안 깔리고, 그 상태는 훅이 옛 동작을 하는 것으로만 드러나 찾기 어렵다. 같은 버전의
  // 정식 빌드끼리는 내용이 같으므로 이 분기가 실제로 도는 것은 개발 중뿐이다.
  const staleSameVersion =
    installedVer !== null && compareSemver(bundledVer, installedVer) === 0 && !installedSame;

  if (installedVer === null || compareSemver(bundledVer, installedVer) > 0 || staleSameVersion) {
    const tmp = `${canonical}.${process.pid}.${Date.now()}.tmp`;
    await fsp.mkdir(dirname(canonical), { recursive: true });
    await fsp.writeFile(tmp, bundled, 'utf8');
    await fsp.rename(tmp, canonical);
    logger.log(`hookInstaller: ${bin} ${bundledVer} → ${canonical} (이전: ${installedVer ?? '미설치'})`);
  }
  return canonical;
}

// ─── 전역 훅 조회와 제거 (0.5.0 3단계 W7, B-5) ───────────────────────────
//
// 익스텐션을 지워도 전역에 깔린 것은 남는다. 제거 시점에 도는 코드가 없기 때문이다. 그래서
// 제거 명령을 만든다 — 대상이 여섯이고(훅 셋, 스킬 셋) 그중 절반은 남의 설정 파일 안의 키
// 하나라, 사용자가 손으로 찾아 지울 수 있는 자리가 아니다.
//
// 조회와 제거가 같은 지식을 쓴다. 어디에 무엇이 깔렸는지 아는 자리와 걷어내는 자리가 갈리면
// 둘 중 하나가 먼저 틀린다.
//
// 설치와 달리 execPath·helperPath가 필요 없다. 우리 항목을 알아보는 데 필요한 것은 표식뿐이라
// 팩토리 밖 함수로 둔다 — CLI가 설치 인자 없이 부를 수 있어야 한다.

export type GlobalHookPresence = {
  agent: CliKind;
  path: string;
  // 우리 항목이 실제로 있는지. 파일이 없거나 우리 것이 없으면 false.
  installed: boolean;
};

function isManaged(v: unknown): boolean {
  return isObject(v) && (v as Record<string, unknown>)[MANAGED_FLAG] === true;
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | null> {
  const raw = await readFileSafe(path);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function globalHookPaths(homeDir?: string): Record<CliKind, string> {
  const home = homeDir ?? homedir();
  return {
    claude: join(home, '.claude', 'settings.json'),
    codex: join(home, '.codex', 'hooks.json'),
    agy: join(home, '.gemini', 'config', 'hooks.json'),
  };
}

// 우리 항목만 걷어낸 사본을 만든다. 남의 키는 그대로 둔다. 바뀐 것이 없으면 null.
function stripOurHooks(agent: CliKind, root: Record<string, unknown>): Record<string, unknown> | null {
  const next = { ...root };
  let changed = false;

  if (agent === 'agy') {
    if (!isManaged(next[AGY_GROUP]) && !(AGY_GROUP in next)) return null;
    delete next[AGY_GROUP];
    return next;
  }

  // claude·codex 둘 다 hooks 아래 이벤트별 배열이다. 우리 것을 가리는 기준만 다르다.
  const hooks = isObject(next.hooks) ? { ...(next.hooks as Record<string, unknown>) } : null;
  if (!hooks) return null;
  for (const event of Object.keys(hooks)) {
    const arr = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    const kept = arr.filter((entry) => {
      if (agent === 'codex') return !isManaged(entry);
      const inner = isObject(entry) && Array.isArray(entry.hooks) ? (entry.hooks as unknown[]) : [];
      return !inner.some(
        (h) => isObject(h) && typeof h.command === 'string' && h.command.includes(CLAUDE_MARKER),
      );
    });
    if (kept.length === arr.length) continue;
    changed = true;
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (!changed) return null;
  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks;
  return next;
}

export async function inspectGlobalHooks(homeDir?: string): Promise<GlobalHookPresence[]> {
  const paths = globalHookPaths(homeDir);
  const out: GlobalHookPresence[] = [];
  for (const agent of ['claude', 'codex', 'agy'] as CliKind[]) {
    const path = paths[agent];
    const root = await readJsonObject(path);
    out.push({ agent, path, installed: !!root && stripOurHooks(agent, root) !== null });
  }
  return out;
}

// 전역 훅에서 우리 항목을 걷어낸다. 반환값은 실제로 바뀐 파일들.
export async function removeGlobalHooks(
  homeDir?: string,
  logger: Logger = noopLogger,
): Promise<string[]> {
  const paths = globalHookPaths(homeDir);
  const touched: string[] = [];
  for (const agent of ['claude', 'codex', 'agy'] as CliKind[]) {
    const path = paths[agent];
    const root = await readJsonObject(path);
    if (!root) continue;
    const next = stripOurHooks(agent, root);
    if (!next) continue;
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
    await fsp.rename(tmp, path);
    touched.push(path);
    logger.log(`hookInstaller: ${agent} 훅을 걷어냈다 — ${path}`);
  }
  return touched;
}
