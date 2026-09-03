import * as vscode from 'vscode';
import type { SpawnOptions } from './pty/types';
import * as claudeAdapter from './core/cliAdapter/claudeAdapter';
import * as codexAdapter from './core/cliAdapter/codexAdapter';
import * as agyAdapter from './core/cliAdapter/agyAdapter';
import * as workspaceStore from './core/workspaceStore';
import {
  installBinToCanonicalPath,
  createSessionFileWatcher,
  startHostRequestHandler,
  HOST_PING,
  HOST_MEMORY_WRITE,
  applyMemoryWrite,
  parseMemoryWriteRequest,
  getStorageRoot,
  migrateLegacyGlobalIfNeeded,
  renderReceipt,
  type SpawnExtras,
} from '@agentbridge/core';
import { initializeCore, getBundledHelperPath, getBundledCliPath, getWorkspaceStore, getLogger } from './core/coreInstances';
import * as output from './log/output';
import { MemoryPanelProvider } from './views/memoryPanel';
import { ProfilePanelProvider } from './views/profilePanel';
import { SessionTreeProvider, SessionItem } from './views/sessionTreeView';
import { rowKindOf, childSessions, planDeleteConfirm } from './views/sessionTreeModel';
import { ChatPanel, getActivePanel, getAllPanels, chatPanelEvents, updateSessionTabTitle, markShuttingDown } from './views/chatPanel';
import { compactionEvents } from './core/compactionScheduler';
import { registerSession, markSessionClosed, markSessionActive, markSessionOpened, renameSession, deleteSession, reclaimPendingModelSessionId } from './core/sessionRegistry';
import { registerConfigWatcher } from './settings/config';
import * as notifications from './core/notifications';
import { assetRootUri } from './core/assetRoot';
import {
  initSubagents,
  subagentHostHandlers,
  cleanupOne,
  cleanupChildrenOf,
  sweepOrphanTrees,
} from './core/subagents';
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
  extras?: SpawnExtras,
): Promise<SpawnOptions> {
  switch (model) {
    case 'claude': return claudeAdapter.buildSpawnOptions(cwd, workspaceId, resumeSessionId, extras);
    case 'codex': return codexAdapter.buildSpawnOptions(cwd, workspaceId, resumeSessionId, resumeModelSessionId, extras);
    case 'agy': return agyAdapter.buildSpawnOptions(cwd, workspaceId, resumeSessionId, resumeModelSessionId, extras);
  }
}

