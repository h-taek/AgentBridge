// 글로벌 컨텍스트 경로 레이아웃 — gc-tree paths.ts 이식, profiles/default 모델로 변경.
// HEAD/branches 없음(§F): v1은 단일 default 프로필.
import { join } from 'node:path';
import { getStorageRoot } from './storageRoot';
import type { ProposalScope } from './shared/global';

export const DEFAULT_PROFILE_ID = 'default';

// 프로덕션: ~/.agentbridge/global. 테스트는 rootOverride로 임시 디렉토리 주입.
export function getGlobalDir(rootOverride?: string): string {
  return join(rootOverride ?? getStorageRoot(), 'global');
}
export function profilesRoot(globalDir: string): string {
  return join(globalDir, 'profiles');
}
// 장기 기억은 두 루트로 갈린다 (0.5.0 B-1).
//   profiles/ — 사용자 지식. 지금은 default 하나이고, 다중 사용자 프로필 확장을 위해 나눠 둔 자리다.
//   projects/ — 저장소 단위 지식. 키는 정규화한 git remote라 폴더를 옮기거나 worktree를 파도 따라온다.
// 공유 지식과 한 저장소의 지식은 성격이 다르므로 프로필 목록에 섞지 않는다.
export function projectsRoot(globalDir: string): string {
  return join(globalDir, 'projects');
}
function scopeRoot(globalDir: string, scope: ProposalScope): string {
  return scope === 'project' ? projectsRoot(globalDir) : profilesRoot(globalDir);
}

// id는 폴더 이름이 되므로 단일 세그먼트여야 한다. 프로젝트 지식이 생기면서 이 값이 상수가
// 아니게 됐다 — 경로 탈출을 여기서 한 번 막는다 (globalValidate의 validateSlug와 같은 규칙).
export function assertProfileSegment(profileId: string): string {
  const v = String(profileId ?? '');
  if (!v || v === '.' || v === '..' || /[\\/\u0000]/.test(v)) {
    throw new Error(`Invalid profileId "${v}": must be a single path segment.`);
  }
  return v;
}
export function profileDir(globalDir: string, profileId: string, scope: ProposalScope = 'user'): string {
  return join(scopeRoot(globalDir, scope), assertProfileSegment(profileId));
}
export function profileMetaPath(globalDir: string, profileId: string, scope: ProposalScope = 'user'): string {
  return join(profileDir(globalDir, profileId, scope), 'profile.json');
}
export function profileIndexPath(globalDir: string, profileId: string, scope: ProposalScope = 'user'): string {
  return join(profileDir(globalDir, profileId, scope), 'index.md');
}
export function profileDocsDir(globalDir: string, profileId: string, scope: ProposalScope = 'user'): string {
  return join(profileDir(globalDir, profileId, scope), 'docs');
}
export function proposalsDir(globalDir: string, profileId: string, scope: ProposalScope = 'user'): string {
  return join(profileDir(globalDir, profileId, scope), 'proposals');
}
