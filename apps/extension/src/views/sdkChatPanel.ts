// SDK 채팅 패널 — 각 에이전트를 SDK/app-server로 구동하는 GUI 채팅(PTY ChatPanel과 토글 병행).
//
// claude SDK(@anthropic-ai/claude-agent-sdk)는 ESM 전용 + 자기 CLI를 디스크서 spawn한다.
//   익스텐션이 ESM 번들(out/extension.mjs)이라 claudeAdapter를 평범하게 정적 import.
//   SDK 자체는 esbuild external(번들 인라인 시 디스크 경로 해석 깨짐) → 런타임에 node_modules에서 해석
//   (dev=워크스페이스 / 패키징=벤더본). codexAdapter는 SDK-free라 배럴에서 정적 import.
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { ChatEvent, Session, CliKind, PermissionMode, ModelOption, AccountUsage, McpServerInfo, AgentInfo } from '@agentbridge/core';
// 번들 코어(SDK-free 배럴) — 저장/IR/스케줄러/어댑터 팩토리·셋업은 번들본 한 사본을 SSOT로. codex·agy는 createSdkAdapters가 들고 온다.
import { readIR, createSdkAdapters, startSdkSession, resolveTranscriptPath, resolveContext, acquireOwnership, readForeignOwner, releaseOwnership } from '@agentbridge/core';
// claudeAdapter는 ESM SDK를 만져 배럴 비노출(코어 테스트/데스크탑 보호) — 서브경로 정적 import. SDK는 esbuild external.
import { claudeAdapter } from '@agentbridge/core/dist/sdkAdapter/claudeAdapter.js';
import { getCompactionScheduler, getWorkspaceStore, getHookInstaller } from '../core/coreInstances';
import { getSessionDir } from '../core/workspaceStore';
import { chatHeaderHtml, CHAT_HEADER_CSS, chatHeaderScript } from './chatHeader';
import { chatPanelEvents } from './chatPanel';
import { getSessions, renameSession, deleteSession, type SessionMeta } from '../core/sessionRegistry';
import { createGroupLocker } from './groupLock';
import * as output from '../log/output';

// SDK 어댑터 set(코어 팩토리) — model→어댑터 선택을 코어 한 곳에. claude만 번들 경계라 호스트가 정적 import해 주입.
const sdkAdapters = createSdkAdapters({ claude: claudeAdapter });

// agy(API 키) 인증용 — claude/codex는 자체 OAuth 스토어를 쓰지만 agy는 키를 우리가 들고 있어야 한다.
// 키는 OS 키체인(SecretStorage)에 보관하고 세션 스폰 시 process.env.GEMINI_API_KEY로 주입. activate에서 setSdkChatSecrets로 주입.
export const GEMINI_SECRET_KEY = 'agentbridge.geminiApiKey';
let secretStore: vscode.SecretStorage | undefined;
export function setSdkChatSecrets(s: vscode.SecretStorage): void {
  secretStore = s;
}

export class SdkChatPanel {
  private session: Session | null = null;
  private disposed = false;
  private cwd = '';
  private workspaceId = '';
  private model: CliKind = 'claude';

  // 세션 통합(seam) — AgentBridge sessionId로 레지스트리·트리에 물린다(PTY ChatPanel과 동일 계약).
  private static activePanels = new Map<string, SdkChatPanel>();
  static getActivePanel(sessionId: string): SdkChatPanel | undefined { return SdkChatPanel.activePanels.get(sessionId); }
  static getAllPanels(): SdkChatPanel[] { return Array.from(SdkChatPanel.activePanels.values()); }

