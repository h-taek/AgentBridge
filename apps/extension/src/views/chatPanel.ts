import * as vscode from 'vscode';
import * as pty from 'node-pty';
import { randomBytes } from 'crypto';
import { chmodSync, createWriteStream, type WriteStream } from 'fs';
import { join } from 'path';
import * as output from '../log/output';
import { registerCapture, unregisterCapture } from '../core/turnRecorder';
import { setHookDisabled } from '../core/hookStatusStore';
import { getSessions, renameSession, deleteSession, setModelSessionId, type SessionMeta } from '../core/sessionRegistry';
import { captureSessionIdFromHook, watchHookErrors, resolveHookErrorFile } from '@agentbridge/core';
import * as workspaceStore from '../core/workspaceStore';
import {
  computeSessionActivity,
  readSessionActivityInputs,
  acquireOwnership,
  updateOwnerSize,
  releaseOwnership,
  readForeignOwner,
} from '@agentbridge/core';
import { CLI_DISPLAY_NAME, type CliKind } from '../shared/types';
import modelColors from '@agentbridge/assets/colors.json';
import { quoteCommandLine } from '../shared/shellQuote';
import type { SpawnOptions } from '../pty/types';
import { createGroupLocker, type GroupLocker } from './groupLock';
import { decideClose } from './closeConfirm';
import { getWorkspaceStore } from '../core/coreInstances';

const activePanels = new Map<string, ChatPanel>();
const MAX_TAB_TITLE_LENGTH = 11;

// 붙여넣기와 제출 사이의 간격(ms). sendPrompt 참조.
const SUBMIT_DELAY_MS = 300;

// 익스텐션이 내려가는 중인가. 그때는 패널이 통째로 사라지는 중이라 닫기 확인을 띄우지 않는다.
let shuttingDown = false;
export function markShuttingDown(): void {
  shuttingDown = true;
}

function tabTitle(title: string): string {
  return title.length > MAX_TAB_TITLE_LENGTH ? title.substring(0, MAX_TAB_TITLE_LENGTH) + '…' : title;
}

// 채팅 패널이 활성화될 때 emit. extension.ts가 받아서 사이드 패널 selection 동기화.
export const chatPanelEvents = new vscode.EventEmitter<{ sessionId: string }>();

export function getActivePanel(sessionId: string): ChatPanel | undefined {
  return activePanels.get(sessionId);
}

export function getAllPanels(): ChatPanel[] {
  return Array.from(activePanels.values());
}

// 세션 이름이 바뀐 뒤(자동 명명·수동 rename) 열린 탭 제목을 즉시 갱신. 패널이 없으면 무시.
// 탭 제목은 패널 생성 시 1회만 박히므로(createWebviewPanel), 이후 변경은 여기로 명시 반영해야 한다.
export function updateSessionTabTitle(sessionId: string, title: string): void {
  activePanels.get(sessionId)?.setTabTitle(title);
}

export class ChatPanel {
  private panel: vscode.WebviewPanel;
  private ptyProcess: pty.IPty | null = null;
  private captureRegistered = false;
  private disposed = false;
  private replayStream: WriteStream | null = null;
  private ownerDir: string | null = null;
  private deletedExternally = false;
  private modelSessionWatchAbort: AbortController | null = null;
  private hookErrorWatchAbort: AbortController | null = null;
  private readonly opts: SpawnOptions;
  private readonly extensionUri: vscode.Uri;
  private onDisposeCallback: (() => void) | null = null;
  private readonly groupLocker: GroupLocker;
  // 이 패널이 새 AB 컬럼을 만들며 생성됐는지 — 그룹 자동 잠금은 이때만 수행한다.
  // (기존 AB 그룹에 합류하거나 IDE 재시작 복원되는 패널은 잠금에 손대지 않는다.)
  private readonly shouldLock: boolean;

  markDeleted(): void {
    this.deletedExternally = true;
  }

  // preserveFocus — 서브 탭은 메인이 명령을 부른 결과로 뜨므로 사용자가 보고 있던 자리에서
  // 커서를 뺏지 않는다 (0.5.0 B-6).
  static create(
    extensionUri: vscode.Uri,
    opts: SpawnOptions,
    preserveFocus = false,
  ): ChatPanel {
    // 컬럼 선택은 공식 claude-code 익스텐션과 동일한 방식 — "맨 오른쪽" 기하학이 아니라
    // "탭이 전부 AgentBridge 챗 웹뷰인 에디터 그룹"을 찾아 그 컬럼에 새 탭으로 합류한다.
    // 그런 그룹이 없으면 빈 컬럼에 새로 만들고(startedInNewColumn=true), 그때만 그룹을 잠근다.
    // 배치/포커스에 좌우되지 않으므로 "잠긴 오른쪽 대신 왼쪽에 스폰" 현상이 사라진다.
    const { column: targetColumn, startedInNewColumn } = ChatPanel.pickColumn();

    const panel = vscode.window.createWebviewPanel(
      'agentbridge.chat',
      tabTitle(opts.terminalName),
      { viewColumn: targetColumn, preserveFocus },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: ChatPanel.localRoots(extensionUri),
      },
    );

