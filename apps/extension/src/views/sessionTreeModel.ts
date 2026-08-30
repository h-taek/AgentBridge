// 세션 트리 순수 계산부 (0.5.0 W4·W5, B-3) — vscode 모듈에 의존하지 않아 유닛 테스트가 가능하다.
// 부모·자식 분류(고아 승격 포함), 행 종류 판정, 아이콘 키 조립, 부모 행 집계값, 삭제 확인
// 문구 조립을 담는다. TreeItem 생성과 vscode.l10n.t 호출은 sessionTreeView.ts·extension.ts 몫이다.

import type { SessionMeta } from '../core/sessionRegistry';
import { aggregateActivity, type SessionActivity } from '@agentbridge/core';

export type RowKind = 'session' | 'subsession';

// 실제로 이 워크스페이스 안에 존재하는 부모를 가리키는지. 자기 자신을 부모로 가리키는
// degenerate 레코드는 무한루프를 막기 위해 부모가 없는 것으로 친다.
function hasLiveParent(session: SessionMeta, byId: Map<string, SessionMeta>): boolean {
  if (!session.parentSessionId) return false;
  if (session.parentSessionId === session.sessionId) return false;
  return byId.has(session.parentSessionId);
}

// 행 종류 — 부모가 실제로 존재하면 서브 행, 그 외(부모 없음·고아)는 메인 행이다.
export function rowKindOf(session: SessionMeta, allSessions: SessionMeta[]): RowKind {
  const byId = new Map(allSessions.map((s) => [s.sessionId, s]));
  return hasLiveParent(session, byId) ? 'subsession' : 'session';
}

// 최상위 행 — 부모가 없거나, 부모가 이 워크스페이스에 없는 고아(고아가 화면에서 사라지지 않는다).
export function rootSessions(allSessions: SessionMeta[]): SessionMeta[] {
  const byId = new Map(allSessions.map((s) => [s.sessionId, s]));
  return allSessions.filter((s) => !hasLiveParent(s, byId));
}

// 한 세션의 직속 자식. 자기 자신을 부모로 가리키는 레코드는 자기 자식으로 잡지 않는다 —
// 트리는 2단이라 자식의 자식은 다루지 않으므로 여기서 잡는 것도 직속 한 단뿐이다.
export function childSessions(allSessions: SessionMeta[], parentSessionId: string): SessionMeta[] {
  return allSessions.filter(
    (s) => s.parentSessionId === parentSessionId && s.sessionId !== parentSessionId,
  );
}

// 아이콘 키 — esbuild가 굽는 media/dots/<key> 파일명과 맞춘다. idle은 접미사 없음(기존 파일명 유지).
export function iconKey(model: string, closed: boolean, activity: SessionActivity): string {
  const suffix = activity === 'idle' ? '' : `-${activity}`;
  return `${model}${closed ? '-closed' : ''}${suffix}.svg`;
}

// 행의 표시 값. 메인 행은 자기 활동과 접힌 자식들 값을 core aggregateActivity로 모으고,
// 서브 행은 자기 활동을 그대로 쓴다(2단 트리라 더 모을 대상이 없다).
export function rowActivity(
  kind: RowKind,
  selfActivity: SessionActivity,
  childActivities: SessionActivity[],
): SessionActivity {
  if (kind === 'subsession') return selfActivity;
  return aggregateActivity(selfActivity, childActivities);
}

// ─── 삭제 확인 문구 조립 ────────────────────────────────────────────────
//
// 실제 문구(vscode.l10n.t 호출)는 extension.ts에 둔다 — l10n 추출 도구가 리터럴 템플릿을
// 소스에서 정적으로 찾으므로, 여기서는 어떤 값을 채울지만 정한다.
//
// childNames는 kind가 'subsession'이면 항상 빈 배열이다. worktree·브랜치·변경 파일 수 같은
// 서브 삭제 영수증 항목(B-7)은 4~5단계에서 생기므로 이 계획에는 아직 없다 — 자리만 비워 둔다.
export interface DeleteConfirmPlan {
  kind: RowKind;
  childCount: number;
  childNames: string[];
}

export function planDeleteConfirm(rowKind: RowKind, children: SessionMeta[]): DeleteConfirmPlan {
  if (rowKind === 'subsession') return { kind: 'subsession', childCount: 0, childNames: [] };
  return { kind: 'session', childCount: children.length, childNames: children.map((c) => c.name) };
}
