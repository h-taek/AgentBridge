// 뷰어가 요소를 보낼 세션을 고르고 문서의 상대 경로를 계산한다 (0.7.0 HTML 뷰어).
//
// 순수 함수로 작성되어 VS Code API나 웹뷰에 의존하지 않는다.

import * as path from 'path';
import type { CliKind } from '../shared/types';

export interface ViewerSession {
  sessionId: string;
  name: string;
  model: CliKind;
  cwd: string;
  alive: boolean;
}

// 작업 디렉터리가 대상 파일의 상위이거나 같은 디렉터리인지 판정한다.
// 문자열 접두사 비교는 /repo-old를 /repo의 하위로 볼 수 있으므로 path.relative를 쓴다.
function isUnder(cwd: string, filePath: string): boolean {
  const rel = path.relative(cwd, filePath);
  return Boolean(rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

// 열린 파일에 요소를 보낼 수 있는 세션만 추린다.
// 죽은 세션과 작업 디렉터리가 파일의 상위가 아닌 세션을 제외한다.
export function candidateSessions(all: ViewerSession[], filePath: string): ViewerSession[] {
  return all.filter((s) => s.alive && isUnder(s.cwd, filePath));
}

// 세션의 작업 디렉터리를 기준으로 파일 경로를 접는다.
// 세션의 cwd가 파일의 상위가 아니면 절대 경로를 그대로 돌려준다.
export function docRelativePath(cwd: string, filePath: string): string {
  const rel = path.relative(cwd, filePath);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    return rel;
  }
  return filePath;
}