    return new ChatPanel(panel, extensionUri, opts, startedInNewColumn);
  }

  // 붙을 컬럼을 고른다. 탭이 전부 AgentBridge 챗인 그룹이 있으면 그 컬럼에 합류하고, 없으면
  // 빈 컬럼을 새로 잡는다. 새 탭을 만드는 자리(생성·재부착)가 같은 규칙을 써야 재부착된 탭이
  // 엉뚱한 자리에 스플릿으로 열리지 않는다 (0.5.0 W8).
  private static pickColumn(): { column: vscode.ViewColumn; startedInNewColumn: boolean } {
    const abGroup = vscode.window.tabGroups.all.find(
      (g) =>
        g.tabs.length > 0 &&
        g.tabs.every(
          (t) =>
            t.input instanceof vscode.TabInputWebview &&
            t.input.viewType.includes('agentbridge.chat'),
        ),
    );
    if (abGroup && abGroup.viewColumn) return { column: abGroup.viewColumn, startedInNewColumn: false };
    return { column: ChatPanel.findUnusedColumn(), startedInNewColumn: true };
  }

  // 안 쓰는 에디터 컬럼(One..Nine 중 첫 빈 칸, 없으면 Beside). 공식 claude-code 익스텐션과 동일.
  private static findUnusedColumn(): vscode.ViewColumn {
    const used = new Set<number>();
    vscode.window.tabGroups.all.forEach((g) => {
      if (g.viewColumn !== undefined) used.add(g.viewColumn);
    });
    for (let c = vscode.ViewColumn.One; c <= vscode.ViewColumn.Nine; c++) {
      if (!used.has(c)) return c;
    }
    return vscode.ViewColumn.Beside;
  }

  static revive(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    opts: SpawnOptions,
  ): ChatPanel {
    // 복원은 VS Code가 그룹 잠금 상태까지 워크벤치 레이아웃으로 복구하므로 잠금에 손대지 않는다.
    return new ChatPanel(panel, extensionUri, opts, false);
  }

  // 웹뷰가 로드 가능한 로컬 리소스 루트 — xterm 에셋(out/vendor) + 브랜드 에셋(media).
  // create·revive 양 경로에서 동일하게 적용해야 로딩 화면 로고가 CSP/리소스 정책에 막히지 않는다.
  private static localRoots(extensionUri: vscode.Uri): vscode.Uri[] {
    return [
      vscode.Uri.joinPath(extensionUri, 'out', 'vendor', '@xterm', 'xterm', 'css'),
      vscode.Uri.joinPath(extensionUri, 'out', 'vendor', '@xterm', 'xterm', 'lib'),
      vscode.Uri.joinPath(extensionUri, 'out', 'vendor', '@xterm', 'addon-fit', 'lib'),
      vscode.Uri.joinPath(extensionUri, 'out', 'vendor', '@xterm', 'addon-webgl', 'lib'),
      vscode.Uri.joinPath(extensionUri, 'out', 'vendor', '@xterm', 'addon-unicode11', 'lib'),
      vscode.Uri.joinPath(extensionUri, 'media'),
    ];
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    opts: SpawnOptions,
    shouldLock: boolean,
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.opts = opts;
    this.shouldLock = shouldLock;
    this.groupLocker = createGroupLocker({
      executeCommand: (cmd) => vscode.commands.executeCommand(cmd),
      warn: (msg) => output.warn(msg),
    });
    if (opts.sessionId) activePanels.set(opts.sessionId, this);
    this.wirePanel();
  }

  // 패널 하나에 붙는 배선 전부. 생성자와 재부착(W8)이 같은 것을 쓴다 — 둘이 갈리면 다시 연
  // 탭에서만 입력이나 리사이즈가 안 먹는 상태가 생긴다.
  private wirePanel(): void {
    const { extensionUri, opts } = this;
    // revive(reload 복원) 경로도 media 리소스 루트를 갖도록 보장 — 로딩 화면 로고 차단 방지.
    this.panel.webview.options = {
      enableScripts: true,
      localResourceRoots: ChatPanel.localRoots(extensionUri),
    };
    const modelLogo = vscode.Uri.joinPath(extensionUri, 'media', 'logos', `${opts.model ?? 'claude'}.svg`);
    this.panel.iconPath = { light: modelLogo, dark: modelLogo };

    this.panel.webview.html = this.buildHtml();

    this.panel.webview.onDidReceiveMessage((msg) => {
      switch (msg.type) {
        case 'ready':
          // 재부착이면 PTY가 이미 살아 있다. 새로 띄우는 대신 크기만 넘긴다 — 세 하니스 모두
          // 크기 변경 신호를 받으면 화면 전체를 스스로 다시 그린다(research 10 §3). 우리가
          // 화면 기록을 재생하지 않는 근거다.
          if (this.ptyProcess) this.repaint(msg.cols ?? 120, msg.rows ?? 30);
          else void this.spawnPty(msg.cols ?? 120, msg.rows ?? 30);
          break;
        case 'log':
          output.log(`[webview] ${msg.data}`);
          break;
        case 'attachSave':
          void this.handleAttachSave(msg.reqId, msg.name, msg.base64);
          break;
        case 'input':
          // 기록은 transcript 파일에서 읽음(M2-5) — 입력은 PTY로만. CLI가 자기 transcript에 기록.
          this.ptyProcess?.write(msg.data);
          break;
        case 'resize':
          try {
            this.ptyProcess?.resize(msg.cols, msg.rows);
          } catch { /* pty may have exited */ }
          if (this.ownerDir) {
            void updateOwnerSize(this.ownerDir, msg.cols, msg.rows).catch(() => {
              /* best-effort */
            });
          }
          break;
        case 'getSessions':
          this.handleGetSessions();
          break;
        case 'openSession':
          void this.handleOpenSession(msg.workspaceId, msg.sessionId);
          break;
        case 'renameSession':
          void this.handleRenameSession(msg.workspaceId, msg.sessionId);
          break;
        case 'deleteSession':
          void this.handleDeleteSession(msg.workspaceId, msg.sessionId);
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
      void this.onPanelClosed();
    });

    this.panel.onDidChangeViewState((e) => {
      if (this.shouldLock) this.groupLocker.onViewState(e.webviewPanel.active);
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
    // 생성 직후 이미 active인 패널의 그룹 잠금 — onDidChangeViewState는 변화만 감지하므로
    // 초기 상태는 직접 1회 전달한다. 단, 새 AB 컬럼을 만든 경우에만(shouldLock).
    if (this.shouldLock) this.groupLocker.onViewState(this.panel.active);
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

  // ─── 닫기 전 확인 (0.5.0 W8, B-2) ────────────────────────────────────
  //
  // 웹뷰 탭의 닫기는 가로챌 수 없다. VS Code가 주는 것은 닫힌 뒤에 오는 onDidDispose 하나뿐이고
  // 취소할 수 있는 이벤트가 없다. 그래서 순서를 뒤집는다 — 닫힌 직후에 묻고, 계속을 고르면
  // 탭을 다시 연다. 죽이는 시점이 우리 손에 있어서 성립한다.
  //
  // 진행 중이 아니면 안 묻는다. 매번 물으면 확인 자체가 무시된다.
  private async onPanelClosed(): Promise<void> {
    if (this.disposed) return;
    // 창을 닫거나 IDE를 끄는 중이면 되돌릴 자리가 없다. 그 경로에서는 디스크도 안 읽는다.
    const dying = shuttingDown || this.deletedExternally || !this.ptyProcess;
    const turnRunning = !dying && (await this.isTurnRunning());
    const decision = decideClose({
      shuttingDown,
      deletedExternally: this.deletedExternally,
      hasPty: !!this.ptyProcess,
      turnRunning,
      askDisabled: turnRunning && (await this.isCloseConfirmDisabled()),
    });
    if (decision === 'close') {
      this.dispose();
      return;
    }
    const keepLabel = vscode.l10n.t('Keep running');
    const neverLabel = vscode.l10n.t('Close and stop asking');
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t('"{0}" is still working. Close it anyway?', this.opts.terminalName),
      { modal: true, detail: vscode.l10n.t('Closing ends the session and the turn in progress is lost.') },
      keepLabel,
      neverLabel,
    );
    if (answer === neverLabel) {
      await this.setCloseConfirmDisabled();
      this.dispose();
      return;
    }
    if (answer !== keepLabel) {
      this.dispose();
      return;
    }
    this.reattach();
  }

  // 이 레포에서 확인을 껐는가 (0.5.0 6단계). 값은 workspace.json에 있어 저장소마다 따로 간다.
  // 못 읽으면 묻는 쪽으로 떨어진다 — 못 묻는 것이 잘못 닫는 것보다 낫다.
  private async isCloseConfirmDisabled(): Promise<boolean> {
    const { workspaceId } = this.opts;
    if (!workspaceId) return false;
    try {
      return (await getWorkspaceStore().loadWorkspace(workspaceId)).closeConfirmDisabled === true;
    } catch {
      return false;
    }
  }

  private async setCloseConfirmDisabled(): Promise<void> {
    const { workspaceId } = this.opts;
    if (!workspaceId) return;
    try {
      await getWorkspaceStore().updateWorkspaceMeta(workspaceId, { closeConfirmDisabled: true });
    } catch (err) {
      output.warn(`닫기 확인 끄기 저장 실패: ${String(err)}`);
    }
  }

  // 상태 표시가 쓰는 판정을 그대로 쓴다 — 우리가 따로 매기는 값이 아니다.
  private async isTurnRunning(): Promise<boolean> {
    const { workspaceId, sessionId } = this.opts;
    if (!workspaceId || !sessionId) return false;
    try {
      const wsDir = workspaceStore.getWorkspacePath(workspaceId);
      const inputs = await readSessionActivityInputs(wsDir, sessionId);
      return computeSessionActivity(inputs, Date.now()) === 'running';
    } catch {
      return false; // 판정할 수 없으면 묻지 않는다. 못 묻는 것이 잘못 막는 것보다 낫다
    }
  }

  // 계속을 고른 경우. PTY는 아직 살아 있으므로 새 탭을 만들어 다시 붙인다. 화면은 웹뷰가
  // 준비되면 크기 신호로 하니스가 스스로 다시 그린다.
  private reattach(): void {
    this.panel = vscode.window.createWebviewPanel(
      'agentbridge.chat',
      tabTitle(this.opts.terminalName),
      { viewColumn: ChatPanel.pickColumn().column, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: ChatPanel.localRoots(this.extensionUri),
      },
    );
    this.wirePanel();
    output.log(`ChatPanel 재부착: ${this.opts.sessionId?.slice(0, 8)}`);
  }

  // 크기 신호로 하니스가 화면 전체를 다시 그리게 한다. 같은 크기를 그대로 주면 신호가 안 가는
  // 터미널이 있어 한 줄 줄였다가 되돌린다.
  private repaint(cols: number, rows: number): void {
    const pty = this.ptyProcess;
    if (!pty) return;
    try {
      pty.resize(cols, Math.max(1, rows - 1));
      setTimeout(() => {
        try {
          pty.resize(cols, rows);
        } catch {
          /* 그 사이 죽었다 */
        }
      }, 50);
    } catch {
      /* 그 사이 죽었다 */
    }
  }

  // 이 세션의 프로세스가 살아 있는가. `agent check`가 빈손으로 돌아올 때 "아직 일하는 중"과
  // "신호 없이 끝남"을 가르는 재료다 (0.5.0 B-6).
  get alive(): boolean {
    return !!this.ptyProcess;
  }

  // 도는 세션에 지침을 더 보낸다 (0.5.0 B-6, `agent send`).
  //
  // 괄호 붙여넣기로 감싼다. 원문을 그대로 쓰면 agy가 조용히 버린다 — 입력줄이 빈 채로 남고
  // 오류도 안 나서 화면만 보면 안 보낸 것과 구분되지 않는다(research 10 §2).
  //
  // 제출은 붙여넣기가 끝난 뒤에 따로 보낸다. 실측에서는 1초를 뒀는데 그건 사람이 보는 간격이라
  // 여기서는 짧게 잡고, 게이트 1 라이브에서 이 값으로 세 하니스가 다 받는지 확인한다.
  sendPrompt(text: string): boolean {
    const pty = this.ptyProcess;
    if (!pty || !text) return false;
    pty.write(`\x1b[200~${text}\x1b[201~`);
    setTimeout(() => {
      try {
        pty.write('\r');
      } catch {
        /* 그 사이 죽었다 */
      }
    }, SUBMIT_DELAY_MS);
    return true;
  }

  // preserveFocus를 켜면 이 탭이 자기 그룹에서 앞으로 나오되 키보드 포커스는 있던 자리에
  // 남는다. 서브가 뜬 뒤 메인을 다시 앞으로 보낼 때 쓴다 (0.5.0 B-6).
  reveal(preserveFocus = false): void {
    this.panel.reveal(undefined, preserveFocus);
  }

  // 탭 제목 갱신 — 패널 생성 후 세션 이름이 바뀌면 호출(자기 세션 자동명명 또는 updateSessionTabTitle 경유).
  // 빈 이름으로 탭을 비우지 않도록 가드(빈 rename은 degenerate edge).
  setTabTitle(title: string): void {
    if (this.disposed || !title.trim()) return;
    this.panel.title = tabTitle(title);
  }

  private async spawnPty(cols: number, rows: number): Promise<void> {
    const { command, args, cwd, env } = this.opts;

    // 소유권 가드 (대화 분기 방지, core 공용) — 다른 프로세스(데스크탑/다른 호스트)가 이 세션을
    // 라이브 소유 중이면 PTY를 띄우지 않는다. 상대가 닫으면 owner.json이 사라져 통과한다.
    if (this.opts.workspaceId && this.opts.sessionId) {
      const dir = workspaceStore.getSessionDir(this.opts.workspaceId, this.opts.sessionId);
      const foreign = await readForeignOwner(dir);
      if (foreign) {
        const appName =
          foreign.app === 'desktop'
            ? vscode.l10n.t('the desktop app')
            : vscode.l10n.t('the other extension');
        output.log(`ChatPanel PTY spawn 거부 — 외부 소유(${appName}, pid=${foreign.pid})`);
        this.panel.webview.postMessage({
          type: 'output',
          data: vscode.l10n.t(
            '\r\n[AgentBridge] This session is in use by {0}.\r\nClose the session in the other app, then close and reopen this tab.\r\n',
            appName,
          ),
        });
        return;
      }
    }

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

      if (this.opts.model && this.opts.workspaceId && this.opts.sessionId && this.opts.turnSignalFilePath) {
        // 턴 기록은 종료 훅 신호가 트리거다. 신호가 transcript 경로까지 실어 오므로 여기서
        // modelSessionId를 넘길 필요가 없다 (0.5.0 A-2).
        registerCapture({
          workspaceId: this.opts.workspaceId,
          sessionId: this.opts.sessionId,
          model: this.opts.model,
          workspacePath: this.opts.cwd,
          signalFilePath: this.opts.turnSignalFilePath,
          // 서브의 턴은 워크스페이스 직하가 아니라 그 세션 폴더에 쌓인다 (0.5.0 B-8).
          subagent: !!this.opts.parentSessionId,
          // 자동 명명이 제목을 정하면 이 패널의 탭 제목을 즉시 갱신(닫았다 열 필요 없이).
          onAutoNamed: (title) => this.setTabTitle(title),
        });
        this.captureRegistered = true;
      }

      // replay.log + owner.json — 두 앱이 같은 세션 디렉토리(V-12 결정적 ID)를 공유하므로
      // 데스크탑과 동일한 raw replay.log를 기록하고, 이 세션이 *익스텐션에서 라이브*임을 표시.
      if (this.opts.workspaceId && this.opts.sessionId) {
        this.ownerDir = workspaceStore.getSessionDir(this.opts.workspaceId, this.opts.sessionId);
        const replayLogPath = join(this.ownerDir, 'replay.log');
        this.replayStream = createWriteStream(replayLogPath, { flags: 'a', encoding: 'utf8' });
        this.replayStream.on('error', (err) => output.warn(`replay.log write error: ${String(err)}`));
        void acquireOwnership(this.ownerDir, { app: 'extension', cols, rows }).catch((err) =>
          output.warn(`owner.json acquire 실패: ${String(err)}`),
        );
      }

      this.ptyProcess.onData((data) => {
        // replay.log: RAW (필터 전 원본 — 데스크탑 ptySession과 동일 규약). 두 앱이 같은
        // replay.log를 써야 어느 쪽 세션이든 상대가 미러링할 수 있다 (V-12 / Plan 2).
        if (this.replayStream && !this.replayStream.destroyed) {
          this.replayStream.write(data);
        }
        // 기록은 transcript 파일에서 읽음(M2-5) — 여기선 표시만(webview output). replay.log는 위에서 RAW 기록.
        if (!this.disposed && data) {
          this.panel.webview.postMessage({ type: 'output', data });
        }
      });

      this.startModelSessionIdWatcher();
      this.startHookErrorWatcher();

      this.ptyProcess.onExit(({ exitCode, signal }) => {
        output.log(`ChatPanel PTY exited: code=${exitCode} signal=${signal ?? 'none'}`);
        this.modelSessionWatchAbort?.abort();
        this.hookErrorWatchAbort?.abort();
        if (this.replayStream && !this.replayStream.destroyed) {
          this.replayStream.end();
          this.replayStream = null;
        }
        if (this.ownerDir) {
          // ownerDir를 먼저 null — 양보/종료 후 dispose()가 owner.json을 재-release해서
          // 다음 소유자(인수한 데스크탑)의 owner.json을 지우는 일을 막는다 (Plan 2b 인수 순서).
          const dir = this.ownerDir;
          this.ownerDir = null;
          void releaseOwnership(dir).catch(() => {
            /* best-effort */
          });
        }
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

  // codex/agy 세션 id 캡처 — spawn 직후 fire-and-forget.
  // 훅이 <워크스페이스>/sessions/<세션 id>/captured.json에 native id를 쓰면 그것만 읽는다.
  // 폴더를 뒤져 알아맞히는 경로는 두지 않는다 — 틀린 id는 없는 id보다 나쁘다 (spec A-1).
  // 캡처되면 sessionRegistry.setModelSessionId로 영속화 → 다음 reopen에서 resume 인자 생성.
  // 훅이 제 일을 못 했다는 사실을 드러낸다 (0.5.0 A-2). 폴백을 걷어낸 뒤로 이 상태를 덮어 줄
  // 것이 없으므로, 조용히 절름발이로 도는 대신 UI에 띄운다.
  private startHookErrorWatcher(): void {
    const { workspaceId, sessionId, model } = this.opts;
    if (!workspaceId || !sessionId || !model) return;
    const ctrl = new AbortController();
    this.hookErrorWatchAbort = ctrl;
    const errorFilePath = resolveHookErrorFile(
      workspaceStore.getWorkspacePath(workspaceId),
      sessionId,
    );
    const watcher = watchHookErrors({
      errorFilePath,
      signal: ctrl.signal,
      logger: { log: (m) => output.log(m), warn: (m) => output.warn(m) },
      onError: (err) => setHookDisabled(workspaceId, model, err.message, 'runtime'),
    });
    ctrl.signal.addEventListener('abort', () => watcher.stop(), { once: true });
  }

  private startModelSessionIdWatcher(): void {
    const { workspaceId, sessionId, model, hookCaptureFilePath } = this.opts;
    if (!workspaceId || !sessionId || !hookCaptureFilePath) return;
    if (model !== 'codex' && model !== 'agy') return;

    const ctrl = new AbortController();
    this.modelSessionWatchAbort = ctrl;

    void captureSessionIdFromHook({ captureFilePath: hookCaptureFilePath, signal: ctrl.signal })
      .then((modelSessionId) => {
        if (!modelSessionId) return;
        void setModelSessionId(workspaceId, sessionId, modelSessionId).catch((err) => {
          output.warn(`ChatPanel: setModelSessionId 실패 — ${String(err)}`);
        });
      })
      .catch((err) => output.warn(`ChatPanel: ${model} 캡처 실패 — ${String(err)}`));
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
      // 자리는 저장소 루트의 attachments/ 하나. 파일명 정리와 프로젝트 구분(경로 다이제스트)은
      // attachmentPathFor가 맡는다.
      const absPath = attachmentPathFor(this.opts.cwd, name);
      await writeAttachment(absPath, base64);
      // cwd 기준 relative — @ mention 단축용. 저장소가 프로젝트 밖이라 사실상 절대경로가 나간다.
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

  // webview 메시지의 소유권 검증 (V-29) — 메시지는 세션을 "지목"만 할 수 있고, 실제 데이터는
  // 전부 호스트 저장소에서 가져온다. 이 패널의 워크스페이스에 실재하는 세션만 통과.
  // 정상 사용에선 검증 실패가 발생하지 않으므로, 경고 로그가 찍히면 그 자체가 이상 신호.
  private async resolveOwnedSession(workspaceId: string, sessionId: string): Promise<SessionMeta | null> {
    const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!folderUri) return null;
    const ownWid = workspaceStore.getOrCreateWorkspaceId(folderUri.fsPath);
    if (workspaceId !== ownWid) {
      output.warn('chatPanel: webview 메시지의 workspaceId가 패널 워크스페이스와 불일치 — 무시');
      return null;
    }
    const sessions = await getSessions(ownWid);
    const session = sessions.find((s) => s.sessionId === sessionId) ?? null;
    if (!session) {
      output.warn('chatPanel: webview 메시지가 지목한 세션이 워크스페이스에 없음 — 무시');
    }
    return session;
  }

  private async handleOpenSession(workspaceId: string, sessionId: string): Promise<void> {
    const session = await this.resolveOwnedSession(workspaceId, sessionId);
    if (!session) return;
    // 메시지의 model 값 대신 저장소의 세션 객체 전체를 전달 — modelSessionId(resume용)도 함께 간다.
    vscode.commands.executeCommand('agentbridge.openSession', session);
  }

  private async handleRenameSession(workspaceId: string, sessionId: string): Promise<void> {
    const session = await this.resolveOwnedSession(workspaceId, sessionId);
    if (!session) return;
    const newName = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Session name'), value: session.name });
    if (newName === undefined) return;
    await renameSession(workspaceId, sessionId, newName);
    updateSessionTabTitle(sessionId, newName);
    this.handleGetSessions();
  }

  private async handleDeleteSession(workspaceId: string, sessionId: string): Promise<void> {
    const session = await this.resolveOwnedSession(workspaceId, sessionId);
    if (!session) return;
    // 확인 모달에는 메시지가 주장한 이름이 아니라 저장소의 실제 이름을 띄운다 (이름표 바꿔치기 차단).
    const answer = await vscode.window.showWarningMessage(vscode.l10n.t('Delete session "{0}"?', session.name), { modal: true }, vscode.l10n.t('Delete'));
    if (answer !== vscode.l10n.t('Delete')) return;
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
    this.hookErrorWatchAbort?.abort();
    void this.flushCapture(); // fire-and-forget finalize (마지막 턴 flush 보장은 disposeAndFlush).

    if (this.replayStream && !this.replayStream.destroyed) {
      this.replayStream.end();
      this.replayStream = null;
    }
    if (this.ownerDir) {
      void releaseOwnership(this.ownerDir).catch(() => {
        /* best-effort */
      });
      this.ownerDir = null;
    }

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

  // 앱/익스텐션 종료(deactivate) 시 — 진행 중 turn을 flush 완료까지 await한 뒤 dispose (V-07).
  // 일반 dispose()는 flushCapture()를 fire-and-forget으로 호출해 마지막 턴이 유실될 수 있음.
  async disposeAndFlush(): Promise<void> {
    if (this.disposed) return;
    try {
      await this.flushCapture();
    } catch {
      /* noop — flush 실패해도 종료는 진행 */
    }
    this.dispose();
  }

  // 캡처 세션 종료 + 마지막 열린 턴 flush. dispose/disposeAndFlush 양쪽에서 호출되나 1회만 수행.
  private async flushCapture(): Promise<void> {
    if (!this.captureRegistered || !this.opts.sessionId) return;
    this.captureRegistered = false;
    await unregisterCapture(this.opts.sessionId);
  }

  private buildHtml(): string {
    const webview = this.panel.webview;
    const xtermCss = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'out', 'vendor', '@xterm', 'xterm', 'css', 'xterm.css'),
    );
    const xtermJs = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'out', 'vendor', '@xterm', 'xterm', 'lib', 'xterm.js'),
    );
    const fitJs = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'out', 'vendor', '@xterm', 'addon-fit', 'lib', 'addon-fit.js'),
    );
    const webglJs = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'out', 'vendor', '@xterm', 'addon-webgl', 'lib', 'addon-webgl.js'),
    );
    const unicode11Js = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'out', 'vendor', '@xterm', 'addon-unicode11', 'lib', 'addon-unicode11.js'),
    );
    const nonce = getNonce();
    const modelLabel = this.opts.model ? CLI_DISPLAY_NAME[this.opts.model] : 'CLI';
    // TUI 부팅 대기 화면용 에셋 — agent 로고 + AgentBridge 마크(데스크톱과 공통 디자인).
    const loadingModel = this.opts.model ?? 'claude';
    const loadingLogo = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'logos', `${loadingModel}.svg`),
    );
    // 브랜드 마크는 테마에 맞춰 변형 선택 — 컬러(주황/보라/파랑)는 유지, 계단 회색만 명/암 적응.
    const isLightTheme =
      vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light ||
      vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight;
    const brandMark = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', isLightTheme ? 'icon-light.svg' : 'icon-dark.svg'),
    );

    // VS Code 재시작 시 panel을 복구하기 위한 최소 state. serializer.deserializeWebviewPanel에서
    // 다시 받아 buildOpts로 재구성한다.
    // '<'를 유니코드 이스케이프 표기로 치환 — 값에 닫는 script 태그가 들어와도 블록을 탈출하지 못하게 (V-28).
    const restoreState = JSON.stringify({
      sessionId: this.opts.sessionId ?? null,
      model: this.opts.model ?? null,
      workspaceId: this.opts.workspaceId ?? null,
      modelSessionId: this.opts.modelSessionId ?? null,
      terminalName: this.opts.terminalName,
    }).replace(/</g, '\\u003c');

    // webview script 안 JS 문자열로 끼워 넣는 자기 세션 ID — JSON.stringify로 따옴표/역슬래시를
    // 안전한 리터럴로 만들고, <까지 치환해 script 탈출을 차단 (V-28).
    const ownSessionIdJs = JSON.stringify(this.opts.sessionId ?? '').replace(/</g, '\\u003c');

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource}; font-src ${webview.cspSource};">
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
    :root { --accent: ${modelColors.claude}; }
    body[data-model="codex"] { --accent: ${modelColors.codex}; }
    body[data-model="agy"] { --accent: ${modelColors.agy}; }
    .title { font-weight: 500; font-size: 12px; color: #fff; }
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
    .header .badge {
      font-size: 11px;
      font-weight: 800;
      letter-spacing: .2px;
      padding: 1px 6px;
      border-radius: 999px;
      background: var(--accent);
      color: #1b1b1d;
    }
    .header .sp { flex: 1; }
    .hbtn {
      background: none;
      border: none;
      color: var(--vscode-foreground);
      cursor: pointer;
      width: 30px;
      height: 30px;
      border-radius: 7px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
    }
    .hbtn:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.1));
    }

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
    #terminal-container.drop-active::after,
    #terminal-container.drop-report::after {
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
    /* 드롭 결과를 잠깐 띄운다 — 실패가 조용히 지나가지 않게. */
    #terminal-container.drop-report::after {
      content: attr(data-drop-msg);
      border-style: solid;
    }
    .xterm { height: 100%; }
    .xterm-viewport { background-color: inherit !important; }

    /* TUI 부팅 대기 — 데스크톱과 공통 디자인. 첫 PTY 출력 도착 시 숨김. */
    #ab-loading {
      position: absolute;
      inset: 0;
      z-index: 40;
      background: var(--vscode-panel-background, var(--vscode-editor-background, #1e1e1e));
      opacity: 1;
      transition: opacity 240ms ease-out;
      pointer-events: none;
    }
    #ab-loading.hidden { opacity: 0; }
    .ab-loading-brand {
      position: absolute;
      top: 18px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      align-items: center;
      gap: 6px;
      opacity: 0.72;
    }
    .ab-loading-brand img { width: 13px; height: 12px; display: block; }
    .ab-loading-brand span {
      font-size: 12.5px;
      font-weight: 600;
      letter-spacing: 0.01em;
      color: var(--vscode-foreground);
    }
    .ab-loading-center {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    .ab-loading-mark {
      position: relative;
      width: 72px;
      height: 72px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 18px;
    }
    .ab-loading-pulse {
      position: absolute;
      inset: -8px;
      border-radius: 50%;
      background: var(--accent);
      opacity: 0.22;
      filter: blur(14px);
      animation: ab-loading-pulse 1.7s ease-in-out infinite;
    }
    @keyframes ab-loading-pulse {
      0%, 100% { transform: scale(0.86); opacity: 0.14; }
      50% { transform: scale(1.06); opacity: 0.3; }
    }
    .ab-loading-logo { position: relative; z-index: 1; width: 56px; height: 56px; display: block; }
    .ab-loading-label {
      font-size: 16px;
      font-weight: 600;
      color: var(--vscode-foreground);
      letter-spacing: 0.01em;
      margin-bottom: 7px;
    }
    .ab-loading-sub { font-size: 11.5px; color: var(--vscode-descriptionForeground); letter-spacing: 0.01em; }
  </style>
</head>
<body data-model="${this.opts.model ?? 'claude'}">
  <div class="sp-overlay" id="spOverlay"></div>
  <div class="header">
    <span class="title">AgentBridge</span>
    <span class="badge">${escapeHtml(modelLabel)}</span>
    <span class="sp"></span>
    <button id="btnSelectSession" class="hbtn" title="History">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
    </button>
    <button id="btnNewSession" class="btn-new hbtn" title="New session">
      <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
    </button>
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
        <span class="mp-item-dot" style="background:${modelColors.claude}"></span>
        <span class="mp-item-name">Claude</span>
        <span class="mp-item-desc">Anthropic</span>
      </div>
      <div class="mp-item" data-model="codex">
        <span class="mp-item-dot" style="background:${modelColors.codex}"></span>
        <span class="mp-item-name">Codex</span>
        <span class="mp-item-desc">OpenAI</span>
      </div>
      <div class="mp-item" data-model="agy">
        <span class="mp-item-dot" style="background:${modelColors.agy}"></span>
        <span class="mp-item-name">Antigravity</span>
        <span class="mp-item-desc">Google</span>
      </div>
    </div>
  </div>
  <div id="terminal-container">
    <div id="ab-loading">
      <div class="ab-loading-brand">
        <img src="${brandMark}" alt="" />
        <span>AgentBridge</span>
      </div>
      <div class="ab-loading-center">
        <div class="ab-loading-mark">
          <div class="ab-loading-pulse"></div>
          <img class="ab-loading-logo" src="${loadingLogo}" alt="" />
        </div>
        <div class="ab-loading-label">${escapeHtml(modelLabel)}</div>
        <div class="ab-loading-sub">${escapeHtml(modelLabel)} running on AgentBridge</div>
      </div>
    </div>
  </div>

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
    // @ 멘션 표기 — 공백이 있는 경로만 큰따옴표로 감싸고, 없으면 그대로 쓴다.
    function quoteMentionPath(p) {
      return /\s/.test(p) ? '"' + p.replace(/"/g, '\\"') + '"' : p;
    }
    function hasFileLikeType(types) {
      if (!types) return false;
      for (let i = 0; i < types.length; i++) {
        const t = types[i];
        if (t === 'Files' || t === 'text/uri-list' || t === 'text/plain') return true;
        // VS Code 내부 드래그 — 탐색기·편집기 탭이 저마다 다른 이름을 싣는다.
        if (t.includes('resource-urls') || t.includes('codeeditors') || t.indexOf('application/vnd.code') === 0) return true;
      }
      return false;
    }

    // Shift 래치 — 커서가 이 화면 안에 있는 동안 Shift가 한 번이라도 눌리면 그 드래그를 우리 것으로
    // 잡고, 화면을 벗어나거나 드래그가 끝날 때까지 유지한다.
    //
    // 매 이벤트마다 shiftKey를 다시 보면 마우스를 놓기 직전에 Shift가 떨어진 드롭이 씹힌다.
    // 리스너가 웹뷰 document에 있어 커서가 이 화면 위일 때만 이벤트가 오므로, 래치의 유효 범위는
    // 자연히 이 패널로 한정된다 — 편집기나 탐색기 위의 드래그는 애초에 우리에게 오지 않는다.
    let dragLatched = false;
    let dragDepth = 0;
    let dropReportTimer = null;

    function releaseDrag() {
      dragLatched = false;
      dragDepth = 0;
      container.classList.remove('drop-active');
    }
    // 이미 잡은 드래그면 Shift와 타입을 다시 묻지 않는다.
    function latchDrag(e) {
      if (!dragLatched && e.shiftKey && hasFileLikeType(e.dataTransfer && e.dataTransfer.types)) {
        dragLatched = true;
      }
      return dragLatched;
    }
    // 드롭 결과를 잠깐 띄운다. 실패가 로그에만 남고 화면은 조용한 상태를 없앤다.
    function reportDrop(msg) {
      container.dataset.dropMsg = msg;
      container.classList.add('drop-report');
      if (dropReportTimer) clearTimeout(dropReportTimer);
      dropReportTimer = setTimeout(() => container.classList.remove('drop-report'), 2600);
    }

    document.addEventListener('dragenter', (e) => {
      dragDepth++;
      if (!latchDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      container.classList.add('drop-active');
    }, true);
    document.addEventListener('dragover', (e) => {
      if (!latchDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      container.classList.add('drop-active');
    }, true);
    document.addEventListener('dragleave', () => {
      // 진입·이탈 깊이로 판단한다. relatedTarget은 웹뷰 안에서 요소를 넘나들 때도 null로 와서,
      // 그것만 보면 드래그 중에 표시가 깜빡이고 래치가 엉뚱하게 풀린다.
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) releaseDrag();
    }, true);
    document.addEventListener('dragend', releaseDrag, true);
    window.addEventListener('blur', releaseDrag);

    document.addEventListener('drop', (e) => {
      const latched = dragLatched;
      releaseDrag();
      if (!latched) return;
      const dt = e.dataTransfer;
      if (!dt) return;
      const types = Array.from(dt.types || []);
      e.preventDefault();
      e.stopPropagation();

      const paths = new Set();
      const pending = [];
      let failed = 0;

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
              if (typeof result !== 'string') { failed++; resolve(); return; }
              const comma = result.indexOf(',');
              const base64 = comma >= 0 ? result.slice(comma + 1) : '';
              if (!base64) { failed++; resolve(); return; }
              const reqId = 'attach-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
              let settled = false;
              const finish = (ok) => {
                if (settled) return;
                settled = true;
                window.removeEventListener('message', handler);
                if (!ok) failed++;
                resolve();
              };
              const handler = (ev) => {
                const m = ev.data;
                if (m && m.type === 'attachSaved' && m.reqId === reqId) {
                  if (m.path) paths.add(m.path);
                  finish(!!m.path);
                }
              };
              window.addEventListener('message', handler);
              vscode.postMessage({ type: 'attachSave', reqId, name: f.name, base64 });
              setTimeout(() => finish(false), 10_000);
            };
            reader.onerror = () => { failed++; resolve(); };
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
          reportDrop(failed > 0 ? 'Could not read the dropped file' : 'No file path found in this drop');
          vscode.postMessage({ type: 'log', data: 'DnD: no paths extracted — failed=' + failed + ' types=' + JSON.stringify(types) });
          return;
        }
        if (failed > 0) {
          reportDrop('Skipped ' + failed + ' file' + (failed > 1 ? 's' : '') + ' that could not be read');
          vscode.postMessage({ type: 'log', data: 'DnD: ' + failed + ' file(s) failed, ' + paths.size + ' inserted' });
        }
        // @<path> mention 형식 — claude/codex/agy 모두 지원.
        const insertion = Array.from(paths).map(p => '@' + quoteMentionPath(p)).join(' ') + ' ';
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
        return '<div class="sp-item' + (s.sessionId === ${ownSessionIdJs} ? ' active' : '') + '" data-sid="' + esc(s.sessionId) + '" data-wid="' + esc(s.workspaceId) + '" data-model="' + esc(s.model) + '">'
          + '<span class="sp-item-name">' + esc(s.name) + '</span>'
          + '<span class="sp-item-desc">' + esc(desc) + '</span>'
          + '<div class="sp-item-actions">'
          + '<button class="sp-rename" title="Rename"><svg viewBox="0 0 16 16"><path d="M13.23 1h-1.46L3.52 9.25l-.16.22L1 13.59 2.41 15l4.12-2.36.22-.16L15 4.23V2.77L13.23 1zM2.41 13.59l1.51-3 1.45 1.45-2.96 1.55zm3.83-2.06L4.47 9.76l6.69-6.69 1.77 1.77-6.69 6.69z"/></svg></button>'
          + '<button class="sp-delete" title="Delete"><svg viewBox="0 0 16 16"><path d="M10 3h3v1h-1v9l-1 1H5l-1-1V4H3V3h3l1-1h2l1 1zM9 3H7l-.5.5h3L9 3zm0 4v5H8V7h1zm-3 0v5h1V7H6z"/></svg></button>'
          + '</div></div>';
      }).join('');
    }

    function esc(s) {
      // 요소 내용뿐 아니라 속성 값(data-*)에도 쓰이므로 따옴표까지 무력화 (V-28).
      if (!s) return '';
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
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
        const loadingEl = document.getElementById('ab-loading');
        if (loadingEl) loadingEl.classList.add('hidden');
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

// 호스트 쪽 HTML 이스케이프 — webview HTML 템플릿에 끼워 넣는 표시값은 모두 이 함수를 거친다.
// 현재 끼워 넣는 값(CLI_DISPLAY_NAME enum, terminalName)은 코드가 만드는 고정값이지만,
// 값의 출처가 바뀌어도 안전하도록 방어 계층을 유지한다 (V-28).
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
