import * as vscode from 'vscode';
import { join } from 'path';
import { getSessions, type SessionMeta } from '../core/sessionRegistry';
import { CLI_DISPLAY_NAME } from '../shared/types';
import * as workspaceStore from '../core/workspaceStore';
import {
  readSessionActivityInputs,
  computeSessionActivity,
  type SessionActivity,
} from '@agentbridge/core';
import { rowKindOf, rootSessions, childSessions, iconKey, rowActivity, type RowKind } from './sessionTreeModel';

// dot SVG는 빌드 때 esbuild가 colors.json 색을 박아 media/dots/에 생성한다(단일 출처=colors.json, gitignore).
// TreeItem.iconPath는 파일 Uri/코디콘만 받으므로 색칠한 dot은 파일이어야 한다. 여기서는 경로만 참조한다.
let dotIconDir: string | undefined;

function dotIcon(key: string): vscode.Uri {
  if (!dotIconDir) return vscode.Uri.file('');
  return vscode.Uri.file(join(dotIconDir, key));
}

export class SessionTreeProvider implements vscode.TreeDataProvider<SessionItem> {
  private readonly _onDidChange = new vscode.EventEmitter<SessionItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(extUri: vscode.Uri) {
    dotIconDir = join(extUri.fsPath, 'media', 'dots');
  }

  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  // 4초 폴링 전용 — 행 데이터(세션·종류·이름·활성·상태·마지막 활동)가 지난번과 같으면 다시
  // 그리지 않는다. timeAgo 표시(설명 문구)는 매 렌더 달라지므로 스냅샷에서 뺀다.
  private lastSnapshot: string | undefined;

  async refreshIfChanged(): Promise<void> {
    await this.getChildren();
    const snapshot = JSON.stringify(
      this.cachedItems.map((i) => [
        i.session.sessionId,
        i.kind,
        i.session.name,
        i.session.active,
        i.activity,
        i.session.lastActiveAt,
      ]),
    );
    if (snapshot === this.lastSnapshot) return;
    this.lastSnapshot = snapshot;
    this._onDidChange.fire(undefined);
  }

  // 평면 — 루트와 자식을 모두 담는다. findItemBySessionId·getParent가 종류를 가리지 않고 찾는다.
  private cachedItems: SessionItem[] = [];

  async getChildren(element?: SessionItem): Promise<SessionItem[]> {
    if (!element) {
      const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!folderUri) { this.cachedItems = []; return []; }
      const wid = workspaceStore.getOrCreateWorkspaceId(folderUri.fsPath);
      const wsDir = workspaceStore.getWorkspacePath(wid);
      const allSessions = await getSessions(wid);

      const roots = rootSessions(allSessions);
      const items = await Promise.all(roots.map((s) => this.buildItem(s, allSessions, wsDir)));
      this.cachedItems = [...items, ...items.flatMap((i) => i.children)];
      return items;
    }

    // 자식은 루트 조회 때 이미 함께 만들어 뒀다(집계값 계산에 필요해 먼저 구했다) — 재계산 없이 돌려준다.
    return element.children;
  }

  findItemBySessionId(sessionId: string): SessionItem | undefined {
    return this.cachedItems.find((i) => i.session.sessionId === sessionId);
  }

  getTreeItem(element: SessionItem): vscode.TreeItem {
    return element;
  }

  getParent(element: SessionItem): vscode.ProviderResult<SessionItem> {
    const parentId = element.session.parentSessionId;
    if (!parentId) return undefined;
    return this.cachedItems.find((i) => i.session.sessionId === parentId);
  }

  private async computeActivity(session: SessionMeta, wsDir: string): Promise<SessionActivity> {
    const inputs = await readSessionActivityInputs(wsDir, session.sessionId);
    const viewedAt = session.lastOpenedAt ? new Date(session.lastOpenedAt).getTime() : undefined;
    return computeSessionActivity({ ...inputs, viewedAt }, Date.now());
  }

  // 세션 하나를 행으로 만든다. kind가 'session'이면 직속 자식도 함께 만들어 집계값에 반영한다.
  // 자식의 자식은 만들지 않는다 — 트리는 2단이다.
  private async buildItem(session: SessionMeta, allSessions: SessionMeta[], wsDir: string): Promise<SessionItem> {
    const kind = rowKindOf(session, allSessions);
    const childRecords = kind === 'session' ? childSessions(allSessions, session.sessionId) : [];

    const [selfActivity, childItems] = await Promise.all([
      this.computeActivity(session, wsDir),
      Promise.all(childRecords.map((c) => this.buildItem(c, allSessions, wsDir))),
    ]);
    const activity = rowActivity(kind, selfActivity, childItems.map((i) => i.activity));

    return new SessionItem(session, kind, activity, childItems);
  }
}

export class SessionItem extends vscode.TreeItem {
  constructor(
    public readonly session: SessionMeta,
    public readonly kind: RowKind,
    public readonly activity: SessionActivity,
    public readonly children: SessionItem[],
  ) {
    const collapsible = children.length > 0
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
    super(session.name, collapsible);

    // 안정적 행 정체성 — 재시작 시 refresh가 폭주하며 active 플래그로 정렬이 바뀔 때,
    // id가 없으면 VS Code가 옛 행과 새 행을 같은 항목으로 못 묶어 잠깐 중복 렌더된다.
    // 종류 접두사를 더한다 — sessionId 하나만 쓰면 부모·자식이 같은 id로 부딪힌다.
    this.id = `${kind}:${session.sessionId}`;

    const closed = !session.active;
    this.description = timeAgo(session.lastActiveAt);
    const icon = dotIcon(iconKey(session.model, closed, activity));
    this.iconPath = { light: icon, dark: icon };
    const prefix = kind === 'session' ? 'session' : 'subsession';
    this.contextValue = session.active ? `${prefix}-active` : `${prefix}-closed`;

    const displayModel = CLI_DISPLAY_NAME[session.model] ?? session.model;
    this.tooltip = new vscode.MarkdownString(
      `**${session.name}**\n\n` +
      `Model: ${displayModel}\n\n` +
      `Created: ${new Date(session.createdAt).toLocaleString()}\n\n` +
      `Last active: ${new Date(session.lastActiveAt).toLocaleString()}`
    );

    this.command = {
      command: 'agentbridge.openSession',
      title: 'Open Session',
      arguments: [session],
    };
  }
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
