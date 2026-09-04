import * as vscode from 'vscode';
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
  resolveProjectProfileId,
  adoptPathKeyedProject,
  type ProposalScope,
} from '@agentbridge/core';

// gc-tree §E — 장기 메모리(프로필) 뷰. 데스크탑 ProfilePanel.tsx의 익스텐션 트윈.
//   ① 승인 큐: 자동제안 카드(카테고리·제목·요약·본문 미리보기 + 승인/버림)
//   ② 읽기전용 문서 목록(카테고리별 그룹) — 수동 편집은 "폴더 열기"로 .md 직접 편집
// 0.5.0 B-1·B-3: 지식이 두 자리로 갈린다. 사용자 지식은 모든 워크스페이스가 공유하는 default
// 프로필이고, 프로젝트 지식은 git remote로 정해지는 저장소 단위 자리다. 패널은 늘리지 않고
// 상단 전환으로 한 번에 한쪽만 보여준다 — 훑는 곳이 아니라 승인하고 버리는 곳이라서다.
const EMPTY_SIDE = { proposals: [], docs: [], profileDir: '' };

export class ProfileSection {
  private view: vscode.WebviewView | undefined;
  // git 호출을 매 갱신마다 하지 않도록 폴더별로 기억한다. remote가 없으면 null이 캐시된다.
  private projectProfileCache = new Map<string, string | null>();

  // 대기 제안 수가 바뀔 때마다 호출(0 포함). 호스트가 액티비티 바 뱃지를 갱신하는 데 쓴다.
  // 섹션이 접혀 있어도 카운트는 나가야 하므로, 뱃지는 항상 살아있는 세션 TreeView에 건다.
  constructor(private readonly onCount?: (count: number) => void) {}

  // Context 뷰가 이 섹션을 품는다 — 웹뷰는 그쪽이 만들고 여기는 손잡이만 받는다.
  attach(view: vscode.WebviewView): void {
    this.view = view;
  }

  // 호스트가 못 알아본 메시지를 넘겨받는다. 처리했으면 true.
  async handleMessage(msg: { type?: string; id?: string; scope?: ProposalScope }): Promise<boolean> {
    switch (msg.type) {
      case 'proposal:list':
        await this.sendProposals();
        return true;
      case 'proposal:approve':
        await this.handleApprove(msg.id as string, msg.scope as ProposalScope);
        return true;
      case 'proposal:discard':
        await this.handleDiscard(msg.id as string, msg.scope as ProposalScope);
        return true;
      case 'proposal:openFolder':
        await this.handleOpenFolder(msg.scope as ProposalScope);
        return true;
      default:
        return false;
    }
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

  // 프로젝트 지식 자리. remote가 있으면 그것으로, 없으면 폴더 경로로 정해진다.
  // 폴더가 안 열려 있을 때만 null이다.
  private async getProjectProfileId(): Promise<string | null> {
    const folderPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folderPath) return null;
    const cached = this.projectProfileCache.get(folderPath);
    if (cached !== undefined) return cached;
    const logger = { log: output.log, warn: output.warn };
    const id = await resolveProjectProfileId(folderPath, { logger });
    // 로컬로 쌓다가 remote가 생긴 경우 자리를 한 번 옮긴다.
    adoptPathKeyedProject(join(getGlobalDir(), 'projects'), folderPath, id, logger);
    this.projectProfileCache.set(folderPath, id);
    return id;
  }

  private async readSide(
    globalDir: string,
    profileId: string,
    scope: ProposalScope,
  ): Promise<{ proposals: unknown[]; docs: unknown[]; profileDir: string }> {
    const [proposals, docsRaw] = await Promise.all([
      readProposals(globalDir, profileId, scope),
      readProfileDocs(globalDir, profileId, scope),
    ]);
    return {
      proposals,
      docs: docsRaw.map((d) => ({ category: d.category, slug: d.slug, title: d.title, summary: d.summary })),
      profileDir: join(globalDir, scope === 'project' ? 'projects' : 'profiles', profileId),
    };
  }

