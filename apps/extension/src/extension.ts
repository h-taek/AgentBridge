import * as vscode from 'vscode';
import type { SpawnOptions } from './pty/types';
import * as claudeAdapter from './core/cliAdapter/claudeAdapter';
import * as codexAdapter from './core/cliAdapter/codexAdapter';
import * as agyAdapter from './core/cliAdapter/agyAdapter';
import * as workspaceStore from './core/workspaceStore';
import { installHelperToCanonicalPath, createSessionFileWatcher, getStorageRoot } from '@agentbridge/core';
import { initializeCore, getBundledHelperPath, getWorkspaceStore, getLogger } from './core/coreInstances';
import * as output from './log/output';
import { MemoryPanelProvider } from './views/memoryPanel';
import { SessionTreeProvider, SessionItem } from './views/sessionTreeView';
import { ChatPanel, getActivePanel, getAllPanels, chatPanelEvents } from './views/chatPanel';
import { compactionEvents } from './core/compactionScheduler';
import { flushAllCaptureOpen } from './core/turnRecorder';
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

  // hook helper를 ~/.agentbridge/bin/에 설치 (V-12 — 양 앱 공용 canonical 경로).
  // 실패해도 익스텐션 동작에는 지장 없음 (hook만 비활성) — 로그만 남김.
  void installHelperToCanonicalPath(
    getBundledHelperPath(),
    getWorkspaceStore().getGlobalStoragePath(),
    getLogger(),
  ).catch((err) => output.warn(`helper 설치 실패: ${String(err)}`));

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

  // 공유 저장소 실시간 동기화 — 다른 앱(데스크탑/다른 호스트)이 workspace.json(세션 목록) 또는
  // owner.json(소유)을 바꾸면 세션 트리를 다시 그린다. 데스크탑과 같은 core 워처를 끌어 쓴다.
  // fs.watch는 즉시성, 폴링(4s)은 패키지/원격 환경에서 watch 누락 시의 안전망.
  const storageWatcher = createSessionFileWatcher({
    root: getStorageRoot(),
    filenames: ['workspace.json', 'owner.json'],
    onChange: () => sessionTree.refresh(),
    logger: { warn: (m, e) => output.warn(`${m} ${e ? String(e) : ''}`) },
  });
  const storagePoll = setInterval(() => sessionTree.refresh(), 4000);
  context.subscriptions.push({
    dispose: () => {
      storageWatcher.stop();
      clearInterval(storagePoll);
    },
  });

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
    // host handoff-flush: refine(turns 읽기) 직전, 열린 마지막 턴을 확정해 직전 대화가 IR에 빠지지 않게 한다.
    try {
      await flushAllCaptureOpen();
    } catch {
      /* non-fatal */
    }
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
      // activate의 resetAllSessionsActive(모든 세션 비활성)와 경합 회피 — reset 완료 후 active 표시.
      // 안 기다리면 reset이 이 복구된 세션의 active 플래그를 덮어써 비활성으로 남을 수 있음 (V-21).
      if (pendingResetDone) await pendingResetDone;
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

export async function deactivate(): Promise<void> {
  // 진행 중 turn flush를 await한 뒤 종료 — 모델 응답 직후 종료 시 마지막 턴 유실 방지 (V-07).
  // VS Code는 deactivate가 반환한 Promise를 (타임아웃 한도 내에서) 기다린다.
  await Promise.allSettled(getAllPanels().map((p) => p.disposeAndFlush()));
}
