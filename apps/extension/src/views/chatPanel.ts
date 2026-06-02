import * as vscode from 'vscode';
import * as pty from 'node-pty';
import { randomBytes } from 'crypto';
import { chmodSync } from 'fs';
import { join } from 'path';
import * as output from '../log/output';
import { TurnRecorder } from '../core/turnRecorder';
import { PtyDisplayFilter } from '../core/ptyDisplayFilter';
import { getSessions, renameSession, deleteSession, setModelSessionId } from '../core/sessionRegistry';
import { captureNewThreadId } from '../core/cliAdapter/codexSessionWatcher';
import { watchForNewConversationUuid } from '../core/cliAdapter/agyResume';
import * as workspaceStore from '../core/workspaceStore';
import { CLI_DISPLAY_NAME, type CliKind } from '../shared/types';
import { quoteCommandLine } from '../shared/shellQuote';
import type { SpawnOptions } from '../pty/types';

const activePanels = new Map<string, ChatPanel>();

// 채팅 패널이 활성화될 때 emit. extension.ts가 받아서 사이드 패널 selection 동기화.
export const chatPanelEvents = new vscode.EventEmitter<{ sessionId: string }>();

export function getActivePanel(sessionId: string): ChatPanel | undefined {
  return activePanels.get(sessionId);
}

export function getAllPanels(): ChatPanel[] {
  return Array.from(activePanels.values());
}

export class ChatPanel {
  private panel: vscode.WebviewPanel;
  private ptyProcess: pty.IPty | null = null;
  private recorder: TurnRecorder | null = null;
  private displayFilter = (() => {
    const f = new PtyDisplayFilter();
    f.setForceUnblockHandler(() => {
      // watchdog가 force unblock하면 빈 데이터를 다시 흘려서 webview에 신호.
      // (xterm은 이미 데이터를 받았으면 자체 렌더링하지만, suppress된 chunk를 복구할 수는 없음.)
      this.panel.webview.postMessage({ type: 'output', data: '\r\n[AgentBridge] hook block watchdog fired — output may have been truncated\r\n' });
    });
    return f;
  })();
  private disposed = false;
  private deletedExternally = false;
  private modelSessionWatchAbort: AbortController | null = null;
  private readonly opts: SpawnOptions;
  private readonly extensionUri: vscode.Uri;
  private onDisposeCallback: (() => void) | null = null;

  markDeleted(): void {
    this.deletedExternally = true;
  }

