import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as output from '../log/output';
import * as workspaceStore from '../core/workspaceStore';
import { readIR } from '@agentbridge/core';
import { readAllTurns, listArchives } from '../core/turnsStore';
import { runManualCompaction, resetMemory } from '../core/compactionScheduler';
import { getHookDisabledReasons } from '../core/hookStatusStore';
import type { CliKind, IR } from '../shared/types';
import { collapseCommand } from './memoryPanelModel';

// 탭 선택과 접힌 섹션 목록이 사는 자리.
const UI_STATE_KEY = 'memoryPanel.ui';

export class MemoryPanelProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'agentbridge.memoryPanel';

  private view: vscode.WebviewView | undefined;

  // 탭 선택과 섹션 접힘. 레포가 아니라 사람에게 묶이는 값이라 전역 저장소에 둔다 (0.5.0 6단계).
  private readonly storage: vscode.Memento;

  constructor(storage: vscode.Memento) {
    this.storage = storage;
  }

  private readUiState(): { tab: string; collapsed: string[] } {
    const raw = this.storage.get<{ tab?: string; collapsed?: string[] }>(UI_STATE_KEY);
    return {
      tab: raw?.tab === 'turns' ? 'turns' : 'summary',
      collapsed: Array.isArray(raw?.collapsed) ? raw!.collapsed!.filter((k) => typeof k === 'string') : [],
    };
  }

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
        case 'ir:load':
          await this.sendIR();
          break;
        case 'ir:refine':
          await this.handleRefine();
          break;
        case 'memory:reset':
          await this.handleReset();
          break;
        case 'hookBadge:show':
          await this.handleHookBadgeShow(msg.items as Array<{ model: CliKind; reason: string }>);
          break;
        case 'ui:set':
          await this.storage.update(UI_STATE_KEY, { tab: msg.tab, collapsed: msg.collapsed });
          break;
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) void this.sendIR();
    });
  }

  notifyIRUpdated(): void {
    output.log(`memoryPanel: notifyIRUpdated called (view=${!!this.view})`);
    void this.sendIR();
  }

  private getWorkspaceId(): string | null {
    const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!folderUri) return null;
    return workspaceStore.getOrCreateWorkspaceId(folderUri.fsPath);
  }

  private async loadIR(workspaceId: string): Promise<IR | null> {
    // core readIR로 위임 — 손상(meta 누락) ir.json 방어 검증을 core와 공유 (V-14).
    return readIR(workspaceStore.getWorkspacePath(workspaceId));
  }

  private async sendIR(): Promise<void> {
    const wid = this.getWorkspaceId();
    if (!wid) {
      this.postMessage({ type: 'ir:data', ir: null, turns: [], archives: [], ui: this.readUiState() });
      return;
    }
    const [ir, turns, allArchives] = await Promise.all([this.loadIR(wid), readAllTurns(wid), listArchives(wid)]);

    let displayIR = ir;
    let archives = allArchives;
    if (!displayIR && allArchives.length > 0) {
      const latest = allArchives[0];
      try {
        const raw = await fs.readFile(latest.archivePath, 'utf8');
        const firstLine = raw.split('\n')[0];
        const meta = JSON.parse(firstLine) as { ir?: IR };
        if (meta.ir) displayIR = meta.ir as IR;
      } catch { /* fall through */ }
      archives = allArchives.slice(1);
    }

    const hookDisabled = getHookDisabledReasons(wid);
    output.log(`memoryPanel: sendIR — wid=${wid}, turnCount=${turns.length}, hasIR=${!!displayIR}, archives=${archives.length}, hookDisabled=${hookDisabled.length}, hasView=${!!this.view}`);
    this.postMessage({
      type: 'ir:data',
      ir: displayIR ? withCommandHeads(displayIR) : null,
      // 개수만 보내던 것을 본문까지 보낸다 (0.5.0 B-10). 최신이 위로 온다.
      turns: turns.slice().reverse(),
      archives,
      hookDisabled,
      ui: this.readUiState(),
    });
  }

  async runRefine(): Promise<void> {
    return this.handleRefine();
  }

  async runReset(): Promise<void> {
    return this.handleReset();
  }

  private async handleRefine(): Promise<void> {
    const wid = this.getWorkspaceId();
    if (!wid) {
      vscode.window.showWarningMessage(vscode.l10n.t('AgentBridge: No workspace open.'));
      return;
    }

    const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    const workspacePath = folderUri?.fsPath ?? '';

    // activeModel은 직전 IR의 lastModel 기준(없으면 claude). 정제 파이프라인 본체
    // (inFlight/disk lock · refine · IR write · 2-phase archive · ir:updated emit)는
    // core runManual이 담당 — 자동 compaction과 동일 경로로 통일, 호스트 중복 제거 (V-13).
    const currentIR = await this.loadIR(wid);
    const activeModel: CliKind = (currentIR?.meta.lastModel as CliKind) ?? 'claude';

    this.postMessage({ type: 'ir:refining', active: true });
    try {
      const result = await runManualCompaction(wid, activeModel, workspacePath, 60_000);
      if (result.ok) {
        vscode.window.showInformationMessage(vscode.l10n.t('AgentBridge: Refined ({0}ms)', result.durationMs));
      } else {
        vscode.window.showWarningMessage(vscode.l10n.t('AgentBridge: Refine failed — {0}', result.error ?? vscode.l10n.t('unknown error')));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      output.warn(`memoryPanel: refine failed — ${msg}`);
      vscode.window.showErrorMessage(vscode.l10n.t('AgentBridge: Refine failed — {0}', msg));
    } finally {
      this.postMessage({ type: 'ir:refining', active: false });
      await this.sendIR();
    }
  }

  private async handleHookBadgeShow(items: Array<{ model: CliKind; reason: string }>): Promise<void> {
    if (!items || items.length === 0) return;
    const names: Record<string, string> = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity' };
    const lines = items.map(x => `• ${names[x.model] ?? x.model}: ${x.reason}`).join('\n');
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t('Memory hook disabled') + `\n\n${lines}`,
      { modal: true },
      vscode.l10n.t('Copy'),
      vscode.l10n.t('Open Output'),
    );
    if (choice === vscode.l10n.t('Copy')) {
      await vscode.env.clipboard.writeText(lines);
    } else if (choice === vscode.l10n.t('Open Output')) {
      output.getOutputChannel().show();
    }
  }

  private async handleReset(): Promise<void> {
    const wid = this.getWorkspaceId();
    if (!wid) return;

    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t('AgentBridge: Reset all memory (IR + turns) for this workspace?'),
      { modal: true },
      vscode.l10n.t('Reset'),
    );
    if (answer !== vscode.l10n.t('Reset')) return;

    // V-06/V-14: reset도 compaction과 같은 락으로 직렬화하고, 쓰기 로직은 core resetMemory로 통합.
    const result = await resetMemory(wid);
    if (!result.ok) {
      if (result.error === 'compaction-in-progress') {
        vscode.window.showWarningMessage(
          vscode.l10n.t('AgentBridge: Memory compaction is in progress. Please try again in a moment.'),
        );
      } else {
        vscode.window.showErrorMessage(vscode.l10n.t('AgentBridge: Memory reset failed — {0}', result.error ?? vscode.l10n.t('unknown error')));
      }
      return;
    }

    output.log('memoryPanel: memory reset');
    vscode.window.showInformationMessage(vscode.l10n.t('AgentBridge: Memory reset.'));
    await this.sendIR();
  }

  private postMessage(msg: unknown): void {
    this.view?.webview.postMessage(msg);
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    // 웹뷰 JS는 host의 vscode.l10n.t()를 못 부르므로, 번역된 문자열을 HTML 빌드 시 주입한다.
    const l10nMemDisabled = vscode.l10n.t('Memory disabled');
    const l10nClickForDetails = vscode.l10n.t('Click for details');
    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <style nonce="${nonce}">
    :root { --pad: 10px; --radius: 6px; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      padding: var(--pad);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
    }
    .panel-header {
      display: flex;
      align-items: center;
      margin-bottom: 8px;
    }
    .panel-title {
      flex: 1;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-foreground);
    }
    .panel-actions { display: flex; gap: 2px; }
    .panel-actions button {
      background: transparent;
      border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      width: 24px;
      height: 24px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
    }
    .panel-actions button:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.1));
      color: var(--vscode-foreground);
    }
    .panel-actions button:disabled { opacity: 0.4; cursor: default; }
    .panel-actions button svg { width: 16px; height: 16px; fill: currentColor; }
    .status {
      display: flex;
      align-items: baseline;
      gap: 8px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 12px;
      padding: 6px 0 10px;
      border-bottom: 2px solid var(--vscode-widget-border, #444);
    }
    .status-turns {
      color: var(--vscode-foreground);
      font-weight: 600;
      font-size: 13px;
    }
    .status-time { font-size: 12px; }
    .status-sep { opacity: 0.4; }
    .status-model {
      text-transform: capitalize;
      font-size: 12px;
      margin-left: auto;
    }
    .section {
      margin-bottom: 10px;
    }
    .section-header {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 4px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #7DA1C7;
    }
    .section-count {
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
      padding: 20px 0;
    }
    .intent-goal {
      font-weight: 600;
      font-size: 13px;
      margin-bottom: 4px;
      line-height: 1.4;
    }
    .intent-meta {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .intent-role {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-top: 6px;
      margin-bottom: 4px;
      font-size: 11px;
      color: var(--vscode-foreground);
    }
    .intent-role-key {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #7DA1C7;
    }
    .intent-role-value {
      font-size: 10px;
      font-weight: normal;
      padding: 0 5px;
      border-radius: 8px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .items {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .item-row {
      display: flex;
      flex-direction: column;
      /* 세로 flex에서 flex-start면 자식 폭이 내용만큼 늘어난다 — 폭이 안 묶이면 말줄임이
         걸릴 자리가 없어 글자가 화면 밖으로 잘린다. */
      align-items: stretch;
      gap: 2px;
      padding: 3px 6px;
      border-radius: 3px;
      font-size: 12px;
      line-height: 1.4;
    }
    .item-row:hover {
      background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.04));
    }
    .item-label {
      color: var(--vscode-foreground);
    }
    .item-value {
      align-self: stretch;
      color: var(--vscode-foreground);
      word-break: break-word;
    }
    /* 배지 + 값이 한 줄로 서는 자리 (Files·Tests). 세부는 이 줄 아래로 붙는다 */
    .line {
      display: flex;
      align-items: baseline;
      gap: 8px;
      min-width: 0;
    }
    .line .item-value {
      flex: 1;
      align-self: auto;
    }
    /* 눌러서 펼친 세부 — 전체 줄과 딸린 설명 */
    .item-detail {
      padding-top: 3px;
      color: var(--vscode-descriptionForeground);
      font-size: 11.5px;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .item-row[data-item] { cursor: pointer; }
    .badge {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 8px;
      font-size: 10px;
      /* 줄 높이를 못 박는다 — 물려받으면 기록 탭처럼 줄 간격이 넓은 자리에서 배지만 두꺼워진다 */
      line-height: 1.4;
      flex: 0 0 auto;
      font-weight: 500;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .exit-code {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      flex: 0 0 auto;
      white-space: nowrap;
    }
    /* 상태 배지: 솔리드 박스 유지, 색상은 회색으로 통일하여 헤더 accent와 충돌 방지. */
    .badge.status-passed,
    .badge.status-failed,
    .badge.status-created,
    .badge.status-deleted,
    .badge.status-modified {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .archive-section {
      margin-top: 16px;
      padding-top: 12px;
      border-top: 2px solid var(--vscode-widget-border, #444);
    }
    .archive-header {
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
    }
    .archive-card {
      padding: 8px 10px;
      margin-bottom: 4px;
      border-radius: 6px;
      background: var(--vscode-editor-background, rgba(255,255,255,0.03));
      cursor: default;
      font-size: 12px;
    }
    .archive-card:hover {
      background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.06));
    }
    .archive-goal {
      font-weight: 500;
      margin-bottom: 3px;
      line-height: 1.3;
    }
    .archive-meta {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .spin { animation: spin 1s linear infinite; }
    .hook-badge {
      margin: 4px 2px 8px;
      padding: 4px 6px;
      border-radius: 4px;
      background: var(--vscode-inputValidation-warningBackground, rgba(255,170,0,0.12));
      border: 1px solid var(--vscode-inputValidation-warningBorder, rgba(255,170,0,0.5));
      color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground));
      font-size: 11px;
      line-height: 1.3;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .hook-badge-icon { flex: 0 0 auto; opacity: 0.9; }
    .hook-badge-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* ── 0.5.0 6단계: 탭 둘과 접기 ── */
    .hidden { display: none !important; }
    .tabs {
      display: flex;
      gap: 2px;
      margin-bottom: 10px;
      border-bottom: 1px solid var(--vscode-widget-border, #444);
    }
    .tab {
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
      padding: 5px 10px;
      font-family: inherit;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
    }
    .tab:hover { color: var(--vscode-foreground); }
    .tab.active {
      color: var(--vscode-foreground);
      border-bottom-color: var(--vscode-focusBorder, #0078d4);
    }
    .tab-count { font-size: 10px; opacity: 0.7; margin-left: 4px; }
    /* 머리줄은 눌러서 접는다 */
    .section-header, .goal-row { cursor: pointer; user-select: none; }
    .chev {
      flex: 0 0 auto;
      width: 9px;
      font-size: 9px;
      color: var(--vscode-descriptionForeground);
    }
    .goal-row { display: flex; gap: 6px; align-items: flex-start; }
    /* 목표 아래 설명 — 회색으로 내리고 접힌다 */
    .intent-detail { padding-top: 2px; }
    .intent-constraint {
      color: var(--vscode-descriptionForeground);
      font-size: 11.5px;
      line-height: 1.5;
      padding: 1px 0;
    }
    /* 한 줄로 자르고 전체는 마우스오버로 */
    .ellip {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .cmd-row { display: flex; gap: 6px; align-items: baseline; cursor: pointer; }
    .cmd-row .item-value { flex: 1; align-self: auto; }
    .cmd-full {
      padding: 2px 0 4px 15px;
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      line-height: 1.5;
      word-break: break-all;
    }
    /* ── 기록 탭 ── */
    .turn {
      border-left: 2px solid var(--vscode-widget-border, #444);
      padding-left: 8px;
      margin-bottom: 12px;
    }
    .turn-head {
      display: flex;
      gap: 6px;
      align-items: center;
      font-size: 10.5px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 3px;
    }
    .turn-model { font-weight: 600; text-transform: capitalize; color: #7DA1C7; }
    .turn-user {
      font-size: 12px;
      line-height: 1.5;
      margin-bottom: 4px;
      word-break: break-word;
      cursor: pointer;
    }
    .turn-body {
      font-size: 11.5px;
      line-height: 1.55;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 5px;
      word-break: break-word;
      cursor: pointer;
    }
    .turn-body.clip,
    .turn-user.clip {
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    /* 도구 호출이 길어지면 턴 하나가 화면을 다 먹는다 — 두 줄만 두고 나머지는 이 줄로 접는다. */
    .turn-more {
      font-size: 11px;
      line-height: 1.6;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      opacity: 0.8;
      letter-spacing: 0.5px;
    }
    .turn-more:hover { opacity: 1; }
    .turn-tools { display: flex; flex-direction: column; gap: 6px; }
    .turn-tool {
      display: flex;
      gap: 7px;
      align-items: baseline;
      padding: 1px 0;
      line-height: 1.6;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
    }
    .turn-tool .turn-tool-arg { min-width: 0; word-break: break-all; }
    .foot-note {
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px solid var(--vscode-widget-border, #333);
      font-size: 10.5px;
      line-height: 1.5;
      color: var(--vscode-descriptionForeground);
      opacity: 0.85;
    }
  </style>
</head>
<body>
  <div class="status" id="status">Loading...</div>
  <div id="hookBadge" class="hook-badge hidden"></div>
  <div class="tabs">
    <button class="tab active" data-tab="summary">Summary</button>
    <button class="tab" data-tab="turns">Turns <span class="tab-count" id="turnCount"></span></button>
  </div>
  <div id="paneSummary"></div>
  <div id="paneTurns" class="hidden"></div>

  <script nonce="${nonce}">
    // 요약(IR)과 기록(원본 턴)을 탭 둘로 가른다 (0.5.0 B-10). 기본은 제목이고 자세한 것은
    // 열거나 마우스를 올려서 본다. 접힘과 탭 선택은 호스트가 전역 저장소에 들고 있다.
    const vscode = acquireVsCodeApi();

    const statusEl = document.getElementById('status');
    const hookBadge = document.getElementById('hookBadge');
    const paneSummary = document.getElementById('paneSummary');
    const paneTurns = document.getElementById('paneTurns');
    const turnCountEl = document.getElementById('turnCount');

    let data = { ir: null, turns: [], archives: [] };
    let ui = { tab: 'summary', collapsed: [] };
    // 펼친 명령과 턴 본문 — 화면 안에서만 사는 값이라 저장하지 않는다.
    const openCmds = {};
    const openTurns = {};
    const openItems = {};
    const openTools = {};
    const openUsers = {};
    const openToolLists = {};

    function esc(s) {
      const d = document.createElement('div');
      d.textContent = s == null ? '' : String(s);
      return d.innerHTML;
    }

    function timeAgo(iso) {
      const t = new Date(iso).getTime();
      if (!t) return '';
      const mins = Math.floor((Date.now() - t) / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return mins + 'm ago';
      const hours = Math.floor(mins / 60);
      if (hours < 24) return hours + 'h ago';
      return Math.floor(hours / 24) + 'd ago';
    }

    function isCollapsed(key) { return ui.collapsed.indexOf(key) !== -1; }
    function bodyCls(key) { return isCollapsed(key) ? ' hidden' : ''; }

    // 눌러서 펼치는 항목. 펼치면 제목 줄의 잘림이 풀리고, 덧붙는 설명만 그 아래로 온다.
    // 제목을 세부에 한 번 더 찍지 않는다 — 같은 문장이 두 줄로 서면 무엇이 더해졌는지 안 보인다.
    function isItemOpen(key, i) { return openItems[key + ':' + i] === true; }
    function ellipCls(open) { return open ? '' : ' ellip'; }

    function itemRow(key, i, line, detail) {
      const open = isItemOpen(key, i);
      return '<div class="item-row" data-item="' + key + ':' + i + '">' + line +
        (detail ? '<div class="item-detail' + (open ? '' : ' hidden') + '">' + detail + '</div>' : '') +
        '</div>';
    }

    function sectionHeader(key, title, count) {
      return '<div class="section-header" data-toggle="' + key + '">' + title +
        (count !== undefined ? ' <span class="section-count">' + count + '</span>' : '') + '</div>';
    }

    // ── 요약 탭 ──────────────────────────────────────────────────────
    function renderSummary() {
      const ir = data.ir;
      let html = '';

      if (ir && ir.intent) {
        const det = [];
        if (ir.intent.role) det.push('<div class="intent-constraint">Role · ' + esc(ir.intent.role) + '</div>');
        (ir.intent.constraints || []).forEach(function (c) {
          det.push('<div class="intent-constraint">' + esc(c) + '</div>');
        });
        html += '<div class="section">';
        html += '<div class="goal-row" data-toggle="intent">' +
          '<span class="intent-goal">' + esc(ir.intent.goal) + '</span></div>';
        if (det.length) html += '<div class="intent-detail' + bodyCls('intent') + '">' + det.join('') + '</div>';
        html += '</div>';
      }

      // 결정은 주제만 선다. 무엇을 골랐는지와 왜는 마우스를 올리면 나온다.
      if (ir && ir.decisions && ir.decisions.length) {
        html += '<div class="section">' + sectionHeader('decisions', 'Decisions', ir.decisions.length);
        html += '<div class="items' + bodyCls('decisions') + '">';
        ir.decisions.forEach(function (d, i) {
          const tip = d.choice + (d.rationale ? '\\n\\n' + d.rationale : '');
          const line = '<span class="item-label' + ellipCls(isItemOpen('decisions', i)) +
            '" title="' + esc(tip) + '">' + esc(d.topic) + '</span>';
          const detail = esc(d.choice) + (d.rationale ? '\\n' + esc(d.rationale) : '');
          html += itemRow('decisions', i, line, detail);
        });
        html += '</div></div>';
      }

      // 명령은 접힌 줄(앞 두 낱말)만. 전문은 눌러서 본다. exit는 인자가 아니라 결말이라 남긴다.
      if (ir && ir.commands && ir.commands.length) {
        html += '<div class="section">' + sectionHeader('commands', 'Commands', ir.commands.length);
        html += '<div class="items' + bodyCls('commands') + '">';
        ir.commands.forEach(function (c, i) {
          const open = openCmds[i] === true;
          const exit = c.exitCode !== undefined ? '<span class="exit-code">(exit ' + esc(c.exitCode) + ')</span>' : '';
          html += '<div class="item-row"><div class="cmd-row" data-cmd="' + i + '">' +
            '<span class="chev">' + (open ? '▾' : '▸') + '</span>' +
            '<span class="item-value ellip">' + esc(c.head || c.cmd) + '</span>' + exit + '</div>' +
            '<div class="cmd-full' + (open ? '' : ' hidden') + '">' + esc(c.cmd) + '</div></div>';
        });
        html += '</div></div>';
      }

      // 파일은 배지 + 경로 그대로. 넘치는 줄만 자르고 전체는 마우스오버로.
      if (ir && ir.files && ir.files.length) {
        html += '<div class="section">' + sectionHeader('files', 'Files', ir.files.length);
        html += '<div class="items' + bodyCls('files') + '">';
        ir.files.forEach(function (f, i) {
          const line = '<div class="line"><span class="badge status-' + esc(f.status) + '">' +
            esc(f.status) + '</span><span class="item-value' + ellipCls(isItemOpen('files', i)) +
            '" title="' + esc(f.path) + '">' + esc(f.path) + '</span></div>';
          // 파일은 경로가 전부다 — 펼치면 잘림만 풀린다. 요약은 안 보여준다.
          html += itemRow('files', i, line, '');
        });
        html += '</div></div>';
      }

      if (ir && ir.tests && ir.tests.length) {
        html += '<div class="section">' + sectionHeader('tests', 'Tests', ir.tests.length);
        html += '<div class="items' + bodyCls('tests') + '">';
        ir.tests.forEach(function (t, i) {
          const line = '<div class="line"><span class="badge status-' + esc(t.status) + '">' +
            esc(t.status) + '</span><span class="item-value' + ellipCls(isItemOpen('tests', i)) +
            '" title="' + esc(t.failureSummary || t.name) + '">' + esc(t.name) + '</span></div>';
          html += itemRow('tests', i, line, t.failureSummary ? esc(t.failureSummary) : '');
        });
        html += '</div></div>';
      }

      if (ir && ir.pending && ir.pending.length) {
        html += '<div class="section">' + sectionHeader('pending', 'Pending', ir.pending.length);
        html += '<div class="items' + bodyCls('pending') + '">';
        ir.pending.forEach(function (p) {
          const next = p.nextStep ? '<div class="item-detail">' + esc(p.nextStep) + '</div>' : '';
          html += '<div class="item-row"><span class="item-value">' + esc(p.task) + '</span>' + next + '</div>';
        });
        html += '</div></div>';
      }

      if (!html) {
        html = '<div class="empty">' + (data.turns.length > 0
          ? 'Not refined yet. The turns are in the Turns tab.'
          : 'No memory yet. Start a session to begin.') + '</div>';
      }

      // 이전 스냅샷은 전부 선다. 필요 없으면 머리줄로 통째로 접는다.
      if (data.archives.length) {
        html += '<div class="archive-section">' +
          sectionHeader('archives', 'Previous snapshots', data.archives.length);
        html += '<div class="' + (isCollapsed('archives') ? 'hidden' : '') + '">';
        data.archives.forEach(function (a) {
          const chips = [];
          const c = a.counts || {};
          if (c.decisions) chips.push(c.decisions + ' decisions');
          if (c.files) chips.push(c.files + ' files');
          if (c.commands) chips.push(c.commands + ' cmds');
          if (c.tests) chips.push(c.tests + ' tests');
          if (c.pending) chips.push(c.pending + ' pending');
          html += '<div class="archive-card"><div class="archive-goal">' +
            esc(a.intentGoal || '(no goal)') + '</div>' +
            '<div class="archive-meta"><span>' + esc(timeAgo(a.updatedAt)) + '</span><span>' +
            esc(chips.join(' · ')) + '</span></div></div>';
        });
        html += '</div>';
        html += '<div class="foot-note">Older snapshots are dropped once the limit is reached. ' +
          'Conversations before these are no longer kept.</div>';
        html += '</div>';
      }

      paneSummary.innerHTML = html;
    }

    // ── 기록 탭 ──────────────────────────────────────────────────────
    const TOOL_PREVIEW = 2; // 접었을 때 남기는 도구 호출 줄 수
    function renderTurns() {
      if (!data.turns.length) {
        paneTurns.innerHTML = '<div class="empty">No turns recorded yet.</div>';
        return;
      }
      let html = '';
      data.turns.forEach(function (t, i) {
        const open = openTurns[i] === true;
        html += '<div class="turn">';
        html += '<div class="turn-head"><span class="turn-model">' + esc(t.model) + '</span><span>·</span><span>' +
          esc(timeAgo(t.completedAt || t.startedAt)) + '</span></div>';
        // 사용자 메시지도 답변과 같은 규칙 — 두 줄만 보이고 누르면 전문이 열린다.
        if (t.user) {
          html += '<div class="turn-user' + (openUsers[i] === true ? '' : ' clip') + '" data-user="' + i + '">' +
            esc(t.user) + '</div>';
        }
        if (t.assistantBody) {
          html += '<div class="turn-body' + (open ? '' : ' clip') + '" data-turn="' + i + '">' +
            esc(t.assistantBody) + '</div>';
        }
        if (t.toolCalls && t.toolCalls.length) {
          const listOpen = openToolLists[i] === true;
          const hidden = listOpen ? 0 : Math.max(0, t.toolCalls.length - TOOL_PREVIEW);
          const shown = hidden > 0 ? t.toolCalls.slice(0, TOOL_PREVIEW) : t.toolCalls;
          html += '<div class="turn-tools">';
          shown.forEach(function (tc, j) {
            // 요약 탭과 같은 규칙 — 누르면 그 줄의 잘림이 풀린다.
            const openTool = openTools[i + ':' + j] === true;
            html += '<div class="turn-tool" data-tool="' + i + ':' + j + '">' +
              '<span class="badge">' + esc(tc.tool) + '</span>' +
              '<span class="turn-tool-arg' + (openTool ? '' : ' ellip') + '" title="' + esc(tc.arg) + '">' +
              esc(tc.arg) + '</span></div>';
          });
          if (hidden > 0) {
            html += '<div class="turn-more" data-toolmore="' + i + '">\u22EF ' + hidden + ' more</div>';
          } else if (listOpen && t.toolCalls.length > TOOL_PREVIEW) {
            html += '<div class="turn-more" data-toolmore="' + i + '">\u22EF less</div>';
          }
          html += '</div>';
        }
        html += '</div>';
      });
      html += '<div class="foot-note">Turns already folded into a summary are under Previous snapshots.</div>';
      paneTurns.innerHTML = html;
    }

    function renderStatus() {
      const meta = (data.ir && data.ir.meta) || {};
      const segs = ['<span class="status-turns">' + data.turns.length + ' turns</span>'];
      if (meta.updatedAt) segs.push('<span class="status-time">' + esc(timeAgo(meta.updatedAt)) + '</span>');
      const right = meta.lastModel ? '<span class="status-model">' + esc(meta.lastModel) + '</span>' : '';
      statusEl.innerHTML = segs.join('<span class="status-sep">·</span>') + right;
      turnCountEl.textContent = data.turns.length ? String(data.turns.length) : '';
    }

    function renderTabs() {
      document.querySelectorAll('.tab').forEach(function (b) {
        b.classList.toggle('active', b.dataset.tab === ui.tab);
      });
      paneSummary.classList.toggle('hidden', ui.tab !== 'summary');
      paneTurns.classList.toggle('hidden', ui.tab !== 'turns');
    }

    function render() {
      renderStatus();
      renderTabs();
      renderSummary();
      renderTurns();
    }

    function saveUi() {
      vscode.postMessage({ type: 'ui:set', tab: ui.tab, collapsed: ui.collapsed });
    }

    document.addEventListener('click', function (e) {
      const tab = e.target.closest('.tab');
      if (tab) {
        ui.tab = tab.dataset.tab;
        renderTabs();
        saveUi();
        return;
      }
      const head = e.target.closest('[data-toggle]');
      if (head) {
        const key = head.dataset.toggle;
        const at = ui.collapsed.indexOf(key);
        if (at === -1) ui.collapsed.push(key); else ui.collapsed.splice(at, 1);
        renderSummary();
        saveUi();
        return;
      }
      const cmd = e.target.closest('[data-cmd]');
      if (cmd) {
        const i = cmd.dataset.cmd;
        openCmds[i] = !openCmds[i];
        renderSummary();
        return;
      }
      const item = e.target.closest('[data-item]');
      if (item) {
        const k = item.dataset.item;
        openItems[k] = !openItems[k];
        renderSummary();
        return;
      }
      const user = e.target.closest('[data-user]');
      if (user) {
        const i = user.dataset.user;
        openUsers[i] = !openUsers[i];
        renderTurns();
        return;
      }
      const toolMore = e.target.closest('[data-toolmore]');
      if (toolMore) {
        const i = toolMore.dataset.toolmore;
        openToolLists[i] = !openToolLists[i];
        renderTurns();
        return;
      }
      const tool = e.target.closest('[data-tool]');
      if (tool) {
        const k = tool.dataset.tool;
        openTools[k] = !openTools[k];
        renderTurns();
        return;
      }
      const turn = e.target.closest('[data-turn]');
      if (turn) {
        const i = turn.dataset.turn;
        openTurns[i] = !openTurns[i];
        renderTurns();
      }
    });

    let lastHookDisabled = [];
    function renderHookBadge(items) {
      lastHookDisabled = items || [];
      if (lastHookDisabled.length === 0) {
        hookBadge.classList.add('hidden');
        hookBadge.innerHTML = '';
        hookBadge.title = '';
        return;
      }
      const names = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity' };
      const labels = lastHookDisabled.map(function (x) { return names[x.model] || x.model; }).join(', ');
      const icon = '<svg class="hook-badge-icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5a.75.75 0 0 1 .67.42l6 12A.75.75 0 0 1 14 15H2a.75.75 0 0 1-.67-1.08l6-12A.75.75 0 0 1 8 1.5zm0 4.5a.75.75 0 0 0-.75.75v3a.75.75 0 0 0 1.5 0v-3A.75.75 0 0 0 8 6zm0 6.5a.875.875 0 1 0 0-1.75.875.875 0 0 0 0 1.75z"/></svg>';
      hookBadge.innerHTML = icon + '<span class="hook-badge-text">' + ${JSON.stringify(l10nMemDisabled)} + ' · ' + esc(labels) + '</span>';
      hookBadge.title = ${JSON.stringify(l10nClickForDetails)};
      hookBadge.classList.remove('hidden');
    }
    hookBadge.addEventListener('click', function () {
      if (lastHookDisabled.length === 0) return;
      vscode.postMessage({ type: 'hookBadge:show', items: lastHookDisabled });
    });

    window.addEventListener('message', function (e) {
      const msg = e.data;
      if (msg.type !== 'ir:data') return;
      data = { ir: msg.ir || null, turns: msg.turns || [], archives: msg.archives || [] };
      if (msg.ui) ui = { tab: msg.ui.tab || 'summary', collapsed: msg.ui.collapsed || [] };
      render();
      renderHookBadge(msg.hookDisabled || []);
    });

    vscode.postMessage({ type: 'ir:load' });
  </script>
</body>
</html>`;
  }
}

// 명령 줄의 접힌 형태를 호스트에서 만들어 붙인다 — 웹뷰가 계산하면 검증할 자리가 없다.
// IR 자체에는 없는 표시용 필드라 반환 타입을 따로 둔다(디스크의 ir.json은 안 바뀐다).
type DisplayIR = Omit<IR, 'commands'> & { commands: Array<IR['commands'][number] & { head: string }> };

function withCommandHeads(ir: IR): DisplayIR {
  return {
    ...ir,
    commands: (ir.commands ?? []).map((c) => ({ ...c, head: collapseCommand(c.cmd) })),
  };
}

function getNonce(): string {
  // CSP nonce는 예측 불가능해야 하므로 Math.random()이 아닌 crypto 난수 사용
  return randomBytes(16).toString('base64');
}
