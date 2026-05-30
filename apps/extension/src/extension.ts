import * as vscode from 'vscode';
import type { SpawnOptions } from './pty/types';
import * as claudeAdapter from './core/cliAdapter/claudeAdapter';
import * as codexAdapter from './core/cliAdapter/codexAdapter';
import * as agyAdapter from './core/cliAdapter/agyAdapter';
import * as workspaceStore from './core/workspaceStore';
import { initializeCore } from './core/coreInstances';
import * as output from './log/output';
import { MemoryPanelProvider } from './views/memoryPanel';
import { SessionTreeProvider, SessionItem } from './views/sessionTreeView';
import { ChatPanel, getActivePanel, getAllPanels, chatPanelEvents } from './views/chatPanel';
import { compactionEvents } from './core/compactionScheduler';
import { registerSession, markSessionClosed, markSessionActive, renameSession, deleteSession } from './core/sessionRegistry';
import { registerConfigWatcher } from './settings/config';
import * as notifications from './core/notifications';
import { CLI_DISPLAY_NAME, type CliKind } from './shared/types';
import { getSessions, type SessionMeta } from './core/sessionRegistry';

interface ModelChoice extends vscode.QuickPickItem {
  model: CliKind;
}

const MODEL_CHOICES: ModelChoice[] = [
  { label: 'Claude', description: 'Anthropic Claude Code', model: 'claude' },
  { label: 'Codex', description: 'OpenAI Codex CLI', model: 'codex' },
  { label: 'Antigravity', description: 'Antigravity CLI', model: 'agy' },
];

function checkAvailability(model: CliKind): { found: boolean; name: string } {
  switch (model) {
    case 'claude': return { ...claudeAdapter.isAvailable(), name: 'claude' };
    case 'codex': return { ...codexAdapter.isAvailable(), name: 'codex' };
    case 'agy': return { ...agyAdapter.isAvailable(), name: 'agy' };
  }
}

async function buildOpts(
  model: CliKind,
  cwd: string,
  workspaceId: string,
  resumeSessionId?: string,
  resumeModelSessionId?: string,
): Promise<SpawnOptions> {
  switch (model) {
    case 'claude': return claudeAdapter.buildSpawnOptions(cwd, workspaceId, resumeSessionId);
    case 'codex': return codexAdapter.buildSpawnOptions(cwd, workspaceId, resumeSessionId, resumeModelSessionId);
    case 'agy': return agyAdapter.buildSpawnOptions(cwd, workspaceId, resumeSessionId, resumeModelSessionId);
  }
}

