// 결정적 워크스페이스 ID — `<폴더 이름>-<경로 다이제스트 4자>` (0.5.0 B-1).
//
// 같은 폴더면 언제 계산해도 같은 ID가 나온다. 덕분에 "폴더 → ID" 매핑 장부(workspaces.json)가
// 필요 없고, 장부 동시 갱신 충돌도 원천 제거.
//
// 접미사는 충돌할 때만 붙이는 게 아니라 항상 붙인다. 조건부로 붙이면 "내가 첫 번째인가"를
// 알기 위해 남의 폴더를 열어 대조해야 하고, 답이 여는 순서와 기계에 따라 달라진다.
//
// 경로는 심볼릭 링크를 해소하고 NFC로 정규화한다. macOS가 같은 한글 폴더를 NFD(자모 분해)
// 또는 NFC(완성형)로 다르게 전달해도 같은 ID를 보장한다.
//
// ID는 저장소 폴더 이름을 겸하므로 단일 경로 세그먼트여야 한다. 경로 탈출 방어는
// workspaceStore의 명시적 세그먼트 검사가 맡는다(UUID 형식 검사가 그 역할을 겸하던 자리).

import { createHash } from 'crypto';
import { realpathSync } from 'fs';
import { resolve, basename } from 'path';

// 폴더 이름이 길어도 파일 시스템 한계에 닿지 않게 자른다. 사람이 알아보는 것이 목적이라
// 앞부분만 남겨도 충분하다.
const MAX_NAME_LEN = 64;
const DIGEST_LEN = 4;

export function canonicalWorkspacePath(folderFsPath: string): string {
  // 심볼릭 링크 해소 + 절대경로 정규화. 폴더가 아직 없으면 resolve만 (생성 전 호출 대비).
  let canonical: string;
  try {
    canonical = realpathSync(folderFsPath);
  } catch {
    canonical = resolve(folderFsPath);
  }
  return canonical.normalize('NFC');
}

function safeName(canonical: string): string {
  const raw = basename(canonical);
  const cleaned = raw
    .replace(/[\\/\u0000-\u001f]/g, '-') // 경로 구분자와 제어문자
    .replace(/\s+/g, '-') // 공백은 하이픈으로
    .replace(/^[.-]+/, '') // 숨김 폴더가 숨김 폴더를 만들지 않게
    .replace(/-+$/, '');
  if (!cleaned) return 'workspace';
  return cleaned.slice(0, MAX_NAME_LEN);
}

// 경로 다이제스트만 따로. 워크스페이스 ID의 접미사이자, 첨부 파일명이 프로젝트를 가르는 표식이다.
export function workspacePathDigest(folderFsPath: string): string {
  const canonical = canonicalWorkspacePath(folderFsPath);
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, DIGEST_LEN);
}

export function deterministicWorkspaceId(folderFsPath: string): string {
  const canonical = canonicalWorkspacePath(folderFsPath);
  return `${safeName(canonical)}-${workspacePathDigest(canonical)}`;
}
