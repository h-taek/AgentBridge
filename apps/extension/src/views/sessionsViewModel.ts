// 세션 목록이 그릴 행을 만든다. 순수 함수라 vscode도 웹뷰도 모른다.
//
// 트리를 웹뷰로 옮기면서 2단 접기·부모 집계·순서를 우리가 쥐게 됐다. 판정은 전부 여기 두고
// 웹뷰는 받은 행을 그리기만 한다 — 웹뷰 스크립트는 tsc가 안 보기 때문이다.

import type { SessionActivity, CliKind } from '@agentbridge/core';
import type { SessionMeta } from '../core/sessionRegistry';
import {
  rowKindOf,
  rootSessions,
  childSessions,
  iconKey,
  rowActivity,
  visibleActivity,
  type RowKind,
} from './sessionTreeModel';

export interface SessionRowView {
  sessionId: string;
  kind: RowKind;
  name: string;
  model: CliKind;
  /** media/dots/ 아래 파일명. 웹뷰가 그대로 img src로 쓴다. */
  iconKey: string;
  timeAgo: string;
  depth: 0 | 1;
  hasChildren: boolean;
  collapsed: boolean;
  closed: boolean;
}

export interface SessionRowsInput {
  sessions: SessionMeta[];
  activityOf(sessionId: string): SessionActivity;
  collapsed: ReadonlySet<string>;
  now: number;
}

export function buildSessionRows(input: SessionRowsInput): SessionRowView[] {
  const { sessions, activityOf, collapsed, now } = input;

  // 닫힌 세션에는 상태가 없다. 집계보다 먼저 잘라야 닫힌 자식이 부모를 물들이지 않는다.
  const visible = (s: SessionMeta): SessionActivity =>
    visibleActivity(s.active, activityOf(s.sessionId));

  const row = (s: SessionMeta, depth: 0 | 1, kind: RowKind, children: SessionMeta[]): SessionRowView => {
    const activity = rowActivity(kind, visible(s), children.map(visible));
    return {
      sessionId: s.sessionId,
      kind,
      name: s.name,
      model: s.model,
      iconKey: iconKey(s.model, !s.active, activity),
      timeAgo: timeAgo(s.lastActiveAt, now),
      depth,
      hasChildren: children.length > 0,
      collapsed: collapsed.has(s.sessionId),
      closed: !s.active,
    };
  };

  const out: SessionRowView[] = [];
  for (const root of rootSessions(sessions)) {
    const children = childSessions(sessions, root.sessionId);
    out.push(row(root, 0, rowKindOf(root, sessions), children));
    if (collapsed.has(root.sessionId)) continue;
    for (const child of children) out.push(row(child, 1, 'subsession', []));
  }
  return out;
}

// 접기 손잡이 자리를 비워 둘지. 펼칠 것이 하나도 없으면 목록 전체가 왼쪽에 붙는다.
//
// 행마다 따로 정하지 않는 이유는 왼쪽 끝이 들쭉날쭉해지기 때문이다. 서브가 있는 세션과 없는
// 세션이 섞이면 같은 단계인데 이름 시작점이 달라진다. 그래서 목록 단위로 정한다 — 서브가
// 하나도 없는 흔한 경우에 24px을 돌려받고, 있을 때는 줄이 맞는다.
export function needsTwistColumn(rows: SessionRowView[]): boolean {
  return rows.some((r) => r.hasChildren);
}

export function timeAgo(iso: string, now: number): string {
  const mins = Math.floor((now - Date.parse(iso)) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