  private async sendProposals(): Promise<void> {
    const wid = this.getWorkspaceId();
    if (!wid) {
      this.onCount?.(0);
      this.postMessage({ type: 'proposal:data', user: EMPTY_SIDE, project: null });
      return;
    }
    const globalDir = getGlobalDir();
    const projectProfileId = await this.getProjectProfileId();
    const [user, project] = await Promise.all([
      this.readSide(globalDir, resolveProfile(wid), 'user'),
      projectProfileId
        ? this.readSide(globalDir, projectProfileId, 'project')
        : Promise.resolve(null),
    ]);
    // 뱃지는 양쪽 합계 — 어느 쪽에 올라왔든 볼 것이 있다는 뜻이다.
    this.onCount?.(user.proposals.length + (project?.proposals.length ?? 0));
    this.postMessage({ type: 'proposal:data', user, project });
  }

  // 어느 자리의 제안인지는 웹뷰가 실어 보낸다. 목록이 갈려 있으므로 id만으로는 못 가린다.
  private async resolveSide(scope: ProposalScope): Promise<string | null> {
    if (scope === 'project') return this.getProjectProfileId();
    const wid = this.getWorkspaceId();
    return wid ? resolveProfile(wid) : null;
  }

  private async handleApprove(id: string, scope: ProposalScope): Promise<void> {
    const profileId = await this.resolveSide(scope);
    if (!profileId || !id) return;
    try {
      await approveProposal(getGlobalDir(), profileId, id, scope);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      output.warn(`profilePanel: approve failed — ${msg}`);
      // 진짜 실패(권한·디스크 등)를 사용자에게 표면화 — output 로그만으론 안 보임.
      void vscode.window.showWarningMessage(vscode.l10n.t('AgentBridge: Failed to update the proposal — {0}.', msg));
    }
    await this.sendProposals();
  }

  private async handleDiscard(id: string, scope: ProposalScope): Promise<void> {
    const profileId = await this.resolveSide(scope);
    if (!profileId || !id) return;
    try {
      await discardProposal(getGlobalDir(), profileId, id, scope);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      output.warn(`profilePanel: discard failed — ${msg}`);
      void vscode.window.showWarningMessage(vscode.l10n.t('AgentBridge: Failed to update the proposal — {0}.', msg));
    }
    await this.sendProposals();
  }

  private async handleOpenFolder(scope: ProposalScope): Promise<void> {
    const profileId = await this.resolveSide(scope);
    if (!profileId) return;
    const dir = join(getGlobalDir(), scope === 'project' ? 'projects' : 'profiles', profileId);
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
  }

  private postMessage(msg: unknown): void {
    this.view?.webview.postMessage(msg);
  }

  // 라벨은 IDE 언어를 따른다(l10n). 데스크탑 ProfilePanel.tsx와 달리 기존엔 한국어 고정이었음.
  private labels() {
    return {
      scopeUser: vscode.l10n.t('User'),
      scopeProject: vscode.l10n.t('Project'),
      openFolder: vscode.l10n.t('Open folder'),
      openFolderTitle: vscode.l10n.t('Open profile folder (edit .md manually)'),
      approvalQueue: vscode.l10n.t('Approval queue'),
      noProposals: vscode.l10n.t('No pending proposals'),
      approve: vscode.l10n.t('Approve'),
      discard: vscode.l10n.t('Dismiss'),
      profileDocs: vscode.l10n.t('Profile documents'),
      noDocs: vscode.l10n.t('No documents yet. They fill in automatically as you work.'),
    };
  }

