// CLI가 로컬에 둔 자격증명을 읽는다. 읽기만 한다 — 쓰지 않고, 지우지 않고, 갱신하지 않는다.
//
// OS를 건드리는 부분(Keychain, 파일, 환경변수, 홈 경로)은 CredentialIO로 빼서 주입한다.
// 그래야 판정 로직이 테스트에서 실제 키체인 없이 돈다.
//
// 반환값에는 액세스 토큰만 싣는다. 리프레시 토큰은 읽지도 않는다.

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface CredentialIO {
  readKeychain(service: string, account?: string): string | null;
  readTextFile(path: string): string | null;
  env: Record<string, string | undefined>;
  home: string;
}

export interface ClaudeCredential {
  accessToken: string;
}

export interface CodexCredential {
  accessToken: string;
  accountId: string | null;
}

export interface AgyCredential {
  accessToken: string;
  /** epoch ms. 벤더가 안 주면 null. */
  expiresAt: number | null;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null;

const parse = (text: string | null): Obj | null => {
  if (text === null) return null;
  try {
    const v: unknown = JSON.parse(text);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
};

/** 빈 문자열은 토큰이 아니다 — 자격증명이 없는 것과 같이 다룬다. */
const token = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

const isoMs = (v: unknown): number | null => {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

// claude — Keychain을 먼저 보고, 없거나 깨졌으면 파일을 본다.
export function readClaudeCredential(io: CredentialIO): ClaudeCredential | null {
  const dir = io.env.CLAUDE_CONFIG_DIR ?? join(io.home, '.claude');
  const sources = [
    () => io.readKeychain('Claude Code-credentials'),
    () => io.readTextFile(join(dir, '.credentials.json')),
  ];
  for (const read of sources) {
    const oauth = parse(read())?.claudeAiOauth;
    const accessToken = isObj(oauth) ? token(oauth.accessToken) : null;
    if (accessToken) return { accessToken };
  }
  return null;
}

// codex — Keychain을 쓰지 않는다. 평문 auth.json 하나뿐이다.
export function readCodexCredential(io: CredentialIO): CodexCredential | null {
  const dir = io.env.CODEX_HOME ?? join(io.home, '.codex');
  const tokens = parse(io.readTextFile(join(dir, 'auth.json')))?.tokens;
  if (!isObj(tokens)) return null;
  const accessToken = token(tokens.access_token);
  if (!accessToken) return null;
  return { accessToken, accountId: token(tokens.account_id) };
}

// agy — go-keyring이 쓴 항목이라 값에 base64 접두사가 붙는다.
export function readAgyCredential(io: CredentialIO): AgyCredential | null {
  const raw = io.readKeychain('gemini', 'antigravity');
  if (raw === null) return null;
  const PREFIX = 'go-keyring-base64:';
  const text = raw.startsWith(PREFIX)
    ? Buffer.from(raw.slice(PREFIX.length), 'base64').toString('utf8')
    : raw;
  const block = parse(text)?.token;
  if (!isObj(block)) return null;
  const accessToken = token(block.access_token);
  if (!accessToken) return null;
  return { accessToken, expiresAt: isoMs(block.expiry) };
}

// 실제 OS를 읽는 구현. macOS 기준이다 — Windows는 spec/01_windows_port를 따른다.
export function systemCredentialIO(): CredentialIO {
  return {
    readKeychain(service, account) {
      const args = ['find-generic-password', '-s', service, '-w'];
      if (account) args.push('-a', account);
      try {
        return execFileSync('security', args, { encoding: 'utf8' }).trim();
      } catch {
        return null;
      }
    },
    readTextFile(path) {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
    env: process.env,
    home: homedir(),
  };
}
