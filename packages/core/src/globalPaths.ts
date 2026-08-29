// 글로벌 컨텍스트 경로 레이아웃 — gc-tree paths.ts 이식, profiles/default 모델로 변경.
// HEAD/branches 없음(§F): v1은 단일 default 프로필.
import { join } from 'node:path';
import { getStorageRoot } from './storageRoot';

export const DEFAULT_PROFILE_ID = 'default';

// 프로덕션: ~/.agentbridge/global. 테스트는 rootOverride로 임시 디렉토리 주입.
export function getGlobalDir(rootOverride?: string): string {
  return join(rootOverride ?? getStorageRoot(), 'global');
}
export function profilesRoot(globalDir: string): string {
  return join(globalDir, 'profiles');
}
// profileId는 폴더 이름이 되므로 단일 세그먼트여야 한다. 프로젝트 프로필이 생기면서 이 값이
// 상수가 아니게 됐다 — 경로 탈출을 여기서 한 번 막는다 (globalValidate의 validateSlug와 같은 규칙).
export function assertProfileSegment(profileId: string): string {
  const v = String(profileId ?? '');
  if (!v || v === '.' || v === '..' || /[\\/\u0000]/.test(v)) {
    throw new Error(`Invalid profileId "${v}": must be a single path segment.`);
  }
  return v;
}
export function profileDir(globalDir: string, profileId: string): string {
  return join(profilesRoot(globalDir), assertProfileSegment(profileId));
}
export function profileMetaPath(globalDir: string, profileId: string): string {
  return join(profileDir(globalDir, profileId), 'profile.json');
}
export function profileIndexPath(globalDir: string, profileId: string): string {
  return join(profileDir(globalDir, profileId), 'index.md');
}
export function profileDocsDir(globalDir: string, profileId: string): string {
  return join(profileDir(globalDir, profileId), 'docs');
}
export function proposalsDir(globalDir: string, profileId: string): string {
  return join(profileDir(globalDir, profileId), 'proposals');
}
