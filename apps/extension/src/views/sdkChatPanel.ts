// SDK 채팅 패널 (rearch/sdk-gui 2단계 — UI seam 검증용, 실험).
// 기존 PTY ChatPanel은 그대로 두고 별도 명령(agentbridge.sdkChat)으로만 뜨는 독립 패널.
//
// ESM 전용 claude SDK를 어떻게 호스트(CJS)에 싣나:
//   esbuild가 코어를 CJS로 번들에 인라인하므로, SDK를 직접 import하면 require(ESM)로 터진다.
//   → SDK를 만지는 claudeAdapter만 "런타임 파일경로 동적 import"로 in-process 로드(변수 specifier라
//     번들러가 require로 못 바꾼다). 공식 클로드 익스텐션도 같은 CJS+동적 import 방식.
//   캡처/저장은 이 경계 밖(번들 코어 한 사본)에서 하므로 모듈 이중 로드의 상태 충돌은 없다(3단계).
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { pathToFileURL } from 'url';
import type { AgentAdapter, ChatEvent, Session, IR, CliKind, PermissionMode, ModelOption, AccountUsage, McpServerInfo, AgentInfo } from '@agentbridge/core';
// 번들 코어(SDK-free)에서 — 이중로드 규칙: 저장/IR/스케줄러는 번들본 한 사본을 SSOT로.
// codexAdapter도 SDK-free라 여기 정적 import(번들). claudeAdapter만 ESM SDK라 런타임 동적 import.
import { readIR, SdkCapture, codexAdapter, resolveTranscriptPath } from '@agentbridge/core';
import { getCompactionScheduler, getWorkspaceStore } from '../core/coreInstances';
import * as output from '../log/output';

type AdapterModule = { claudeAdapter: AgentAdapter };

// 이전 세션 IR을 어댑터 context(→systemPrompt append)로 주입할 텍스트로 렌더. compaction의 formatCurrentIR과 동형(JSON 블록).
function formatIRContext(ir: IR | null): string | undefined {
  if (!ir) return undefined;
  const body = {
    intent: ir.intent,
    decisions: ir.decisions,
    files: ir.files,
    commands: ir.commands,
    tests: ir.tests,
    pending: ir.pending,
  };
  return (
    '# 이전 세션 인계 (AgentBridge IR)\n\n다음은 이전 대화에서 압축된 작업 맥락이다. 이어서 돕는다.\n\n' +
    '```json\n' + JSON.stringify(body, null, 2) + '\n```'
  );
}

