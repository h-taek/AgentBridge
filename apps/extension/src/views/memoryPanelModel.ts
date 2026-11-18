// 기억 패널의 표시 계산 (0.5.0 6단계).
//
// 웹뷰 스크립트는 템플릿 문자열 안이라 tsc가 안 본다. 검증이 필요한 값은 여기서 만들어 넘기고
// 웹뷰는 받은 것을 그리기만 한다.

import { isAbsolute, relative, resolve, sep } from 'path';

export interface ProfileDocSource {
  category: string;
  slug: string;
  title: string;
  summary: string;
  tags?: readonly string[];
  path: string;
}

export interface ProfileDocRow {
  category: string;
  slug: string;
  title: string;
  summary: string;
  path: string;
  pinned: boolean;
}

// 웹뷰에 넘길 승인 문서 행 자료. 핀 여부는 tags에 'pinned'가 있는지로 정한다.
export function toProfileDocRow(doc: ProfileDocSource): ProfileDocRow {
  return {
    category: doc.category,
    slug: doc.slug,
    title: doc.title,
    summary: doc.summary,
    path: doc.path,
    pinned: Array.isArray(doc.tags) && doc.tags.includes('pinned'),
  };
}

// 고정된 문서를 앞으로 모은다(spec/05 §2-3). 웹뷰가 이 순서대로 맨 위 '고정' 묶음을 그린다.
// 나머지는 들어온 순서(카테고리·파일 이름순)를 지킨다.
export function orderPinnedFirst(rows: readonly ProfileDocRow[]): ProfileDocRow[] {
  return [...rows.filter((r) => r.pinned), ...rows.filter((r) => !r.pinned)];
}

// 더블클릭으로 열려는 경로가 프로필 docs 폴더 아래의 .md 파일인지 확인한다.
// 'index.md'와 상위 경로 탈출(..)을 막는다.
export function isProfileDocPath(profileDocsDir: string, docPath: string): boolean {
  if (!profileDocsDir || !docPath) return false;
  const base = resolve(profileDocsDir);
  const target = resolve(docPath);
  const rel = relative(base, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
  if (!target.endsWith('.md')) return false;
  const normalized = rel.replace(/\\/g, '/');
  if (/(^|\/)index\.md$/i.test(normalized)) return false;
  return true;
}

// 프로필 감시기가 목록을 다시 보낼 파일 변경인지 판정한다.
// *.md 변경만 받고 index.md와 빈 경로는 거른다.
export function shouldRefreshOnProfileFileChange(eventPath: string | null | undefined): boolean {
  if (!eventPath) return false;
  const normalized = String(eventPath).replace(/\\/g, '/');
  if (!normalized.endsWith('.md')) return false;
  if (/(^|\/)index\.md$/i.test(normalized)) return false;
  return true;
}

// 명령의 접힌 줄. 공백으로 잘라 앞 두 낱말만 남긴다.
//
// 따옴표도 경로도 플래그도 구분하지 않는다 — 규칙이 한 줄이어야 어긋나는 자리가 없다.
// 도구 이름 하나만 남기면 `git`이 세 줄로 서서 접힌 목록이 아무것도 말하지 않고, 더 남기면
// 사이드바 폭을 넘는다. `npm run typecheck`가 `npm run`이 되는 것은 이 규칙이 치르는 값이다.
// 전문은 눌러서 본다.
export function collapseCommand(cmd: string): string {
  return cmd.trim().split(/\s+/).slice(0, 2).join(' ');
}