  private sessionId = '';
  private resumeId: string | undefined; // 이전 세션 이어가기(claude session_id / codex thread id)
  private onModelSessionCb: ((modelSessionId: string) => void) | undefined; // 에이전트 세션 id 보고(영속용)
  private onDisposeCb: (() => void) | undefined; // 패널 닫힘 알림(호스트가 markSessionClosed)
  private onTitleCb: ((title: string) => void) | undefined; // 자동 제목 보고(호스트가 renameSession)
  private titlePending = false; // 새 세션의 첫 메시지에서 자동 제목 1회
  private lastModelSession = ''; // 마지막으로 보고한 모델 세션 id(중복 영속 방지)
  // 에디터 그룹 자동 잠금(PTY와 동일) — 처음 active 시 그룹 잠가 탐색기 파일이 챗을 덮지 않게.
  private readonly groupLocker = createGroupLocker({ executeCommand: (cmd) => vscode.commands.executeCommand(cmd), warn: (msg) => output.warn(msg) });
  private ownerDir: string | null = null; // 소유권 가드용 세션 디렉토리(owner.json) — #1
  private deletedExternally = false; // 세션 삭제 시 set → dispose에서 markSessionClosed 중복 방지 — #7

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly extensionUri: vscode.Uri) {}

  static create(
    extensionUri: vscode.Uri,
    cwd: string,
    workspaceId: string,
    model: CliKind,
    sessionId: string,
    opts?: { resume?: string; title?: string; onModelSession?: (modelSessionId: string) => void; onDispose?: () => void; onTitle?: (title: string) => void },
  ): SdkChatPanel {
    const panel = vscode.window.createWebviewPanel(
      'agentbridge.sdkChat',
      opts?.title || `AgentBridge · ${model}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    // 탭 아이콘 = 각 에이전트 정식 로고 SVG(media/logos/<model>.svg).
    const logo = vscode.Uri.joinPath(extensionUri, 'media', 'logos', `${model}.svg`);
    panel.iconPath = { light: logo, dark: logo };
    const inst = new SdkChatPanel(panel, extensionUri);
    inst.sessionId = sessionId;
    inst.resumeId = opts?.resume;
    inst.onModelSessionCb = opts?.onModelSession;
    inst.onDisposeCb = opts?.onDispose;
    inst.onTitleCb = opts?.onTitle;
    inst.titlePending = !opts?.resume; // 새 세션(재개 아님)만 첫 메시지에서 자동 제목
    SdkChatPanel.activePanels.set(sessionId, inst);
    void inst.init(cwd, workspaceId, model);
    return inst;
  }

  // IDE 재시작 복원 — VS Code가 넘겨준 기존 panel을 wrap(새로 만들지 않음). 나머지는 create와 동일.
  static revive(
    extensionUri: vscode.Uri,
    panel: vscode.WebviewPanel,
    cwd: string,
    workspaceId: string,
    model: CliKind,
    sessionId: string,
    opts?: { resume?: string; title?: string; onModelSession?: (modelSessionId: string) => void; onDispose?: () => void; onTitle?: (title: string) => void },
  ): SdkChatPanel {
    const logo = vscode.Uri.joinPath(extensionUri, 'media', 'logos', `${model}.svg`);
    panel.iconPath = { light: logo, dark: logo };
    const inst = new SdkChatPanel(panel, extensionUri);
    inst.sessionId = sessionId;
    inst.resumeId = opts?.resume;
    inst.onModelSessionCb = opts?.onModelSession;
    inst.onDisposeCb = opts?.onDispose;
    inst.onTitleCb = opts?.onTitle;
    inst.titlePending = false; // 복원은 기존 세션 — 자동제목 안 함
    SdkChatPanel.activePanels.set(sessionId, inst);
    void inst.init(cwd, workspaceId, model);
    return inst;
  }

  reveal(): void { this.panel.reveal(); }
  markDeleted(): void { this.deletedExternally = true; } // #7
  dispose(): void { this.panel.dispose(); }

  // 앱/익스텐션 종료(deactivate) 시 — session.end()를 await해 깔끔히 종료(#3, V-07).
  // SDK 캡처는 턴마다 즉시 영속(accept→appendTurn)이라 버퍼된 마지막 턴 없음 — end만 await.
  async disposeAndFlush(): Promise<void> {
    if (this.disposed) return;
    await this.session?.end().catch(() => { /* already gone */ });
    this.dispose();
  }

  // 새 세션 첫 메시지에서 자동 제목 1회 — claude=generateSessionTitle / codex(null)=첫 메시지 잘라서. 호스트가 renameSession.
  private async maybeAutoTitle(firstMessage: string): Promise<void> {
    if (!this.titlePending) return;
    this.titlePending = false;
    const first = firstMessage.trim();
    if (!first) return;
    const suggested = await this.session?.suggestTitle(first).catch(() => null);
    const title = (suggested ?? first.slice(0, 60)).trim();
    if (title) { this.panel.title = title; this.onTitleCb?.(title); } // 탭 제목도 즉시 갱신
  }

  // 에이전트 세션 id를 modelSessionId로 영속(다음 open 시 resume). 빈 값/중복은 무시.
  private reportModelSession(id: string): void {
    if (id && id !== this.lastModelSession) {
      this.lastModelSession = id;
      this.onModelSessionCb?.(id);
    }
  }

  // 재개 시 이전 대화를 webview로 보내 시작화면 대신 렌더.
  // 소스 = 에이전트 네이티브 트랜스크립트(~/.claude JSONL / ~/.codex rollout) — IR 요약본(turns.jsonl) 아님.
  // 거긴 전체 대화가 cap 없이 다 있음 → 공식 앱과 동일하게 온전 복원. 복원 전용 파서(IR 리더와 분리: SDK 포맷 대응).
  private async restoreTranscript(modelSessionId: string): Promise<void> {
    if (this.model === 'agy') return; // 패널은 claude/codex만
    try {
      const transcriptPath = await resolveTranscriptPath(this.model, modelSessionId, this.cwd);
      if (!transcriptPath) return;
      const raw = await fs.promises.readFile(transcriptPath, 'utf8').catch(() => '');
      if (!raw) return;
      const records: Array<Record<string, unknown>> = [];
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try { records.push(JSON.parse(t) as Record<string, unknown>); } catch { /* 깨진 줄 skip */ }
      }
      const turns = this.model === 'codex' ? parseCodexTranscript(records) : parseClaudeTranscript(records);
      if (turns.length) this.post({ type: 'restore', turns });
    } catch (err) {
      output.warn(`SdkChatPanel: transcript 복원 실패 — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 둘 다 정적 import(번들). claude는 ESM SDK를 external로 두고 런타임 해석.
  private async init(cwd: string, workspaceId: string, model: CliKind): Promise<void> {
    this.cwd = cwd;
    this.workspaceId = workspaceId;
    this.model = model;
    this.panel.webview.html = this.html(model);
    this.panel.webview.onDidReceiveMessage((msg) => void this.onMessage(msg));
    // 활성화 시: 에디터그룹 잠금(#6) + 사이드바 트리 선택 동기화(#4, chatPanelEvents 재사용).
    const onActive = (active: boolean) => {
      this.groupLocker.onViewState(active);
      if (active && this.sessionId) chatPanelEvents.fire({ sessionId: this.sessionId });
    };
    this.panel.onDidChangeViewState((e) => onActive(e.webviewPanel.active));
    onActive(this.panel.active);
    this.panel.onDidDispose(() => {
      this.disposed = true;
      SdkChatPanel.activePanels.delete(this.sessionId);
      if (this.ownerDir) { void releaseOwnership(this.ownerDir).catch(() => { /* best-effort */ }); this.ownerDir = null; } // #1
      void this.session?.end().catch(() => { /* already gone */ });
      if (!this.deletedExternally) this.onDisposeCb?.(); // 삭제로 닫히면 markSessionClosed 생략(#7)
    });
    // 소유권 가드(#1, PTY와 동일 core 함수) — 다른 앱(데스크탑/타 익스텐션)이 이 세션 라이브 소유 중이면 시작 차단.
    if (this.workspaceId && this.sessionId) {
      const dir = getSessionDir(this.workspaceId, this.sessionId);
      const foreign = await readForeignOwner(dir);
      if (foreign) {
        const appName = foreign.app === 'desktop' ? vscode.l10n.t('the desktop app') : vscode.l10n.t('the other extension');
        output.log(`SdkChatPanel: 시작 거부 — 외부 소유(${appName}, pid=${foreign.pid})`);
        this.post({ type: 'event', ev: { t: 'error', message: vscode.l10n.t('This session is in use by {0}. Close it there, then reopen this tab.', appName) } });
        return;
      }
      this.ownerDir = dir;
      void acquireOwnership(dir, { app: 'extension', cols: 0, rows: 0 }).catch((err) => output.warn(`owner.json acquire 실패: ${String(err)}`));
    }
    await this.startSession(true, this.resumeId);
  }

  // 세션 생성(최초 init + /clear·New 재시작에서 공용). injectContext=false면 이전 IR 주입 없이 클린 슬레이트(/clear).
  // resume=이전 modelSessionId면 그 세션을 이어간다(최초 open만; /clear는 resume 없이 새로).
  private async startSession(injectContext: boolean, resume?: string): Promise<void> {
    try {
      // agy는 Gemini API 키가 있어야 엔진을 띄운다. 키 없으면 다운로드/스폰 없이 로그인 화면만(불필요한 30MB 다운로드 방지).
      // 키 출처: process.env(.env dev 폴백) → SecretStorage(온디맨드 로드, race-free).
      if (this.model === 'agy') {
        if (!process.env.GEMINI_API_KEY && secretStore) {
          const stored = await secretStore.get(GEMINI_SECRET_KEY);
          if (stored) process.env.GEMINI_API_KEY = stored;
        }
        if (!process.env.GEMINI_API_KEY) {
          this.post({ type: 'ready', sessionId: this.sessionId, model: this.model, injected: false, loggedIn: false });
          return;
        }
      }
      // 셋업 시퀀스(hook→IR→capture→adapter.start)는 코어 startSdkSession 한 곳. 호스트는 결속만 주입.
      const workspaceRoot = getWorkspaceStore().getWorkspacePath(this.workspaceId);
      const { session, context } = await startSdkSession({
        adapter: sdkAdapters[this.model],
        model: this.model,
        cwd: this.cwd,
        workspaceId: this.workspaceId,
        workspaceRoot,
        scheduler: getCompactionScheduler(), // 기존 PTY 경로와 같은 스케줄러 인스턴스
        hookInstaller: getHookInstaller(),
        detail: 'compact',
        injectContext,
        ...(resume ? { resume } : {}),
        logger: { log: (m) => output.log(m), warn: (m) => output.warn(m) },
      });
      this.session = session;
      // 에이전트 세션 id 영속(다음 open 시 resume). codex=시작 시 thread id 있음 / claude=빈 값 → 첫 턴 session 이벤트에서 잡음.
      this.reportModelSession(this.session.sessionId);
      // 미로그인 여부를 send 없이 미리 확인 → 미로그인이면 패널이 처음부터 로그인 화면 + 입력 차단.
      const loggedIn = await this.session.checkAuth().catch(() => true);
      this.post({ type: 'ready', sessionId: this.session.sessionId, model: this.model, injected: Boolean(context), loggedIn });
      // 6-3: 에이전트 내부 모델 목록을 받아 패널 모델 칩 메뉴를 채운다(실패해도 채팅엔 영향 없음).
      const models = await this.session.listModels().catch(() => [] as ModelOption[]);
      if (models.length) this.post({ type: 'models', list: models });
      // 슬래시 명령을 첫 send 전에 미리 채워 / 메뉴에 바로 보이게 (claude=전체 목록 / codex=빈 목록).
      const cmds = await this.session.listCommands().catch(() => [] as string[]);
      if (cmds.length) this.post({ type: 'slash', list: cmds });
      // 재개 세션이면 이전 대화를 화면에 복원(시작화면 대신). resume=modelSessionId로 이 세션의 턴만 필터.
      if (resume) await this.restoreTranscript(resume);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      output.warn(`SdkChatPanel: session start failed — ${m}`);
      this.post({ type: 'event', ev: { t: 'error', message: `Session start failed: ${m}` } });
    }
  }

  // 주입 라벨용 — 이번 메시지로 들어갈 IR 유무 + 장기메모리 수를 훅과 동일한 globalSearch로 산출(별도 검색이지만 같은 쿼리라 같은 수).
  private async computeInjectLabel(text: string): Promise<void> {
    const workspaceRoot = getWorkspaceStore().getWorkspacePath(this.workspaceId);
    let irPresent = false;
    try { irPresent = Boolean(await readIR(workspaceRoot)); } catch { /* IR 없음 */ }
    let mem = 0;
    try {
      const userData = path.dirname(path.dirname(workspaceRoot)); // <userData>/workspaces/<id> → <userData>
      const matches = await resolveContext(path.join(userData, 'global'), 'default', text, { topN: 5 });
      mem = matches.length;
    } catch { /* 글로벌 메모리 미설정 등 */ }
    if (irPresent || mem > 0) this.post({ type: 'inject', ir: irPresent, mem });
  }

  private async onMessage(msg: { type: string; text?: string; id?: string; approve?: boolean; mode?: PermissionMode; level?: string; url?: string; on?: boolean; style?: string; name?: string; enabled?: boolean; query?: string; base64?: string; workspaceId?: string; sessionId?: string; model?: string; paths?: string[]; key?: string }): Promise<void> {
    if (msg.type === 'send') {
      if (!this.session) return;
      void this.computeInjectLabel(String(msg.text ?? '')); // 이번 턴 주입 상태 라벨(IR·장기메모리 수)
      try {
        for await (const ev of this.session.send(String(msg.text ?? ''))) {
          if (this.disposed) break;
          if (ev.t === 'session') this.reportModelSession(ev.sessionId); // claude 실제 session_id가 첫 턴에 도착 → 그때 영속
          this.post({ type: 'event', ev });
        }
        await this.maybeAutoTitle(String(msg.text ?? ''));
      } catch (err) {
        this.post({ type: 'event', ev: { t: 'error', message: err instanceof Error ? err.message : String(err) } });
      }
    } else if (msg.type === 'interrupt') {
      await this.session?.interrupt().catch(() => { /* nothing in flight */ });
    } else if (msg.type === 'respondApproval') {
      this.session?.respondApproval(String(msg.id), Boolean(msg.approve));
    } else if (msg.type === 'setPermissionMode' && msg.mode) {
      await this.session?.setPermissionMode(msg.mode).catch((err) => {
        output.warn(`SdkChatPanel: setPermissionMode 실패 — ${err instanceof Error ? err.message : String(err)}`);
      });
    } else if (msg.type === 'setModel' && msg.id) {
      await this.session?.setModel(msg.id).catch((err) => {
        output.warn(`SdkChatPanel: setModel 실패 — ${err instanceof Error ? err.message : String(err)}`);
      });
    } else if (msg.type === 'setEffort' && msg.level) {
      await this.session?.setEffort(msg.level).catch((err) => {
        output.warn(`SdkChatPanel: setEffort 실패 — ${err instanceof Error ? err.message : String(err)}`);
      });
    } else if (msg.type === 'pickImage') {
      await this.handlePickImage();
    } else if (msg.type === 'attachBytes' && msg.base64) {
      // 붙여넣기/드롭 — 웹뷰가 보낸 이미지 바이트를 picker와 동일하게 프로젝트에 저장.
      try {
        await this.saveAttachment(String(msg.name || `pasted-${Date.now()}.png`), String(msg.base64));
      } catch (err) {
        output.warn(`SdkChatPanel: paste/drop 첨부 실패 — ${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (msg.type === 'mentionPaths' && Array.isArray(msg.paths)) {
      // 드롭된 파일/에디터탭 경로 → @멘션(cwd-상대, 밖이면 절대). 호스트가 상대화해 webview에 mentionAdded로 회신.
      for (const abs of msg.paths) {
        const rel = path.relative(this.cwd, abs);
        const insert = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs;
        this.post({ type: 'mentionAdded', path: insert });
      }
    } else if (msg.type === 'log') {
      output.log(`[sdk webview] ${String(msg.text ?? '')}`); // #8 — 웹뷰 디버그 로그 통로(PTY 파리티)
    } else if (msg.type === 'login') {
      await this.handleLogin();
    } else if (msg.type === 'submitKey') {
      await this.handleSubmitKey(String(msg.key ?? ''));
    } else if (msg.type === 'openExternal' && msg.url) {
      await vscode.env.openExternal(vscode.Uri.parse(String(msg.url)));
    } else if (msg.type === 'getUsage') {
      const data = (await this.session?.getAccountUsage().catch(() => null)) ?? null;
      this.post({ type: 'usage', data });
    } else if (msg.type === 'listOutputStyles') {
      const data = (await this.session?.listOutputStyles().catch(() => null)) ?? null;
      this.post({ type: 'outputStyles', data });
    } else if (msg.type === 'setOutputStyle' && msg.style) {
      await this.session?.setOutputStyle(String(msg.style)).catch(() => { /* ignore */ });
    } else if (msg.type === 'listMcp') {
      const data = (await this.session?.listMcpServers().catch(() => [])) ?? [];
      this.post({ type: 'mcp', data });
    } else if (msg.type === 'toggleMcp' && msg.name) {
      await this.session?.setMcpServerEnabled(String(msg.name), Boolean(msg.enabled)).catch(() => { /* ignore */ });
    } else if (msg.type === 'listAgents') {
      const data = (await this.session?.listAgents().catch(() => [])) ?? [];
      this.post({ type: 'agents', data });
    } else if (msg.type === 'setThinking') {
      await this.session?.setThinking(Boolean(msg.on)).catch(() => { /* ignore */ });
    } else if (msg.type === 'compact') {
      const ok = Boolean(await this.session?.compact().catch(() => false));
      this.post({ type: 'compacted', ok });
    } else if (msg.type === 'openTerminal') {
      const term = vscode.window.createTerminal({ cwd: this.cwd, name: 'AgentBridge' });
      term.show();
    } else if (msg.type === 'mentionFile') {
      await this.handleMentionFile();
    } else if (msg.type === 'searchFiles') {
      await this.handleSearchFiles(String(msg.query ?? ''));
    } else if (msg.type === 'newSession') {
      // /clear — 현재 세션 종료 후 인플레이스로 새 세션(같은 탭). 웹뷰는 'cleared'로 채팅 로그를 비운다.
      // 채팅 화면은 비우되 IR 핸드오프는 유지 주입(AgentBridge의 핵심 — 맥락 연속성).
      // (헤더 ＋ 버튼은 더 이상 이걸 쓰지 않음 — modelPanel로 새 탭 세션. newSessionWithModel 참고.)
      await this.session?.end().catch(() => { /* already gone */ });
      this.session = null;
      this.post({ type: 'cleared' });
      await this.startSession(true);
    } else if (msg.type === 'getSessions') {
      await this.handleGetSessions();
    } else if (msg.type === 'openSession') {
      await this.handleOpenSession(String(msg.workspaceId ?? ''), String(msg.sessionId ?? ''));
    } else if (msg.type === 'renameSession') {
      await this.handleRenameSession(String(msg.workspaceId ?? ''), String(msg.sessionId ?? ''));
    } else if (msg.type === 'deleteSession') {
      await this.handleDeleteSession(String(msg.workspaceId ?? ''), String(msg.sessionId ?? ''));
    } else if (msg.type === 'newSessionWithModel' && msg.model) {
      await vscode.commands.executeCommand('agentbridge.newSessionWithModel', msg.model);
    }
  }

  // 세션 목록(🕐 오버레이) — PTY ChatPanel과 동일 계약. 이 워크스페이스의 모든 세션을 웹뷰로 회신.
  private async handleGetSessions(): Promise<void> {
    const sessions = await getSessions(this.workspaceId);
    this.post({ type: 'sessions', sessions });
  }

  // 소유권 검증(V-29) — 웹뷰 메시지는 세션을 "지목"만, 실데이터는 호스트 저장소에서. 이 패널 워크스페이스 세션만 통과.
  private async resolveOwnedSession(workspaceId: string, sessionId: string): Promise<SessionMeta | null> {
    if (workspaceId !== this.workspaceId) {
      output.warn('SdkChatPanel: webview 메시지의 workspaceId가 패널 워크스페이스와 불일치 — 무시');
      return null;
    }
    const sessions = await getSessions(this.workspaceId);
    const session = sessions.find((s) => s.sessionId === sessionId) ?? null;
    if (!session) output.warn('SdkChatPanel: webview 메시지가 지목한 세션이 워크스페이스에 없음 — 무시');
    return session;
  }

  private async handleOpenSession(workspaceId: string, sessionId: string): Promise<void> {
    const session = await this.resolveOwnedSession(workspaceId, sessionId);
    if (!session) return;
    await vscode.commands.executeCommand('agentbridge.openSession', session);
  }

  private async handleRenameSession(workspaceId: string, sessionId: string): Promise<void> {
    const session = await this.resolveOwnedSession(workspaceId, sessionId);
    if (!session) return;
    const newName = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Session name'), value: session.name });
    if (newName === undefined) return;
    await renameSession(workspaceId, sessionId, newName);
    await this.handleGetSessions();
  }

  private async handleDeleteSession(workspaceId: string, sessionId: string): Promise<void> {
    const session = await this.resolveOwnedSession(workspaceId, sessionId);
    if (!session) return;
    // 확인 모달엔 메시지가 주장한 이름이 아니라 저장소의 실제 이름을 띄운다(이름표 바꿔치기 차단).
    const answer = await vscode.window.showWarningMessage(vscode.l10n.t('Delete session "{0}"?', session.name), { modal: true }, vscode.l10n.t('Delete'));
    if (answer !== vscode.l10n.t('Delete')) return;
    const activePanel = SdkChatPanel.getActivePanel(sessionId);
    if (activePanel && activePanel !== this) activePanel.dispose();
    await deleteSession(workspaceId, sessionId);
    if (!this.disposed) await this.handleGetSessions();
    if (activePanel === this) this.panel.dispose();
  }

  // @ 멘션 자동완성 — cwd 기준 파일명 부분일치 검색(node_modules 등 제외), cwd-상대경로 회신.
  private async handleSearchFiles(query: string): Promise<void> {
    const safe = query.replace(/[^\w.\-/]/g, '');
    const pattern = new vscode.RelativePattern(this.cwd, `**/*${safe}*`);
    const uris = await vscode.workspace.findFiles(pattern, '**/{node_modules,.git,dist,out,.agentbridge}/**', 30);
    const files = uris
      .map((u) => path.relative(this.cwd, u.fsPath))
      .filter((p) => p && !p.startsWith('..') && !path.isAbsolute(p))
      .sort((a, b) => a.length - b.length)
      .slice(0, 20);
    this.post({ type: 'files', list: files });
  }

  // Mention file(설정 2차) — 호스트 파일 피커로 프로젝트 파일 선택 → cwd-상대경로를 입력창에 @멘션으로 삽입.
  private async handleMentionFile(): Promise<void> {
    const picks = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Mention',
      defaultUri: vscode.Uri.file(this.cwd),
    });
    if (!picks?.length) return;
    const rel = path.relative(this.cwd, picks[0].fsPath);
    const insert = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : picks[0].fsPath;
    this.post({ type: 'mentionAdded', path: insert });
  }

  // 로그인(미로그인 사용자): startLogin으로 OAuth URL 받아 브라우저 열고(openExternal), waitLogin으로 완료 대기.
  // 토큰 저장은 SDK가 키체인에 처리 — 우리는 흐름만 중계.
  private async handleLogin(): Promise<void> {
    if (!this.session) return;
    try {
      const ch = await this.session.startLogin();
      await vscode.env.openExternal(vscode.Uri.parse(ch.automaticUrl));
      this.post({ type: 'loginStarted', manualUrl: ch.manualUrl });
      const ok = await this.session.waitLogin();
      this.post({ type: 'loginResult', ok });
    } catch (err) {
      output.warn(`SdkChatPanel: login 실패 — ${err instanceof Error ? err.message : String(err)}`);
      this.post({ type: 'loginResult', ok: false });
    }
  }

  // agy 키 입력(OAuth 대신) — 키를 OS 키체인에 저장하고 process.env에 반영한 뒤 세션을 재기동(엔진을 키와 함께 스폰).
  // 재기동의 ready(loggedIn=true)가 로그인 화면을 닫는다. 유효성은 첫 턴에 검증됨(여기선 존재만).
  private async handleSubmitKey(rawKey: string): Promise<void> {
    const key = rawKey.trim();
    if (!key) {
      this.post({ type: 'loginResult', ok: false });
      return;
    }
    try {
      await secretStore?.store(GEMINI_SECRET_KEY, key);
      process.env.GEMINI_API_KEY = key;
      await this.session?.end().catch(() => { /* keyless 세션 정리 */ });
      this.session = null;
      await this.startSession(true, this.resumeId); // 키 반영해 재기동 → ready(loggedIn=true)로 로그인 화면 닫힘
    } catch (err) {
      output.warn(`SdkChatPanel: 키 저장/재기동 실패 — ${err instanceof Error ? err.message : String(err)}`);
      this.post({ type: 'loginResult', ok: false });
    }
  }

  // 첨부 이미지(6-5): 호스트 파일 다이얼로그로 이미지 선택 → saveAttachment로 프로젝트에 복사.
  private async handlePickImage(): Promise<void> {
    const picks = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: 'Attach',
      filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] },
    });
    if (!picks?.length) return;
    for (const uri of picks) {
      try {
        const base64 = (await fs.promises.readFile(uri.fsPath)).toString('base64');
        await this.saveAttachment(path.basename(uri.fsPath), base64);
      } catch (err) {
        output.warn(`SdkChatPanel: attachment 저장 실패 — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // 이미지 바이트를 프로젝트 .agentbridge/attachments/<sid>/ 아래로 쓰고, cwd-상대경로 + 썸네일 dataUrl을 회신.
  // 에이전트 샌드박스가 프로젝트 내부만 읽으므로 항상 프로젝트 안에 쓴다. picker·paste·drop 공용 경로.
  private async saveAttachment(name: string, base64: string): Promise<void> {
    const { attachmentPathFor, writeAttachment } = await import('../core/attachmentStore');
    const safeName = name.replace(/[\\/]/g, '_').slice(-150);
    const filename = `${Date.now()}-${safeName}`;
    const sid = this.session?.sessionId || 'no-session';
    const absPath = attachmentPathFor(this.workspaceId || 'no-workspace', sid, filename);
    await writeAttachment(absPath, base64);
    const rel = path.relative(this.cwd, absPath);
    const insertPath = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : absPath;
    const ext = (safeName.split('.').pop() || 'png').toLowerCase();
    const mime = ext === 'jpg' ? 'jpeg' : ext === 'svg' ? 'svg+xml' : ext;
    output.log(`SdkChatPanel: attachment 저장 ${absPath} → "${insertPath}"`);
    this.post({ type: 'attachAdded', name: safeName, path: insertPath, dataUrl: `data:image/${mime};base64,${base64}` });
  }

  private post(msg: { type: 'ready'; sessionId: string; model?: string; injected?: boolean; loggedIn?: boolean } | { type: 'event'; ev: ChatEvent } | { type: 'models'; list: ModelOption[] } | { type: 'attachAdded'; name: string; path: string; dataUrl: string } | { type: 'loginStarted'; manualUrl: string } | { type: 'loginResult'; ok: boolean } | { type: 'usage'; data: AccountUsage | null } | { type: 'outputStyles'; data: { current: string; available: string[] } | null } | { type: 'mcp'; data: McpServerInfo[] } | { type: 'agents'; data: AgentInfo[] } | { type: 'compacted'; ok: boolean } | { type: 'mentionAdded'; path: string } | { type: 'slash'; list: string[] } | { type: 'files'; list: string[] } | { type: 'cleared' } | { type: 'inject'; ir: boolean; mem: number } | { type: 'restore'; turns: Array<{ user: string; items: Array<{ type: string; text?: string; name?: string; arg?: string }> }> } | { type: 'sessions'; sessions: SessionMeta[] }): void {
    void this.panel.webview.postMessage(msg);
  }

  // 시작 화면 로고 = 탭 아이콘과 같은 단일 소스(media/logos/<model>.svg)를 인라인 주입.
  private readLogoSvg(model: CliKind): string {
    try {
      return fs.readFileSync(path.join(this.extensionUri.fsPath, 'media', 'logos', `${model}.svg`), 'utf8');
    } catch {
      return '';
    }
  }

  private html(model: CliKind): string {
    const permLabel = model === 'codex' ? 'Default permissions' : 'Ask before edits';
    const logoSvg = this.readLogoSvg(model);
    const brand = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity' }[model];
    const nonce = makeNonce();
    const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}';`;
    return `<!doctype html><html lang="en"><head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  /* 모델 포인트색(기존 앱). data-model로 스위치. transcript 점: 도구=accent / 생각·채팅=회색. */
  :root{--accent:#d97757;--accent-bright:#f0a88c;--green:#5ec98a}
  body[data-model="codex"]{--accent:#5D8AF9;--accent-bright:#9ab8ff}
  body[data-model="agy"]{--accent:#8e6cef;--accent-bright:#b69cf5}
  *{box-sizing:border-box}
  body{margin:0;padding:0;height:100vh;display:flex;flex-direction:column;
    font:13px/1.6 var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-sideBar-background,var(--vscode-editor-background))}
  ${CHAT_HEADER_CSS}

  .logwrap{position:relative;flex:1;display:flex;flex-direction:column;min-height:0}
  #log{flex:1;overflow-y:auto;overflow-x:hidden;padding:18px 16px;display:flex;flex-direction:column;gap:16px}
  /* 시작 화면 — 대화 전(빈 채팅)에 #log 위에 겹쳐 중앙 표시. 첫 메시지/대화중이면 숨김. */
  #welcome{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
    background:var(--vscode-sideBar-background,var(--vscode-editor-background))}
  #welcome.hide{display:none}
  /* 상단 중앙 — AgentBridge 로고(앱 에셋) + 텍스트. 회색 칸은 currentColor라 테마(dark/light) 자동 대응 */
  .wtop{display:flex;align-items:center;gap:6px;padding-top:22px;color:var(--vscode-foreground)}
  .wtop .abtext{font-size:13px;font-weight:600;letter-spacing:.2px}
  #welcome .wbox{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:auto}
  /* 원본 브랜드 로고 그대로(배경 박스 없음). claude는 단색이라 accent 따름, codex/agy는 자체 색. */
  .wlogo{display:flex;align-items:center;justify-content:center;color:var(--accent)}
  .wlogo svg{width:96px;height:96px}
  .wbrand{margin-top:17px;font-size:22px;font-weight:600;letter-spacing:.2px;color:var(--vscode-foreground)}
  /* 캡션 = 로그인 부제와 같은 회색으로 통일 */
  .wcap,.wsub{margin-top:8px;font-size:12.5px;color:var(--vscode-descriptionForeground);opacity:.8}
  .wlogin{margin-top:20px;display:flex;flex-direction:column;align-items:center;gap:9px}
  .wlbtn{background:var(--accent);color:#1b1b1d;border:none;border-radius:7px;padding:6px 18px;font:inherit;font-weight:600;cursor:pointer}
  .wlbtn:disabled{opacity:.6;cursor:default}
  .wkey{width:280px;max-width:74vw;padding:7px 11px;font:inherit;font-size:12.5px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent);border-radius:7px;outline:none}
  .wkey:focus{border-color:var(--accent)}
  .wmanual{margin-top:6px;font-size:11px;color:var(--vscode-textLink-foreground);cursor:pointer;text-decoration:underline}
  .turn{display:flex;flex-direction:column;gap:8px}
  .turn.assistant{gap:20px}
  .turn.user{align-items:flex-end}
  .user .msg{background:var(--vscode-textBlockQuote-background);border-radius:12px;padding:4px 13px;max-width:80%;white-space:pre-wrap}
  /* 주입 상태 라벨 — 유저 버블 바로 아래 작은 회색 한 줄(매 턴 IR·장기메모리 수). */
  .inj{font-size:11px;color:var(--vscode-descriptionForeground);font-family:var(--vscode-editor-font-family),monospace;margin-top:-8px;opacity:.85}
  .att{display:inline-flex;align-items:center;gap:5px;background:var(--vscode-textBlockQuote-background);border:1px solid var(--vscode-panel-border);border-radius:8px;padding:4px 8px;font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:5px}

  .item{display:flex;gap:9px;position:relative}
  /* 한 턴의 점들을 잇는 옅은 세로선 (다음 점 중심까지) */
  .item:not(:last-child)::before{content:'';position:absolute;left:3px;top:10px;bottom:-30px;width:1px;background:var(--vscode-panel-border)}
  .item:has(+ .working)::before,.item:has(+ .worked)::before,.item:has(+ .copybtn)::before{display:none}
  .dot{flex:none;width:7px;height:7px;border-radius:50%;margin-top:7px;position:relative;z-index:1}
  .dot.tool{background:var(--accent)} .dot.text{background:var(--vscode-descriptionForeground);opacity:.6}
  .body{flex:1;min-width:0}
  details.think>summary{cursor:pointer;list-style:none;color:var(--vscode-descriptionForeground);font-size:12px;opacity:.85}
  details.think>summary::-webkit-details-marker{display:none}
  details.think>summary::after{content:" ▸";font-size:9px} details.think[open]>summary::after{content:" ▾"}
  details.think .tx{margin-top:4px;color:var(--vscode-descriptionForeground);white-space:pre-wrap;border-left:1px solid var(--vscode-panel-border);padding-left:9px}
  /* 도구: 볼드 이름 + 설명, 그 아래 IN/OUT 박스 */
  .tname{font-size:13px;color:var(--vscode-descriptionForeground);overflow-wrap:anywhere;word-break:break-word}
  .tname strong{color:var(--vscode-foreground);font-weight:700;margin-right:7px}
  .tbox{margin-top:5px;border:1px solid var(--vscode-panel-border);border-radius:7px;overflow:hidden;font-family:var(--vscode-editor-font-family),monospace;font-size:11.5px;
    background:var(--vscode-textCodeBlock-background);
    background:color-mix(in srgb,var(--vscode-sideBar-background,var(--vscode-editor-background)) 60%,#000 40%)}
  .trow{display:flex;gap:10px;padding:6px 10px}
  .trow+.trow{border-top:1px solid rgba(127,127,127,.3)}
  .tlabel{flex:none;width:24px;color:var(--vscode-descriptionForeground);opacity:.5;font-size:10.5px;padding-top:2px}
  .tcontent{flex:1;min-width:0;color:var(--vscode-foreground);opacity:.92;white-space:pre-wrap;word-break:break-word;line-height:1.5;max-height:60px;overflow:auto}
  .md{line-height:1.72;overflow-wrap:anywhere;word-break:break-word} .md p{margin:0 0 .7em} .md p:last-child{margin:0} .md strong{font-weight:700}
  .copybtn{display:inline-flex;align-items:center;align-self:flex-start;margin-top:-10px;margin-left:16px;background:none;border:none;color:var(--vscode-descriptionForeground);opacity:.4;cursor:pointer;padding:4px;border-radius:5px;line-height:1}
  .copybtn svg{width:15px;height:15px}
  .copybtn:hover{opacity:.9;background:var(--vscode-toolbar-hoverBackground)}
  .md code{background:var(--vscode-textCodeBlock-background);padding:1px 5px;border-radius:4px;font-family:var(--vscode-editor-font-family),monospace;font-size:12px}
  .md pre{background:var(--vscode-textCodeBlock-background);border:1px solid var(--vscode-panel-border);border-radius:8px;padding:10px 12px;overflow-x:auto;max-width:100%;margin:.4em 0}
  .md pre code{background:none;padding:0} .md ul{margin:.3em 0;padding-left:1.3em}
  .md h1,.md h2,.md h3,.md h4,.md h5,.md h6{margin:.6em 0 .3em;font-weight:700;line-height:1.3}
  .md h1{font-size:1.45em} .md h2{font-size:1.25em} .md h3{font-size:1.1em} .md h4,.md h5,.md h6{font-size:1em;opacity:.95}
  .md table{border-collapse:collapse;margin:.5em 0;font-size:.95em;display:block;width:max-content;max-width:100%;overflow-x:auto}
  .md th,.md td{border:1px solid var(--vscode-panel-border);padding:4px 9px;text-align:left;vertical-align:top}
  .md th{background:var(--vscode-textBlockQuote-background);font-weight:700}
  .caret{display:inline-block;width:6px;height:13px;background:var(--vscode-editor-foreground);margin-left:1px;vertical-align:-2px;animation:blink 1s steps(2) infinite}
  @keyframes blink{50%{opacity:0}}

  .working{display:flex;align-items:center;gap:7px;font-size:12px}
  .tspin{font-family:var(--vscode-editor-font-family),monospace;color:var(--accent);white-space:pre;display:inline-block;min-width:10px;text-align:center}
  .shim{background:linear-gradient(90deg,var(--accent) 42%,var(--accent-bright) 50%,var(--accent) 58%);background-size:280% 100%;
    -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent;animation:shim 3s linear infinite}
  @keyframes shim{from{background-position:140% 0}to{background-position:-140% 0}}
  .wmeta{color:var(--vscode-descriptionForeground);opacity:.7;font-size:12px}
  .worked{font-family:var(--vscode-editor-font-family),monospace;color:var(--vscode-descriptionForeground);opacity:.7;font-size:12px;margin-top:2px}

  footer{padding:6px 8px 12px}
  .dock{position:relative}
  @keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
  .approval{position:relative;z-index:1;margin:0 30px -30px;display:flex;flex-direction:column;gap:10px;
    border:1px solid var(--accent);background:var(--vscode-editorWidget-background,#23211e);border-radius:12px;
    padding:11px 14px 40px;box-shadow:0 10px 24px rgba(0,0,0,.5);animation:rise .22s ease}
  .approval .t{font-weight:600;font-size:12px}
  .approval .d{font-size:11px;color:var(--vscode-descriptionForeground);font-family:var(--vscode-editor-font-family),monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .approval .aacts{display:flex;gap:7px;justify-content:flex-end}
  .approval button{font:inherit;padding:6px 16px;border-radius:8px;border:none;cursor:pointer}
  .ay{background:var(--accent);color:#1b1b1d;font-weight:600} .an{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}

  /* 입력바 외곽선 = 권한 모드 색(#7). default=포인트색 / edit자동·auto-review=흰색 / plan=파랑 / auto·full=빨강 */
  .inbox{position:relative;z-index:2;background:var(--vscode-input-background);border:1.5px solid var(--accent);border-radius:14px;padding:12px 12px 8px;transition:border-color .15s}
  body[data-perm="acceptEdits"] .inbox,body[data-perm="autoReview"] .inbox{border-color:#e8e8e8}
  body[data-perm="plan"] .inbox{border-color:#5d8af9}
  body[data-perm="auto"] .inbox,body[data-perm="fullAccess"] .inbox{border-color:#e0564f}
  .inbox .chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
  .inbox .chips:empty{display:none}
  .pend{display:inline-flex;align-items:center;gap:6px;background:var(--vscode-badge-background,var(--vscode-textBlockQuote-background));border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:8px;padding:3px 7px 3px 4px;font-size:11px;color:var(--vscode-foreground)}
  .pend .x{cursor:pointer;opacity:.65;font-size:10px}
  .pend .x:hover{opacity:1}
  /* 첨부 칩 = 글씨 한 줄 높이에 맞춤 (#2) */
  .thumb{height:18px;width:auto;max-width:34px;border-radius:4px;object-fit:cover;flex:none;display:block}
  /* 입력 위 하이라이트 오버레이(#inhl)와 정확히 겹치도록 동일 폰트·줄높이·여백. 텍스트는 투명, 캐럿만 보임. */
  .inwrap{position:relative}
  #input{display:block;width:100%;background:none;border:none;color:transparent;caret-color:var(--vscode-input-foreground);font:inherit;resize:none;outline:none;min-height:44px;max-height:200px;line-height:1.5;overflow-y:auto;position:relative;z-index:1}
  #input::placeholder{color:var(--vscode-input-placeholderForeground)}
  #inhl{position:absolute;inset:0;font:inherit;line-height:1.5;white-space:pre-wrap;word-break:break-word;color:var(--vscode-input-foreground);pointer-events:none;overflow:hidden;z-index:0}
  #inhl .cmdok{color:var(--accent);font-weight:600}
  #inhl .mention{color:#5d8af9}
  /* / · @ 자동완성 드롭다운 */
  #acMenu{min-width:240px}
  .acitem{display:flex;align-items:center;gap:8px;padding:5px 10px;border-radius:6px;cursor:pointer}
  .acitem.sel{background:var(--vscode-menu-selectionBackground,var(--vscode-toolbar-hoverBackground))}
  .acname{flex:1;font-size:13px;color:var(--vscode-foreground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ctrls{display:flex;align-items:center;gap:9px;margin-top:2px}
  .ic{height:26px;min-width:24px;padding:0 2px;border-radius:7px;border:none;background:none;color:var(--vscode-foreground);cursor:pointer;font-size:17px;font-weight:700;line-height:1}
  .ic:hover{background:var(--vscode-toolbar-hoverBackground)}
  .pill{font-size:12px;font-weight:700;color:var(--vscode-foreground);border:none;border-radius:7px;padding:3px 6px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;max-width:160px}
  .pill:hover{background:var(--vscode-toolbar-hoverBackground)}
  .menu{position:fixed;display:none;z-index:10;background:var(--vscode-menu-background,var(--vscode-input-background));border:1px solid var(--vscode-menu-border,var(--vscode-input-border,var(--vscode-panel-border)));border-radius:8px;padding:4px;min-width:200px;max-width:calc(100vw - 24px);max-height:min(460px,calc(100vh - 56px));overflow-y:auto;box-shadow:0 6px 20px rgba(0,0,0,.4)}
  .mhdr{padding:5px 10px 6px;font-size:11px;color:var(--vscode-descriptionForeground);opacity:.7}
  .mitem{padding:6px 10px;border-radius:6px;cursor:pointer;color:var(--vscode-menu-foreground,var(--vscode-foreground))}
  .mitem:hover{background:var(--vscode-menu-selectionBackground,var(--vscode-toolbar-hoverBackground))}
  .mitem.cur{background:color-mix(in srgb,var(--accent) 18%,transparent)}
  .mrow{display:flex;align-items:center;gap:8px}
  .mname{flex:1;font-size:13px;color:var(--vscode-foreground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .mitem.cur .mname{font-weight:600}
  .mchk{color:var(--accent);font-weight:700;flex:none}
  .mdesc{font-size:11px;color:var(--vscode-descriptionForeground);opacity:.8;margin-top:2px;line-height:1.35}
  .msep{height:1px;background:var(--vscode-panel-border);margin:5px 4px}
  .effort{display:flex;align-items:center;padding:5px 10px 7px}
  .elbl{font-size:11px;color:var(--vscode-descriptionForeground);text-transform:capitalize;flex:none}
  /* Effort·Thinking 라벨 = 모델 이름 폰트(13px foreground) */
  .emname{font-size:13px;color:var(--vscode-foreground);text-transform:capitalize;flex:none}
  /* 알약 트랙 + accent 채움(--fill) + 흰색 손잡이, 포커스 노란테 제거 */
  /* 알약 트랙 + 정지점 점 + 흰 손잡이. 트랙(채움+점)은 .ertrack, range는 손잡이/조작만(투명 트랙) */
  .erwrap{position:relative;height:16px;width:120px;flex:none;margin-left:auto}
  .ertrack{position:absolute;inset:0;border-radius:999px;background:linear-gradient(to right,var(--accent) 0 var(--fill,50%),var(--vscode-scrollbarSlider-background,#3a3b40) var(--fill,50%) 100%)}
  .edot{position:absolute;top:50%;width:4px;height:4px;border-radius:50%;background:rgba(255,255,255,.45);transform:translate(-50%,-50%)}
  .edot.ultra{background:#b69cf5}
  .erange{position:absolute;inset:0;-webkit-appearance:none;appearance:none;width:100%;height:16px;background:transparent;outline:none;cursor:pointer;margin:0;z-index:2}
  .erange:focus{outline:none}
  .erange::-webkit-slider-runnable-track{background:transparent;height:16px}
  .erange::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:16px;height:16px;border-radius:50%;background:#fff;border:none;box-shadow:0 1px 3px rgba(0,0,0,.5);margin-top:0}
  #send{height:28px;min-width:32px;padding:0 8px;border-radius:8px;border:none;background:var(--accent);color:#1b1b1d;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
  /* 정지버튼 = 테마 무관 고정 (모델 accent + 어두운 사각형). VS Code 테마색에 안 기댐 */
  #send.stop{background:var(--accent);color:#1b1b1d}
  .err{color:var(--vscode-errorForeground);font-size:12px;white-space:pre-wrap}

  /* 설정 메뉴(/ 버튼 통합) — 섹션·토글·서브패널 */
  .menu.settings{min-width:272px}
  .ssec{padding:8px 10px 4px;font-size:10px;color:var(--vscode-descriptionForeground);text-transform:uppercase;letter-spacing:.5px;opacity:.7}
  .ssec:first-child{padding-top:3px}
  .srow{display:flex;align-items:center;gap:9px}
  .mico{width:15px;text-align:center;color:var(--vscode-descriptionForeground);font-size:12px;flex:none}
  .mitem .sname{flex:1;font-size:13px;color:var(--vscode-foreground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .sval{font-size:11.5px;color:var(--vscode-descriptionForeground);font-family:var(--vscode-editor-font-family),monospace}
  .schev{color:var(--vscode-descriptionForeground);opacity:.7;font-size:14px;flex:none}
  .sext{color:var(--vscode-descriptionForeground);font-size:11px;flex:none}
  /* 토글 스위치 */
  .tog{flex:none;width:28px;height:16px;border-radius:999px;background:var(--vscode-scrollbarSlider-background,#555);position:relative;cursor:pointer}
  .tog::after{content:'';position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:#fff;transition:left .12s}
  .tog.on{background:var(--accent)} .tog.on::after{left:14px}
  /* 서브패널 */
  .menu.panel{min-width:288px}
  .sback{display:flex;align-items:center;padding:4px 8px 7px;color:var(--vscode-descriptionForeground);font-size:12px;border-bottom:1px solid var(--vscode-panel-border);margin-bottom:4px}
  .sbk{cursor:pointer;color:var(--vscode-textLink-foreground)}
  .sload{padding:14px 12px;color:var(--vscode-descriptionForeground);font-size:12px;opacity:.7}
  .skv{display:flex;justify-content:space-between;gap:12px;padding:3px 11px;font-size:12px}
  .skv .sk{color:var(--vscode-descriptionForeground)} .skv .svv{color:var(--vscode-foreground);text-align:right;word-break:break-word}
  .surow{display:flex;justify-content:space-between;padding:8px 11px 0;font-size:12.5px}
  .surow .spct{color:var(--vscode-foreground);font-family:var(--vscode-editor-font-family),monospace}
  .sbar{height:5px;border-radius:999px;background:var(--vscode-scrollbarSlider-background,#3a3a3a);overflow:hidden;margin:5px 11px 0}
  .sbar i{display:block;height:100%;border-radius:999px;background:var(--accent)}
  .sreset{font-size:10px;color:var(--vscode-descriptionForeground);opacity:.8;padding:2px 11px 0}
  .sseg{display:inline-flex;margin:8px 11px;border:1px solid var(--vscode-panel-border);border-radius:7px;overflow:hidden}
  .sseg span{padding:3px 13px;font-size:11px;color:var(--vscode-descriptionForeground);cursor:pointer}
  .sseg span.on{background:color-mix(in srgb,var(--accent) 26%,transparent);color:var(--vscode-foreground)}
  .sins{padding:7px 11px 1px} .sinsh{font-size:12px;color:var(--vscode-foreground)}
  .sthead2{padding:9px 11px 3px;font-size:10px;color:var(--vscode-descriptionForeground);text-transform:uppercase;letter-spacing:.5px;opacity:.7}
  .strow{display:flex;justify-content:space-between;gap:10px;padding:2px 11px;font-size:11.5px}
  .strow .snm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--vscode-editor-font-family),monospace}
  .strow .spp{color:var(--vscode-descriptionForeground);flex:none;font-family:var(--vscode-editor-font-family),monospace}
  .sopt{display:flex;align-items:center;gap:9px;padding:7px 11px;border-radius:6px;cursor:pointer}
  .sopt:hover{background:var(--vscode-menu-selectionBackground,var(--vscode-toolbar-hoverBackground))}
  .sopt .sck{color:var(--accent);width:11px;flex:none}
  .sopt .snm2{flex:1;font-size:13px} .sopt.cur .snm2{font-weight:600}
  .sopt .sod{font-size:10.5px;color:var(--vscode-descriptionForeground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px}
  .ssrv{display:flex;align-items:center;gap:9px;padding:7px 11px}
  .ssrv .sdot{width:7px;height:7px;border-radius:50%;flex:none}
  .ssrv .sdot.on{background:var(--green)} .ssrv .sdot.off{background:#5a5a5a}
  .ssrv .sname{flex:1;font-size:13px} .ssrv .smeta{font-size:10.5px;color:var(--vscode-descriptionForeground);font-family:var(--vscode-editor-font-family),monospace}
</style></head>
<body data-model="${model}" data-perm="default">
  ${chatHeaderHtml(model)}
  <div class="logwrap">
    <div id="log"></div>
    <div id="welcome">
      <div class="wtop">
        <svg viewBox="0 0 409 386" width="16" height="15"><rect y="279" width="103" height="107" fill="#DD7A5A" fill-opacity="0.8"/><rect x="51" y="186" width="103" height="107" fill="#9471F5" fill-opacity="0.8"/><rect x="154" width="103" height="107" fill="currentColor"/><rect x="203" y="93" width="103" height="107" fill="currentColor"/><rect x="257" y="186" width="103" height="107" fill="currentColor"/><rect x="306" y="279" width="103" height="107" fill="currentColor"/><rect x="103" y="93" width="103" height="107" fill="#628EFE" fill-opacity="0.8"/></svg>
        <span class="abtext">AgentBridge</span>
      </div>
      <div class="wbox">
        <div class="wlogo" id="wlogo">${logoSvg}</div>
        <div class="wbrand" id="wbrand">${brand}</div>
        <div class="wcap" id="wcap"><span id="wcapco">${brand}</span> running on AgentBridge</div>
        <div class="wlogin" id="wlogin" style="display:none">
          <button class="wlbtn" id="wlbtn">Log in to <span id="wlco">${brand}</span></button>
          <input class="wkey" id="wkinput" type="password" placeholder="Paste your Gemini API key" autocomplete="off" autocapitalize="off" spellcheck="false" style="display:none" />
          <button class="wlbtn" id="wkbtn" style="display:none">Save key</button>
          <span class="wsub" id="wsub">Opens your browser · token stored securely</span>
          <span class="wmanual" id="wmanual" style="display:none">Open the login link manually</span>
        </div>
      </div>
    </div>
  </div>
  <footer>
    <div class="dock">
      <div id="approvalSlot"></div>
      <div class="inbox">
        <div class="chips" id="chips"></div>
        <div class="inwrap"><div id="inhl" aria-hidden="true"></div><textarea id="input" rows="1" placeholder="Message…  (Enter to send · Shift+Enter newline)" disabled></textarea></div>
        <div class="ctrls">
          <button class="ic" id="attachBtn" title="Attach image"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button>
          <button class="ic" id="slashBtn" title="Slash commands"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M16 5L8 19"/></svg></button>
          <span class="pill" id="modelPill" title="Model">Model</span>
          <span class="sp"></span>
          <span class="pill" id="permPill" title="Permission mode · Shift+Tab">${permLabel}</span>
          <button id="send" title="Send" disabled><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20V6M6 12l6-6 6 6"/></svg></button>
        </div>
      </div>
    </div>
  </footer>
  <div id="modelMenu" class="menu"></div>
  <div id="slashMenu" class="menu"></div>
  <div id="acMenu" class="menu"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  vscode.setState({ sessionId: ${JSON.stringify(this.sessionId)}, model: ${JSON.stringify(model)}, workspaceId: ${JSON.stringify(this.workspaceId)} }); // IDE 재시작 복원용 — 직렬화기가 이 값으로 패널 재구성
  const log = document.getElementById('log');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const approvalSlot = document.getElementById('approvalSlot');
  const permPill = document.getElementById('permPill');
  const STATUS = { thinking:'Thinking…', working:'Working…', responding:'Responding…' };
  let cur = null, work = null, busy = false, interruptRequested = false;

  // 시작 화면(welcome) — 브랜드 풀네임 + 로고. 대화 전 표시, 첫 메시지/미로그인 분기.
  const welcome = document.getElementById('welcome');
  const BRAND = { claude:'Claude', codex:'Codex', agy:'Antigravity' };
  // 로고는 서버에서 media/logos/<model>.svg를 인라인 주입(단일 소스). 여기선 브랜드 텍스트만 갱신.
  var welcomeModel='${model}', loginManualUrl='';
  function paintWelcome(m){ welcomeModel=m||welcomeModel; var b=BRAND[welcomeModel]||welcomeModel;
    document.getElementById('wbrand').textContent=b;
    document.getElementById('wcapco').textContent=b; document.getElementById('wlco').textContent=b; }
  function hideWelcome(){ welcome.classList.add('hide'); }
  // agy는 OAuth가 없고 API 키 입력 → 같은 로그인 영역에서 버튼 대신 키 입력창을 보인다(claude/codex는 브라우저 버튼 그대로).
  function showLoginMode(on){ document.getElementById('wcap').style.display=on?'none':'';
    document.getElementById('wlogin').style.display=on?'flex':'none'; if(on) welcome.classList.remove('hide');
    var isAgy = welcomeModel==='agy';
    document.getElementById('wlbtn').style.display = (on && !isAgy)?'':'none';
    document.getElementById('wkinput').style.display = (on && isAgy)?'':'none';
    var kb=document.getElementById('wkbtn'); kb.style.display = (on && isAgy)?'':'none'; kb.disabled=false; kb.textContent='Save key';
    document.getElementById('wsub').textContent = isAgy ? 'Stored securely in your OS keychain' : 'Opens your browser · token stored securely';
    if(on && isAgy) try{ document.getElementById('wkinput').focus(); }catch(e){} }
  // 미로그인이면 입력 자체를 막아 "보냈는데 안 사라짐"이 안 생기게. 로그인 성공 시 해제.
  function setLoggedOut(on){ input.disabled=on; sendBtn.disabled=on;
    input.placeholder = on ? 'Log in to start chatting…' : 'Message…  (Enter to send · Shift+Enter newline)'; }
  document.getElementById('wlbtn').addEventListener('click', function(){
    var btn=this; btn.disabled=true; btn.textContent='Waiting for browser…'; vscode.postMessage({type:'login'}); });
  document.getElementById('wmanual').addEventListener('click', function(){ if(loginManualUrl) vscode.postMessage({type:'openExternal',url:loginManualUrl}); });
  document.getElementById('wkbtn').addEventListener('click', function(){
    var inp=document.getElementById('wkinput'); var v=(inp.value||'').trim(); if(!v) return;
    var btn=this; btn.disabled=true; btn.textContent='Saving…'; vscode.postMessage({type:'submitKey', key:v}); });
  document.getElementById('wkinput').addEventListener('keydown', function(e){ if(e.key==='Enter'){ e.preventDefault(); document.getElementById('wkbtn').click(); } });

  // 권한 모드(6-2) — 에이전트별 모드 세트(claude 4 / codex 3). Shift+Tab·칩 클릭으로 순환.
  // body[data-perm]으로 입력바 외곽선 색 전환. 호스트가 claude=setPermissionMode / codex=approvalPolicy+sandbox로 매핑.
  var PERM_SETS={
    claude:[{id:'default',label:'Ask before edits'},{id:'acceptEdits',label:'Edit automatically'},{id:'plan',label:'Plan mode'},{id:'auto',label:'Auto mode'}],
    codex:[{id:'default',label:'Default permissions'},{id:'autoReview',label:'Auto-review'},{id:'fullAccess',label:'Full access'}]
  };
  var permList=PERM_SETS.claude, permIdx=0;
  function showPerm(){ var m=permList[permIdx]; permPill.textContent=m.label; document.body.dataset.perm=m.id; }
  function initPerm(model){ permList=PERM_SETS[model]||PERM_SETS.claude; permIdx=0; showPerm(); }
  function cyclePerm(){ permIdx=(permIdx+1)%permList.length; showPerm(); vscode.postMessage({type:'setPermissionMode',mode:permList[permIdx].id}); }
  permPill.addEventListener('click', cyclePerm);

  // 모델 선택(6-3) — 호스트가 listModels로 채운 목록을 칩 클릭 시 팝업으로. 선택 → setModel.
  const modelPill = document.getElementById('modelPill');
  const modelMenu = document.getElementById('modelMenu');
  var MODELS=[], userPickedModel=false;
  // 추론 effort — 레벨은 모델별 API(MODELS[].efforts)에서. 'ultra'=ultracode(보라 점).
  var effortIdx=-1, userSetEffort=false;
  function currentEfforts(){ var m=MODELS.filter(function(x){return x.current;})[0]; return (m&&m.efforts)||[]; }
  function effortLabel(lv){ return lv==='ultra'?'ultracode':lv; }
  function buildEffortIdx(efforts){ if(effortIdx<0||!userSetEffort){ var mi=efforts.indexOf('medium'); effortIdx=mi>=0?mi:Math.floor((efforts.length-1)/2); } effortIdx=Math.max(0,Math.min(effortIdx,efforts.length-1)); }
  modelMenu.addEventListener('click', function(e){ e.stopPropagation(); }); // 메뉴 내부 클릭은 닫지 않음(슬라이더용)
  function closeModelMenu(){ modelMenu.style.display='none'; }
  function openModelMenu(){
    closeSettingsMenu(); closeAc(); // 한 번에 하나만
    if(!MODELS.length) return;
    modelMenu.innerHTML='';
    modelMenu.appendChild(el('div','mhdr','Select a model'));
    MODELS.forEach(function(m){
      var it=el('div','mitem'+(m.current?' cur':''));
      var row=el('div','mrow'); row.appendChild(el('div','mname',m.label)); if(m.current) row.appendChild(el('span','mchk','✓'));
      it.appendChild(row);
      if(m.desc) it.appendChild(el('div','mdesc',m.desc));
      it.addEventListener('click', function(){ vscode.postMessage({type:'setModel',id:m.id}); modelPill.textContent=m.label; userPickedModel=true; MODELS.forEach(function(x){x.current=(x.id===m.id);}); closeModelMenu(); });
      modelMenu.appendChild(it);
    });
    // effort 슬라이더 (#1b) — 모델별 레벨(MODELS.efforts) + 정지점 점 + ultra(보라). claude=applyFlagSettings / codex=turn/start.effort
    var efforts=currentEfforts();
    var showThinking=(document.body.dataset.model!=='codex');
    if(efforts.length||showThinking){ modelMenu.appendChild(el('div','msep')); modelMenu.appendChild(el('div','mhdr','Effort · Thinking')); }
    if(efforts.length){
      buildEffortIdx(efforts);
      var er=el('div','effort');
      var lbl=el('div','emname','Effort · '+effortLabel(efforts[effortIdx]));
      var wrap=el('div','erwrap'); var track=el('div','ertrack');
      var n=efforts.length;
      function pos(i){ return 'calc(8px + '+(n>1?(i/(n-1)):0)+' * (100% - 16px))'; }
      efforts.forEach(function(lv,i){ var d=el('span','edot'+(lv==='ultra'?' ultra':'')); d.style.left=pos(i); track.appendChild(d); });
      var rng=document.createElement('input'); rng.type='range'; rng.min='0'; rng.max=String(n-1); rng.step='1'; rng.value=String(effortIdx); rng.className='erange';
      function setFill(){ track.style.setProperty('--fill',pos(effortIdx)); }
      setFill();
      rng.addEventListener('input', function(){ effortIdx=parseInt(rng.value,10); userSetEffort=true; lbl.textContent='Effort · '+effortLabel(efforts[effortIdx]); setFill(); });
      rng.addEventListener('change', function(){ effortIdx=parseInt(rng.value,10); userSetEffort=true; vscode.postMessage({type:'setEffort',level:efforts[effortIdx]}); });
      wrap.appendChild(track); wrap.appendChild(rng);
      er.appendChild(lbl); er.appendChild(wrap); modelMenu.appendChild(er);
    }
    // Thinking 토글(#4) — 모델 메뉴 안, effort 바로 아래(구분선 없음). claude 계열만(codex는 effort에 통합).
    if(showThinking){
      var tkr=el('div','effort'); tkr.appendChild(el('div','emname','Thinking'));
      var tkt=mkToggle(thinkingOn); tkt.style.marginLeft='auto';
      tkt.addEventListener('click', function(e){ e.stopPropagation(); thinkingOn=!thinkingOn; tkt.className='tog'+(thinkingOn?' on':''); vscode.postMessage({type:'setThinking',on:thinkingOn}); });
      tkr.appendChild(tkt); modelMenu.appendChild(tkr);
    }
    var r=modelPill.getBoundingClientRect();
    modelMenu.style.left=r.left+'px';
    modelMenu.style.bottom=(window.innerHeight-r.top+6)+'px';
    modelMenu.style.display='block';
  }
  modelPill.addEventListener('click', function(ev){ ev.stopPropagation(); if(modelMenu.style.display==='block') closeModelMenu(); else openModelMenu(); });

  // 설정 + 슬래시 메뉴(원본 앱처럼 / 버튼 하나에 통합). 설정 섹션 + 기존 슬래시 명령 + 서브패널.
  const slashBtn = document.getElementById('slashBtn');
  const settingsMenu = document.getElementById('slashMenu'); // 재사용
  var SLASH=[], thinkingOn=true;
  var SUPPORT_URLS={
    claude:{help:'https://docs.claude.com/en/docs/claude-code/overview',report:'https://github.com/anthropics/claude-code/issues/new'},
    codex:{help:'https://developers.openai.com/codex',report:'https://github.com/openai/codex/issues/new'},
    agy:{help:'https://antigravity.google',report:'https://antigravity.google'}
  };
  settingsMenu.addEventListener('click', function(e){ e.stopPropagation(); }); // 내부 클릭은 닫지 않음(토글·서브패널)
  function closeSettingsMenu(){ settingsMenu.style.display='none'; }
  function placeMenu(){ var r=slashBtn.getBoundingClientRect(); settingsMenu.style.left=r.left+'px'; settingsMenu.style.bottom=(window.innerHeight-r.top+6)+'px'; }
  function showMenu(){ placeMenu(); settingsMenu.style.display='block'; }
  function mkToggle(on){ return el('span','tog'+(on?' on':'')); }
  function mkItem(o){ var it=el('div','mitem'); var row=el('div','srow');
    if(o.icon!=null) row.appendChild(el('span','mico',o.icon));
    row.appendChild(el('span','sname',o.label));
    if(o.val) row.appendChild(el('span','sval',o.val));
    if(o.trailing) row.appendChild(o.trailing);
    it.appendChild(row); if(o.onClick) it.addEventListener('click', o.onClick); return it; }

  function openSettingsMenu(){
    closeModelMenu(); closeAc(); // 한 번에 하나만
    var model=document.body.dataset.model||'claude';
    settingsMenu.className='menu settings'; settingsMenu.innerHTML='';
    var f=document.createDocumentFragment();
    f.appendChild(el('div','ssec','Context'));
    f.appendChild(mkItem({icon:'@',label:'Mention file…',onClick:function(){ vscode.postMessage({type:'mentionFile'}); closeSettingsMenu(); }}));
    if(model==='codex') f.appendChild(mkItem({icon:'⤿',label:'Compact conversation',onClick:function(){ vscode.postMessage({type:'compact'}); closeSettingsMenu(); }}));
    f.appendChild(el('div','ssec','Model'));
    f.appendChild(mkItem({icon:'◐',label:'Account & usage',trailing:el('span','schev','›'),onClick:function(){ openPanel('account'); }}));
    f.appendChild(el('div','ssec','Customize'));
    if(model!=='codex') f.appendChild(mkItem({icon:'✎',label:'Output style',trailing:el('span','schev','›'),onClick:function(){ openPanel('output'); }}));
    f.appendChild(mkItem({icon:'⊞',label:'Agents & skills',trailing:el('span','schev','›'),onClick:function(){ openPanel('agents'); }}));
    f.appendChild(mkItem({icon:'⧉',label:'MCP servers',trailing:el('span','schev','›'),onClick:function(){ openPanel('mcp'); }}));
    f.appendChild(mkItem({icon:'›_',label:'Open in Terminal',trailing:el('span','sext','↗'),onClick:function(){ vscode.postMessage({type:'openTerminal'}); closeSettingsMenu(); }}));
    f.appendChild(el('div','ssec','Support'));
    var urls=SUPPORT_URLS[model]||SUPPORT_URLS.claude;
    f.appendChild(mkItem({icon:'?',label:'View help docs',trailing:el('span','sext','↗'),onClick:function(){ vscode.postMessage({type:'openExternal',url:urls.help}); closeSettingsMenu(); }}));
    f.appendChild(mkItem({icon:'⚑',label:'Report a problem',trailing:el('span','sext','↗'),onClick:function(){ vscode.postMessage({type:'openExternal',url:urls.report}); closeSettingsMenu(); }}));
    if(SLASH.length){ f.appendChild(el('div','msep')); f.appendChild(el('div','ssec','Commands'));
      SLASH.forEach(function(c){ f.appendChild(mkItem({label:'/'+c,onClick:function(){ input.value='/'+c+' '; grow(); renderHL(); input.focus(); closeSettingsMenu(); }})); }); }
    settingsMenu.appendChild(f); showMenu();
  }

  function panelHeader(title){ var h=el('div','sback'); var bk=el('span','sbk','‹ Back'); bk.addEventListener('click', openSettingsMenu); h.appendChild(bk); h.appendChild(el('span',null,' · '+title)); return h; }
  function openPanel(which){
    closeModelMenu(); closeAc(); // 한 번에 하나만
    settingsMenu.className='menu settings panel'; settingsMenu.innerHTML='';
    var titles={account:'Account & Usage',output:'Output style',mcp:'MCP servers',agents:'Agents & skills'};
    settingsMenu.appendChild(panelHeader(titles[which])); settingsMenu.appendChild(el('div','sload','Loading…'));
    var reqs={account:'getUsage',output:'listOutputStyles',mcp:'listMcp',agents:'listAgents'};
    vscode.postMessage({type:reqs[which]}); showMenu();
  }
  function panelOpen(){ return settingsMenu.style.display==='block' && settingsMenu.classList.contains('panel'); }

  function behaviorLabel(k){ return ({subagent_heavy:'subagent-heavy sessions',cron:'background/long-running sessions',long_context:'>150k context sessions'})[k]||k; }
  function relReset(iso){ try{ var ms=new Date(iso).getTime()-Date.now(); if(ms<=0) return 'soon'; var h=Math.floor(ms/3600000); if(h<1) return 'in '+Math.max(1,Math.round(ms/60000))+'m'; if(h<24) return 'in '+h+'h'; return 'in '+Math.round(h/24)+'d'; }catch(e){ return ''; } }
  function renderContrib(parent,b){ parent.innerHTML=''; parent.appendChild(el('div','ssec',"What's contributing"));
    (b.behaviors||[]).forEach(function(x){ var d=el('div','sins'); d.appendChild(el('div','sinsh',x.pct+'% — '+behaviorLabel(x.key))); parent.appendChild(d); });
    function table(t,arr){ if(!arr||!arr.length) return; parent.appendChild(el('div','sthead2',t)); arr.forEach(function(r){ var tr=el('div','strow'); tr.appendChild(el('span','snm',r.name)); tr.appendChild(el('span','spp',r.pct+'%')); parent.appendChild(tr); }); }
    table('Subagents',b.agents); table('Skills',b.skills); table('Plugins',b.plugins); table('MCP servers',b.mcpServers); }
  function renderUsage(u){ if(!panelOpen()) return; settingsMenu.innerHTML=''; settingsMenu.appendChild(panelHeader('Account & Usage'));
    if(!u){ settingsMenu.appendChild(el('div','sload','Unavailable')); return; }
    var f=document.createDocumentFragment(); f.appendChild(el('div','ssec','Account'));
    function kv(k,v){ if(!v) return; var r=el('div','skv'); r.appendChild(el('span','sk',k)); r.appendChild(el('span','svv',v)); f.appendChild(r); }
    kv('Auth method',u.account.authMethod); kv('Email',u.account.email); kv('Organization',u.account.organization); kv('Plan',u.account.plan);
    if(u.limits&&u.limits.length){ f.appendChild(el('div','msep')); f.appendChild(el('div','ssec','Usage'));
      u.limits.forEach(function(l){ var row=el('div','surow'); row.appendChild(el('span',null,l.label)); row.appendChild(el('span','spct',l.percent+'%')); f.appendChild(row);
        var bar=el('div','sbar'); var i=document.createElement('i'); i.style.width=Math.max(0,Math.min(100,l.percent))+'%'; bar.appendChild(i); f.appendChild(bar);
        if(l.resetsAt) f.appendChild(el('div','sreset','Resets '+relReset(l.resetsAt))); }); }
    if(u.contributors){ f.appendChild(el('div','msep'));
      var seg=el('div','sseg'); var dayB=el('span',null,'Day'); var weekB=el('span',null,'Week'); seg.appendChild(dayB); seg.appendChild(weekB); f.appendChild(seg);
      var body=el('div'); f.appendChild(body);
      function paint(w){ dayB.className=w==='day'?'on':''; weekB.className=w==='week'?'on':''; renderContrib(body,u.contributors[w]); }
      dayB.addEventListener('click', function(){ paint('day'); }); weekB.addEventListener('click', function(){ paint('week'); });
      settingsMenu.appendChild(f); paint('day'); placeMenu(); return; }
    settingsMenu.appendChild(f); placeMenu(); }
  function renderOutputStyles(d){ if(!panelOpen()) return; settingsMenu.innerHTML=''; settingsMenu.appendChild(panelHeader('Output style'));
    if(!d||!d.available||!d.available.length){ settingsMenu.appendChild(el('div','sload','Unavailable')); return; }
    d.available.forEach(function(name){ var it=el('div','sopt'+(name===d.current?' cur':'')); it.appendChild(el('span','sck',name===d.current?'✓':'')); it.appendChild(el('span','snm2',name));
      it.addEventListener('click', function(){ vscode.postMessage({type:'setOutputStyle',style:name}); d.current=name; renderOutputStyles(d); }); settingsMenu.appendChild(it); }); placeMenu(); }
  function renderMcp(list){ if(!panelOpen()) return; settingsMenu.innerHTML=''; settingsMenu.appendChild(panelHeader('MCP servers'));
    if(!list||!list.length){ settingsMenu.appendChild(el('div','sload','No MCP servers')); return; }
    var canToggle=(document.body.dataset.model!=='codex');
    list.forEach(function(s){ var row=el('div','ssrv'); row.appendChild(el('span','sdot'+(s.connected?' on':' off'))); row.appendChild(el('span','sname',s.name)); row.appendChild(el('span','smeta',s.toolCount?(s.toolCount+' tools'):''));
      if(canToggle){ var tg=mkToggle(s.enabled); tg.addEventListener('click', function(e){ e.stopPropagation(); s.enabled=!s.enabled; tg.className='tog'+(s.enabled?' on':''); vscode.postMessage({type:'toggleMcp',name:s.name,enabled:s.enabled}); }); row.appendChild(tg); }
      settingsMenu.appendChild(row); }); placeMenu(); }
  function renderAgents(list){ if(!panelOpen()) return; settingsMenu.innerHTML=''; settingsMenu.appendChild(panelHeader('Agents & skills'));
    if(!list||!list.length){ settingsMenu.appendChild(el('div','sload','None')); return; }
    list.forEach(function(a){ var it=el('div','sopt'); it.appendChild(el('span','snm2',a.name)); if(a.description) it.appendChild(el('span','sod',a.description)); settingsMenu.appendChild(it); }); placeMenu(); }

  slashBtn.addEventListener('click', function(ev){ ev.stopPropagation(); if(settingsMenu.style.display==='block') closeSettingsMenu(); else openSettingsMenu(); });
  document.addEventListener('click', function(){ closeModelMenu(); closeSettingsMenu(); closeAc(); });
  // Esc로 모델/설정/자동완성 패널 닫기 (입력 포커스가 아니어도 동작하도록 window 레벨)
  window.addEventListener('keydown', function(e){ if(e.key!=='Escape') return;
    if(modelMenu.style.display==='block'||settingsMenu.style.display==='block'||acOpen()){ closeModelMenu(); closeSettingsMenu(); closeAc(); e.preventDefault(); return; }
    if(busy){ interruptRequested=true; vscode.postMessage({type:'interrupt'}); e.preventDefault(); } });

  // ── 입력 자동완성(/ 명령 + @ 파일) + 명령 색상 하이라이트 ──
  const inhl=document.getElementById('inhl');
  const acMenu=document.getElementById('acMenu');
  var AC={items:[],idx:0,mode:null};
  acMenu.addEventListener('mousedown', function(e){ e.preventDefault(); }); // 클릭 시 입력 포커스 유지
  acMenu.addEventListener('click', function(e){ e.stopPropagation(); });
  function acOpen(){ return acMenu.style.display==='block'; }
  function closeAc(){ acMenu.style.display='none'; AC.items=[]; AC.mode=null; }
  // B 그룹(설정 가로채기) — SDK가 안 주는 설정형 명령. 완성 시 send 대신 우리 패널을 연다.
  function appCmds(){ var model=document.body.dataset.model||'claude'; var u=SUPPORT_URLS[model]||SUPPORT_URLS.claude;
    var b=[
      {name:'model',hint:'Switch model',act:function(){ stripSlash(); closeAc(); openModelMenu(); }},
      {name:'usage',hint:'Account & usage',act:function(){ stripSlash(); closeAc(); openPanel('account'); }},
      {name:'mcp',hint:'MCP servers',act:function(){ stripSlash(); closeAc(); openPanel('mcp'); }},
      {name:'agents',hint:'Agents & skills',act:function(){ stripSlash(); closeAc(); openPanel('agents'); }},
      {name:'help',hint:'Help docs',act:function(){ stripSlash(); closeAc(); vscode.postMessage({type:'openExternal',url:u.help}); }},
      {name:'bug',hint:'Report a problem',act:function(){ stripSlash(); closeAc(); vscode.postMessage({type:'openExternal',url:u.report}); }},
      {name:'clear',hint:'New session',act:function(){ stripSlash(); closeAc(); vscode.postMessage({type:'newSession'}); }}
    ];
    if(model!=='codex') b.push({name:'output-style',hint:'Output style',act:function(){ stripSlash(); closeAc(); openPanel('output'); }});
    if(model==='codex') b.push({name:'compact',hint:'Compact',act:function(){ stripSlash(); closeAc(); vscode.postMessage({type:'compact'}); }});
    return b;
  }
  function knownCmd(name){ if(SLASH.indexOf(name)>=0) return true; return appCmds().some(function(a){return a.name===name;}); }
  function stripSlash(){ input.value=input.value.replace(/^\\/[^\\s]*\\s?/, ''); grow(); renderHL(); }
  // 명령/멘션 토큰 색칠(오버레이). 입력 텍스트는 투명, 이 div가 같은 위치에 색 입혀 보여줌.
  function renderHL(){ var v=input.value, out=esc(v);
    out=out.replace(/(^|\\s)(@[^\\s]+)/g, function(_,p,mn){ return p+'<span class="mention">'+mn+'</span>'; });
    var cm=v.match(/^\\/([^\\s]+)/); if(cm && knownCmd(cm[1])) out=out.replace(/^(\\/[^\\s]+)/, '<span class="cmdok">$1</span>');
    inhl.innerHTML=out; inhl.scrollTop=input.scrollTop; }

  function placeAc(){ var r=input.getBoundingClientRect(); acMenu.style.left=r.left+'px'; acMenu.style.bottom=(window.innerHeight-r.top+8)+'px'; }
  function renderAc(){ acMenu.innerHTML='';
    if(!AC.items.length){ closeAc(); return; }
    AC.items.forEach(function(it,i){ var row=el('div','acitem'+(i===AC.idx?' sel':''));
      row.appendChild(el('span','acname',(AC.mode==='cmd'?'/':'@')+it.name));
      row.addEventListener('mousedown', function(e){ e.preventDefault(); AC.idx=i; acAccept(); });
      acMenu.appendChild(row); });
    placeAc(); acMenu.style.display='block'; }
  function acMove(d){ if(!AC.items.length) return; AC.idx=(AC.idx+d+AC.items.length)%AC.items.length;
    Array.prototype.forEach.call(acMenu.children, function(c,i){ c.className='acitem'+(i===AC.idx?' sel':''); });
    var s=acMenu.children[AC.idx]; if(s&&s.scrollIntoView) s.scrollIntoView({block:'nearest'}); }
  function acAccept(){ var it=AC.items[AC.idx]; if(!it) return;
    if(AC.mode==='cmd'){ if(it.app){ it.act(); return; } input.value='/'+it.name+' '; grow(); renderHL(); closeAc(); input.focus(); }
    else { input.value=input.value.replace(/(^|\\s)@[^\\s]*$/, function(_,p){ return p+'@'+it.name+' '; }); grow(); renderHL(); closeAc(); input.focus(); } }
  function updateAc(){ var caret=input.selectionStart||0, pre=input.value.slice(0,caret);
    var cm=pre.match(/^\\/([^\\s]*)$/), fm=pre.match(/(?:^|\\s)@([^\\s]*)$/);
    if(cm){ AC.mode='cmd'; var q=cm[1].toLowerCase();
      var app=appCmds().filter(function(a){return a.name.indexOf(q)===0;}).map(function(a){return {name:a.name,hint:a.hint,app:true,act:a.act};});
      var sk=SLASH.filter(function(c){return c.toLowerCase().indexOf(q)===0 && !app.some(function(a){return a.name===c.toLowerCase();});}).map(function(c){return {name:c,app:false};});
      AC.items=app.concat(sk).slice(0,50); AC.idx=0; renderAc(); }
    else if(fm){ AC.mode='file'; vscode.postMessage({type:'searchFiles',query:fm[1]}); }
    else { closeAc(); } }

  // 이미지 첨부(6-5) — + 버튼 → 호스트 파일 다이얼로그 → 프로젝트로 복사 → 경로+썸네일(dataUrl) 회신 → 전송 시 경로 주입.
  const attachBtn = document.getElementById('attachBtn');
  const chips = document.getElementById('chips');
  var PENDING=[];
  attachBtn.addEventListener('click', function(){ vscode.postMessage({type:'pickImage'}); });
  // 이미지 붙여넣기/드롭 → 바이트를 호스트로 보내 + 버튼과 동일 파이프라인(프로젝트 저장→경로 주입)에 합류.
  function sendImageFile(file){ if(!file||!file.type||file.type.indexOf('image/')!==0) return;
    var reader=new FileReader();
    reader.onload=function(){ var s=String(reader.result||''); var ci=s.indexOf(','); var b64=ci>=0?s.slice(ci+1):s;
      var ext=(file.type.split('/')[1]||'png').replace('jpeg','jpg').replace('svg+xml','svg');
      var name=file.name||('pasted-'+Date.now()+'.'+ext);
      vscode.postMessage({type:'attachBytes',name:name,base64:b64}); };
    reader.readAsDataURL(file); }
  input.addEventListener('paste', function(e){ var items=(e.clipboardData&&e.clipboardData.items)||[]; var had=false;
    for(var i=0;i<items.length;i++){ if(items[i].type&&items[i].type.indexOf('image/')===0){ var f=items[i].getAsFile(); if(f){ sendImageFile(f); had=true; } } }
    if(had) e.preventDefault(); });
  ['dragenter','dragover'].forEach(function(ev){ document.addEventListener(ev, function(e){ e.preventDefault(); }); });
  // 드롭 — 이미지=첨부 / 그 외 파일·에디터탭·탐색기 항목=@멘션(경로). PTY 드롭과 동형(File.path + VSCode 내부 uri-list/resource-urls/codeeditors).
  function decodeFileUri(s){ var t=(s||'').trim(); if(!t||t.charAt(0)==='#') return ''; if(t.indexOf('file://')===0){ try{ return decodeURIComponent(t.slice(7)); }catch(e){ return t.slice(7); } } return t.charAt(0)==='/'?t:''; }
  document.addEventListener('drop', function(e){
    var dt=e.dataTransfer; if(!dt) return;
    var files=dt.files||[]; var imgs=[]; var paths={};
    for(var i=0;i<files.length;i++){ var f=files[i];
      if(f.type&&f.type.indexOf('image/')===0) imgs.push(f);
      else if(f.path) paths[f.path]=1; }
    var pending=[];
    if(dt.items){ for(var k=0;k<dt.items.length;k++){ (function(item){
      if(!item||item.kind!=='string') return; var ty=item.type||'';
      if(ty!=='text/uri-list'&&ty!=='text/plain'&&ty.indexOf('resource-urls')<0&&ty.indexOf('codeeditors')<0) return;
      pending.push(new Promise(function(res){ item.getAsString(function(data){
        if(!data) return res();
        try{ var j=JSON.parse(data); if(Array.isArray(j)){ j.forEach(function(x){
          if(typeof x==='string'){ var p=decodeFileUri(x); if(p) paths[p]=1; }
          else if(x&&typeof x==='object'){ var r=x.resource; var u=(r&&(r.external||r.fsPath||r.path))||x.external||x.fsPath||x.path; if(typeof u==='string'){ var q=decodeFileUri(u); if(q) paths[q]=1; } } }); return res(); } }catch(_){}
        data.split(/\\r?\\n/).forEach(function(line){ var p2=decodeFileUri(line); if(p2) paths[p2]=1; }); res();
      }); })); })(dt.items[k]); } }
    if(imgs.length||pending.length||Object.keys(paths).length) e.preventDefault();
    imgs.forEach(sendImageFile);
    Promise.all(pending).then(function(){ var list=Object.keys(paths);
      if(list.length) vscode.postMessage({type:'mentionPaths',paths:list});
      else if(!imgs.length) vscode.postMessage({type:'log',text:'drop: no paths — types='+JSON.stringify(Array.from(dt.types||[]))}); });
  });
  function thumb(a){ if(!a.dataUrl) return null; var im=document.createElement('img'); im.className='thumb'; im.src=a.dataUrl; return im; }
  function renderChips(){
    chips.innerHTML='';
    PENDING.forEach(function(a,i){
      var c=el('span','pend'); var im=thumb(a); if(im) c.appendChild(im); else c.appendChild(el('span',null,'🖼'));
      c.appendChild(el('span',null,a.name));
      var x=el('span','x','✕'); x.addEventListener('click', function(){ PENDING.splice(i,1); renderChips(); }); c.appendChild(x);
      chips.appendChild(c);
    });
  }

  function el(t,c,x){ var e=document.createElement(t); if(c)e.className=c; if(x!=null)e.textContent=x; return e; }
  function bottom(){ log.scrollTop = log.scrollHeight; }
  function esc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  // 최소 마크다운: 펜스코드 → 인라인코드 → 굵게 → 리스트 → 단락
  function md(src){
    // 라인 기반 — 펜스 코드블록은 내부 빈 줄·미완(스트리밍)에도 한 블록으로 안전하게 처리.
    var lines = src.split('\\n'), out = [], i = 0;
    var cells=function(r){ return r.replace(/^\\s*\\|/,'').replace(/\\|\\s*$/,'').split('|').map(function(c){return c.trim();}); };
    while (i < lines.length){
      if (/^\\s*\`\`\`/.test(lines[i])){
        var code = []; i++;
        while (i < lines.length && !/^\\s*\`\`\`\\s*$/.test(lines[i])){ code.push(lines[i]); i++; }
        i++; // 닫는 \`\`\`
        out.push('<pre><code>'+esc(code.join('\\n'))+'</code></pre>'); continue;
      }
      // 제목 (#~######) (#7)
      var hm = lines[i].match(/^\\s*(#{1,6})\\s+(.*)$/);
      if (hm){ var lv=hm[1].length; out.push('<h'+lv+'>'+inline(esc(hm[2].replace(/\\s+#+\\s*$/,'')))+'</h'+lv+'>'); i++; continue; }
      // 표: "| a | b |" 다음 줄이 구분줄("|---|") 일 때만 (#7)
      if (lines[i].indexOf('|')>=0 && i+1<lines.length && /-/.test(lines[i+1]) && lines[i+1].indexOf('|')>=0 && /^[\\s|:-]+$/.test(lines[i+1])){
        var head=cells(lines[i]); i+=2; var rows=[];
        while (i < lines.length && lines[i].trim() && lines[i].indexOf('|')>=0){ rows.push(cells(lines[i])); i++; }
        var th='<tr>'+head.map(function(c){return '<th>'+inline(esc(c))+'</th>';}).join('')+'</tr>';
        var tb=rows.map(function(r){return '<tr>'+r.map(function(c){return '<td>'+inline(esc(c))+'</td>';}).join('')+'</tr>';}).join('');
        out.push('<table>'+th+tb+'</table>'); continue;
      }
      if (/^\\s*[-*]\\s+/.test(lines[i])){
        var li = [];
        while (i < lines.length && /^\\s*[-*]\\s+/.test(lines[i])){ li.push('<li>'+inline(esc(lines[i].replace(/^\\s*[-*]\\s+/,'')))+'</li>'); i++; }
        out.push('<ul>'+li.join('')+'</ul>'); continue;
      }
      if (!lines[i].trim()){ i++; continue; }
      // 단락 — 첫 줄은 무조건 소비(진행 보장), 이후 펜스/리스트/제목 만나면 중단
      var para = [lines[i]]; i++;
      while (i < lines.length && lines[i].trim() && !/^\\s*\`\`\`/.test(lines[i]) && !/^\\s*[-*]\\s+/.test(lines[i]) && !/^\\s*#{1,6}\\s/.test(lines[i])){ para.push(lines[i]); i++; }
      out.push('<p>'+inline(esc(para.join('\\n'))).replace(/\\n/g,'<br>')+'</p>');
    }
    return out.join('');
  }
  function inline(s){ return s.replace(/\`([^\`]+)\`/g,function(_,c){return '<code>'+esc(c)+'</code>';}).replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>'); }

  // 재개 시 이전 대화 복원 — user 말풍선 + assistant의 텍스트/도구를 '나온 순서대로'(흐름 보존) 그리고 시작화면 숨김.
  function renderRestore(turns){
    if(!turns||!turns.length) return;
    hideWelcome();
    turns.forEach(function(t){
      if(t.user&&t.user.trim()){ var ut=el('div','turn user'); ut.appendChild(el('div','msg',t.user)); log.appendChild(ut); }
      var items=t.items||[];
      if(items.length){ var at=el('div','turn assistant'); var turnRaw='';
        items.forEach(function(it){
          if(it.type==='text'){ if(!it.text||!it.text.trim()) return; var r=el('div','item'); r.appendChild(el('span','dot text')); var bd=el('div','body md'); bd.innerHTML=md(it.text); r.appendChild(bd); at.appendChild(r); turnRaw=(turnRaw?turnRaw+'\\n\\n':'')+it.text; }
          else { var r2=el('div','item'); r2.appendChild(el('span','dot tool')); var nm=el('div','tname'); nm.appendChild(el('strong',null,it.name)); if(it.arg) nm.appendChild(el('span','tdesc',it.arg)); r2.appendChild(nm); at.appendChild(r2); }
        });
        addTurnCopyBtn(at, turnRaw);
        log.appendChild(at);
      }
    });
    bottom();
  }

  var SEND_SVG='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20V6M6 12l6-6 6 6"/></svg>';
  var STOP_SVG='<svg width="15" height="15" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3" fill="currentColor"/></svg>';
  function setBusy(b){ busy=b; sendBtn.disabled=false; sendBtn.classList.toggle('stop',b); sendBtn.innerHTML=b?STOP_SVG:SEND_SVG; } // 입력은 항상 활성(생성 중 큐잉 위해) — 비활성은 로그아웃 상태만
  var COPY_SVG='<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
  var CHECK_SVG='<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
  // 답변(턴)당 1개 복사 버튼 — 그 답변의 모든 텍스트(원본 마크다운)를 합쳐 복사. 클릭 시 체크 아이콘 1초 후 원복.
  function addTurnCopyBtn(turnEl, raw){
    if(!turnEl || !raw || !raw.trim()) return;
    var btn=el('button','copybtn'); btn.title='Copy answer'; btn.innerHTML=COPY_SVG;
    btn.addEventListener('click', function(e){ e.stopPropagation(); navigator.clipboard.writeText(raw); btn.innerHTML=CHECK_SVG; setTimeout(function(){ btn.innerHTML=COPY_SVG; },1000); });
    turnEl.appendChild(btn);
  }
  function newAssistantTurn(afterNode){ var t=el('div','turn assistant'); if(afterNode) log.insertBefore(t, afterNode.nextSibling); else log.appendChild(t); cur={turn:t,textItem:null,raw:'',fullRaw:'',deltas:0,think:null}; bottom(); }
  function itemRow(dotCls){ var r=el('div','item'); r.appendChild(el('span','dot '+dotCls)); var b=el('div','body'); r.appendChild(b);
    // working 줄이 있으면 그 앞에 끼워 항상 맨 아래에 두기.
    var anchor=(work&&work.line&&work.line.parentNode===cur.turn)?work.line:null; cur.turn.insertBefore(r,anchor); return b; }
  function closeText(){ if(cur&&cur.textItem){ cur.textItem.innerHTML = md(cur.raw); if(cur.raw&&cur.raw.trim()) cur.fullRaw=(cur.fullRaw?cur.fullRaw+'\\n\\n':'')+cur.raw; } cur && (cur.textItem=null, cur.raw=''); }
  // 생각 블록 종료 시 "Thought for Ns"로 요약 갱신 (#4)
  function closeThink(){ if(cur&&cur.think&&cur.thinkSummary){ var s=Math.max(1,Math.round((Date.now()-cur.thinkT0)/1000)); cur.thinkSummary.textContent='Thought for '+s+'s'; } if(cur){ cur.think=null; cur.thinkSummary=null; } }

  function startWork(){
    if(work) return;
    var line=el('div','working'); var sp=el('span','tspin'); var st=el('span','shim',STATUS.working); var mt=el('span','wmeta','');
    line.appendChild(sp); line.appendChild(st); line.appendChild(mt); cur.turn.appendChild(line);
    work={line:line,st:st,mt:mt,t0:Date.now(),out:0,frame:0};
    work.spin=setInterval(function(){ var F=' .oO@* '; sp.textContent=F[work.frame%F.length]; work.frame++; tick(); },200);
    tick();
  }
  function tick(){ if(!work) return; var s=Math.floor((Date.now()-work.t0)/1000); work.mt.textContent='('+fmtDur(s)+(work.out?(' · ↑ '+fmt(work.out)+' tokens'):'')+')'; }
  function setStatus(k){ if(work) work.st.textContent=STATUS[k]; }
  function setStatusText(t){ if(work) work.st.textContent=t; }
  // 도구 이름 → "무엇을 하는 중"인지 라벨 (#17). 모르는 이름은 그대로 노출.
  var TOOLVERB={Bash:'Running command',Shell:'Running command',Read:'Reading file',Glob:'Searching files',Grep:'Searching',Edit:'Editing',MultiEdit:'Editing',Write:'Writing file',NotebookEdit:'Editing',WebFetch:'Fetching',WebSearch:'Searching the web',Task:'Sub-agent',TodoWrite:'Planning'};
  function toolVerb(n){ return (TOOLVERB[n]||n||'Working')+'…'; }
  function fmt(n){ return n>=1000? (n/1000).toFixed(1).replace(/\\.0$/,'')+'k' : ''+n; }
  function fmtDur(s){ if(s<60) return s+'s'; var h=Math.floor(s/3600), m=Math.floor(s%3600/60), x=s%60; return (h?h+'h ':'')+((h||m)?m+'m ':'')+x+'s'; }
  function stopWork(){ if(work){ clearInterval(work.spin); work.line.remove(); work=null; } }
  function cleanModel(m){ if(!m) return ''; var s=m.replace(/\\[.*?\\]/g,'').replace(/^(claude|codex)-/,''); var p=s.match(/^(opus|sonnet|haiku)-?(\\d+)-?(\\d+)?/i); return p? (p[1].charAt(0).toUpperCase()+p[1].slice(1)+' '+p[2]+(p[3]?'.'+p[3]:'')) : s; }
  function grow(){ input.style.height='auto'; input.style.height=Math.min(input.scrollHeight,160)+'px'; }
  // 도구 표시용 — 설명(Bash 등의 description) + IN 본문(command/file_path/pattern…)
  function toolDesc(input){ return (input&&typeof input==='object'&&input.description)?String(input.description):''; }
  function toolIn(input){ if(input==null) return ''; if(typeof input==='string') return input;
    if(input.command!=null) return Array.isArray(input.command)?input.command.join(' '):String(input.command);
    if(input.file_path) return String(input.file_path);
    if(input.pattern) return String(input.pattern)+(input.path?(' · '+input.path):'');
    if(input.url) return String(input.url);
    var s=JSON.stringify(input); return s.length>240?s.slice(0,240)+'…':s; }

  // 생성 중 입력 큐(A) — 답변 생성 중 보낸 메시지는 여기 쌓였다 turn_end/error에 순서대로 발사(엔진은 직렬).
  // 유저 버블은 Enter 즉시 표시(가시화)하고, 발사 시 어시스턴트 턴을 그 버블 *바로 뒤에 끼워* 순서 보존:
  // 화면이 [유저→응답→유저→응답]으로 나옴(앞에 유저만 쌓이지도, 안 보이지도 않음).
  var QUEUE=[];
  function renderUser(text, atts){
    var t=el('div','turn user');
    atts.forEach(function(a){ var ac=el('span','att'); var im=thumb(a); if(im) ac.appendChild(im); else ac.appendChild(el('span',null,'🖼')); ac.appendChild(el('span',null,a.name)); t.appendChild(ac); });
    if(text) t.appendChild(el('div','msg',text));
    log.appendChild(t);
    hideWelcome(); // 첫 메시지 → 시작 화면 숨김
    return t;
  }
  function fireSend(item){ interruptRequested=false; setBusy(true); newAssistantTurn(item.node); startWork(); bottom(); vscode.postMessage({type:'send',text:item.sent}); }
  function drainQueue(){ if(QUEUE.length) fireSend(QUEUE.shift()); }
  function sendMsg(){
    var text=input.value.trim(); if(!text&&!PENDING.length) return;
    var atts=PENDING.slice();
    // 첨부 경로를 메시지에 주입(샌드박스가 프로젝트 내부만 읽으므로 복사된 경로를 전달).
    var sent = atts.length ? (text? text+'\\n\\n':'') + atts.map(function(a){return a.path;}).join('\\n') : text;
    var node=renderUser(text, atts); // Enter 즉시 유저 버블 표시
    input.value=''; input.style.height='auto'; renderHL(); closeAc(); PENDING=[]; renderChips();
    var item={ sent: sent, node: node };
    // 생성 중이면 큐에 쌓고 turn_end에 발사(발사 시 그 유저 버블 뒤에 응답을 끼움) — 아니면 즉시 발사.
    if(busy){ QUEUE.push(item); bottom(); }
    else fireSend(item);
  }
  sendBtn.addEventListener('click', function(){ if(busy){ interruptRequested=true; vscode.postMessage({type:'interrupt'}); } else sendMsg(); });
  input.addEventListener('keydown', function(e){
    if(e.isComposing||e.keyCode===229) return; // IME 조합 중(한글 등) Enter/단축키 무시 — 마지막 글자 중복 전송 방지
    if(acOpen()){
      if(e.key==='ArrowDown'){ e.preventDefault(); acMove(1); return; }
      if(e.key==='ArrowUp'){ e.preventDefault(); acMove(-1); return; }
      if(e.key==='Enter'||e.key==='Tab'){ e.preventDefault(); acAccept(); return; }
      if(e.key==='Escape'){ e.preventDefault(); closeAc(); return; }
    }
    if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); sendMsg(); }
    else if(e.key==='Tab'&&e.shiftKey){ e.preventDefault(); cyclePerm(); }
  });
  input.addEventListener('input', function(){ grow(); renderHL(); updateAc(); });
  input.addEventListener('scroll', function(){ inhl.scrollTop=input.scrollTop; });
  input.addEventListener('blur', function(){ setTimeout(closeAc, 120); });
  input.addEventListener('keyup', function(e){ if(e.key==='ArrowLeft'||e.key==='ArrowRight') updateAc(); });
  ${chatHeaderScript(JSON.stringify(this.sessionId))}

  window.addEventListener('message', function(event){
    var msg=event.data;
    if(msg.type==='ready'){
      if(msg.model){ document.body.dataset.model=msg.model; document.getElementById('badge').textContent=msg.model; initPerm(msg.model); paintWelcome(msg.model); }
      if(msg.loggedIn===false){ showLoginMode(true); setLoggedOut(true); }
      else { showLoginMode(false); setLoggedOut(false); setBusy(false); input.disabled=false; input.focus(); }
      return;
    }
    if(msg.type==='models'){ MODELS=msg.list||[]; var curM=MODELS.filter(function(m){return m.current;})[0]; if(curM && modelPill.textContent==='Model') modelPill.textContent=curM.label; return; }
    if(msg.type==='attachAdded'){ PENDING.push({name:msg.name,path:msg.path,dataUrl:msg.dataUrl}); renderChips(); return; }
    if(msg.type==='loginStarted'){ loginManualUrl=msg.manualUrl||''; if(loginManualUrl) document.getElementById('wmanual').style.display='block'; return; }
    if(msg.type==='loginResult'){
      var btn=document.getElementById('wlbtn');
      if(msg.ok){ showLoginMode(false); setLoggedOut(false); setBusy(false); input.focus(); }
      else { btn.disabled=false; btn.textContent='Log in to '+(BRAND[welcomeModel]||welcomeModel);
             var kb=document.getElementById('wkbtn'); kb.disabled=false; kb.textContent='Save key'; }
      return;
    }
    if(msg.type==='usage'){ renderUsage(msg.data); return; }
    if(msg.type==='outputStyles'){ renderOutputStyles(msg.data); return; }
    if(msg.type==='mcp'){ renderMcp(msg.data); return; }
    if(msg.type==='agents'){ renderAgents(msg.data); return; }
    if(msg.type==='slash'){ SLASH=msg.list||[]; return; }
    if(msg.type==='files'){ if(AC.mode==='file'){ AC.items=(msg.list||[]).map(function(p){return {name:p};}); AC.idx=0; renderAc(); } return; }
    if(msg.type==='cleared'){ stopWork(); QUEUE=[]; cur=null; log.innerHTML=''; closeSettingsMenu(); closeAc(); input.value=''; renderHL(); welcome.classList.remove('hide'); return; }
    if(msg.type==='restore'){ renderRestore(msg.turns); return; }
    if(msg.type==='inject'){
      var ip=[]; if(msg.ir) ip.push('IR'); if(msg.mem>0) ip.push(msg.mem+' memory');
      if(ip.length && cur && cur.turn){
        // 현재 어시스턴트 턴(cur) 바로 앞 = 그 턴의 유저 버블과 답변 사이. "마지막 유저 버블"이 아니라 cur 기준이라
        // 큐로 다음 유저 버블이 미리 떠 있어도 어긋나지 않음.
        var prev=cur.turn.previousElementSibling;
        if(!(prev && prev.classList.contains('inj'))){
          var lab=el('div','inj'); lab.textContent='↳ Injected · '+ip.join(', ');
          log.insertBefore(lab, cur.turn);
        }
      }
      return;
    }
    if(msg.type==='compacted'){ closeSettingsMenu(); return; }
    if(msg.type==='mentionAdded'){ var pth=msg.path; input.value=(input.value? input.value.replace(/\\s*$/,'')+' ':'')+'@'+pth+' '; grow(); renderHL(); input.focus(); return; }
    if(msg.type!=='event') return;
    var ev=msg.ev;
    if(ev.t==='auth'){ if(ev.loggedIn===false){ stopWork(); showLoginMode(true); setLoggedOut(true); if(cur&&cur.turn){ cur.turn.remove(); cur=null; } } }
    else if(ev.t==='session'){ if(ev.model){ modelPill.textContent=cleanModel(ev.model); } }
    else if(ev.t==='text' && ev.final===false){
      if(!cur) newAssistantTurn(); closeThink();
      if(!cur.textItem){ cur.textItem=itemRow('text'); cur.textItem.className='body md'; cur.raw=''; }
      cur.raw+=ev.text; cur.deltas++; cur.textItem.innerHTML=md(cur.raw); setStatus('responding'); bottom();
    }
    else if(ev.t==='text' && ev.final===true){
      if(!cur) newAssistantTurn(); closeThink();
      if(!cur.textItem){ cur.textItem=itemRow('text'); cur.raw=''; }
      if(cur.deltas===0) cur.raw=ev.text;
      cur.textItem.innerHTML=md(cur.raw); cur.textItem.className='body md'; if(cur.raw&&cur.raw.trim()) cur.fullRaw=(cur.fullRaw?cur.fullRaw+'\\n\\n':'')+cur.raw; cur.textItem=null; cur.raw=''; cur.deltas=0; bottom();
    }
    else if(ev.t==='thinking'){
      if(!cur) newAssistantTurn(); closeText();
      if(!cur.think){ var b=itemRow('text'); var d=el('details','think'); var sm=el('summary',null,'Thinking…'); var tx=el('div','tx',''); d.appendChild(sm); d.appendChild(tx); b.appendChild(d); cur.think=tx; cur.thinkSummary=sm; cur.thinkT0=Date.now(); }
      cur.think.textContent+=ev.text; setStatus('thinking'); bottom();
    }
    else if(ev.t==='tool'){
      if(!cur) newAssistantTurn();
      if(!cur.tools) cur.tools={};
      // started(또는 처음 보는 id) → 헤더 + IN 박스 생성
      if(!cur.tools[ev.id]){
        closeText(); closeThink();
        var b=itemRow('tool'); var nm=el('div','tname'); nm.appendChild(el('strong',null,ev.name||'Tool'));
        var dsc=toolDesc(ev.input); if(dsc) nm.appendChild(el('span','tdesc',dsc));
        b.appendChild(nm);
        var box=el('div','tbox'); var inTxt=toolIn(ev.input);
        if(inTxt){ var ir=el('div','trow'); ir.appendChild(el('span','tlabel','IN')); ir.appendChild(el('div','tcontent',inTxt)); box.appendChild(ir); }
        b.appendChild(box); cur.tools[ev.id]={box:box,hasOut:false}; setStatusText(toolVerb(ev.name)); bottom();
      }
      // done → OUT 박스 채움
      if(ev.status==='done'){
        var t=cur.tools[ev.id]; var out=ev.output!=null?(typeof ev.output==='string'?ev.output:JSON.stringify(ev.output)):'';
        if(t&&!t.hasOut&&out.trim()){ var orr=el('div','trow'); orr.appendChild(el('span','tlabel','OUT')); orr.appendChild(el('div','tcontent',out)); t.box.appendChild(orr); t.hasOut=true; bottom(); }
      }
    }
    else if(ev.t==='usage'){ if(work){ work.out=ev.outputTokens; tick(); } }
    else if(ev.t==='commands'){ SLASH=ev.commands||[]; }
    else if(ev.t==='approval'){
      var box=el('div','approval'); var info=el('div'); info.appendChild(el('div','t','🔐 '+ev.title)); if(ev.detail) info.appendChild(el('div','d',ev.detail));
      var acts=el('div','aacts'); var no=el('button','an','Deny'); var yes=el('button','ay','Approve');
      no.addEventListener('click', function(){ vscode.postMessage({type:'respondApproval',id:ev.id,approve:false}); box.remove(); });
      yes.addEventListener('click', function(){ vscode.postMessage({type:'respondApproval',id:ev.id,approve:true}); box.remove(); });
      acts.appendChild(no); acts.appendChild(yes); box.appendChild(info); box.appendChild(acts); approvalSlot.appendChild(box); setStatusText('Waiting for approval…');
    }
    else if(ev.t==='turn_end'){
      closeText(); closeThink();
      // 완료 요약 줄 — Worked for Xs · N tokens (#3) / 인터럽트 시 Interrupted
      if(work&&cur){ var s=Math.max(1,Math.round((Date.now()-work.t0)/1000)); var tok=work.out;
        var w=el('div','worked'); w.textContent=(interruptRequested?'■ Interrupted after '+fmtDur(s):'* Worked for '+fmtDur(s))+(tok?(' · '+fmt(tok)+' tokens'):''); cur.turn.appendChild(w); }
      if(cur&&cur.fullRaw&&cur.fullRaw.trim()) addTurnCopyBtn(cur.turn, cur.fullRaw);
      interruptRequested=false; stopWork(); setBusy(false); input.focus(); bottom(); drainQueue();
    }
    else if(ev.t==='error'){ if(!cur) newAssistantTurn(); closeText();
      if(interruptRequested){ var w=el('div','worked'); w.textContent='■ Interrupted'; cur.turn.appendChild(w); }
      else { var b=itemRow('text'); b.appendChild(el('div','err','⚠ '+ev.message)); }
      interruptRequested=false; stopWork(); setBusy(false); bottom(); drainQueue(); }
  });
</script>
</body></html>`;
  }
}

// ── 트랜스크립트 복원 파서 (display 전용 — IR 리더와 분리). 텍스트/도구를 '나온 순서대로' items에 담아 원래 흐름 보존. ──
type RestoreItem = { type: 'text'; text: string } | { type: 'tool'; name: string; arg: string };
type RestoreTurn = { user: string; items: RestoreItem[] };

// 도구 입력 → 한 줄 요약(command/file_path/pattern…). codex는 arguments가 JSON 문자열.
function toolArgSummary(input: unknown): string {
  let o: unknown = input;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { return (o as string).slice(0, 160); } }
  if (!o || typeof o !== 'object') return '';
  const r = o as Record<string, unknown>;
  const v = r.command ?? r.cmd ?? r.file_path ?? r.path ?? r.pattern ?? r.url ?? r.description;
  if (v == null) return '';
  return (Array.isArray(v) ? v.join(' ') : String(v)).slice(0, 200);
}
// 연속 텍스트는 합치고, 도구가 끼면 새 항목 — 그래서 텍스트-도구-텍스트 흐름이 그대로 남는다.
// 복원 시 유저 버블에 혹 끼어든 AgentBridge 주입 래퍼 블록을 제거(화면 오염 방지). 태그는 출력 필터 회피용 조각 결합.
const _AGB_TAG = 'agentbridge' + '-context';
function stripInjected(text: string): string {
  const open = '<' + _AGB_TAG + '>';
  const close = '</' + _AGB_TAG + '>';
  let s = text.indexOf(open);
  while (s >= 0) {
    const e = text.indexOf(close, s);
    if (e < 0) { text = text.slice(0, s); break; }
    text = text.slice(0, s) + text.slice(e + close.length);
    s = text.indexOf(open);
  }
  return text.trim();
}