// dev(F5): <repo>/apps/extension → ../../packages/core/dist/sdkAdapter/claudeAdapter.js
function resolveAdapterPath(extensionPath: string): string {
  return path.join(extensionPath, '..', '..', 'packages', 'core', 'dist', 'sdkAdapter', 'claudeAdapter.js');
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
  private lastModelSession = ''; // 마지막으로 보고한 모델 세션 id(중복 영속 방지)

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly extensionUri: vscode.Uri) {}

  static create(
    extensionUri: vscode.Uri,
    cwd: string,
    workspaceId: string,
    model: CliKind,
    sessionId: string,
    opts?: { resume?: string; onModelSession?: (modelSessionId: string) => void; onDispose?: () => void },
  ): SdkChatPanel {
    const panel = vscode.window.createWebviewPanel(
      'agentbridge.sdkChat',
      `AgentBridge · ${model}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    const inst = new SdkChatPanel(panel, extensionUri);
    inst.sessionId = sessionId;
    inst.resumeId = opts?.resume;
    inst.onModelSessionCb = opts?.onModelSession;
    inst.onDisposeCb = opts?.onDispose;
    SdkChatPanel.activePanels.set(sessionId, inst);
    void inst.init(cwd, workspaceId, model);
    return inst;
  }

  reveal(): void { this.panel.reveal(); }
  markDeleted(): void { /* SDK 패널은 별도 삭제 전 처리 불필요(현재) */ }
  dispose(): void { this.panel.dispose(); }

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
      const msgs = this.model === 'codex' ? parseCodexTranscript(records) : parseClaudeTranscript(records);
      const turns = msgsToTurns(msgs);
      if (turns.length) this.post({ type: 'restore', turns });
    } catch (err) {
      output.warn(`SdkChatPanel: transcript 복원 실패 — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // claude=ESM SDK라 dist 동적 import / codex=SDK-free라 번들 정적. 못 찾으면 웹뷰 에러 + null.
  private async loadAdapter(model: CliKind): Promise<AgentAdapter | null> {
    if (model === 'codex') return codexAdapter;
    const adapterPath = resolveAdapterPath(this.extensionUri.fsPath);
    output.log(`SdkChatPanel: claude adapter 경로 = ${adapterPath}`);
    if (!fs.existsSync(adapterPath)) {
      this.post({ type: 'event', ev: { t: 'error', message: `Adapter not found: ${adapterPath} (build core first)` } });
      return null;
    }
    const mod = (await import(pathToFileURL(adapterPath).href)) as AdapterModule;
    return mod.claudeAdapter;
  }

  private async init(cwd: string, workspaceId: string, model: CliKind): Promise<void> {
    this.cwd = cwd;
    this.workspaceId = workspaceId;
    this.model = model;
    this.panel.webview.html = this.html(model);
    this.panel.webview.onDidReceiveMessage((msg) => void this.onMessage(msg));
    this.panel.onDidDispose(() => {
      this.disposed = true;
      SdkChatPanel.activePanels.delete(this.sessionId);
      void this.session?.end().catch(() => { /* already gone */ });
      this.onDisposeCb?.();
    });
    await this.startSession(true, this.resumeId);
  }

  // 세션 생성(최초 init + /clear·New 재시작에서 공용). injectContext=false면 이전 IR 주입 없이 클린 슬레이트(/clear).
  // resume=이전 modelSessionId면 그 세션을 이어간다(최초 open만; /clear는 resume 없이 새로).
  private async startSession(injectContext: boolean, resume?: string): Promise<void> {
    try {
      // 3단계 — 캡처/IR 배선 (모두 번들 코어 = SSOT).
      const workspaceRoot = getWorkspaceStore().getWorkspacePath(this.workspaceId);
      const ir = injectContext ? await readIR(workspaceRoot) : null;
      const context = formatIRContext(ir); // 이전 IR → systemPrompt/developerInstructions로 주입
      const capture = new SdkCapture({
        workspaceId: this.workspaceId,
        workspaceRoot,
        workspacePath: this.cwd,
        model: this.model,
        scheduler: getCompactionScheduler(), // 기존 PTY 경로와 같은 스케줄러 인스턴스
      });

      const adapter = await this.loadAdapter(this.model);
      if (!adapter) return; // 에러는 loadAdapter가 이미 post
      this.session = await adapter.start({
        cwd: this.cwd,
        workspaceId: this.workspaceId,
        detail: 'compact',
        context,
        ...(resume ? { resume } : {}),
        // onTurn: 어댑터가 만든 plain TurnRecord를 경계 넘겨 번들 코어 캡처로 영속(turns→압축→IR).
        onTurn: (turn) => capture.accept(turn),
      });
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

  private async onMessage(msg: { type: string; text?: string; id?: string; approve?: boolean; mode?: PermissionMode; level?: string; url?: string; on?: boolean; style?: string; name?: string; enabled?: boolean; query?: string; base64?: string }): Promise<void> {
    if (msg.type === 'send') {
      if (!this.session) return;
      try {
        for await (const ev of this.session.send(String(msg.text ?? ''))) {
          if (this.disposed) break;
          if (ev.t === 'session') this.reportModelSession(ev.sessionId); // claude 실제 session_id가 첫 턴에 도착 → 그때 영속
          this.post({ type: 'event', ev });
        }
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
    } else if (msg.type === 'login') {
      await this.handleLogin();
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
      // /clear·New(＋) — 현재 세션 종료 후 새 세션. 웹뷰는 'cleared'로 채팅 로그를 비운다.
      // 채팅 화면은 비우되 IR 핸드오프는 유지 주입(AgentBridge의 핵심 — 맥락 연속성).
      await this.session?.end().catch(() => { /* already gone */ });
      this.session = null;
      this.post({ type: 'cleared' });
      await this.startSession(true);
    }
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

  private post(msg: { type: 'ready'; sessionId: string; model?: string; injected?: boolean; loggedIn?: boolean } | { type: 'event'; ev: ChatEvent } | { type: 'models'; list: ModelOption[] } | { type: 'attachAdded'; name: string; path: string; dataUrl: string } | { type: 'loginStarted'; manualUrl: string } | { type: 'loginResult'; ok: boolean } | { type: 'usage'; data: AccountUsage | null } | { type: 'outputStyles'; data: { current: string; available: string[] } | null } | { type: 'mcp'; data: McpServerInfo[] } | { type: 'agents'; data: AgentInfo[] } | { type: 'compacted'; ok: boolean } | { type: 'mentionAdded'; path: string } | { type: 'slash'; list: string[] } | { type: 'files'; list: string[] } | { type: 'cleared' } | { type: 'restore'; turns: Array<{ user: string; assistant: string }> }): void {
    void this.panel.webview.postMessage(msg);
  }

  private html(model: CliKind): string {
    const permLabel = model === 'codex' ? 'Default permissions' : 'Ask before edits';
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
  header{display:flex;gap:7px;align-items:center;padding:1px 10px;border-bottom:1px solid var(--vscode-panel-border)}
  .title{font-weight:500;font-size:12px}
  .badge{background:var(--accent);color:#1b1b1d;border-radius:999px;padding:1px 5px;font-size:11px;font-weight:800;letter-spacing:.2px;text-transform:capitalize;line-height:1.35}
  .sp{flex:1}
  .hbtn{width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;border:none;background:none;color:var(--vscode-foreground);cursor:pointer;border-radius:7px}
  #newBtn{margin-left:-5px}
  .hbtn:hover{background:var(--vscode-toolbar-hoverBackground)}

  .logwrap{position:relative;flex:1;display:flex;flex-direction:column;min-height:0}
  #log{flex:1;overflow-y:auto;padding:18px 16px;display:flex;flex-direction:column;gap:16px}
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
  .wmanual{margin-top:6px;font-size:11px;color:var(--vscode-textLink-foreground);cursor:pointer;text-decoration:underline}
  .turn{display:flex;flex-direction:column;gap:8px}
  .turn.assistant{gap:20px}
  .turn.user{align-items:flex-end}
  .user .msg{background:var(--vscode-textBlockQuote-background);border-radius:12px;padding:9px 13px;max-width:80%;white-space:pre-wrap}
  .att{display:inline-flex;align-items:center;gap:5px;background:var(--vscode-textBlockQuote-background);border:1px solid var(--vscode-panel-border);border-radius:8px;padding:4px 8px;font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:5px}

  .item{display:flex;gap:9px;position:relative}
  /* 한 턴의 점들을 잇는 옅은 세로선 (다음 점 중심까지) */
  .item:not(:last-child)::before{content:'';position:absolute;left:3px;top:10px;bottom:-30px;width:1px;background:var(--vscode-panel-border)}
  .item:has(+ .working)::before,.item:has(+ .worked)::before{display:none}
  .dot{flex:none;width:7px;height:7px;border-radius:50%;margin-top:7px;position:relative;z-index:1}
  .dot.tool{background:var(--accent)} .dot.text{background:var(--vscode-descriptionForeground);opacity:.6}
  .body{flex:1;min-width:0}
  details.think>summary{cursor:pointer;list-style:none;color:var(--vscode-descriptionForeground);font-size:12px;opacity:.85}
  details.think>summary::-webkit-details-marker{display:none}
  details.think>summary::after{content:" ▸";font-size:9px} details.think[open]>summary::after{content:" ▾"}
  details.think .tx{margin-top:4px;color:var(--vscode-descriptionForeground);white-space:pre-wrap;border-left:1px solid var(--vscode-panel-border);padding-left:9px}
  /* 도구: 볼드 이름 + 설명, 그 아래 IN/OUT 박스 */
  .tname{font-size:13px;color:var(--vscode-descriptionForeground)}
  .tname strong{color:var(--vscode-foreground);font-weight:700;margin-right:7px}
  .tbox{margin-top:5px;border:1px solid var(--vscode-panel-border);border-radius:7px;overflow:hidden;font-family:var(--vscode-editor-font-family),monospace;font-size:11.5px;
    background:var(--vscode-textCodeBlock-background);
    background:color-mix(in srgb,var(--vscode-sideBar-background,var(--vscode-editor-background)) 60%,#000 40%)}
  .trow{display:flex;gap:10px;padding:6px 10px}
  .trow+.trow{border-top:1px solid rgba(127,127,127,.3)}
  .tlabel{flex:none;width:24px;color:var(--vscode-descriptionForeground);opacity:.5;font-size:10.5px;padding-top:2px}
  .tcontent{flex:1;min-width:0;color:var(--vscode-foreground);opacity:.92;white-space:pre-wrap;word-break:break-word;line-height:1.5;max-height:60px;overflow:auto}
  .md p{margin:0 0 .4em} .md p:last-child{margin:0} .md strong{font-weight:700}
  .md code{background:var(--vscode-textCodeBlock-background);padding:1px 5px;border-radius:4px;font-family:var(--vscode-editor-font-family),monospace;font-size:12px}
  .md pre{background:var(--vscode-textCodeBlock-background);border:1px solid var(--vscode-panel-border);border-radius:8px;padding:10px 12px;overflow-x:auto;margin:.4em 0}
  .md pre code{background:none;padding:0} .md ul{margin:.3em 0;padding-left:1.3em}
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
  .pill{font-size:12px;font-weight:700;color:var(--vscode-foreground);border:none;border-radius:7px;padding:3px 6px;cursor:pointer}
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
  #send.stop{background:var(--vscode-button-secondaryBackground,#6b6b6b);color:#fff}
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
  <header>
    <span class="title">AgentBridge</span>
    <span class="badge" id="badge">${model}</span>
    <span class="sp"></span>
    <button class="hbtn" id="histBtn" title="History"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></button>
    <button class="hbtn" id="newBtn" title="New session"><svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button>
  </header>
  <div class="logwrap">
    <div id="log"></div>
    <div id="welcome">
      <div class="wtop">
        <svg viewBox="0 0 409 386" width="16" height="15"><rect y="279" width="103" height="107" fill="#DD7A5A" fill-opacity="0.8"/><rect x="51" y="186" width="103" height="107" fill="#9471F5" fill-opacity="0.8"/><rect x="154" width="103" height="107" fill="currentColor"/><rect x="203" y="93" width="103" height="107" fill="currentColor"/><rect x="257" y="186" width="103" height="107" fill="currentColor"/><rect x="306" y="279" width="103" height="107" fill="currentColor"/><rect x="103" y="93" width="103" height="107" fill="#628EFE" fill-opacity="0.8"/></svg>
        <span class="abtext">AgentBridge</span>
      </div>
      <div class="wbox">
        <div class="wlogo" id="wlogo"></div>
        <div class="wbrand" id="wbrand">Claude</div>
        <div class="wcap" id="wcap"><span id="wcapco">Claude</span> running on AgentBridge</div>
        <div class="wlogin" id="wlogin" style="display:none">
          <button class="wlbtn" id="wlbtn">Log in to <span id="wlco">Claude</span></button>
          <span class="wsub">Opens your browser · token stored securely</span>
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
  const log = document.getElementById('log');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const approvalSlot = document.getElementById('approvalSlot');
  const permPill = document.getElementById('permPill');
  const STATUS = { thinking:'Thinking…', working:'Working…', responding:'Responding…' };
  let cur = null, work = null, busy = false;

  // 시작 화면(welcome) — 브랜드 풀네임 + 로고. 대화 전 표시, 첫 메시지/미로그인 분기.
  const welcome = document.getElementById('welcome');
  const BRAND = { claude:'Claude', codex:'Codex', agy:'Antigravity' };
  // 공식 브랜드 로고(사용자 제공 에셋). claude=단색(currentColor=accent) / codex,agy=자체 색 그대로.
  const W_LOGOS = {
    claude: '<svg viewBox="0 0 100 100" fill="currentColor"><path d="m19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6 1 3.3 2 1.9 2.7-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.3h-.8v.4l4.6 4.5 8.3 7.5L89 80.1l.5 2.4-1.3 2-1.4-.2-9.2-7-3.6-3-8-6.8h-.5v.7l1.8 2.7 9.8 14.7.5 4.5-.7 1.4-2.6 1-2.7-.6-5.8-8-6-9-4.7-8.2-.5.4-2.9 30.2-1.3 1.5-3 1.2-2.5-2-1.4-3 1.4-6.2 1.6-8 1.3-6.4 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z"/></svg>',
    codex:  '<svg viewBox="0 0 9 9" fill="none"><path d="M3.03191 0.172167C3.39319 0.023523 3.7865 -0.030181 4.17441 0.0161665C4.67441 0.0736665 5.11991 0.286167 5.51091 0.653667C5.51591 0.658667 5.52291 0.662167 5.52941 0.664167C5.53647 0.665904 5.54385 0.665904 5.55091 0.664167C6.05923 0.532896 6.59731 0.581475 7.07391 0.801667L7.09741 0.812666L7.15541 0.841167C7.65429 1.09402 8.04342 1.52067 8.24941 2.04067C8.35391 2.29567 8.40591 2.56117 8.40691 2.83817C8.41442 3.04417 8.39185 3.25017 8.33991 3.44967C8.33735 3.45974 8.33738 3.47029 8.34 3.48035C8.34263 3.4904 8.34775 3.49963 8.35491 3.50717C8.65191 3.81067 8.84891 4.17217 8.94641 4.59217C9.09091 5.30467 8.94291 5.94717 8.50291 6.51917L8.43491 6.60217C8.14349 6.93574 7.761 7.17695 7.33441 7.29617C7.32515 7.29888 7.31666 7.30373 7.30962 7.31033C7.30259 7.31694 7.2972 7.3251 7.29391 7.33417C7.19841 7.60967 7.10241 7.84567 6.92391 8.08117C6.47391 8.67467 5.81291 9.00417 5.06841 9.00017C4.47491 8.99717 3.94891 8.78017 3.48991 8.34917C3.483 8.3427 3.4745 8.33819 3.46528 8.33608C3.45606 8.33397 3.44644 8.33435 3.43741 8.33717C3.24341 8.39967 3.04741 8.40867 2.83541 8.40617C2.49774 8.40346 2.16514 8.32377 1.86291 8.17317C1.54632 8.01629 1.27069 7.78773 1.05791 7.50567C0.981908 7.40467 0.906408 7.30967 0.850908 7.19717C0.775141 7.04279 0.713231 6.88199 0.665908 6.71667C0.566008 6.34048 0.563599 5.94504 0.658908 5.56767C0.662042 5.55869 0.663069 5.54911 0.661908 5.53967C0.660196 5.53039 0.655446 5.52195 0.648408 5.51567C0.417442 5.28189 0.240911 5.00002 0.131408 4.69017C0.0585831 4.49931 0.0162322 4.29818 0.00590778 4.09417C-0.0122568 3.82546 0.0115281 3.55556 0.0764078 3.29417C0.244908 2.73817 0.567408 2.30167 1.04291 1.98517C1.14891 1.91467 1.24941 1.85967 1.34341 1.82017C1.45091 1.77567 1.55841 1.73817 1.66641 1.70667C1.67413 1.70427 1.68113 1.70001 1.6868 1.69425C1.69247 1.68849 1.69663 1.68142 1.69891 1.67367C1.78091 1.37919 1.92194 1.10446 2.11341 0.866166C2.35477 0.559671 2.67114 0.320634 3.03191 0.172167ZM4.77291 5.45467C4.69165 5.45922 4.61522 5.49471 4.55931 5.55385C4.5034 5.61299 4.47225 5.69128 4.47225 5.77267C4.47225 5.85405 4.5034 5.93235 4.55931 5.99148C4.61522 6.05062 4.69165 6.08611 4.77291 6.09067H6.59091C6.63417 6.09309 6.67747 6.08667 6.71816 6.07178C6.75885 6.0569 6.79608 6.03387 6.82756 6.0041C6.85905 5.97433 6.88413 5.93846 6.90127 5.89866C6.91841 5.85887 6.92725 5.81599 6.92725 5.77267C6.92725 5.72934 6.91841 5.68647 6.90127 5.64667C6.88413 5.60688 6.85905 5.571 6.82756 5.54123C6.79608 5.51146 6.75885 5.48843 6.71816 5.47355C6.67747 5.45866 6.63417 5.45224 6.59091 5.45467H4.77291ZM2.73091 3.11517C2.68764 3.04469 2.61865 2.99381 2.53854 2.97328C2.45844 2.95275 2.37348 2.96419 2.30165 3.00517C2.22982 3.04615 2.17675 3.11346 2.15366 3.19287C2.13056 3.27228 2.13926 3.35756 2.17791 3.43067L2.81391 4.54267L2.18091 5.61067C2.1596 5.64662 2.14558 5.68641 2.13966 5.72778C2.13373 5.76914 2.13601 5.81127 2.14636 5.85176C2.15671 5.89225 2.17494 5.9303 2.2 5.96374C2.22506 5.99718 2.25646 6.02536 2.29241 6.04667C2.32836 6.06797 2.36815 6.08199 2.40952 6.08792C2.45088 6.09385 2.49301 6.09157 2.5335 6.08121C2.57399 6.07086 2.61204 6.05263 2.64548 6.02758C2.67892 6.00252 2.7071 5.97112 2.72841 5.93517L3.45541 4.70767C3.48407 4.65931 3.4994 4.60422 3.49984 4.548C3.50028 4.49179 3.48581 4.43647 3.45791 4.38767L2.73091 3.11517Z" fill="url(#cdxg)"/><defs><linearGradient id="cdxg" x1="4.5" y1="0" x2="4.5" y2="9" gradientUnits="userSpaceOnUse"><stop stop-color="#B1A7FF"/><stop offset="0.5" stop-color="#7A9DFF"/><stop offset="1" stop-color="#3941FF"/></linearGradient></defs></svg>',
    agy:    '<svg viewBox="0 0 24 24"><mask height="23" id="agm" maskUnits="userSpaceOnUse" width="24" x="0" y="1"><path d="M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z" fill="#fff"/></mask><g mask="url(#agm)"><path d="M-1.018-3.992c-.408 3.591 2.686 6.89 6.91 7.37 4.225.48 7.98-2.043 8.387-5.633.408-3.59-2.686-6.89-6.91-7.37-4.225-.479-7.98 2.043-8.387 5.633z" fill="#FFE432"/><path d="M15.269 7.747c1.058 4.557 5.691 7.374 10.348 6.293 4.657-1.082 7.575-5.653 6.516-10.21-1.058-4.556-5.691-7.374-10.348-6.292-4.657 1.082-7.575 5.653-6.516 10.21z" fill="#FC413D"/><path d="M-12.443 10.804c1.338 4.703 7.36 7.11 13.453 5.378 6.092-1.733 9.947-6.95 8.61-11.652C8.282-.173 2.26-2.58-3.833-.848-9.925.884-13.78 6.1-12.443 10.804z" fill="#00B95C"/><path d="M9.932 27.617c1.04 4.482 5.384 7.303 9.7 6.3 4.316-1.002 6.971-5.448 5.93-9.93-1.04-4.483-5.384-7.304-9.7-6.301-4.316 1.002-6.971 5.448-5.93 9.93z" fill="#3186FF"/><path d="M2.572-8.185C.392-3.329 2.778 2.472 7.9 4.771c5.122 2.3 11.042.227 13.222-4.63 2.18-4.855-.205-10.656-5.327-12.955-5.122-2.3-11.042-.227-13.222 4.63z" fill="#FBBC04"/><path d="M18.163 9.077c5.81 3.93 12.502 4.19 14.946.577 2.443-3.612-.287-9.727-6.098-13.658-5.81-3.931-12.502-4.19-14.946-.577-2.443 3.612.287 9.727 6.098 13.658z" fill="#FC413D"/></g></svg>'
  };
  var welcomeModel='claude', loginManualUrl='';
  function paintWelcome(m){ welcomeModel=m||welcomeModel; var b=BRAND[welcomeModel]||welcomeModel;
    document.getElementById('wlogo').innerHTML=W_LOGOS[welcomeModel]||W_LOGOS.claude;
    document.getElementById('wbrand').textContent=b;
    document.getElementById('wcapco').textContent=b; document.getElementById('wlco').textContent=b; }
  function hideWelcome(){ welcome.classList.add('hide'); }
  function showLoginMode(on){ document.getElementById('wcap').style.display=on?'none':'';
    document.getElementById('wlogin').style.display=on?'flex':'none'; if(on) welcome.classList.remove('hide'); }
  // 미로그인이면 입력 자체를 막아 "보냈는데 안 사라짐"이 안 생기게. 로그인 성공 시 해제.
  function setLoggedOut(on){ input.disabled=on; sendBtn.disabled=on;
    input.placeholder = on ? 'Log in to start chatting…' : 'Message…  (Enter to send · Shift+Enter newline)'; }
  document.getElementById('wlbtn').addEventListener('click', function(){
    var btn=this; btn.disabled=true; btn.textContent='Waiting for browser…'; vscode.postMessage({type:'login'}); });
  document.getElementById('wmanual').addEventListener('click', function(){ if(loginManualUrl) vscode.postMessage({type:'openExternal',url:loginManualUrl}); });

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
  window.addEventListener('keydown', function(e){ if(e.key==='Escape' && (modelMenu.style.display==='block'||settingsMenu.style.display==='block'||acOpen())){ closeModelMenu(); closeSettingsMenu(); closeAc(); e.preventDefault(); } });

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
      var sk=SLASH.filter(function(c){return c.toLowerCase().indexOf(q)===0;}).map(function(c){return {name:c,app:false};});
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
  document.addEventListener('drop', function(e){ var files=(e.dataTransfer&&e.dataTransfer.files)||[]; var imgs=[];
    for(var i=0;i<files.length;i++){ if(files[i].type&&files[i].type.indexOf('image/')===0) imgs.push(files[i]); }
    if(imgs.length){ e.preventDefault(); imgs.forEach(sendImageFile); } });
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
    var blocks = src.split(/\\n{2,}/), out = [];
    for (var i=0;i<blocks.length;i++){
      var b = blocks[i];
      var fence = b.match(/^\\s*\`\`\`[^\\n]*\\n([\\s\\S]*?)\`\`\`\\s*$/);
      if (fence){ out.push('<pre><code>'+esc(fence[1])+'</code></pre>'); continue; }
      var lines = b.split('\\n');
      if (lines.every(function(l){return /^\\s*[-*]\\s+/.test(l)||l.trim()==='';})){
        var li = lines.filter(function(l){return l.trim();}).map(function(l){return '<li>'+inline(l.replace(/^\\s*[-*]\\s+/,''))+'</li>';});
        out.push('<ul>'+li.join('')+'</ul>'); continue;
      }
      out.push('<p>'+inline(esc(b)).replace(/\\n/g,'<br>')+'</p>');
    }
    return out.join('');
  }
  function inline(s){ return s.replace(/\`([^\`]+)\`/g,function(_,c){return '<code>'+esc(c)+'</code>';}).replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>'); }

  // 재개 시 이전 대화 복원 — 저장된 턴(user/assistant)을 말풍선으로 그리고 시작화면을 숨긴다.
  function renderRestore(turns){
    if(!turns||!turns.length) return;
    hideWelcome();
    turns.forEach(function(t){
      if(t.user&&t.user.trim()){ var ut=el('div','turn user'); ut.appendChild(el('div','msg',t.user)); log.appendChild(ut); }
      if(t.assistant&&t.assistant.trim()){ var at=el('div','turn assistant'); var it=el('div','item'); it.appendChild(el('span','dot text'));
        var bd=el('div','body md'); bd.innerHTML=md(t.assistant); it.appendChild(bd); at.appendChild(it); log.appendChild(at); }
    });
    bottom();
  }

  var SEND_SVG='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20V6M6 12l6-6 6 6"/></svg>';
  var STOP_SVG='<svg width="15" height="15" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3" fill="currentColor"/></svg>';
  function setBusy(b){ busy=b; input.disabled=b; sendBtn.disabled=false; sendBtn.classList.toggle('stop',b); sendBtn.innerHTML=b?STOP_SVG:SEND_SVG; }
  function newAssistantTurn(){ var t=el('div','turn assistant'); log.appendChild(t); cur={turn:t,textItem:null,raw:'',deltas:0,think:null}; bottom(); }
  function itemRow(dotCls){ var r=el('div','item'); r.appendChild(el('span','dot '+dotCls)); var b=el('div','body'); r.appendChild(b);
    // working 줄이 있으면 그 앞에 끼워 항상 맨 아래에 두기.
    var anchor=(work&&work.line&&work.line.parentNode===cur.turn)?work.line:null; cur.turn.insertBefore(r,anchor); return b; }
  function closeText(){ if(cur&&cur.textItem){ cur.textItem.innerHTML = md(cur.raw); } cur && (cur.textItem=null, cur.raw=''); }
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
  function tick(){ if(!work) return; var s=Math.floor((Date.now()-work.t0)/1000); work.mt.textContent='('+s+'s'+(work.out?(' · ↑ '+fmt(work.out)+' tokens'):'')+')'; }
  function setStatus(k){ if(work) work.st.textContent=STATUS[k]; }
  function fmt(n){ return n>=1000? (n/1000).toFixed(1).replace(/\\.0$/,'')+'k' : ''+n; }
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

  function sendMsg(){
    var text=input.value.trim(); if((!text&&!PENDING.length)||busy) return;
    var atts=PENDING.slice();
    // 첨부 경로를 메시지에 주입(샌드박스가 프로젝트 내부만 읽으므로 복사된 경로를 전달).
    var sent = atts.length ? (text? text+'\\n\\n':'') + atts.map(function(a){return a.path;}).join('\\n') : text;
    var t=el('div','turn user');
    atts.forEach(function(a){ var ac=el('span','att'); var im=thumb(a); if(im) ac.appendChild(im); else ac.appendChild(el('span',null,'🖼')); ac.appendChild(el('span',null,a.name)); t.appendChild(ac); });
    if(text) t.appendChild(el('div','msg',text));
    log.appendChild(t);
    hideWelcome(); // 첫 메시지 → 시작 화면 숨김
    input.value=''; input.style.height='auto'; renderHL(); closeAc(); PENDING=[]; renderChips();
    setBusy(true); newAssistantTurn(); startWork(); bottom();
    vscode.postMessage({type:'send',text:sent});
  }
  sendBtn.addEventListener('click', function(){ busy? vscode.postMessage({type:'interrupt'}) : sendMsg(); });
  input.addEventListener('keydown', function(e){
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
  document.getElementById('newBtn').addEventListener('click', function(){ vscode.postMessage({type:'newSession'}); });
  document.getElementById('histBtn').addEventListener('click', function(){ vscode.postMessage({type:'history'}); });

  window.addEventListener('message', function(event){
    var msg=event.data;
    if(msg.type==='ready'){
      if(msg.model){ document.body.dataset.model=msg.model; document.getElementById('badge').textContent=msg.model; initPerm(msg.model); paintWelcome(msg.model); }
      if(msg.loggedIn===false){ showLoginMode(true); setLoggedOut(true); }
      else { setBusy(false); input.focus(); }
      return;
    }
    if(msg.type==='models'){ MODELS=msg.list||[]; var curM=MODELS.filter(function(m){return m.current;})[0]; if(curM && modelPill.textContent==='Model') modelPill.textContent=curM.label; return; }
    if(msg.type==='attachAdded'){ PENDING.push({name:msg.name,path:msg.path,dataUrl:msg.dataUrl}); renderChips(); return; }
    if(msg.type==='loginStarted'){ loginManualUrl=msg.manualUrl||''; if(loginManualUrl) document.getElementById('wmanual').style.display='block'; return; }
    if(msg.type==='loginResult'){
      var btn=document.getElementById('wlbtn');
      if(msg.ok){ showLoginMode(false); setLoggedOut(false); setBusy(false); input.focus(); }
      else { btn.disabled=false; btn.textContent='Log in to '+(BRAND[welcomeModel]||welcomeModel); }
      return;
    }
    if(msg.type==='usage'){ renderUsage(msg.data); return; }
    if(msg.type==='outputStyles'){ renderOutputStyles(msg.data); return; }
    if(msg.type==='mcp'){ renderMcp(msg.data); return; }
    if(msg.type==='agents'){ renderAgents(msg.data); return; }
    if(msg.type==='slash'){ SLASH=msg.list||[]; return; }
    if(msg.type==='files'){ if(AC.mode==='file'){ AC.items=(msg.list||[]).map(function(p){return {name:p};}); AC.idx=0; renderAc(); } return; }
    if(msg.type==='cleared'){ stopWork(); cur=null; log.innerHTML=''; closeSettingsMenu(); closeAc(); input.value=''; renderHL(); welcome.classList.remove('hide'); return; }
    if(msg.type==='restore'){ renderRestore(msg.turns); return; }
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
      cur.textItem.innerHTML=md(cur.raw); cur.textItem.className='body md'; cur.textItem=null; cur.raw=''; cur.deltas=0; bottom();
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
        b.appendChild(box); cur.tools[ev.id]={box:box,hasOut:false}; setStatus('working'); bottom();
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
      acts.appendChild(no); acts.appendChild(yes); box.appendChild(info); box.appendChild(acts); approvalSlot.appendChild(box);
    }
    else if(ev.t==='turn_end'){
      closeText(); closeThink();
      // 완료 요약 줄 — Worked for Xs · N tokens (#3)
      if(work&&cur){ var s=Math.max(1,Math.round((Date.now()-work.t0)/1000)); var tok=work.out;
        var w=el('div','worked'); w.textContent='* Worked for '+s+'s'+(tok?(' · '+fmt(tok)+' tokens'):''); cur.turn.appendChild(w); }
      stopWork(); setBusy(false); input.focus(); bottom();
    }
    else if(ev.t==='error'){ if(!cur) newAssistantTurn(); closeText(); var b=itemRow('text'); b.appendChild(el('div','err','⚠ '+ev.message)); stopWork(); setBusy(false); bottom(); }
  });
</script>
</body></html>`;
  }
}

// ── 트랜스크립트 복원 파서 (display 전용 — IR 리더와 분리). 네이티브 JSONL의 user/assistant 텍스트만 추출. ──
type DisplayMsg = { role: 'user' | 'assistant'; text: string };

// claude(SDK/CLI 공통): type 'user'(content=string) / type 'assistant'(content=배열, text 블록만). thinking·tool_use는 제외.
function parseClaudeTranscript(records: Array<Record<string, unknown>>): DisplayMsg[] {
  const out: DisplayMsg[] = [];
  for (const r of records) {
    const msg = r.message as { role?: string; content?: unknown } | undefined;
    if (r.type === 'user' && typeof msg?.content === 'string') {
      if (msg.content.trim()) out.push({ role: 'user', text: msg.content });
    } else if (r.type === 'assistant' && Array.isArray(msg?.content)) {
      const text = (msg.content as Array<{ type?: string; text?: string }>)
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('');
      if (text.trim()) out.push({ role: 'assistant', text });
    }
  }
  return out;
}

// codex rollout: event_msg의 user_message/agent_message.message가 실제 대화 텍스트(깔끔).
//   response_item user엔 codex가 주입하는 AGENTS.md·환경 컨텍스트가 섞여 있어 event_msg를 쓴다.
function parseCodexTranscript(records: Array<Record<string, unknown>>): DisplayMsg[] {
  const out: DisplayMsg[] = [];
  for (const r of records) {
    if (r.type !== 'event_msg') continue;
    const p = r.payload as { type?: string; message?: unknown } | undefined;
    if (p?.type === 'user_message' && typeof p.message === 'string') {
      if (p.message.trim()) out.push({ role: 'user', text: p.message });
    } else if (p?.type === 'agent_message' && typeof p.message === 'string') {
      if (p.message.trim()) out.push({ role: 'assistant', text: p.message });
    }
  }
  return out;
}

// 평탄한 메시지 목록 → {user, assistant} 턴. 연속 중복(codex가 user를 두 번 기록)은 1회만.
function msgsToTurns(msgs: DisplayMsg[]): Array<{ user: string; assistant: string }> {
  const turns: Array<{ user: string; assistant: string }> = [];
  let cur: { user: string; assistant: string } | null = null;
  let prev = '';
  for (const m of msgs) {
    const key = m.role + ':' + m.text;
    if (key === prev) continue;
    prev = key;
    if (m.role === 'user') {
      if (cur) turns.push(cur);
      cur = { user: m.text, assistant: '' };
    } else {
      if (!cur) cur = { user: '', assistant: '' };
      cur.assistant += (cur.assistant ? '\n\n' : '') + m.text;
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
