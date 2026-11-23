// 사용자 실행 인자(agentbridge.launchArgs.<kind>)에서 AgentBridge가 정하는 인자를 거른다 (0.10.0 spec/01 §4).

import type { CliKind } from '../shared/cli';

type ValueKind = 'value' | 'optional' | 'none';

const DENYLIST: Record<CliKind, Readonly<Record<string, ValueKind>>> = {
  claude: {
    '--session-id': 'value',
    '--model': 'value',
    '--effort': 'value',
    '-r': 'optional',
    '--resume': 'optional',
    '--from-pr': 'optional',
    '--teleport': 'optional',
    '--cloud': 'optional',
    '--remote': 'optional',
    '-w': 'optional',
    '--worktree': 'optional',
    '-c': 'none',
    '--continue': 'none',
    '--fork-session': 'none',
    '--no-session-persistence': 'none',
    '-p': 'none',
    '--print': 'none',
    '--desktop': 'none',
    '--bg': 'none',
    '--background': 'none',
  },
  codex: {
    '-m': 'value',
    '--model': 'value',
    '--local-provider': 'value',
    '-C': 'value',
    '--cd': 'value',
    '--remote': 'value',
    '--oss': 'none',
    '--worktree': 'none',
  },
  agy: {
    '--conversation': 'value',
    '-p': 'value',
    '--print': 'value',
    '--prompt': 'value',
    '-i': 'value',
    '--prompt-interactive': 'value',
    '--model': 'value',
    '--effort': 'value',
    '-c': 'none',
    '--continue': 'none',
    '--remote-agent': 'none',
  },
};

const CODEX_DENIED_CONFIG_KEYS = new Set([
  'model',
  'model_reasoning_effort',
  'model_provider',
  'sandbox_workspace_write.writable_roots',
]);

function extractConfigKey(rawValue: string): string {
  const eq = rawValue.indexOf('=');
  return (eq === -1 ? rawValue : rawValue.slice(0, eq)).trim();
}

/**
 * 사용자 실행 인자에서 AgentBridge가 정하는 옵션·설정 키·위치 인자를 빼고 나눈다.
 * `kept`는 기동 인자 맨 앞에 붙이고, `dropped`는 원래 순서대로 알림·로그에 쓴다.
 */
export function filterLaunchArgs(
  kind: CliKind,
  args: readonly string[],
): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  const deny = DENYLIST[kind];
  let prevKeptOptWithoutEq = false;

  for (let i = 0; i < args.length; ) {
    const a = args[i]!;

    if (a === '--') {
      dropped.push(...args.slice(i));
      break;
    }

    if (a.startsWith('-')) {
      if (kind === 'codex') {
        if (a === '-c' || a === '--config') {
          if (i + 1 < args.length) {
            const val = args[i + 1]!;
            const target = CODEX_DENIED_CONFIG_KEYS.has(extractConfigKey(val)) ? dropped : kept;
            target.push(a, val);
            i += 2;
          } else {
            kept.push(a);
            i += 1;
          }
          prevKeptOptWithoutEq = false;
          continue;
        }
        if ((a.startsWith('-c') && a.length > 2) || a.startsWith('--config=')) {
          const val = a.startsWith('--config=') ? a.slice('--config='.length) : a.slice(2);
          const target = CODEX_DENIED_CONFIG_KEYS.has(extractConfigKey(val)) ? dropped : kept;
          target.push(a);
          i += 1;
          prevKeptOptWithoutEq = false;
          continue;
        }
      }

      const eqIdx = a.indexOf('=');
      const name = eqIdx === -1 ? a : a.slice(0, eqIdx);
      const hasEq = eqIdx !== -1;
      const rule = Object.prototype.hasOwnProperty.call(deny, name) ? deny[name] : undefined;

      if (rule !== undefined) {
        dropped.push(a);
        if (!hasEq && i + 1 < args.length) {
          if (rule === 'value' || (rule === 'optional' && !args[i + 1]!.startsWith('-'))) {
            dropped.push(args[i + 1]!);
            i += 2;
            prevKeptOptWithoutEq = false;
            continue;
          }
        }
        i += 1;
        prevKeptOptWithoutEq = false;
        continue;
      }

      kept.push(a);
      prevKeptOptWithoutEq = !hasEq;
      i += 1;
      continue;
    }

    if (prevKeptOptWithoutEq) {
      kept.push(a);
    } else {
      dropped.push(a);
    }
    prevKeptOptWithoutEq = false;
    i += 1;
  }

  return { kept, dropped };
}