  static create(
    extensionUri: vscode.Uri,
    opts: SpawnOptions,
  ): ChatPanel {
    // split이 이미 2개 이상이면 가장 오른쪽 기존 컬럼에 탭으로 추가. 1개면 Beside로 새 split.
    const groups = vscode.window.tabGroups.all;
    const targetColumn = groups.length >= 2
      ? groups[groups.length - 1].viewColumn
      : vscode.ViewColumn.Beside;

    const panel = vscode.window.createWebviewPanel(
      'agentbridge.chat',
      opts.terminalName,
      { viewColumn: targetColumn, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'node_modules', '@xterm', 'xterm', 'css'),
          vscode.Uri.joinPath(extensionUri, 'node_modules', '@xterm', 'xterm', 'lib'),
          vscode.Uri.joinPath(extensionUri, 'node_modules', '@xterm', 'addon-fit', 'lib'),
          vscode.Uri.joinPath(extensionUri, 'node_modules', '@xterm', 'addon-webgl', 'lib'),
          vscode.Uri.joinPath(extensionUri, 'node_modules', '@xterm', 'addon-unicode11', 'lib'),
        ],
      },
    );

    return new ChatPanel(panel, extensionUri, opts);
  }

  static revive(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    opts: SpawnOptions,
  ): ChatPanel {
    return new ChatPanel(panel, extensionUri, opts);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    opts: SpawnOptions,
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.opts = opts;

    if (opts.sessionId) activePanels.set(opts.sessionId, this);

    const modelIcon = `model-${opts.model ?? 'claude'}.png`;
    this.panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, 'media', modelIcon),
      dark: vscode.Uri.joinPath(extensionUri, 'media', modelIcon),
    };

    this.panel.webview.html = this.buildHtml();

    this.panel.webview.onDidReceiveMessage((msg) => {
      switch (msg.type) {
        case 'ready':
          this.spawnPty(msg.cols ?? 120, msg.rows ?? 30);
          break;
        case 'log':
          output.log(`[webview] ${msg.data}`);
          break;
        case 'attachSave':
          void this.handleAttachSave(msg.reqId, msg.name, msg.base64);
          break;
        case 'input':
          this.recorder?.onUserInput(msg.data);
          this.ptyProcess?.write(msg.data);
          break;
        case 'resize':
          try {
            this.ptyProcess?.resize(msg.cols, msg.rows);
          } catch { /* pty may have exited */ }
          break;
        case 'getSessions':
          this.handleGetSessions();
          break;
        case 'openSession':
          vscode.commands.executeCommand('agentbridge.openSession', {
            sessionId: msg.sessionId,
            workspaceId: msg.workspaceId,
            model: msg.model,
          });
          break;
        case 'renameSession':
          this.handleRenameSession(msg.workspaceId, msg.sessionId, msg.currentName);
          break;
        case 'deleteSession':
          this.handleDeleteSession(msg.workspaceId, msg.sessionId, msg.name);
          break;
        case 'newSession':
          vscode.commands.executeCommand('agentbridge.newSession');
          break;
        case 'newSessionWithModel':
          vscode.commands.executeCommand('agentbridge.newSessionWithModel', msg.model);
          break;
      }
    });

    this.panel.onDidDispose(() => {
      this.dispose();
    });

    this.panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active && this.opts.sessionId) {
        chatPanelEvents.fire({ sessionId: this.opts.sessionId });
      }
    });

    // 패널이 active 상태로 생성되었을 때 초기 fire — onDidChangeViewState는 변화만 감지하므로.
    if (this.opts.sessionId && this.panel.active) {
      setTimeout(() => {
        if (!this.disposed && this.opts.sessionId) {
          chatPanelEvents.fire({ sessionId: this.opts.sessionId });
        }
      }, 50);
    }
  }

  get sessionId(): string {
    return this.opts.sessionId ?? '';
  }

  get model(): CliKind {
    return this.opts.model ?? 'claude';
  }

  onDispose(cb: () => void): void {
    this.onDisposeCallback = cb;
  }

  reveal(): void {
    this.panel.reveal(undefined, false);
  }

  private spawnPty(cols: number, rows: number): void {
    const { command, args, cwd, env } = this.opts;
    output.log(`ChatPanel PTY spawn: ${command} ${args.join(' ')} (${cols}x${rows})`);

    const ptyEnv = {
      ...env,
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    };

    try {
      this.ensureSpawnHelperExecutable();
      const shellCmd = quoteCommandLine([command, ...args]);
      this.ptyProcess = pty.spawn('/bin/zsh', ['-lc', `exec ${shellCmd}`], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: ptyEnv,
      });

      output.log(`ChatPanel PTY pid=${this.ptyProcess.pid}`);

      if (this.opts.model && this.opts.workspaceId && this.opts.sessionId) {
        this.recorder = new TurnRecorder(
          this.opts.workspaceId,
          this.opts.sessionId,
          this.opts.model,
          this.opts.cwd,
        );
      }

      this.ptyProcess.onData((data) => {
        const filtered = this.displayFilter.filter(data);
        this.recorder?.onAssistantData(filtered);
        if (!this.disposed && filtered) {
          this.panel.webview.postMessage({ type: 'output', data: filtered });
        }
      });

      this.startModelSessionIdWatcher();

      this.ptyProcess.onExit(({ exitCode, signal }) => {
        output.log(`ChatPanel PTY exited: code=${exitCode} signal=${signal ?? 'none'}`);
        this.modelSessionWatchAbort?.abort();
        if (!this.disposed) {
          this.panel.webview.postMessage({
            type: 'output',
            data: `\r\n[AgentBridge] Process exited (code=${exitCode}). Close this tab when ready.\r\n`,
          });
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      output.error(`ChatPanel PTY spawn failed: ${msg}`);
      this.panel.webview.postMessage({
        type: 'output',
        data: `\r\n[AgentBridge] Failed to spawn: ${msg}\r\n`,
      });
    }
  }

  // codex/agy modelSessionId 후처리 캡처 — spawn 직후 fire-and-forget.
  // codex: ~/.codex/sessions 스냅샷 diff로 thread_id 파일명 추출.
  // agy:   ~/.gemini/antigravity-cli/cache/last_conversations.json polling으로 cwd→UUID 매핑 캡처.
  // 캡처되면 sessionRegistry.setModelSessionId로 영속화 → 다음 reopen에서 resume 인자 생성.
  private startModelSessionIdWatcher(): void {
    const { workspaceId, sessionId, codexSessionSnapshot, agyWatchUuid, cwd, model } = this.opts;
    if (!workspaceId || !sessionId) return;

    const persist = (modelSessionId: string): void => {
      void setModelSessionId(workspaceId, sessionId, modelSessionId).catch((err) => {
        output.warn(`ChatPanel: setModelSessionId 실패 — ${String(err)}`);
      });
    };

    if (model === 'codex' && codexSessionSnapshot) {
      const ctrl = new AbortController();
      this.modelSessionWatchAbort = ctrl;
      void captureNewThreadId(codexSessionSnapshot, { signal: ctrl.signal })
        .then((threadId) => persist(threadId))
        .catch((err) => {
          output.warn(`ChatPanel: codex thread_id 캡처 실패 — ${String(err)}`);
        });
    } else if (model === 'agy' && agyWatchUuid && cwd) {
      const ctrl = new AbortController();
      this.modelSessionWatchAbort = ctrl;
      void watchForNewConversationUuid({
        cwd,
        excludeUuids: agyWatchUuid.excludeUuids,
        abortSignal: ctrl.signal,
        onCaptured: (uuid) => persist(uuid),
      }).catch((err) => {
        output.warn(`ChatPanel: agy UUID 캡처 실패 — ${String(err)}`);
      });
    }
  }

  private ensureSpawnHelperExecutable(): void {
    try {
      const nodePtyPath = require.resolve('node-pty');
      const prebuildsDir = join(nodePtyPath, '..', '..', 'prebuilds');
      const helpers = [
        join(prebuildsDir, 'darwin-arm64', 'spawn-helper'),
        join(prebuildsDir, 'darwin-x64', 'spawn-helper'),
      ];
      for (const h of helpers) {
        try { chmodSync(h, 0o755); } catch { /* may not exist */ }
      }
    } catch {
      output.warn('Could not auto-fix spawn-helper permissions');
    }
  }

  private async handleAttachSave(reqId: string, name: string, base64: string): Promise<void> {
    try {
      const { attachmentPathFor, writeAttachment } = await import('../core/attachmentStore');
      const path = await import('path');
      const safeName = (name || 'file').replace(/[\\/]/g, '_').slice(-150);
      const ts = Date.now();
      const filename = `${ts}-${safeName}`;
      const wid = this.opts.workspaceId ?? 'no-workspace';
      const sid = this.opts.sessionId ?? 'no-session';
      const absPath = attachmentPathFor(wid, sid, filename);
      await writeAttachment(absPath, base64);
      // cwd 기준 relative — @ mention 단축용. 외부 cwd이면 절대경로 fallback.
      const rel = path.relative(this.opts.cwd, absPath);
      const useRel = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
      const insertPath = useRel ? rel : absPath;
      output.log(`attachment saved: ${absPath} → "${insertPath}"`);
      this.panel.webview.postMessage({ type: 'attachSaved', reqId, path: insertPath });
    } catch (err) {
      output.warn(`attachment save failed: ${err instanceof Error ? err.message : String(err)}`);
      this.panel.webview.postMessage({ type: 'attachSaved', reqId, path: null });
    }
  }

  private async handleGetSessions(): Promise<void> {
    const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!folderUri) {
      this.panel.webview.postMessage({ type: 'sessions', sessions: [] });
      return;
    }
    const wid = workspaceStore.getOrCreateWorkspaceId(folderUri.fsPath);
    const sessions = await getSessions(wid);
    this.panel.webview.postMessage({ type: 'sessions', sessions });
  }

  private async handleRenameSession(workspaceId: string, sessionId: string, currentName: string): Promise<void> {
    const newName = await vscode.window.showInputBox({ prompt: 'Session name', value: currentName });
    if (newName === undefined) return;
    await renameSession(workspaceId, sessionId, newName);
    this.handleGetSessions();
  }

  private async handleDeleteSession(workspaceId: string, sessionId: string, name: string): Promise<void> {
    const answer = await vscode.window.showWarningMessage(`Delete session "${name}"?`, { modal: true }, 'Delete');
    if (answer !== 'Delete') return;
    const activePanel = activePanels.get(sessionId);
    if (activePanel) activePanel.markDeleted();
    if (activePanel && activePanel !== this) activePanel.dispose();
    await deleteSession(workspaceId, sessionId);
    this.handleGetSessions();
    if (activePanel === this) this.panel.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.opts.sessionId) activePanels.delete(this.opts.sessionId);

    this.modelSessionWatchAbort?.abort();
    this.recorder?.dispose();
    this.displayFilter.dispose();

    if (this.ptyProcess) {
      try { this.ptyProcess.kill(); } catch { /* already exited */ }
      // SIGKILL fallback after grace period. `disposed` guard above prevents re-entry,
      // so we don't need to track the timer handle — fire-and-forget is intentional.
      setTimeout(() => {
        try { this.ptyProcess?.kill('SIGKILL' as unknown as string); } catch { /* gone */ }
      }, 3000);
    }

    try { this.panel.dispose(); } catch { /* already disposed */ }

    if (!this.deletedExternally) this.onDisposeCallback?.();
  }

  private buildHtml(): string {
    const webview = this.panel.webview;
    const xtermCss = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'),
    );
    const xtermJs = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js'),
    );
    const fitJs = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.js'),
    );
    const webglJs = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@xterm', 'addon-webgl', 'lib', 'addon-webgl.js'),
    );
    const unicode11Js = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@xterm', 'addon-unicode11', 'lib', 'addon-unicode11.js'),
    );
    const nonce = getNonce();
    const modelLabel = this.opts.model ? CLI_DISPLAY_NAME[this.opts.model].toUpperCase() : 'CLI';

    // VS Code 재시작 시 panel을 복구하기 위한 최소 state. serializer.deserializeWebviewPanel에서
    // 다시 받아 buildOpts로 재구성한다.
    const restoreState = JSON.stringify({
      sessionId: this.opts.sessionId ?? null,
      model: this.opts.model ?? null,
      workspaceId: this.opts.workspaceId ?? null,
      modelSessionId: this.opts.modelSessionId ?? null,
      terminalName: this.opts.terminalName,
    });

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <link rel="stylesheet" href="${xtermCss}" />
  <style nonce="${nonce}">
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: var(--vscode-panel-background, var(--vscode-editor-background, #1e1e1e));
      overflow: hidden;
      display: flex;
      flex-direction: column;
      height: 100vh;
    }
    .header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 2px 12px;
      background: var(--vscode-panel-background, var(--vscode-editor-background, #1e1e1e));
      border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-editorGroupHeader-tabsBorder, #333));
      flex-shrink: 0;
      position: relative;
    }
    .header .model-badge {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 10px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .header .session-name {
      font-size: 12px;
      color: var(--vscode-foreground);
      flex: 1;
    }
    .header-actions { display: flex; gap: 4px; }
    .header-actions button {
      background: transparent;
      border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      width: 28px;
      height: 28px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
    }
    .header-actions button:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.1));
      color: var(--vscode-foreground);
    }
    .header-actions button svg { width: 22px; height: 22px; fill: currentColor; }
    .header-actions button.btn-new svg { width: 18px; height: 18px; }

    /* Session dropdown panel */
    .session-panel {
      display: none;
      position: absolute;
      top: 100%;
      right: 8px;
      width: 320px;
      max-height: 400px;
      background: var(--vscode-editorWidget-background, #252526);
      border: 1px solid var(--vscode-widget-border, #444);
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
      z-index: 100;
      overflow: hidden;
      flex-direction: column;
    }
    .session-panel.open { display: flex; }
    .sp-search {
      padding: 8px;
      border-bottom: 1px solid var(--vscode-widget-border, #333);
    }
    .sp-search input {
      width: 100%;
      padding: 6px 8px 6px 28px;
      border: 1px solid var(--vscode-input-border, #444);
      border-radius: 6px;
      background: var(--vscode-input-background, #1e1e1e);
      color: var(--vscode-input-foreground, #ccc);
      font-size: 12px;
      outline: none;
    }
    .sp-search input:focus { border-color: var(--vscode-focusBorder, #007fd4); }
    .sp-search-wrap {
      position: relative;
    }
    .sp-search-wrap svg {
      position: absolute;
      left: 8px;
      top: 50%;
      transform: translateY(-50%);
      width: 14px;
      height: 14px;
      fill: var(--vscode-descriptionForeground);
      pointer-events: none;
    }
    .sp-list {
      overflow-y: auto;
      max-height: 320px;
      padding: 4px 0;
    }
    .sp-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      cursor: pointer;
      font-size: 12px;
      color: var(--vscode-foreground);
    }
    .sp-item:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.06)); }
    .sp-item.active { background: var(--vscode-list-activeSelectionBackground, #094771); }
    .sp-item-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sp-item-desc {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
    }
    .sp-item-actions {
      display: none;
      gap: 2px;
    }
    .sp-item:hover .sp-item-actions { display: flex; }
    .sp-item:hover .sp-item-desc { display: none; }
    .sp-item-actions button {
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
    .sp-item-actions button:hover {
      background: rgba(255,255,255,0.1);
      color: var(--vscode-foreground);
    }
    .sp-item-actions button svg { width: 14px; height: 14px; fill: currentColor; }
    .sp-empty {
      padding: 20px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .sp-overlay {
      display: none;
      position: fixed;
      inset: 0;
      z-index: 99;
    }
    .sp-overlay.open { display: block; }

    /* New session model panel */
    .model-panel {
      display: none;
      position: absolute;
      top: 100%;
      right: 8px;
      width: 180px;
      background: var(--vscode-editorWidget-background, #252526);
      border: 1px solid var(--vscode-widget-border, #444);
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
      z-index: 100;
      overflow: hidden;
      padding: 4px 0;
    }
    .model-panel.open { display: block; }
    .mp-item {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 7px 10px;
      cursor: pointer;
      font-size: 12px;
      color: var(--vscode-foreground);
    }
    .mp-item:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.06)); }
    .mp-item-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .mp-item-name { flex: 1; }
    .mp-item-desc {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    #terminal-container {
      flex: 1;
      overflow: hidden;
      background: var(--vscode-panel-background, var(--vscode-editor-background, #1e1e1e));
      position: relative;
    }
    #terminal-container.drop-active::after {
      content: 'Drop with Shift to insert paths';
      position: absolute;
      inset: 8px;
      border: 2px dashed var(--vscode-focusBorder, #007acc);
      background: rgba(0,122,204,0.08);
      color: var(--vscode-foreground);
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
      z-index: 50;
      font-size: 13px;
    }
    .xterm { height: 100%; }
    .xterm-viewport { background-color: inherit !important; }
  </style>
</head>
<body>
  <div class="sp-overlay" id="spOverlay"></div>
  <div class="header">
    <span class="model-badge">${modelLabel}</span>
    <span class="session-name">${this.opts.terminalName}</span>
    <div class="header-actions">
      <button id="btnSelectSession" title="Select session">
        <svg viewBox="0 0 16 16"><path d="M13.5 8a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0ZM8 3.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9ZM8.5 5v2.793l1.854 1.853-.708.708L7.5 8.207V5h1Z"/></svg>
      </button>
      <button id="btnNewSession" class="btn-new" title="New session">
        <svg viewBox="0 0 16 16"><path d="M8 1a.5.5 0 0 1 .5.5V7h5.5a.5.5 0 0 1 0 1H8.5v5.5a.5.5 0 0 1-1 0V8H2a.5.5 0 0 1 0-1h5.5V1.5A.5.5 0 0 1 8 1Z"/></svg>
      </button>
    </div>
    <div class="session-panel" id="sessionPanel">
      <div class="sp-search">
        <div class="sp-search-wrap">
          <svg viewBox="0 0 16 16"><path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85zm-5.242.156a5 5 0 1 1 0-10 5 5 0 0 1 0 10z"/></svg>
          <input type="text" id="spSearchInput" placeholder="Search sessions..." />
        </div>
      </div>
      <div class="sp-list" id="spList"></div>
    </div>
    <div class="model-panel" id="modelPanel">
      <div class="mp-item" data-model="claude">
        <span class="mp-item-dot" style="background:#d97757"></span>
        <span class="mp-item-name">Claude</span>
        <span class="mp-item-desc">Anthropic</span>
      </div>
      <div class="mp-item" data-model="codex">
        <span class="mp-item-dot" style="background:#5D8AF9"></span>
        <span class="mp-item-name">Codex</span>
        <span class="mp-item-desc">OpenAI</span>
      </div>
      <div class="mp-item" data-model="agy">
        <span class="mp-item-dot" style="background:#8e6cef"></span>
        <span class="mp-item-name">Antigravity</span>
        <span class="mp-item-desc">Google</span>
      </div>
    </div>
  </div>
  <div id="terminal-container"></div>

  <script nonce="${nonce}" src="${xtermJs}"></script>
  <script nonce="${nonce}" src="${fitJs}"></script>
  <script nonce="${nonce}" src="${webglJs}"></script>
  <script nonce="${nonce}" src="${unicode11Js}"></script>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    vscode.setState(${restoreState});

    // VS Code 테마 변수를 읽어 xterm theme 객체를 구성. IDE 테마가 바뀌면 MutationObserver가
    // body의 style/class 변화를 감지해 term.options.theme를 다시 할당, 라이브로 색상 갱신.
    function cssVar(name, fallback) {
      const v = getComputedStyle(document.body).getPropertyValue(name).trim();
      return v || fallback;
    }
    function buildTheme() {
      return {
        background: cssVar('--vscode-terminal-background',
                    cssVar('--vscode-panel-background',
                    cssVar('--vscode-editor-background', '#1e1e1e'))),
        foreground: cssVar('--vscode-terminal-foreground',
                    cssVar('--vscode-editor-foreground', '#d4d4d4')),
        cursor: cssVar('--vscode-terminalCursor-foreground', '#aeafad'),
        cursorAccent: cssVar('--vscode-terminalCursor-background', '#1e1e1e'),
        selectionBackground: cssVar('--vscode-terminal-selectionBackground', '#264f78'),
        black: cssVar('--vscode-terminal-ansiBlack', '#000000'),
        red: cssVar('--vscode-terminal-ansiRed', '#cd3131'),
        green: cssVar('--vscode-terminal-ansiGreen', '#0dbc79'),
        yellow: cssVar('--vscode-terminal-ansiYellow', '#e5e510'),
        blue: cssVar('--vscode-terminal-ansiBlue', '#2472c8'),
        magenta: cssVar('--vscode-terminal-ansiMagenta', '#bc3fbc'),
        cyan: cssVar('--vscode-terminal-ansiCyan', '#11a8cd'),
        white: cssVar('--vscode-terminal-ansiWhite', '#e5e5e5'),
        brightBlack: cssVar('--vscode-terminal-ansiBrightBlack', '#666666'),
        brightRed: cssVar('--vscode-terminal-ansiBrightRed', '#f14c4c'),
        brightGreen: cssVar('--vscode-terminal-ansiBrightGreen', '#23d18b'),
        brightYellow: cssVar('--vscode-terminal-ansiBrightYellow', '#f5f543'),
        brightBlue: cssVar('--vscode-terminal-ansiBrightBlue', '#3b8eea'),
        brightMagenta: cssVar('--vscode-terminal-ansiBrightMagenta', '#d670d6'),
        brightCyan: cssVar('--vscode-terminal-ansiBrightCyan', '#29b8db'),
        brightWhite: cssVar('--vscode-terminal-ansiBrightWhite', '#ffffff'),
      };
    }

    const term = new Terminal({
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      theme: buildTheme(),
      cursorBlink: true,
      allowProposedApi: true,
      drawBoldTextInBrightColors: true,
    });

    // 테마 변경 라이브 갱신 — VS Code는 테마 전환 시 body의 inline style(CSS 변수)을 갱신.
    // attributes 관찰로 그 시점에 xterm theme 재할당. 짧은 burst 무시용 디바운스 50ms.
    let themeUpdateTimer = null;
    const themeObserver = new MutationObserver(() => {
      if (themeUpdateTimer) clearTimeout(themeUpdateTimer);
      themeUpdateTimer = setTimeout(() => { term.options.theme = buildTheme(); }, 50);
    });
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ['style', 'class'] });

    const unicode11Addon = new Unicode11Addon.Unicode11Addon();
    term.loadAddon(unicode11Addon);
    term.unicode.activeVersion = '11';

    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);

    const container = document.getElementById('terminal-container');
    term.open(container);

    try {
      const webglAddon = new WebglAddon.WebglAddon();
      webglAddon.onContextLoss(() => { webglAddon.dispose(); });
      term.loadAddon(webglAddon);
    } catch (e) {
      console.warn('WebGL addon failed, using canvas renderer', e);
    }

    fitAddon.fit();

    // Shift+Enter → Option+Enter(\\x1b\\r) 매핑. 한글 IME race 회피 상태 머신 — 원본 AgentBridge
    // (02_AgentBridge_App/src/renderer/src/components/XtermView.tsx)에서 그대로 포팅.
    // 한글 조합 중에는 newline을 보류하고 composition commit이 PTY로 빠져나간 직후 송신해야
    // 한글이 다음 줄로 밀리지 않는다. 50ms dedupe, 200ms fallback.
    const SHIFT_ENTER_LOCK_MS = 50;
    const SHIFT_ENTER_FALLBACK_MS = 200;
    let isComposingState = false;
    let pendingShiftEnter = false;
    let lastShiftEnterAt = 0;
    let pendingFallbackTimer = null;
    const emitShiftEnterNewline = () => {
      if (pendingFallbackTimer) {
        clearTimeout(pendingFallbackTimer);
        pendingFallbackTimer = null;
      }
      pendingShiftEnter = false;
      vscode.postMessage({ type: 'input', data: '\\x1b\\r' });
    };

    term.onData((data) => {
      vscode.postMessage({ type: 'input', data });
      // composition commit된 글자가 PTY로 흘러나간 직후 pending \\x1b\\r 처리.
      if (pendingShiftEnter) {
        emitShiftEnterNewline();
      }
    });

    const xtermTextarea = container.querySelector('textarea');
    if (xtermTextarea) {
      xtermTextarea.addEventListener('compositionstart', () => { isComposingState = true; });
      xtermTextarea.addEventListener('compositionend', () => { isComposingState = false; });
    }

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || e.key !== 'Enter' || !e.shiftKey) return true;
      e.preventDefault();
      const now = performance.now();
      if (now - lastShiftEnterAt < SHIFT_ENTER_LOCK_MS) {
        // IME가 한 번의 사용자 입력에 keydown을 두 번 발사 — 50ms 안 두 번째는 무시.
        return false;
      }
      lastShiftEnterAt = now;
      if (isComposingState) {
        pendingShiftEnter = true;
        pendingFallbackTimer = setTimeout(() => {
          if (pendingShiftEnter) emitShiftEnterNewline();
        }, SHIFT_ENTER_FALLBACK_MS);
      } else {
        emitShiftEnterNewline();
      }
      return false;
    });

    // 패널 드래그 중 fit()은 매 프레임 발화한다. 매번 호스트로 resize를 보내면 PTY SIGWINCH가
    // 연발되어 CLI가 중간 폭마다 화면을 다시 그리며 스크롤백에 깨진 조각이 누적된다.
    // → fit()은 즉시(캔버스는 패널을 따라감), 호스트 통보만 trailing debounce로 마지막 1회.
    const PTY_RESIZE_DEBOUNCE_MS = 200;
    let ptyResizeTimer = null;
    term.onResize(({ cols, rows }) => {
      if (ptyResizeTimer) clearTimeout(ptyResizeTimer);
      ptyResizeTimer = setTimeout(() => {
        ptyResizeTimer = null;
        vscode.postMessage({ type: 'resize', cols, rows });
      }, PTY_RESIZE_DEBOUNCE_MS);
    });

    // Shift+Drag-and-drop file attach — document-level capture phase로 IDE 핸들러보다 먼저 가로채야 작동.
    // VSCode webview는 sandboxed iframe이라 container-level listener는 IDE가 흡수함.
    function decodeFileUri(s) {
      const t = (s || '').trim();
      if (!t || t.startsWith('#')) return '';
      if (t.startsWith('file://')) {
        try { return decodeURIComponent(t.slice(7)); } catch { return t.slice(7); }
      }
      return t.startsWith('/') ? t : '';
    }
    function quoteShellArg(p) {
      return /[\\s'"]/.test(p) ? "'" + p.replace(/'/g, "'\\\\''") + "'" : p;
    }
    function hasFileLikeType(types) {
      if (!types) return false;
      for (let i = 0; i < types.length; i++) {
        const t = types[i];
        if (t === 'Files' || t === 'text/uri-list' || t.includes('resource-urls') || t.includes('codeeditors')) return true;
      }
      return false;
    }
    function isShiftActive(e) {
      return !!(e && e.shiftKey);
    }

    document.addEventListener('dragenter', (e) => {
      if (!isShiftActive(e) || !hasFileLikeType(e.dataTransfer && e.dataTransfer.types)) return;
      e.preventDefault();
      e.stopPropagation();
      container.classList.add('drop-active');
    }, true);
    document.addEventListener('dragover', (e) => {
      if (!isShiftActive(e) || !hasFileLikeType(e.dataTransfer && e.dataTransfer.types)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      container.classList.add('drop-active');
    }, true);
    document.addEventListener('dragleave', (e) => {
      // 드래그가 윈도우 밖으로 나가면 (relatedTarget=null) 오버레이 제거.
      if (!e.relatedTarget) container.classList.remove('drop-active');
    }, true);
    document.addEventListener('drop', (e) => {
      container.classList.remove('drop-active');
      if (!isShiftActive(e)) return;
      const dt = e.dataTransfer;
      if (!dt) return;
      const types = Array.from(dt.types || []);
      if (!hasFileLikeType(types)) return;
      e.preventDefault();
      e.stopPropagation();

      const paths = new Set();
      const pending = [];

      // 1a. File.path가 있으면 직접 사용 (Electron 일부 환경에서만 노출)
      if (dt.files) {
        for (let i = 0; i < dt.files.length; i++) {
          const f = dt.files[i];
          if (f.path) paths.add(f.path);
        }
      }
      // 1b. Sandboxed webview — 파일 내용을 읽어 익스텐션으로 보낸 뒤 임시 디스크 경로 받음.
      if (dt.files && paths.size === 0) {
        for (let i = 0; i < dt.files.length; i++) {
          const f = dt.files[i];
          pending.push(new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => {
              const result = reader.result;
              if (typeof result !== 'string') { resolve(); return; }
              const comma = result.indexOf(',');
              const base64 = comma >= 0 ? result.slice(comma + 1) : '';
              if (!base64) { resolve(); return; }
              const reqId = 'attach-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
              const handler = (ev) => {
                const m = ev.data;
                if (m && m.type === 'attachSaved' && m.reqId === reqId) {
                  window.removeEventListener('message', handler);
                  if (m.path) paths.add(m.path);
                  resolve();
                }
              };
              window.addEventListener('message', handler);
              vscode.postMessage({ type: 'attachSave', reqId, name: f.name, base64 });
              setTimeout(() => { window.removeEventListener('message', handler); resolve(); }, 10_000);
            };
            reader.onerror = () => resolve();
            reader.readAsDataURL(f);
          }));
        }
      }

      // 2. VSCode internal types — items.getAsString (async)
      if (dt.items) {
        for (let i = 0; i < dt.items.length; i++) {
          const item = dt.items[i];
          const type = item.type;
          if (item.kind !== 'string') continue;
          if (type !== 'text/uri-list' && type !== 'text/plain' && !type.includes('resource-urls') && !type.includes('codeeditors')) continue;
          pending.push(new Promise((resolve) => {
            item.getAsString((data) => {
              if (!data) return resolve();
              // JSON 배열 시도 (resource-urls / codeeditors)
              try {
                const j = JSON.parse(data);
                if (Array.isArray(j)) {
                  for (const x of j) {
                    if (typeof x === 'string') {
                      const p = decodeFileUri(x);
                      if (p) paths.add(p);
                    } else if (x && typeof x === 'object') {
                      const r = x.resource;
                      const u = (r && (r.external || r.fsPath || r.path)) || x.external || x.fsPath || x.path;
                      if (typeof u === 'string') {
                        const p = decodeFileUri(u);
                        if (p) paths.add(p);
                      }
                    }
                  }
                  return resolve();
                }
              } catch {}
              // plain text / uri-list (multi-line)
              for (const line of data.split(/\\r?\\n/)) {
                const p = decodeFileUri(line);
                if (p) paths.add(p);
              }
              resolve();
            });
          }));
        }
      }

      Promise.all(pending).then(() => {
        if (paths.size === 0) {
          vscode.postMessage({ type: 'log', data: 'DnD: no paths extracted — types=' + JSON.stringify(types) });
          return;
        }
        // @<path> mention 형식 — claude/codex/agy 모두 지원.
        const insertion = Array.from(paths).map(p => '@' + quoteShellArg(p)).join(' ') + ' ';
        vscode.postMessage({ type: 'input', data: insertion });
      });
    }, true);

    window.addEventListener('resize', () => {
      fitAddon.fit();
    });

    // --- Panels ---
    const sessionPanel = document.getElementById('sessionPanel');
    const modelPanel = document.getElementById('modelPanel');
    const spOverlay = document.getElementById('spOverlay');
    const spList = document.getElementById('spList');
    const spSearchInput = document.getElementById('spSearchInput');
    let allSessions = [];

    function togglePanel(open) {
      const isOpen = open !== undefined ? open : !sessionPanel.classList.contains('open');
      modelPanel.classList.remove('open');
      sessionPanel.classList.toggle('open', isOpen);
      spOverlay.classList.toggle('open', isOpen);
      if (isOpen) {
        spSearchInput.value = '';
        vscode.postMessage({ type: 'getSessions' });
        setTimeout(() => spSearchInput.focus(), 50);
      }
    }

    function renderSessions(sessions) {
      if (sessions.length === 0) {
        spList.innerHTML = '<div class="sp-empty">No sessions found</div>';
        return;
      }
      spList.innerHTML = sessions.map(s => {
        const desc = s.active ? 'active' : (s.lastActiveAt || '');
        return '<div class="sp-item' + (s.sessionId === '${this.opts.sessionId ?? ''}' ? ' active' : '') + '" data-sid="' + s.sessionId + '" data-wid="' + s.workspaceId + '" data-model="' + s.model + '">'
          + '<span class="sp-item-name">' + esc(s.name) + '</span>'
          + '<span class="sp-item-desc">' + esc(desc) + '</span>'
          + '<div class="sp-item-actions">'
          + '<button class="sp-rename" title="Rename"><svg viewBox="0 0 16 16"><path d="M13.23 1h-1.46L3.52 9.25l-.16.22L1 13.59 2.41 15l4.12-2.36.22-.16L15 4.23V2.77L13.23 1zM2.41 13.59l1.51-3 1.45 1.45-2.96 1.55zm3.83-2.06L4.47 9.76l6.69-6.69 1.77 1.77-6.69 6.69z"/></svg></button>'
          + '<button class="sp-delete" title="Delete"><svg viewBox="0 0 16 16"><path d="M10 3h3v1h-1v9l-1 1H5l-1-1V4H3V3h3l1-1h2l1 1zM9 3H7l-.5.5h3L9 3zm0 4v5H8V7h1zm-3 0v5h1V7H6z"/></svg></button>'
          + '</div></div>';
      }).join('');
    }

    function esc(s) {
      if (!s) return '';
      const d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }

    document.getElementById('btnSelectSession').addEventListener('click', (e) => {
      e.stopPropagation();
      togglePanel();
    });
    spOverlay.addEventListener('click', () => { togglePanel(false); toggleModelPanel(false); });

    spSearchInput.addEventListener('input', () => {
      const q = spSearchInput.value.toLowerCase();
      const filtered = q ? allSessions.filter(s => s.name.toLowerCase().includes(q)) : allSessions;
      renderSessions(filtered);
    });

    spList.addEventListener('click', (e) => {
      const item = e.target.closest('.sp-item');
      if (!item) return;
      const renameBtn = e.target.closest('.sp-rename');
      const deleteBtn = e.target.closest('.sp-delete');
      if (renameBtn) {
        vscode.postMessage({ type: 'renameSession', sessionId: item.dataset.sid, workspaceId: item.dataset.wid, currentName: item.querySelector('.sp-item-name').textContent });
        return;
      }
      if (deleteBtn) {
        vscode.postMessage({ type: 'deleteSession', sessionId: item.dataset.sid, workspaceId: item.dataset.wid, name: item.querySelector('.sp-item-name').textContent });
        return;
      }
      vscode.postMessage({ type: 'openSession', sessionId: item.dataset.sid, workspaceId: item.dataset.wid, model: item.dataset.model });
      togglePanel(false);
    });

    // --- Model panel ---
    function toggleModelPanel(open) {
      const isOpen = open !== undefined ? open : !modelPanel.classList.contains('open');
      sessionPanel.classList.remove('open');
      modelPanel.classList.toggle('open', isOpen);
      spOverlay.classList.toggle('open', isOpen);
    }

    document.getElementById('btnNewSession').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleModelPanel();
    });

    modelPanel.addEventListener('click', (e) => {
      const item = e.target.closest('.mp-item');
      if (!item) return;
      vscode.postMessage({ type: 'newSessionWithModel', model: item.dataset.model });
      toggleModelPanel(false);
    });

    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.type === 'output') {
        term.write(msg.data);
      }
      if (msg.type === 'sessions') {
        allSessions = msg.sessions || [];
        const q = spSearchInput.value.toLowerCase();
        const filtered = q ? allSessions.filter(s => s.name.toLowerCase().includes(q)) : allSessions;
        renderSessions(filtered);
      }
    });

    vscode.postMessage({ type: 'ready', cols: term.cols, rows: term.rows });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  // CSP nonce는 예측 불가능해야 하므로 Math.random()이 아닌 crypto 난수 사용
  return randomBytes(16).toString('base64');
}