  // 아래 셋은 Context 웹뷰 문서에 끼워 넣는 조각이다. 선택자는 모두 #ltmBody 아래로
  // 묶어 같은 문서에 사는 Context 쪽 규칙(.empty 등)과 안 부딪히게 한다.
  css(): string {
    return /*css*/ `
    #ltmBody { padding: var(--pad); }
    #ltmBody .profile-loc {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 0 10px;
      margin-bottom: 8px;
      border-bottom: 2px solid var(--vscode-widget-border, #444);
    }
    #ltmBody .profile-loc-name {
      flex: 1;
      font-size: 12px;
      font-weight: 600;
      color: var(--vscode-foreground);
    }
    #ltmBody .open-folder {
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
    #ltmBody .open-folder:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.1));
    }
    #ltmBody .open-folder:disabled { opacity: 0.4; cursor: default; }
    #ltmBody .open-folder svg { width: 14px; height: 14px; fill: currentColor; }
    #ltmBody .segmented {
      display: flex;
      gap: 2px;
      padding: 2px;
      border-radius: 5px;
      background: var(--vscode-button-secondaryBackground, rgba(255,255,255,0.06));
      margin-bottom: 10px;
    }
    #ltmBody .segmented button {
      flex: 1;
      cursor: pointer;
      font: inherit;
      font-size: 11.5px;
      padding: 4px 0;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
    }
    #ltmBody .segmented button[aria-pressed="true"] {
      background: var(--vscode-editor-background, rgba(0,0,0,0.35));
      color: var(--vscode-foreground);
    }
    #ltmBody .seg-count {
      font-size: 9.5px;
      padding: 0 4px;
      border-radius: 7px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    /* 보고 있지 않은 쪽에 새 제안이 있으면 눈에 띄게 — 전환을 안 눌러도 알아야 한다. */
    #ltmBody .segmented button[aria-pressed="false"] .seg-count {
      background: var(--vscode-activityBarBadge-background, #0078d4);
      color: var(--vscode-activityBarBadge-foreground, #fff);
    }
    #ltmBody .sechead {
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
    #ltmBody .sechead-count {
      font-size: 10px;
      font-weight: normal;
      padding: 0 5px;
      border-radius: 8px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    #ltmBody .empty {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      font-size: 12px;
      text-align: center;
      padding: 16px 0;
    }
    #ltmBody .card {
      padding: 8px 10px;
      margin-bottom: 6px;
      border-radius: 6px;
      background: var(--vscode-editor-background, rgba(255,255,255,0.03));
      border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.08));
    }
    #ltmBody .card-cat {
      display: inline-block;
      padding: 1px 6px;
      margin-bottom: 4px;
      border-radius: 8px;
      font-size: 10px;
      font-weight: 500;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    #ltmBody .card-title {
      font-weight: 600;
      font-size: 13px;
      line-height: 1.4;
      margin-bottom: 3px;
    }
    #ltmBody .card-sub {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.4;
      margin-bottom: 4px;
    }
    #ltmBody .card-body {
      font-size: 12px;
      color: var(--vscode-foreground);
      line-height: 1.4;
      margin-bottom: 8px;
      word-break: break-word;
    }
    #ltmBody .card-acts { display: flex; gap: 6px; }
    #ltmBody .card-acts button {
      flex: 1;
      cursor: pointer;
      font-size: 12px;
      padding: 4px 0;
      border-radius: 4px;
      border: 1px solid transparent;
    }
    #ltmBody .card-acts button:disabled { opacity: 0.4; cursor: default; }
    #ltmBody .act-approve {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    #ltmBody .act-approve:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    #ltmBody .act-discard {
      background: var(--vscode-button-secondaryBackground, transparent);
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      border-color: var(--vscode-widget-border, #444);
    }
    #ltmBody .act-discard:hover:not(:disabled) {
      background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.1));
    }
    #ltmBody .doc-group { margin-bottom: 8px; }
    #ltmBody .doc-cat {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 3px;
    }
    #ltmBody .doc {
      padding: 4px 8px;
      border-radius: 4px;
    }
    #ltmBody .doc:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.04)); }
    #ltmBody .doc-title { font-size: 12px; line-height: 1.4; }
    #ltmBody .doc-summary {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.3;
    }
`;
  }

