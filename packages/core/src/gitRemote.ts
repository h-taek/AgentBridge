// git remote를 읽어 프로젝트 프로필 키를 만든다 (0.5.0 B-1).
//
// 프로젝트 지식의 자리를 폴더가 아니라 저장소로 잡는 이유는 셋이다. 폴더를 옮기거나 이름을 바꿔도
// 따라오고, 다른 기계에 클론해도 같은 프로필을 쓰고, worktree는 remote가 같으니 본 저장소의 지식을
// 그대로 공유한다.
//
// remote가 없는 저장소(로컬 전용, git 아님)는 프로젝트 프로필 없이 돌아간다 — 프로젝트 지식을
// 안 쌓을 뿐 나머지는 그대로다.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Logger } from './interfaces';
import { noopLogger } from './interfaces';

const GIT_TIMEOUT_MS = 3000;
const PROFILE_DIGEST_LEN = 8;
const MAX_NAME_LEN = 48;

// 같은 저장소를 가리키는 여러 표기를 한 형태로 모은다.
//   git@github.com:h-taek/AgentBridge.git  → github.com/h-taek/agentbridge
//   https://github.com/h-taek/AgentBridge  → github.com/h-taek/agentbridge
//   ssh://git@github.com:22/h-taek/Agent.git → github.com/h-taek/agent
//
// 대소문자를 내리는 이유는 같은 저장소를 다른 표기로 클론한 경우를 합치기 위해서다. 경로가
// 대소문자를 가리는 호스트에서 서로 다른 두 저장소가 합쳐질 수 있으나, 그런 조합을 한 사용자가
// 동시에 쓰는 경우보다 표기가 갈리는 경우가 훨씬 흔하다.
export function normalizeRemoteUrl(raw: string): string {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''); // scheme
  s = s.replace(/^[^@/]+@/, ''); // user@
  s = s.replace(/:(\d+)\//, '/'); // ssh 포트
  s = s.replace(/:/, '/'); // scp 표기의 host:path
  s = s.replace(/\/+$/, ''); // 먼저 끝 슬래시 — ".git/" 표기를 위해 .git 제거보다 앞선다
  s = s.replace(/\.git$/i, '');
  s = s.replace(/\/+$/, '');
  s = s.replace(/\/{2,}/g, '/');
  return s.toLowerCase();
}

// 정규화한 remote → 단일 경로 세그먼트인 프로필 id.
// 사람이 알아볼 이름 + 다이제스트. 워크스페이스 id와 같은 규칙이되 다이제스트가 더 길다 —
// 워크스페이스에는 충돌 tripwire가 있지만 프로필에는 없어서, 충돌 확률 자체를 낮춰 둔다.
export function profileIdForRemote(normalized: string): string {
  const digest = createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, PROFILE_DIGEST_LEN);
  const tail = normalized.split('/').filter(Boolean).slice(-2).join('-');
  const name = tail
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^[.\-]+/, '')
    .replace(/[.\-]+$/, '')
    .slice(0, MAX_NAME_LEN);
  return `${name || 'repo'}-${digest}`;
}

export type GitRemoteReader = (cwd: string) => Promise<string | null>;

// origin의 URL. git이 없거나 저장소가 아니거나 remote가 없으면 null.
// worktree에서도 git이 본 저장소의 설정을 읽어 주므로 따로 처리할 것이 없다.
export const readOriginUrl: GitRemoteReader = (cwd) =>
  new Promise((resolve) => {
    execFile(
      'git',
      ['config', '--get', 'remote.origin.url'],
      { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const v = String(stdout ?? '').trim();
        resolve(v || null);
      },
    );
  });

// 프로젝트 프로필 id. remote가 없으면 null — 호출처는 프로젝트 지식을 안 쌓는다.
export async function resolveProjectProfileId(
  cwd: string,
  opts: { readRemote?: GitRemoteReader; logger?: Logger } = {},
): Promise<string | null> {
  const log = opts.logger ?? noopLogger;
  const read = opts.readRemote ?? readOriginUrl;
  let url: string | null;
  try {
    url = await read(cwd);
  } catch (err) {
    log.warn(`gitRemote: origin 조회 실패 — ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (!url) return null;
  const normalized = normalizeRemoteUrl(url);
  if (!normalized) return null;
  return profileIdForRemote(normalized);
}
