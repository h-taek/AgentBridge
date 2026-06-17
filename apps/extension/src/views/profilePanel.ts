import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { join } from 'path';
import * as output from '../log/output';
import * as workspaceStore from '../core/workspaceStore';
import {
  readProposals,
  approveProposal,
  discardProposal,
  readProfileDocs,
  getGlobalDir,
  resolveProfile,
} from '@agentbridge/core';

// gc-tree §E — 장기 메모리(프로필) 뷰. 데스크탑 ProfilePanel.tsx의 익스텐션 트윈.
//   ① 승인 큐: 자동제안 카드(카테고리·제목·요약·본문 미리보기 + 승인/버림)
//   ② 읽기전용 문서 목록(카테고리별 그룹) — 수동 편집은 "폴더 열기"로 .md 직접 편집
// 제안·문서는 default 프로필 단위로 모든 워크스페이스가 공유 — workspaceId는 resolveProfile 입력일 뿐.
export class ProfilePanelProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'agentbridge.proposalPanel';

  private view: vscode.WebviewView | undefined;

  constructor() {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.buildHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'proposal:list':
          await this.sendProposals();
          break;
        case 'proposal:approve':
          await this.handleApprove(msg.id as string);
          break;
        case 'proposal:discard':
          await this.handleDiscard(msg.id as string);
          break;
        case 'proposal:openFolder':
          await this.handleOpenFolder();
          break;
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) void this.sendProposals();
    });
  }

  // E3 자동제안 패스 종료 시 extension.ts가 호출 — 목록 재푸시.
  notifyProposalsUpdated(): void {
    void this.sendProposals();
  }

  private getWorkspaceId(): string | null {
    const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!folderUri) return null;
    return workspaceStore.getOrCreateWorkspaceId(folderUri.fsPath);
  }

  private async sendProposals(): Promise<void> {
    const wid = this.getWorkspaceId();
    if (!wid) {
      this.postMessage({ type: 'proposal:data', proposals: [], docs: [], profileDir: '' });
      return;
    }
    const globalDir = getGlobalDir();
    const profileId = resolveProfile(wid);
    const profileDir = join(globalDir, 'profiles', profileId);
    const [proposals, docsRaw] = await Promise.all([
      readProposals(globalDir, profileId),
      readProfileDocs(globalDir, profileId),
    ]);
    const docs = docsRaw.map((d) => ({ category: d.category, slug: d.slug, title: d.title, summary: d.summary }));
    this.postMessage({ type: 'proposal:data', proposals, docs, profileDir });
  }

  private async handleApprove(id: string): Promise<void> {
    const wid = this.getWorkspaceId();
    if (!wid || !id) return;
    try {
      await approveProposal(getGlobalDir(), resolveProfile(wid), id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      output.warn(`profilePanel: approve failed — ${msg}`);
      // 진짜 실패(권한·디스크 등)를 사용자에게 표면화 — output 로그만으론 안 보임.
      void vscode.window.showWarningMessage(vscode.l10n.t('AgentBridge: Failed to update the proposal — {0}.', msg));
    }
    await this.sendProposals();
  }

  private async handleDiscard(id: string): Promise<void> {
    const wid = this.getWorkspaceId();
    if (!wid || !id) return;
    try {
      await discardProposal(getGlobalDir(), resolveProfile(wid), id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      output.warn(`profilePanel: discard failed — ${msg}`);
      void vscode.window.showWarningMessage(vscode.l10n.t('AgentBridge: Failed to update the proposal — {0}.', msg));
    }
    await this.sendProposals();
  }

  private async handleOpenFolder(): Promise<void> {
    const wid = this.getWorkspaceId();
    if (!wid) return;
    const profileDir = join(getGlobalDir(), 'profiles', resolveProfile(wid));
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(profileDir));
  }

  private postMessage(msg: unknown): void {
    this.view?.webview.postMessage(msg);
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    // 라벨은 IDE 언어를 따른다(l10n). 데스크탑 ProfilePanel.tsx와 달리 기존엔 한국어 고정이었음.
    const L = {
      openFolder: vscode.l10n.t('Open folder'),
      openFolderTitle: vscode.l10n.t('Open profile folder (edit .md manually)'),
      approvalQueue: vscode.l10n.t('Approval queue'),
      noProposals: vscode.l10n.t('No pending proposals'),
      approve: vscode.l10n.t('Approve'),
      discard: vscode.l10n.t('Dismiss'),
      profileDocs: vscode.l10n.t('Profile documents'),
      noDocs: vscode.l10n.t('No documents yet. They fill in automatically as you work.'),
    };
    return /*html*/ `<!DOCTYPE html>
<html lang="${vscode.env.language || 'en'}">
<head>
  <meta charset="UTF-8"/>
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <style nonce="${nonce}">
    :root { --pad: 10px; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      padding: var(--pad);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
    }
    .profile-loc {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 0 10px;
      margin-bottom: 8px;
      border-bottom: 2px solid var(--vscode-widget-border, #444);
    }
    .profile-loc-name {
      flex: 1;
      font-size: 12px;
      font-weight: 600;
      color: var(--vscode-foreground);
    }
    .open-folder {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: transparent;
      border: 1px solid var(--vscode-button-border, var(--vscode-widget-border, #444));
      color: var(--vscode-foreground);
      cursor: pointer;
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 4px;
    }
    .open-folder:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.1));
    }
    .open-folder:disabled { opacity: 0.4; cursor: default; }
    .open-folder svg { width: 14px; height: 14px; fill: currentColor; }
    .sechead {
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 14px 0 6px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #7DA1C7;
    }
    .sechead-count {
      font-size: 10px;
      font-weight: normal;
      padding: 0 5px;
      border-radius: 8px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .empty {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      font-size: 12px;
      text-align: center;
      padding: 16px 0;
    }
    .card {
      padding: 8px 10px;
      margin-bottom: 6px;
      border-radius: 6px;
      background: var(--vscode-editor-background, rgba(255,255,255,0.03));
      border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.08));
    }
    .card-cat {
      display: inline-block;
      padding: 1px 6px;
      margin-bottom: 4px;
      border-radius: 8px;
      font-size: 10px;
      font-weight: 500;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .card-title {
      font-weight: 600;
      font-size: 13px;
      line-height: 1.4;
      margin-bottom: 3px;
    }
    .card-sub {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.4;
      margin-bottom: 4px;
    }
    .card-body {
      font-size: 12px;
      color: var(--vscode-foreground);
      line-height: 1.4;
      margin-bottom: 8px;
      word-break: break-word;
    }
    .card-acts { display: flex; gap: 6px; }
    .card-acts button {
      flex: 1;
      cursor: pointer;
      font-size: 12px;
      padding: 4px 0;
      border-radius: 4px;
      border: 1px solid transparent;
    }
    .card-acts button:disabled { opacity: 0.4; cursor: default; }
    .act-approve {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .act-approve:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    .act-discard {
      background: var(--vscode-button-secondaryBackground, transparent);
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      border-color: var(--vscode-widget-border, #444);
    }
    .act-discard:hover:not(:disabled) {
      background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.1));
    }
    .doc-group { margin-bottom: 8px; }
    .doc-cat {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 3px;
    }
    .doc {
      padding: 4px 8px;
      border-radius: 4px;
    }
    .doc:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.04)); }
    .doc-title { font-size: 12px; line-height: 1.4; }
    .doc-summary {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.3;
    }
  </style>
</head>
<body>
  <div class="profile-loc">
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M14.5 3H7.71l-.85-.85L6.51 2h-5l-.5.5v11l.5.5h13l.5-.5v-10L14.5 3zm-.51 8.49V13h-12V7h4.49l.35-.15.86-.86H14v1.5l-.01 4z"/></svg>
    <span class="profile-loc-name">default</span>
    <button id="openFolderBtn" class="open-folder" disabled title="${L.openFolderTitle}">
      <svg viewBox="0 0 16 16" fill="currentColor"><path d="M14.5 3H7.71l-.85-.85L6.51 2h-5l-.5.5v11l.5.5h13l.5-.5v-10L14.5 3zm-.51 8.49V13h-12V7h4.49l.35-.15.86-.86H14v1.5l-.01 4z"/></svg>
      ${L.openFolder}
    </button>
  </div>

  <div id="content"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const L = ${JSON.stringify(L)};
    const contentEl = document.getElementById('content');
    const openFolderBtn = document.getElementById('openFolderBtn');

    let busy = false;
    let profileDir = '';

    openFolderBtn.addEventListener('click', () => {
      if (!profileDir) return;
      vscode.postMessage({ type: 'proposal:openFolder' });
    });

    const BODY_PREVIEW_MAX = 200;
    function bodyPreview(body) {
      const flat = String(body || '').replace(/\\s+/g, ' ').trim();
      return flat.length > BODY_PREVIEW_MAX ? flat.slice(0, BODY_PREVIEW_MAX).replace(/\\s+$/, '') + '…' : flat;
    }

    function esc(s) {
      const d = document.createElement('div');
      d.textContent = s == null ? '' : String(s);
      return d.innerHTML;
    }

    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.type === 'proposal:data') {
        busy = false;
        profileDir = msg.profileDir || '';
        openFolderBtn.disabled = !profileDir;
        render(msg.proposals || [], msg.docs || []);
      }
    });

    function render(proposals, docs) {
      let html = '';

      // ① 승인 큐
      html += '<div class="sechead"><span>' + L.approvalQueue + '</span>' +
        (proposals.length > 0 ? '<span class="sechead-count">' + proposals.length + '</span>' : '') + '</div>';
      if (proposals.length === 0) {
        html += '<div class="empty">' + L.noProposals + '</div>';
      } else {
        proposals.forEach((p) => {
          html += '<div class="card">';
          html += '<span class="card-cat">' + esc(p.category) + '</span>';
          html += '<div class="card-title">' + esc(p.title) + '</div>';
          if (p.summary) html += '<div class="card-sub">' + esc(p.summary) + '</div>';
          if (p.body) html += '<div class="card-body">' + esc(bodyPreview(p.body)) + '</div>';
          html += '<div class="card-acts">';
          html += '<button class="act-approve" data-act="approve" data-id="' + esc(p.id) + '"' + (busy ? ' disabled' : '') + '>' + L.approve + '</button>';
          html += '<button class="act-discard" data-act="discard" data-id="' + esc(p.id) + '"' + (busy ? ' disabled' : '') + '>' + L.discard + '</button>';
          html += '</div></div>';
        });
      }

      // ② 읽기전용 문서 (카테고리별 그룹)
      html += '<div class="sechead"><span>' + L.profileDocs + '</span>' +
        (docs.length > 0 ? '<span class="sechead-count">' + docs.length + '</span>' : '') + '</div>';
      if (docs.length === 0) {
        html += '<div class="empty">' + L.noDocs + '</div>';
      } else {
        const groups = [];
        const byCat = {};
        docs.forEach((d) => {
          if (!byCat[d.category]) { byCat[d.category] = []; groups.push({ category: d.category, docs: byCat[d.category] }); }
          byCat[d.category].push(d);
        });
        groups.forEach((g) => {
          html += '<div class="doc-group"><div class="doc-cat">' + esc(g.category) + '</div>';
          g.docs.forEach((d) => {
            html += '<div class="doc"><div class="doc-title">' + esc(d.title) + '</div>';
            if (d.summary) html += '<div class="doc-summary">' + esc(d.summary) + '</div>';
            html += '</div>';
          });
          html += '</div>';
        });
      }

      contentEl.innerHTML = html;
      bindActions();
    }

    function bindActions() {
      contentEl.querySelectorAll('button[data-act]').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (busy) return;
          const id = btn.getAttribute('data-id');
          const act = btn.getAttribute('data-act');
          busy = true;
          // 진행 중엔 모든 액션 버튼 비활성 — 재조회(proposal:data) 시 busy 해제.
          contentEl.querySelectorAll('button[data-act]').forEach((b) => { b.disabled = true; });
          vscode.postMessage({ type: act === 'approve' ? 'proposal:approve' : 'proposal:discard', id: id });
        });
      });
    }

    vscode.postMessage({ type: 'proposal:list' });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  return randomBytes(16).toString('base64');
}