  bodyHtml(): string {
    const L = this.labels();
    return /*html*/ `
  <div class="segmented" id="scopeSwitch">
    <button type="button" data-scope="user" aria-pressed="true">${L.scopeUser}<span class="seg-count" id="userCount" hidden></span></button>
    <button type="button" data-scope="project" aria-pressed="false">${L.scopeProject}<span class="seg-count" id="projectCount" hidden></span></button>
  </div>
  <div class="profile-loc">
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M14.5 3H7.71l-.85-.85L6.51 2h-5l-.5.5v11l.5.5h13l.5-.5v-10L14.5 3zm-.51 8.49V13h-12V7h4.49l.35-.15.86-.86H14v1.5l-.01 4z"/></svg>
    <span class="profile-loc-name">default</span>
    <button id="openFolderBtn" class="open-folder" disabled title="${L.openFolderTitle}">
      <svg viewBox="0 0 16 16" fill="currentColor"><path d="M14.5 3H7.71l-.85-.85L6.51 2h-5l-.5.5v11l.5.5h13l.5-.5v-10L14.5 3zm-.51 8.49V13h-12V7h4.49l.35-.15.86-.86H14v1.5l-.01 4z"/></svg>
      ${L.openFolder}
    </button>
  </div>

  <div id="ltmContent"></div>
`;
  }

  // 같은 문서를 Context 쪽 스크립트와 나눠 쓴다 — 이름을 밖으로 흘리지 않게 감싼다.
  script(): string {
    const L = this.labels();
    return /*js*/ `
  (function () {
    const vscode = window.__abApi;
    const L = ${JSON.stringify(L)};
    const contentEl = document.getElementById('ltmContent');
    const openFolderBtn = document.getElementById('openFolderBtn');

    let busy = false;
    let scope = 'user';
    // 양쪽 데이터를 함께 받아두고 전환은 다시 그리기만 한다 — 누를 때마다 왕복하지 않는다.
    let sides = { user: { proposals: [], docs: [], profileDir: '' }, project: null };

    const switchEl = document.getElementById('scopeSwitch');
    const countEls = { user: document.getElementById('userCount'), project: document.getElementById('projectCount') };
    const locNameEl = document.querySelector('.profile-loc-name');

    switchEl.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-scope]');
      if (!btn || btn.getAttribute('data-scope') === scope) return;
      scope = btn.getAttribute('data-scope');
      paint();
    });

    openFolderBtn.addEventListener('click', () => {
      const side = sides[scope];
      if (!side || !side.profileDir) return;
      vscode.postMessage({ type: 'proposal:openFolder', scope: scope });
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
        sides = { user: msg.user || { proposals: [], docs: [], profileDir: '' }, project: msg.project || null };
        // 프로젝트 지식이 없는 저장소면 그쪽으로 못 넘어간다.
        if (!sides.project && scope === 'project') scope = 'user';
        paint();
      }
    });

    // 전환 상태와 목록을 한 번에 맞춘다.
    function paint() {
      switchEl.querySelectorAll('button[data-scope]').forEach((b) => {
        const s = b.getAttribute('data-scope');
        b.setAttribute('aria-pressed', String(s === scope));
        const n = s === 'user' ? sides.user.proposals.length : (sides.project ? sides.project.proposals.length : 0);
        countEls[s].textContent = String(n);
        countEls[s].hidden = n === 0;
      });
      const side = sides[scope] || { proposals: [], docs: [], profileDir: '' };
      const dirName = side.profileDir ? side.profileDir.split('/').filter(Boolean).pop() : '';
      locNameEl.textContent = dirName || '—';
      openFolderBtn.disabled = !side.profileDir;
      render(side.proposals, side.docs);
    }

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
          vscode.postMessage({ type: act === 'approve' ? 'proposal:approve' : 'proposal:discard', id: id, scope: scope });
        });
      });
    }

    // 섹션을 펼칠 때 호스트 쪽 스크립트가 부른다 — 접혀 있는 동안의 변화를 따라잡는다.
    window.__abLtmRefresh = function () { vscode.postMessage({ type: 'proposal:list' }); };

    vscode.postMessage({ type: 'proposal:list' });
  })();
`;
  }
}
