// 사용자 login shell의 환경변수를 캡처하고, CLI 바이너리 위치를 probe한다.
// child PTY는 같은 env를 받되 keep-out 키는 제거.
//
// keep-out 키:
//   - OPENAI_API_KEY: Codex의 ChatGPT 구독을 silently 무시 → child에 노출 X
//   - GEMINI_SYSTEM_MD: Gemini system prompt를 full replacement로 덮어쓰는 차단

import { execSync, execFileSync } from 'child_process';
import { existsSync } from 'fs';
import type { CliKind } from './shared/cli';
import type { Logger } from './interfaces';
import { noopLogger } from './interfaces';

// 사용자의 기본 로그인 셸. zsh 외(bash/fish 등) 사용자도 CLI를 찾을 수 있게 $SHELL을 따른다
// (미설정 시 zsh 폴백). 플래그는 -i -l -c 분리 전달 — zsh/bash/fish 모두 호환 (V-22).
const LOGIN_SHELL = process.env.SHELL || 'zsh';

export interface ProbeResult {
  found: boolean;
  path?: string;
  resolvedPath?: string;
  version?: string;
  versionError?: string;
}

const ADAPTER_ENV_KEEP_OUT: ReadonlyArray<string> = ['OPENAI_API_KEY', 'GEMINI_SYSTEM_MD'];

export type EnvProbeOptions = {
  logger?: Logger;
  // true이면 probe()가 `<bin> --version`까지 호출해 version 필드를 채움. UI 표시용.
  probeVersion?: boolean;
};

export interface EnvProbe {
  probe(binaryName: CliKind): ProbeResult;
  getShellEnv(): Record<string, string>;
}

export function createEnvProbe(opts: EnvProbeOptions = {}): EnvProbe {
  const log = opts.logger ?? noopLogger;
  let shellEnvCache: Record<string, string> | null = null;

  function getLoginShellEnv(): Record<string, string> {
    if (shellEnvCache) return shellEnvCache;
    try {
      const raw = execFileSync(LOGIN_SHELL, ['-i', '-l', '-c', 'env'], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const env: Record<string, string> = {};
      for (const line of raw.split('\n')) {
        const idx = line.indexOf('=');
        if (idx > 0) {
          env[line.slice(0, idx)] = line.slice(idx + 1);
        }
      }
      shellEnvCache = env;
      return env;
    } catch {
      log.warn('envProbe: failed to capture login shell env, falling back to process.env');
      const fallback: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === 'string') fallback[k] = v;
      }
      shellEnvCache = fallback;
      return fallback;
    }
  }

  function captureVersion(binaryPath: string): { version?: string; versionError?: string } {
    try {
      const out = execSync(`${binaryPath} --version 2>&1`, {
        encoding: 'utf8',
        timeout: 5000,
        env: getLoginShellEnv(),
      });
      const firstLine = out.split('\n')[0]?.trim();
      if (firstLine && firstLine.length > 0) return { version: firstLine };
      return { versionError: 'empty --version output' };
    } catch (err) {
      return { versionError: err instanceof Error ? err.message : String(err) };
    }
  }

  return {
    // binaryName is a CliKind literal — `which ${binaryName}` arg is safe by type constraint.
    probe(binaryName: CliKind): ProbeResult {
      const env = getLoginShellEnv();
      try {
        const resolved = execFileSync(LOGIN_SHELL, ['-i', '-l', '-c', `which ${binaryName}`], {
          encoding: 'utf8',
          timeout: 5000,
          env,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (resolved && existsSync(resolved)) {
          log.log(`envProbe: ${binaryName} found at ${resolved}`);
          const base: ProbeResult = { found: true, path: binaryName, resolvedPath: resolved };
          if (opts.probeVersion) {
            const ver = captureVersion(resolved);
            return { ...base, ...ver };
          }
          return base;
        }
      } catch {
        /* which failed */
      }
      log.warn(`envProbe: ${binaryName} not found in PATH`);
      return { found: false };
    },

    getShellEnv(): Record<string, string> {
      const base = getLoginShellEnv();
      const filtered: Record<string, string> = {};
      for (const [k, v] of Object.entries(base)) {
        if (ADAPTER_ENV_KEEP_OUT.includes(k)) continue;
        filtered[k] = v;
      }
      filtered.TERM = 'xterm-256color';
      filtered.COLORTERM = 'truecolor';
      return filtered;
    },
  };
}