export function activate(context: vscode.ExtensionContext) {
  output.log('AgentBridge activating');

  // 코어 인스턴스 셋업 — workspaceStore, envProbe, hookInstaller, sessionRegistry,
  // cliAdapter, compactionScheduler 등 모든 코어 팩토리 인스턴스를 한 번에 초기화.
  initializeCore(context);

  // 옛 저장소(~/.agentbridge)의 장기 메모리를 새 저장소로 한 번 복사 (0.5.0 B-1).
  // 옛 폴더는 지우지 않는다. 실패해도 익스텐션 동작에는 지장 없다.
  try {
    const migrated = migrateLegacyGlobalIfNeeded({ logger: getLogger() });
    if (migrated === 'copied') output.log('옛 저장소의 장기 메모리를 새 저장소로 복사했다');
  } catch (err) {
    output.warn(`장기 메모리 이전 실패: ${String(err)}`);
  }

  // hook helper와 에이전트용 CLI를 <저장소 루트>/bin/에 설치 (V-12 — canonical 경로).
  // 실패해도 익스텐션 동작에는 지장 없음 (훅·CLI만 비활성) — 로그만 남김.
  void installBinToCanonicalPath(
    getBundledHelperPath(),
    getWorkspaceStore().getGlobalStoragePath(),
    'helper',
    getLogger(),
  ).catch((err) => output.warn(`helper 설치 실패: ${String(err)}`));
  void installBinToCanonicalPath(
    getBundledCliPath(),
    getWorkspaceStore().getGlobalStoragePath(),
    'cli',
    getLogger(),
  ).catch((err) => output.warn(`CLI 설치 실패: ${String(err)}`));

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

  // attachment 정리 — 1시간 이상 된 파일 제거 + 구버전이 프로젝트에 만든 폴더 제거 (fire-and-forget).
  void import('./core/attachmentStore')
    .then(async (m) => {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!folder) return;
      await m.cleanupStaleAttachments();
      await m.cleanupLegacyProjectFolder(folder.fsPath);
    })
    .catch(() => { /* noop */ });
  registerConfigWatcher(context);
  notifications.init(context.globalState);
  notifications.notifyFirstRun();

  // --- Memory Panel (WebviewView) ---
  const memoryProvider = new MemoryPanelProvider(context.globalState);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      MemoryPanelProvider.viewType,
      memoryProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  // --- Profile Panel (장기 메모리 — 자동제안 승인 큐 + 읽기전용 문서) ---
  // 대기 제안 수를 액티비티 바 뱃지로 — 항상 살아있는 세션 TreeView(treeView, 아래에서 생성)에 건다.
  // (webview view는 펼치기 전엔 resolve 안 돼 뱃지가 안 먹음.) 콜백은 런타임에만 호출되므로
  // 아래에서 선언되는 treeView를 클로저로 참조해도 안전하다.
  const profileProvider = new ProfilePanelProvider((count) => {
    treeView.badge = count > 0
      ? { value: count, tooltip: vscode.l10n.t('{0} pending proposals', count) }
      : undefined;
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ProfilePanelProvider.viewType,
      profileProvider,
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
  // 에셋은 확장 루트 한 겹 아래에 있다(assetRoot). 트리 아이콘과 채팅 웹뷰가 그 자리를 쓴다.
  const assets = assetRootUri(context.extensionUri);
  const sessionTree = new SessionTreeProvider(assets);
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
    // 완료 표시는 여기서 끈다 — 탭을 열어봤다는 사실이 곧 "확인했다"는 사실이다(B-2).
    // 사이드바가 안 보이는 상태에서도 열람 시각은 남겨야 다음에 트리를 볼 때 정정돼 있다.
    const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (folderUri) {
      const wid = workspaceStore.getOrCreateWorkspaceId(folderUri.fsPath);
      await markSessionOpened(wid, sessionId);
    }

    if (!treeView.visible) return;
    await sessionTree.getChildren();
    const item = sessionTree.findItemBySessionId(sessionId);
    if (item) {
      try { await treeView.reveal(item, { select: true, focus: false }); } catch { /* race */ }
    }
  });
  context.subscriptions.push(treeView);

  // 활성화 시 대기 제안 수로 뱃지 1회 초기화 (이후엔 패널을 다시 볼 때와 승인·버림이 갱신한다).
  void profileProvider.notifyProposalsUpdated();

  // 공유 저장소 실시간 동기화 — 다른 앱(데스크탑/다른 호스트)이 workspace.json(세션 목록) 또는
  // owner.json(소유)을 바꾸면 세션 트리를 다시 그린다. 데스크탑과 같은 core 워처를 끌어 쓴다.
  // fs.watch는 즉시성, 폴링(4s)은 패키지/원격 환경에서 watch 누락 시의 안전망.
  const storageWatcher = createSessionFileWatcher({
    root: getStorageRoot(),
    filenames: ['workspace.json', 'owner.json'],
    onChange: () => sessionTree.refresh(),
    logger: { warn: (m, e) => output.warn(`${m} ${e ? String(e) : ''}`) },
  });
  // 상태(진행 중/완료/모름)가 이 주기를 탄다. 값이 안 바뀌었으면 refresh하지 않는다 —
  // 4초마다 전체 리렌더하면 선택 상태가 흔들린다.
  const storagePoll = setInterval(() => { void sessionTree.refreshIfChanged(); }, 4000);

  // 에이전트용 CLI가 우리에게 넘기는 요청을 집는다 (0.5.0 B-5). 우리가 소유한 세션의 것만
  // 집는다. 이 단계의 종류는 배선 확인 하나이고, PTY를 만지는 넷은 4단계에서 붙는다.
  const hostRequests = startHostRequestHandler({
    storageRoot: getStorageRoot(),
    handlers: {
      [HOST_PING]: () => `호스트 응답 — extension pid ${process.pid}`,
      // 모델이 남기는 지식. 쓰는 주체가 화면을 쥔 쪽이라 쓰는 순간이 곧 갱신하는 순간이다.
      [HOST_MEMORY_WRITE]: async (req) => {
        const out = await applyMemoryWrite(getStorageRoot(), parseMemoryWriteRequest(req.payload));
        profileProvider.notifyProposalsUpdated();
        return out;
      },
      // PTY를 만지는 넷 (0.5.0 W3). 본체는 subagents.ts에 있다.
      ...subagentHostHandlers,
    },
    logger: getLogger(),
  });

  context.subscriptions.push({
    dispose: () => {
      storageWatcher.stop();
      hostRequests.stop();
      clearInterval(storagePoll);
    },
  });

  // --- Helper: open chat panel for a session ---
  // preserveFocus는 서브 탭에서만 참이다. 메인이 명령을 부른 결과로 뜨는 탭이라 사용자가 보고
  // 있던 자리에서 커서를 뺏지 않는다 (0.5.0 B-6).
  function openChatPanel(opts: SpawnOptions, workspaceId: string, preserveFocus = false): void {
    const chat = ChatPanel.create(assets, opts, preserveFocus);
    chat.onDispose(async () => {
      await markSessionClosed(workspaceId, opts.sessionId!);
      sessionTree.refresh();
    });
  }

  // 프로젝트를 열 때 고아 worktree를 훑는다 (0.5.0 B-7 정리 시점 셋째). 레코드가 아예 없는
  // 폴더만 지운다 — 앱이 비정상 종료해 레코드를 못 쓴 흔적이다. 알릴 상대가 없던 시점의 일이라
  // 지금 알린다. 훑는 것은 이 프로젝트의 trees/ 하나뿐이고 다른 프로젝트는 훑지 않는다.
  void (async () => {
    const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!folderUri) return;
    try {
      const wid = workspaceStore.getOrCreateWorkspaceId(folderUri.fsPath);
      const swept = await sweepOrphanTrees(wid);
      if (swept.length > 0) {
        output.log(`고아 worktree 정리: ${swept.join(', ')}`);
        void vscode.window.showInformationMessage(
          vscode.l10n.t('AgentBridge cleaned up {0} leftover sub-agent worktree(s): {1}', swept.length, swept.join(', ')),
        );
      }
    } catch (err) {
      output.warn(`고아 스캔 실패: ${String(err)}`);
    }
  })();

  // 서브에이전트 스폰은 위 배선을 그대로 쓴다 — 어느 경로로 뜬 세션이든 닫힘 처리가 같아야 한다.
  initSubagents({
    buildOpts,
    openPanel: (opts, workspaceId, preserveFocus) => openChatPanel(opts, workspaceId, preserveFocus),
    refreshTree: () => sessionTree.refresh(),
  });

  // --- Commands ---
  const newSession = vscode.commands.registerCommand('agentbridge.newSession', async () => {
    const picked = await vscode.window.showQuickPick<ModelChoice>(
      MODEL_CHOICES,
      { placeHolder: vscode.l10n.t('Select a model to start') },
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
      vscode.window.showWarningMessage(vscode.l10n.t('AgentBridge: Open a workspace folder first.'));
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
      vscode.window.showWarningMessage(vscode.l10n.t('AgentBridge: Open a workspace folder first.'));
      return;
    }
    const cwd = folderUri.fsPath;

    const availability = checkAvailability(session.model);
    if (!availability.found) {
      notifications.notifyCliNotFound(availability.name);
      return;
    }

    const modelSessionId = await reclaimPendingModelSessionId(session);
    const opts = await buildOpts(session.model, cwd, session.workspaceId, session.sessionId, modelSessionId);
    opts.terminalName = session.name; // 탭 제목 = 세션 이름(트리와 일치; 이름 없으면 모델명)
    await markSessionActive(session.workspaceId, session.sessionId);
    sessionTree.refresh();
    openChatPanel(opts, session.workspaceId);
  });

  const selectSessionCmd = vscode.commands.registerCommand('agentbridge.selectSession', async () => {
    const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!folderUri) {
      vscode.window.showWarningMessage(vscode.l10n.t('AgentBridge: Open a workspace folder first.'));
      return;
    }
    const cwd = folderUri.fsPath;
    const wid = workspaceStore.getOrCreateWorkspaceId(cwd);
    const sessions = await getSessions(wid);
    if (sessions.length === 0) {
      vscode.window.showInformationMessage(vscode.l10n.t('No sessions yet. Create one first.'));
      return;
    }

    interface SessionChoice extends vscode.QuickPickItem { session: SessionMeta }
    const items: SessionChoice[] = sessions.map(s => ({
      label: s.name,
      description: `${CLI_DISPLAY_NAME[s.model]} · ${s.active ? 'active' : timeAgo(s.lastActiveAt)}`,
      session: s,
    }));

    const picked = await vscode.window.showQuickPick(items, { placeHolder: vscode.l10n.t('Select a session') });
    if (!picked) return;
    vscode.commands.executeCommand('agentbridge.openSession', picked.session);
  });

  const refineCmd = vscode.commands.registerCommand('agentbridge.refineMemory', async () => {
    await memoryProvider.runRefine();
  });

  const resetCmd = vscode.commands.registerCommand('agentbridge.resetMemory', async () => {
    await memoryProvider.runReset();
  });

  // 닫기 확인을 껐던 것을 되돌린다 (0.5.0 6단계). 끄는 자리는 확인 창의 버튼이고, 값은 그 레포의
  // workspace.json에 있다 — 되돌리는 자리가 없으면 한 번 끈 사용자가 다시 켤 방법이 없다.
  const enableCloseConfirmCmd = vscode.commands.registerCommand('agentbridge.enableCloseConfirm', async () => {
    const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!folderUri) {
      vscode.window.showWarningMessage(vscode.l10n.t('AgentBridge: Open a workspace folder first.'));
      return;
    }
    const workspaceId = workspaceStore.getOrCreateWorkspaceId(folderUri.fsPath);
    await getWorkspaceStore().updateWorkspaceMeta(workspaceId, { closeConfirmDisabled: false });
    vscode.window.showInformationMessage(
      vscode.l10n.t('AgentBridge: Will ask again before closing a session that is still working.'),
    );
  });

  const renameCmd = vscode.commands.registerCommand('agentbridge.renameSession', async (item?: SessionItem) => {
    const session = (item ?? selectedSessionItem)?.session;
    if (!session) return;
    const newName = await vscode.window.showInputBox({
      prompt: vscode.l10n.t('Session name'),
      value: session.name,
    });
    if (newName === undefined) return;
    await renameSession(session.workspaceId, session.sessionId, newName);
    updateSessionTabTitle(session.sessionId, newName);
    sessionTree.refresh();
  });

  const deleteCmd = vscode.commands.registerCommand('agentbridge.deleteSession', async (item?: SessionItem) => {
    const session = (item ?? selectedSessionItem)?.session;
    if (!session) return;

    // 확인 문구를 행 종류에 맞춘다(0.5.0 W5, B-3) — 메인 행은 아래 서브 개수·이름을 함께 낸다.
    // 서브 삭제의 영수증 항목(worktree·브랜치·변경 파일 수)은 정리(B-7)가 생기는 단계의 몫이라
    // 여기서는 레코드가 지워진다는 사실만 알린다.
    const allSessions = await getSessions(session.workspaceId);
    const rowKind = rowKindOf(session, allSessions);
    const children = childSessions(allSessions, session.sessionId);
    const plan = planDeleteConfirm(rowKind, children);

    let message: string;
    if (plan.kind === 'subsession') {
      message = vscode.l10n.t(
        'Delete sub-session "{0}"? Its record and conversation log are removed.',
        session.name,
      );
    } else if (plan.childCount === 0) {
      message = vscode.l10n.t('Delete session "{0}"?', session.name);
    } else if (plan.childCount === 1) {
      message = vscode.l10n.t(
        'Delete session "{0}"? Its sub-session "{1}" will also be removed.',
        session.name, plan.childNames[0],
      );
    } else {
      message = vscode.l10n.t(
        'Delete session "{0}"? Its {1} sub-sessions ({2}) will also be removed.',
        session.name, plan.childCount, plan.childNames.join(', '),
      );
    }

    const answer = await vscode.window.showWarningMessage(
      message,
      { modal: true },
      vscode.l10n.t('Delete'),
    );
    if (answer !== vscode.l10n.t('Delete')) return;

    // 서브를 지울 때는 레코드만 지우는 것이 아니라 정리를 탄다 — worktree와 브랜치가 함께
    // 사라지고 영수증이 나온다 (0.5.0 B-7). 어느 경로로 지우든 결과가 같아야 하므로
    // `agent close`와 같은 함수로 들어간다.
    const receipts = plan.kind === 'subsession'
      ? [await cleanupOne(session.workspaceId, session.sessionId, session.agentName ?? '')]
      : await cleanupChildrenOf(session.workspaceId, session.sessionId);

    const activePanel = getActivePanel(session.sessionId);
    if (activePanel) {
      activePanel.markDeleted();
      activePanel.dispose();
    }
    await deleteSession(session.workspaceId, session.sessionId);
    sessionTree.refresh();

    // 영수증은 무엇이 사라졌고 어떻게 되살리는지를 담는다. 강제로 지워도 커밋은 남으므로
    // 사용자가 되살릴 수 있어야 한다.
    const shown = receipts.filter((r) => r.isolated || !r.ok);
    if (shown.length > 0) {
      void vscode.window.showInformationMessage(shown.map(renderReceipt).join('\n'), { modal: false });
    }
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
      vscode.window.showWarningMessage(vscode.l10n.t('AgentBridge: Open a workspace folder first.'));
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
      // modelSessionId(codex thread_id / agy UUID)는 PTY spawn 직후 비동기로 캡처되어 레지스트리에만
      // 영속되고, webview state에는 생성 시점 값(codex/agy는 보통 null)이 박힌 채 갱신되지 않는다.
      // 그래서 복원 때 state의 modelSessionId를 그대로 믿으면 resume 인자가 비어 새 세션으로 fallback된다
      // (openSession이 정상인 이유는 레지스트리를 읽기 때문). 복원도 레지스트리를 SSOT로 삼아 최신 값을 읽는다.
      const sessions = await getSessions(s.workspaceId);
      const meta = sessions.find((m) => m.sessionId === s.sessionId);
      const restored = meta
        ? await reclaimPendingModelSessionId(meta)
        : undefined;
      const opts = await buildOpts(s.model, folder.fsPath, s.workspaceId, s.sessionId, restored ?? s.modelSessionId);
      if (meta?.name) opts.terminalName = meta.name; // 복원 탭 제목 = 세션 이름
      // activate의 resetAllSessionsActive(모든 세션 비활성)와 경합 회피 — reset 완료 후 active 표시.
      // 안 기다리면 reset이 이 복구된 세션의 active 플래그를 덮어써 비활성으로 남을 수 있음 (V-21).
      if (pendingResetDone) await pendingResetDone;
      await markSessionActive(s.workspaceId, s.sessionId);
      sessionTree.refresh();
      const chat = ChatPanel.revive(panel, assets, opts);
      chat.onDispose(async () => {
        await markSessionClosed(s.workspaceId!, s.sessionId!);
        sessionTree.refresh();
      });
    },
  };
  context.subscriptions.push(vscode.window.registerWebviewPanelSerializer('agentbridge.chat', serializer));

  context.subscriptions.push(
    newSession, newSessionFromTab, newSessionWithModel, openSessionCmd, selectSessionCmd, refineCmd, resetCmd, enableCloseConfirmCmd, renameCmd, deleteCmd,
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
  // 내려가는 중임을 알린다 — 이때 닫히는 탭에는 닫기 확인을 띄우지 않는다 (0.5.0 W8).
  markShuttingDown();
  // VS Code는 deactivate가 반환한 Promise를 (타임아웃 한도 내에서) 기다린다.
  await Promise.allSettled(getAllPanels().map((p) => p.disposeAndFlush()));
}