function pushText(items: RestoreItem[], text: string, sep: string): void {
  const last = items[items.length - 1];
  if (last && last.type === 'text') last.text += sep + text;
  else items.push({ type: 'text', text });
}

// claude: type 'user'(content=string) / type 'assistant'(content 배열: text·tool_use를 순서대로). thinking 제외. tool_result(content=배열 user)는 skip.
function parseClaudeTranscript(records: Array<Record<string, unknown>>): RestoreTurn[] {
  const turns: RestoreTurn[] = [];
  let cur: RestoreTurn | null = null;
  for (const r of records) {
    const msg = r.message as { role?: string; content?: unknown } | undefined;
    if (r.type === 'user' && typeof msg?.content === 'string') {
      const ut = stripInjected(msg.content);
      if (ut.trim()) { if (cur) turns.push(cur); cur = { user: ut, items: [] }; }
    } else if (r.type === 'assistant' && Array.isArray(msg?.content)) {
      if (!cur) cur = { user: '', items: [] };
      for (const b of msg.content as Array<{ type?: string; text?: string; name?: string; input?: unknown }>) {
        if (b.type === 'text' && b.text) pushText(cur.items, b.text, '');
        else if (b.type === 'tool_use' && b.name) cur.items.push({ type: 'tool', name: b.name, arg: toolArgSummary(b.input) });
      }
    }
  }
  if (cur) turns.push(cur);
  return turns;
}

// codex rollout: event_msg(user_message/agent_message)=대화, response_item/function_call=도구 — 모두 나온 순서대로 items에.
function parseCodexTranscript(records: Array<Record<string, unknown>>): RestoreTurn[] {
  const turns: RestoreTurn[] = [];
  let cur: RestoreTurn | null = null;
  for (const r of records) {
    const p = r.payload as { type?: string; message?: unknown; name?: string; arguments?: unknown } | undefined;
    if (r.type === 'event_msg' && p?.type === 'user_message' && typeof p.message === 'string') {
      const ut = stripInjected(p.message);
      if (ut.trim()) { if (cur) turns.push(cur); cur = { user: ut, items: [] }; }
    } else if (r.type === 'event_msg' && p?.type === 'agent_message' && typeof p.message === 'string') {
      if (!cur) cur = { user: '', items: [] };
      if (p.message.trim()) pushText(cur.items, p.message, '\n\n');
    } else if (r.type === 'response_item' && p?.type === 'function_call' && p.name) {
      if (!cur) cur = { user: '', items: [] };
      cur.items.push({ type: 'tool', name: p.name, arg: toolArgSummary(p.arguments) });
    }
  }
  if (cur) turns.push(cur);
  return turns;
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 24; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
