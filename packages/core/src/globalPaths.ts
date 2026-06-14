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
export function profileDir(globalDir: string, profileId: string): string {
  return join(profilesRoot(globalDir), profileId);
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
