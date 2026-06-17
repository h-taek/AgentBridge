import * as vscode from 'vscode';
import { join } from 'path';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { getSessions, type SessionMeta } from '../core/sessionRegistry';
import { CLI_DISPLAY_NAME } from '../shared/types';
import * as workspaceStore from '../core/workspaceStore';

const MODEL_DOT_COLOR: Record<string, string> = {
  claude: '#d97757',
  codex: '#5D8AF9',
  agy: '#8e6cef',
};

let dotIconDir: string | undefined;

function ensureDotIcon(model: string, closed: boolean): vscode.Uri {
  if (!dotIconDir) return vscode.Uri.file('');
  const color = MODEL_DOT_COLOR[model] ?? '#888';
  const opacity = closed ? '0.4' : '1';
  const key = `dot-${model}${closed ? '-closed' : ''}.svg`;
  const filePath = join(dotIconDir, key);
  if (!existsSync(filePath)) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="3.5" fill="${color}" opacity="${opacity}"/></svg>`;
    writeFileSync(filePath, svg, 'utf8');
  }
  return vscode.Uri.file(filePath);
}

export class SessionTreeProvider implements vscode.TreeDataProvider<SessionItem> {
  private readonly _onDidChange = new vscode.EventEmitter<SessionItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(extUri: vscode.Uri) {
    dotIconDir = join(extUri.fsPath, 'media', 'dots');
    mkdirSync(dotIconDir, { recursive: true });
  }

  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  private cachedItems: SessionItem[] = [];

  async getChildren(): Promise<SessionItem[]> {
    const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!folderUri) { this.cachedItems = []; return []; }
    const wid = workspaceStore.getOrCreateWorkspaceId(folderUri.fsPath);
    const sessions = await getSessions(wid);
    this.cachedItems = sessions.map(s => new SessionItem(s));
    return this.cachedItems;
  }

  findItemBySessionId(sessionId: string): SessionItem | undefined {
    return this.cachedItems.find(i => i.session.sessionId === sessionId);
  }

  getTreeItem(element: SessionItem): vscode.TreeItem {
    return element;
  }

  getParent(_element: SessionItem): vscode.ProviderResult<SessionItem> {
    return undefined;
  }
}

export class SessionItem extends vscode.TreeItem {
  constructor(public readonly session: SessionMeta) {
    super(session.name, vscode.TreeItemCollapsibleState.None);

    // 안정적 행 정체성 — 재시작 시 refresh가 폭주하며 active 플래그로 정렬이 바뀔 때,
    // id가 없으면 VS Code가 옛 행과 새 행을 같은 항목으로 못 묶어 잠깐 중복 렌더된다.
    // sessionId를 id로 고정하면 행을 추적해 중복을 없애고 셀렉션/펼침 상태도 유지된다.
    this.id = session.sessionId;

    const closed = !session.active;
    this.description = timeAgo(session.lastActiveAt);
    const icon = ensureDotIcon(session.model, closed);
    this.iconPath = { light: icon, dark: icon };
    this.contextValue = session.active ? 'session-active' : 'session-closed';

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