export function activate(context: vscode.ExtensionContext) {
  output.log('AgentBridge activating');

  // 코어 인스턴스 셋업 — workspaceStore, envProbe, hookInstaller, sessionRegistry,
  // cliAdapter, compactionScheduler 등 모든 코어 팩토리 인스턴스를 한 번에 초기화.
  initializeCore(context);
  workspaceStore.init(context.globalStorageUri.fsPath);

  // activate 시점엔 어떤 panel도 안 열려있음 — 모든 세션 active 플래그 초기화.
  // 이후 ChatPanel.create가 markSessionActive로 갱신.
  // (sessionTree는 아래에서 생성되므로, reset 완료 후 closure 통해 refresh.)
  let pendingResetDone: Promise<void> | null = null;
  const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (folderUri) {
    const wid = workspaceStore.getOrCreateWorkspaceId(folderUri.fsPath);
    pendingResetDone = import('./core/sessionRegistry')
      .then(m => m.resetAllSessionsActive(wid))
      .catch(() => { /* noop */ });
  }

  // attachment 정리 — 1시간 이상 된 파일 제거 (fire-and-forget).
  void import('./core/attachmentStore').then(m => m.cleanupStaleAttachments()).catch(() => { /* noop */ });
  registerConfigWatcher(context);
  notifications.init(context.globalState);
  notifications.notifyFirstRun();

  // --- Memory Panel (WebviewView) ---
  const memoryProvider = new MemoryPanelProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      MemoryPanelProvider.viewType,
      memoryProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  compactionEvents.on('ir:updated', () => {
    output.log('extension: ir:updated event received');
    memoryProvider.notifyIRUpdated();
  });
  compactionEvents.on('turns:updated', () => {
    output.log('extension: turns:updated event received');
    memoryProvider.notifyIRUpdated();
  });
  // hook 활성/비활성 상태 변화 → Memory 패널 배지 갱신.
  void import('./core/hookStatusStore').then(m => {
    m.hookStatusEvents.on('changed', () => {
      output.log('extension: hookStatus changed event received');
      memoryProvider.notifyIRUpdated();
    });
  });

  // --- Session TreeView ---
  const sessionTree = new SessionTreeProvider(context.extensionUri);
  const treeView = vscode.window.createTreeView('agentbridge.sessions', {
    treeDataProvider: sessionTree,
    showCollapseAll: false,
  });
  // reset이 비동기로 끝나면 tree 다시 그리기 — race 회피.
  if (pendingResetDone) {
    void pendingResetDone.then(() => sessionTree.refresh());
  }
  let selectedSessionItem: SessionItem | undefined;
  treeView.onDidChangeSelection(e => {
    selectedSessionItem = e.selection[0];
  });
  // 채팅 탭이 활성화되면 사이드 패널 selection 동기화. 단, AgentBridge 사이드바가 이미
  // 보이는 상태일 때만 reveal — 다른 사이드바(Explorer 등)를 사용 중인 사용자의 화면을
  // 우리 패널로 강제 전환시키지 않기 위함.
  chatPanelEvents.event(async ({ sessionId }) => {
    if (!treeView.visible) return;
    await sessionTree.getChildren();
    const item = sessionTree.findItemBySessionId(sessionId);
    if (item) {
      try { await treeView.reveal(item, { select: true, focus: false }); } catch { /* race */ }
    }
  });
  context.subscriptions.push(treeView);

  // --- Helper: open chat panel for a session ---
  function openChatPanel(opts: SpawnOptions, workspaceId: string): void {
    const chat = ChatPanel.create(context.extensionUri, opts);
    chat.onDispose(async () => {
      await markSessionClosed(workspaceId, opts.sessionId!);
      sessionTree.refresh();
    });
  }

  // --- Commands ---
  const newSession = vscode.commands.registerCommand('agentbridge.newSession', async () => {
    const picked = await vscode.window.showQuickPick<ModelChoice>(
      MODEL_CHOICES,
      { placeHolder: 'Select a model to start' },
    );
    if (!picked) return;

    const model = picked.model;
    const availability = checkAvailability(model);
    if (!availability.found) {
      notifications.notifyCliNotFound(availability.name);
      return;
    }

    const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!folderUri) {
      vscode.window.showWarningMessage('AgentBridge: Open a workspace folder first.');
      return;
    }
    const cwd = folderUri.fsPath;
    const workspaceId = workspaceStore.getOrCreateWorkspaceId(cwd);

    const opts = await buildOpts(model, cwd, workspaceId);
    output.log(`New session [${model}]: ${opts.terminalName} cwd=${cwd} workspaceId=${workspaceId}`);

    await registerSession(workspaceId, opts.sessionId!, model);
    sessionTree.refresh();

    if (model === 'codex') notifications.notifyCodexHooksTrust();

    openChatPanel(opts, workspaceId);
  });

  const openSessionCmd = vscode.commands.registerCommand('agentbridge.openSession', async (session: SessionMeta) => {
    const existing = getActivePanel(session.sessionId);
    if (existing) {
      existing.reveal();
      return;
    }

    const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!folderUri) {
      vscode.window.showWarningMessage('AgentBridge: Open a workspace folder first.');
      return;
    }
    const cwd = folderUri.fsPath;

    const availability = checkAvailability(session.model);
    if (!availability.found) {
      notifications.notifyCliNotFound(availability.name);
      return;
    }

    const opts = await buildOpts(session.model, cwd, session.workspaceId, session.sessionId, session.modelSessionId);
    await markSessionActive(session.workspaceId, session.sessionId);
    sessionTree.refresh();
    openChatPanel(opts, session.workspaceId);
  });

  const selectSessionCmd = vscode.commands.registerCommand('agentbridge.selectSession', async () => {
    const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!folderUri) {
      vscode.window.showWarningMessage('AgentBridge: Open a workspace folder first.');
      return;
    }
    const cwd = folderUri.fsPath;
    const wid = workspaceStore.getOrCreateWorkspaceId(cwd);
    const sessions = await getSessions(wid);
    if (sessions.length === 0) {
      vscode.window.showInformationMessage('No sessions yet. Create one first.');
      return;
    }

    interface SessionChoice extends vscode.QuickPickItem { session: SessionMeta }
    const items: SessionChoice[] = sessions.map(s => ({
      label: s.name,
      description: `${CLI_DISPLAY_NAME[s.model]} · ${s.active ? 'active' : timeAgo(s.lastActiveAt)}`,
      session: s,
    }));

    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select a session' });
    if (!picked) return;
    vscode.commands.executeCommand('agentbridge.openSession', picked.session);
  });

  const refineCmd = vscode.commands.registerCommand('agentbridge.refineMemory', async () => {
    await memoryProvider.runRefine();
  });

  const resetCmd = vscode.commands.registerCommand('agentbridge.resetMemory', async () => {
    await memoryProvider.runReset();
  });

  const renameCmd = vscode.commands.registerCommand('agentbridge.renameSession', async (item?: SessionItem) => {
    const session = (item ?? selectedSessionItem)?.session;
    if (!session) return;
    const newName = await vscode.window.showInputBox({
      prompt: 'Session name',
      value: session.name,
    });
    if (newName === undefined) return;
    await renameSession(session.workspaceId, session.sessionId, newName);
    sessionTree.refresh();
  });

  const deleteCmd = vscode.commands.registerCommand('agentbridge.deleteSession', async (item?: SessionItem) => {
    const session = (item ?? selectedSessionItem)?.session;
    if (!session) return;
    const answer = await vscode.window.showWarningMessage(
      `Delete session "${session.name}"?`,
      { modal: true },
      'Delete',
    );
    if (answer !== 'Delete') return;
    const activePanel = getActivePanel(session.sessionId);
    if (activePanel) {
      activePanel.markDeleted();
      activePanel.dispose();
    }
    await deleteSession(session.workspaceId, session.sessionId);
    sessionTree.refresh();
  });

  const newSessionFromTab = vscode.commands.registerCommand('agentbridge.newSessionFromTab', () => {
    vscode.commands.executeCommand('agentbridge.newSession');
  });

  const newSessionWithModel = vscode.commands.registerCommand('agentbridge.newSessionWithModel', async (model: CliKind) => {
    const availability = checkAvailability(model);
    if (!availability.found) {
      notifications.notifyCliNotFound(availability.name);
      return;
    }

    const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!folderUri) {
      vscode.window.showWarningMessage('AgentBridge: Open a workspace folder first.');
      return;
    }
    const cwd = folderUri.fsPath;
    const workspaceId = workspaceStore.getOrCreateWorkspaceId(cwd);

    const opts = await buildOpts(model, cwd, workspaceId);
    output.log(`New session [${model}]: ${opts.terminalName} cwd=${cwd} workspaceId=${workspaceId}`);

    await registerSession(workspaceId, opts.sessionId!, model);
    sessionTree.refresh();

    if (model === 'codex') notifications.notifyCodexHooksTrust();

    openChatPanel(opts, workspaceId);
  });

  // IDE 재시작 시 직전 챗 탭들을 복구 — webview state(sessionId/model/workspaceId)로
  // SpawnOptions 재구성 후 ChatPanel.revive로 기존 panel을 wrap한다. PTY는 새로 spawn되며
  // claude/codex/agy 어댑터가 sessionId 기반 --resume을 알아서 처리.
  const serializer: vscode.WebviewPanelSerializer = {
    async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
      const s = state as { sessionId?: string; model?: CliKind; workspaceId?: string; modelSessionId?: string } | null;
      if (!s || !s.sessionId || !s.model || !s.workspaceId) {
        panel.dispose();
        return;
      }
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!folder) {
        panel.dispose();
        return;
      }
      const availability = checkAvailability(s.model);
      if (!availability.found) {
        notifications.notifyCliNotFound(availability.name);
        panel.dispose();
        return;
      }
      const opts = await buildOpts(s.model, folder.fsPath, s.workspaceId, s.sessionId, s.modelSessionId);
      await markSessionActive(s.workspaceId, s.sessionId);
      sessionTree.refresh();
      const chat = ChatPanel.revive(panel, context.extensionUri, opts);
      chat.onDispose(async () => {
        await markSessionClosed(s.workspaceId!, s.sessionId!);
        sessionTree.refresh();
      });
    },
  };
  context.subscriptions.push(vscode.window.registerWebviewPanelSerializer('agentbridge.chat', serializer));

  context.subscriptions.push(
    newSession, newSessionFromTab, newSessionWithModel, openSessionCmd, selectSessionCmd, refineCmd, resetCmd, renameCmd, deleteCmd,
    output.getOutputChannel(),
  );
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function deactivate() {
  for (const panel of getAllPanels()) {
    panel.dispose();
  }
}
