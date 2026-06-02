import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import * as output from '../log/output';
import * as workspaceStore from '../core/workspaceStore';
import {
  readAllTurns,
  rewriteTurns,
  listArchives,
  stageCompactedTurns,
  commitArchive,
  abortArchive,
  type StagedArchive,
} from '../core/turnsStore';
import { buildCompactionPrompt } from '../core/irModule/prompt';
import { parseRefineOutput, assembleIR } from '../core/irModule/parse';
import { runRefine } from '../core/refineDispatcher';
import {
  acquireDiskLock,
  releaseDiskLock,
  markCompactionInFlight,
  unmarkCompactionInFlight,
  compactionEvents,
} from '../core/compactionScheduler';
import { getHookDisabledReasons } from '../core/hookStatusStore';
import type { CliKind, IR } from '../shared/types';

export class MemoryPanelProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'agentbridge.memoryPanel';

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
    const irPath = join(workspaceStore.getWorkspacePath(workspaceId), 'ir.json');
    try {
      const raw = await fs.readFile(irPath, 'utf8');
      return JSON.parse(raw) as IR;
    } catch {
      return null;
    }
  }

  private async sendIR(): Promise<void> {
    const wid = this.getWorkspaceId();
    if (!wid) {
      this.postMessage({ type: 'ir:data', ir: null, turnCount: 0 });
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
    this.postMessage({ type: 'ir:data', ir: displayIR, turnCount: turns.length, archives, hookDisabled });
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
      vscode.window.showWarningMessage('AgentBridge: No workspace open.');
      return;
    }

    const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    const workspacePath = folderUri?.fsPath ?? '';

    const turns = await readAllTurns(wid);
    if (turns.length === 0) {
      vscode.window.showInformationMessage('AgentBridge: No turns to refine.');
      return;
    }

    // Coordinate with compactionScheduler: in-process inFlight guard + cross-process disk lock.
    // Prevents the manual Refine path from racing with background auto-compaction over ir.json/turns.jsonl.
    if (!markCompactionInFlight(wid)) {
      vscode.window.showWarningMessage('AgentBridge: Compaction already in progress.');
      return;
    }
    let holdsDiskLock = false;

    this.postMessage({ type: 'ir:refining', active: true });

    try {
      holdsDiskLock = await acquireDiskLock(wid);
      if (!holdsDiskLock) {
        vscode.window.showWarningMessage('AgentBridge: Another process holds the compaction lock — try again shortly.');
        return;
      }

      const currentIR = await this.loadIR(wid);
      const activeModel: CliKind = (currentIR?.meta.lastModel as CliKind) ?? 'claude';
      const prompt = buildCompactionPrompt({
        fromModel: activeModel,
        workspacePath,
        turns,
        currentIR,
      });

      const dispatch = await runRefine({
        activeModel,
        prompt,
        cwd: workspacePath,
        timeoutMs: 60_000,
      });

      const parsed = parseRefineOutput(dispatch.result.assistantText);
      if (!parsed.ok) {
        vscode.window.showWarningMessage(`AgentBridge: Refine parse failed — ${parsed.error}`);
        return;
      }

      const ir = await assembleIR({
        contextId: wid,
        body: parsed.body,
        fromModel: activeModel,
        workspacePath,
        previousIR: currentIR,
      });

      const irPath = join(workspaceStore.getWorkspacePath(wid), 'ir.json');
      const tmp = `${irPath}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(ir, null, 2), 'utf8');
      await fs.rename(tmp, irPath);

      // 2-phase commit (matches compactionScheduler auto path) — archive the dropped turns
      // so users can browse history. Stage first; commit only after rewriteTurns succeeds.
      const keepRecent = 3;
      const dropped = turns.length > keepRecent ? turns.slice(0, turns.length - keepRecent) : [];
      let staged: StagedArchive | null = null;
      if (currentIR && dropped.length > 0) {
        try {
          staged = await stageCompactedTurns(wid, dropped, currentIR);
        } catch (err) {
          output.warn(`memoryPanel: archive stage failed — ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (dropped.length > 0) {
        try {
          await rewriteTurns(wid, turns.slice(turns.length - keepRecent));
        } catch (err) {
          if (staged) await abortArchive(staged);
          throw err;
        }
      }

      if (staged) {
        try {
          await commitArchive(staged);
        } catch (err) {
          output.warn(`memoryPanel: archive commit failed — ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      output.log(`memoryPanel: manual refine complete (archived=${dropped.length}, kept=${Math.min(turns.length, keepRecent)})`);
      compactionEvents.emit('ir:updated', wid);
      vscode.window.showInformationMessage(`AgentBridge: Refined with ${dispatch.spawnedModel} (${dispatch.result.durationMs}ms)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      output.warn(`memoryPanel: refine failed — ${msg}`);
      vscode.window.showErrorMessage(`AgentBridge: Refine failed — ${msg}`);
    } finally {
      if (holdsDiskLock) await releaseDiskLock(wid);
      unmarkCompactionInFlight(wid);
      this.postMessage({ type: 'ir:refining', active: false });
      await this.sendIR();
    }
  }

  private async handleHookBadgeShow(items: Array<{ model: CliKind; reason: string }>): Promise<void> {
    if (!items || items.length === 0) return;
    const names: Record<string, string> = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity' };
    const lines = items.map(x => `• ${names[x.model] ?? x.model}: ${x.reason}`).join('\n');
    const choice = await vscode.window.showWarningMessage(
      `메모리 hook 비활성\n\n${lines}`,
      { modal: true },
      'Copy',
      'Open Output',
    );
    if (choice === 'Copy') {
      await vscode.env.clipboard.writeText(lines);
    } else if (choice === 'Open Output') {
      output.getOutputChannel().show();
    }
  }

  private async handleReset(): Promise<void> {
    const wid = this.getWorkspaceId();
    if (!wid) return;

    const answer = await vscode.window.showWarningMessage(
      'AgentBridge: Reset all memory (IR + turns) for this workspace?',
      { modal: true },
      'Reset',
    );
    if (answer !== 'Reset') return;

    const wsPath = workspaceStore.getWorkspacePath(wid);
    const irPath = join(wsPath, 'ir.json');
    const turnsPath = join(wsPath, 'turns.jsonl');
    const archiveDir = join(wsPath, 'archive');

    try { await fs.unlink(irPath); } catch { /* may not exist */ }
    try { await fs.unlink(turnsPath); } catch { /* may not exist */ }
    try {
      const files = await fs.readdir(archiveDir);
      for (const f of files) {
        try { await fs.unlink(join(archiveDir, f)); } catch { /* skip */ }
      }
    } catch { /* archive dir may not exist */ }

    output.log('memoryPanel: memory reset');
    vscode.window.showInformationMessage('AgentBridge: Memory reset.');
    await this.sendIR();
  }

  private postMessage(msg: unknown): void {
    this.view?.webview.postMessage(msg);
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
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
      align-items: flex-start;
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
      color: var(--vscode-descriptionForeground);
      word-break: break-word;
    }
    /* FILES 섹션은 이전처럼 좌우 레이아웃 유지 — 상태 배지 + 경로 */
    .item-row-h {
      flex-direction: row;
      align-items: baseline;
      gap: 8px;
    }
    .item-row-h .item-value {
      flex: 1;
      align-self: auto;
      color: var(--vscode-foreground);
    }
    .badge {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 8px;
      font-size: 10px;
      font-weight: 500;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .exit-code {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
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
    .archive-more {
      background: transparent;
      border: none;
      color: var(--vscode-textLink-foreground, #3794ff);
      font-size: 11px;
      cursor: pointer;
      padding: 4px 0;
    }
    .archive-more:hover { text-decoration: underline; }
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
  </style>
</head>
<body>
  <div class="status" id="status">Loading...</div>
  <div id="hookBadge" class="hook-badge" style="display:none"></div>
  <div id="content"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const statusEl = document.getElementById('status');
    const contentEl = document.getElementById('content');
    const hookBadge = document.getElementById('hookBadge');

    let lastHookDisabled = [];
    function renderHookBadge(items) {
      lastHookDisabled = items || [];
      if (lastHookDisabled.length === 0) { hookBadge.style.display = 'none'; hookBadge.innerHTML = ''; hookBadge.title = ''; return; }
      const names = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity' };
      const labels = lastHookDisabled.map(x => names[x.model] || x.model).join(', ');
      const icon = '<svg class="hook-badge-icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5a.75.75 0 0 1 .67.42l6 12A.75.75 0 0 1 14 15H2a.75.75 0 0 1-.67-1.08l6-12A.75.75 0 0 1 8 1.5zm0 4.5a.75.75 0 0 0-.75.75v3a.75.75 0 0 0 1.5 0v-3A.75.75 0 0 0 8 6zm0 6.5a.875.875 0 1 0 0-1.75.875.875 0 0 0 0 1.75z"/></svg>';
      hookBadge.innerHTML = icon + '<span class="hook-badge-text">메모리 비활성 · ' + escapeHtml(labels) + '</span>';
      hookBadge.title = '자세히 보려면 클릭';
      hookBadge.style.display = '';
    }
    hookBadge.addEventListener('click', () => {
      if (lastHookDisabled.length === 0) return;
      vscode.postMessage({ type: 'hookBadge:show', items: lastHookDisabled });
    });

    function escapeHtml(s) {
      const d = document.createElement('div');
      d.textContent = s == null ? '' : String(s);
      return d.innerHTML;
    }

    // Refine / Reset 버튼은 view title 메뉴(VS Code 네이티브 아이콘)로 이동 — 이 panel 내부에서
    // ir:refine, memory:reset 메시지는 더 이상 발송하지 않으며, ir:refining 진행 상태도 표시 안 함.

    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.type === 'ir:data') {
        renderIR(msg.ir, msg.turnCount, msg.archives || []);
        renderHookBadge(msg.hookDisabled || []);
      }
    });

    const ARCHIVE_INITIAL = 5;
    let showAllArchive = false;

    function renderIR(ir, turnCount, archives) {
      lastIR = ir;
      lastTurnCount = turnCount;
      lastArchives = archives;
      if (!ir) {
        statusEl.textContent = turnCount > 0
          ? turnCount + ' turns recorded (not yet refined)'
          : 'No memory yet. Start a session to begin.';
        contentEl.innerHTML = turnCount > 0 ? '' : '<div class="empty">Start a session to begin.</div>';
        if (archives.length > 0) contentEl.innerHTML += renderArchives(archives);
        bindArchiveMore();
        return;
      }

      const meta = ir.meta || {};
      const leftSegs = ['<span class="status-turns">' + turnCount + ' turns</span>'];
      if (meta.updatedAt) leftSegs.push('<span class="status-time">' + esc(timeAgo(meta.updatedAt)) + '</span>');
      const left = leftSegs.join('<span class="status-sep">·</span>');
      const right = meta.lastModel ? '<span class="status-model">' + esc(meta.lastModel) + '</span>' : '';
      statusEl.innerHTML = left + right;

      let html = '';

      if (ir.intent) {
        html += '<div class="section">';
        html += '<div class="intent-goal">' + esc(ir.intent.goal) + '</div>';
        if (ir.intent.role) html += '<div class="intent-role"><span class="intent-role-key">Role</span><span class="intent-role-value">' + esc(ir.intent.role) + '</span></div>';
        if (ir.intent.constraints && ir.intent.constraints.length) {
          html += '<div class="items">';
          ir.intent.constraints.forEach(c => {
            html += '<div class="item-row"><span class="item-label">' + esc(c) + '</span></div>';
          });
          html += '</div>';
        }
        html += '</div>';
      }

      if (ir.decisions && ir.decisions.length) {
        html += '<div class="section">';
        html += '<div class="section-header">Decisions <span class="section-count">' + ir.decisions.length + '</span></div>';
        html += '<div class="items">';
        ir.decisions.forEach(d => {
          html += '<div class="item-row"><span class="item-label">' + esc(d.topic) + '</span><span class="item-value">' + esc(d.choice) + '</span></div>';
        });
        html += '</div></div>';
      }

      if (ir.files && ir.files.length) {
        html += '<div class="section">';
        html += '<div class="section-header">Files <span class="section-count">' + ir.files.length + '</span></div>';
        html += '<div class="items">';
        ir.files.forEach(f => {
          html += '<div class="item-row item-row-h"><span class="badge status-' + esc(f.status) + '">' + esc(f.status) + '</span><span class="item-value">' + esc(f.path) + '</span></div>';
        });
        html += '</div></div>';
      }

      if (ir.commands && ir.commands.length) {
        html += '<div class="section">';
        html += '<div class="section-header">Commands <span class="section-count">' + ir.commands.length + '</span></div>';
        html += '<div class="items">';
        ir.commands.forEach(c => {
          const exit = c.exitCode !== undefined ? ' <span class="exit-code">(exit ' + c.exitCode + ')</span>' : '';
          html += '<div class="item-row"><span class="item-value">' + esc(c.cmd) + exit + '</span></div>';
        });
        html += '</div></div>';
      }

      if (ir.tests && ir.tests.length) {
        html += '<div class="section">';
        html += '<div class="section-header">Tests <span class="section-count">' + ir.tests.length + '</span></div>';
        html += '<div class="items">';
        ir.tests.forEach(t => {
          html += '<div class="item-row"><span class="badge status-' + esc(t.status) + '">' + esc(t.status) + '</span><span class="item-value">' + esc(t.name) + '</span></div>';
        });
        html += '</div></div>';
      }

      if (ir.pending && ir.pending.length) {
        html += '<div class="section">';
        html += '<div class="section-header">Pending <span class="section-count">' + ir.pending.length + '</span></div>';
        html += '<div class="items">';
        ir.pending.forEach(p => {
          const next = p.nextStep ? '<span class="intent-meta"> → ' + esc(p.nextStep) + '</span>' : '';
          html += '<div class="item-row"><span class="item-value">' + esc(p.task) + next + '</span></div>';
        });
        html += '</div></div>';
      }

      if (!html) html = '<div class="empty">IR is empty.</div>';
      if (archives.length > 0) html += renderArchives(archives);
      contentEl.innerHTML = html;
      bindArchiveMore();
    }

    function renderArchives(archives) {
      const visible = showAllArchive ? archives : archives.slice(0, ARCHIVE_INITIAL);
      let html = '<div class="archive-section">';
      html += '<div class="archive-header">Previous snapshots · ' + archives.length + '</div>';
      visible.forEach(a => {
        const goal = a.intentGoal ? esc(a.intentGoal) : '(no goal)';
        const c = a.counts;
        const chips = [];
        if (c.decisions) chips.push(c.decisions + ' decisions');
        if (c.files) chips.push(c.files + ' files');
        if (c.commands) chips.push(c.commands + ' cmds');
        if (c.tests) chips.push(c.tests + ' tests');
        if (c.pending) chips.push(c.pending + ' pending');
        const time = a.updatedAt ? timeAgo(a.updatedAt) : '';
        html += '<div class="archive-card">';
        html += '<div class="archive-goal">' + goal + '</div>';
        html += '<div class="archive-meta"><span>' + time + '</span><span>' + chips.join(' · ') + '</span></div>';
        html += '</div>';
      });
      if (archives.length > ARCHIVE_INITIAL) {
        html += '<button class="archive-more" id="archiveMoreBtn">' +
          (showAllArchive ? 'Collapse' : '+ ' + (archives.length - ARCHIVE_INITIAL) + ' more') +
          '</button>';
      }
      html += '</div>';
      return html;
    }

    let lastIR = null;
    let lastTurnCount = 0;
    let lastArchives = [];

    function bindArchiveMore() {
      const btn = document.getElementById('archiveMoreBtn');
      if (btn) {
        btn.addEventListener('click', () => {
          showAllArchive = !showAllArchive;
          renderIR(lastIR, lastTurnCount, lastArchives);
        });
      }
    }

    function timeAgo(iso) {
      const diff = Date.now() - new Date(iso).getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return mins + 'm ago';
      const hours = Math.floor(mins / 60);
      if (hours < 24) return hours + 'h ago';
      return Math.floor(hours / 24) + 'd ago';
    }

    function esc(s) {
      if (!s) return '';
      const d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }

    vscode.postMessage({ type: 'ir:load' });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  // CSP nonce는 예측 불가능해야 하므로 Math.random()이 아닌 crypto 난수 사용
  return randomBytes(16).toString('base64');
}
