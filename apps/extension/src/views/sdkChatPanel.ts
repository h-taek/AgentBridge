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
import type { AgentAdapter, ChatEvent, Session, IR, CliKind, PermissionMode, ModelOption } from '@agentbridge/core';
// 번들 코어(SDK-free)에서 — 이중로드 규칙: 저장/IR/스케줄러는 번들본 한 사본을 SSOT로.
// codexAdapter도 SDK-free라 여기 정적 import(번들). claudeAdapter만 ESM SDK라 런타임 동적 import.
import { readIR, SdkCapture, codexAdapter } from '@agentbridge/core';
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

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly extensionUri: vscode.Uri) {}

  static create(extensionUri: vscode.Uri, cwd: string, workspaceId: string, model: CliKind): SdkChatPanel {
    const panel = vscode.window.createWebviewPanel(
      'agentbridge.sdkChat',
      `AgentBridge · SDK 채팅 (${model})`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    const inst = new SdkChatPanel(panel, extensionUri);
    void inst.init(cwd, workspaceId, model);
    return inst;
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
    this.panel.webview.html = this.html(model);
    this.panel.webview.onDidReceiveMessage((msg) => void this.onMessage(msg));
    this.panel.onDidDispose(() => {
      this.disposed = true;
      void this.session?.end().catch(() => { /* already gone */ });
    });

    try {
      // 3단계 — 캡처/IR 배선 (모두 번들 코어 = SSOT).
      const workspaceRoot = getWorkspaceStore().getWorkspacePath(workspaceId);
      const ir = await readIR(workspaceRoot);
      const context = formatIRContext(ir); // 이전 IR → systemPrompt/developerInstructions로 주입
      const capture = new SdkCapture({
        workspaceId,
        workspaceRoot,
        workspacePath: cwd,
        model,
        scheduler: getCompactionScheduler(), // 기존 PTY 경로와 같은 스케줄러 인스턴스
      });

      const adapter = await this.loadAdapter(model);
      if (!adapter) return; // 에러는 loadAdapter가 이미 post
      this.session = await adapter.start({
        cwd,
        workspaceId,
        detail: 'compact',
        context,
        // onTurn: 어댑터가 만든 plain TurnRecord를 경계 넘겨 번들 코어 캡처로 영속(turns→압축→IR).
        onTurn: (turn) => capture.accept(turn),
      });
      this.post({ type: 'ready', sessionId: this.session.sessionId, model, injected: Boolean(context) });
      // 6-3: 에이전트 내부 모델 목록을 받아 패널 모델 칩 메뉴를 채운다(실패해도 채팅엔 영향 없음).
      const models = await this.session.listModels().catch(() => [] as ModelOption[]);
      if (models.length) this.post({ type: 'models', list: models });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      output.warn(`SdkChatPanel: session start failed — ${m}`);
      this.post({ type: 'event', ev: { t: 'error', message: `Session start failed: ${m}` } });
    }
  }

  private async onMessage(msg: { type: string; text?: string; id?: string; approve?: boolean; mode?: PermissionMode; level?: string }): Promise<void> {
    if (msg.type === 'send') {
      if (!this.session) return;
      try {
        for await (const ev of this.session.send(String(msg.text ?? ''))) {
          if (this.disposed) break;
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
    }
  }

  // 첨부 이미지(6-5): 호스트 파일 다이얼로그로 이미지 선택 → 프로젝트 .agentbridge/attachments/<sid>/ 아래로 복사하고
  // cwd-상대경로 + 썸네일용 dataUrl을 회신(에이전트 샌드박스가 프로젝트 내부만 읽으므로). attachmentStore는 기존 PTY와 동형.
  private async handlePickImage(): Promise<void> {
    const picks = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: 'Attach',
      filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] },
    });
    if (!picks?.length) return;
    const { attachmentPathFor, writeAttachment } = await import('../core/attachmentStore');
    for (const uri of picks) {
      try {
        const base64 = (await fs.promises.readFile(uri.fsPath)).toString('base64');
        const name = path.basename(uri.fsPath);
        const safeName = name.replace(/[\\/]/g, '_').slice(-150);
        const filename = `${Date.now()}-${safeName}`;
        const sid = this.session?.sessionId || 'no-session';
        const absPath = attachmentPathFor(this.workspaceId || 'no-workspace', sid, filename);
        await writeAttachment(absPath, base64);
        const rel = path.relative(this.cwd, absPath);
        const insertPath = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : absPath;
        const ext = (name.split('.').pop() || 'png').toLowerCase();
        const mime = ext === 'jpg' ? 'jpeg' : ext === 'svg' ? 'svg+xml' : ext;
        output.log(`SdkChatPanel: attachment 저장 ${absPath} → "${insertPath}"`);
        this.post({ type: 'attachAdded', name: safeName, path: insertPath, dataUrl: `data:image/${mime};base64,${base64}` });
      } catch (err) {
        output.warn(`SdkChatPanel: attachment 저장 실패 — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private post(msg: { type: 'ready'; sessionId: string; model?: string; injected?: boolean } | { type: 'event'; ev: ChatEvent } | { type: 'models'; list: ModelOption[] } | { type: 'attachAdded'; name: string; path: string; dataUrl: string }): void {
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

  #log{flex:1;overflow-y:auto;padding:18px 16px;display:flex;flex-direction:column;gap:16px}
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
  #input{display:block;width:100%;background:none;border:none;color:var(--vscode-input-foreground);font:inherit;resize:none;outline:none;min-height:44px;max-height:200px;line-height:1.5;overflow-y:auto}
  #input::placeholder{color:var(--vscode-input-placeholderForeground)}
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
  .effort{padding:3px 10px 7px}
  .elbl{font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:6px;text-transform:capitalize}
  /* 알약 트랙 + accent 채움(--fill) + 흰색 손잡이, 포커스 노란테 제거 */
  /* 알약 트랙 + 정지점 점 + 흰 손잡이. 트랙(채움+점)은 .ertrack, range는 손잡이/조작만(투명 트랙) */
  .erwrap{position:relative;height:16px}
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
</style></head>
<body data-model="${model}" data-perm="default">
  <header>
    <span class="title">AgentBridge</span>
    <span class="badge" id="badge">${model}</span>
    <span class="sp"></span>
    <button class="hbtn" id="histBtn" title="History"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></button>
    <button class="hbtn" id="newBtn" title="New session"><svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button>
  </header>
  <div id="log"></div>
  <footer>
    <div class="dock">
      <div id="approvalSlot"></div>
      <div class="inbox">
        <div class="chips" id="chips"></div>
        <textarea id="input" rows="1" placeholder="Message…  (Enter to send · Shift+Enter newline)" disabled></textarea>
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
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const approvalSlot = document.getElementById('approvalSlot');
  const permPill = document.getElementById('permPill');
  const STATUS = { thinking:'Thinking…', working:'Working…', responding:'Responding…' };
  let cur = null, work = null, busy = false;

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
    if(efforts.length){
      modelMenu.appendChild(el('div','msep'));
      buildEffortIdx(efforts);
      var er=el('div','effort');
      var lbl=el('div','elbl','Effort · '+effortLabel(efforts[effortIdx]));
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
    var r=modelPill.getBoundingClientRect();
    modelMenu.style.left=r.left+'px';
    modelMenu.style.bottom=(window.innerHeight-r.top+6)+'px';
    modelMenu.style.display='block';
  }
  modelPill.addEventListener('click', function(ev){ ev.stopPropagation(); if(modelMenu.style.display==='block') closeModelMenu(); else openModelMenu(); });

  // 슬래시 명령(6-4) — claude init의 slash_commands를 / 버튼 팝업으로. 선택 시 입력창에 "/cmd " 삽입.
  const slashBtn = document.getElementById('slashBtn');
  const slashMenu = document.getElementById('slashMenu');
  var SLASH=[];
  function closeSlashMenu(){ slashMenu.style.display='none'; }
  function openSlashMenu(){
    slashMenu.innerHTML='';
    if(!SLASH.length){
      var hint=el('div','mitem','Send a message first to load commands'); hint.style.opacity='.6'; hint.style.cursor='default';
      slashMenu.appendChild(hint);
    } else SLASH.forEach(function(c){
      var it=el('div','mitem','/'+c);
      it.addEventListener('click', function(ev){ ev.stopPropagation(); input.value='/'+c+' '; grow(); input.focus(); closeSlashMenu(); });
      slashMenu.appendChild(it);
    });
    var r=slashBtn.getBoundingClientRect();
    slashMenu.style.left=r.left+'px';
    slashMenu.style.bottom=(window.innerHeight-r.top+6)+'px';
    slashMenu.style.display='block';
  }
  slashBtn.addEventListener('click', function(ev){ ev.stopPropagation(); if(slashMenu.style.display==='block') closeSlashMenu(); else openSlashMenu(); });
  document.addEventListener('click', function(){ closeModelMenu(); closeSlashMenu(); });

  // 이미지 첨부(6-5) — + 버튼 → 호스트 파일 다이얼로그 → 프로젝트로 복사 → 경로+썸네일(dataUrl) 회신 → 전송 시 경로 주입.
  const attachBtn = document.getElementById('attachBtn');
  const chips = document.getElementById('chips');
  var PENDING=[];
  attachBtn.addEventListener('click', function(){ vscode.postMessage({type:'pickImage'}); });
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
    input.value=''; input.style.height='auto'; PENDING=[]; renderChips();
    setBusy(true); newAssistantTurn(); startWork(); bottom();
    vscode.postMessage({type:'send',text:sent});
  }
  sendBtn.addEventListener('click', function(){ busy? vscode.postMessage({type:'interrupt'}) : sendMsg(); });
  input.addEventListener('keydown', function(e){ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); sendMsg(); } else if(e.key==='Tab'&&e.shiftKey){ e.preventDefault(); cyclePerm(); } });
  input.addEventListener('input', grow);
  document.getElementById('newBtn').addEventListener('click', function(){ vscode.postMessage({type:'newSession'}); });
  document.getElementById('histBtn').addEventListener('click', function(){ vscode.postMessage({type:'history'}); });

  window.addEventListener('message', function(event){
    var msg=event.data;
    if(msg.type==='ready'){
      if(msg.model){ document.body.dataset.model=msg.model; document.getElementById('badge').textContent=msg.model; initPerm(msg.model); }
      setBusy(false); input.focus(); return;
    }
    if(msg.type==='models'){ MODELS=msg.list||[]; var curM=MODELS.filter(function(m){return m.current;})[0]; if(curM && modelPill.textContent==='Model') modelPill.textContent=curM.label; return; }
    if(msg.type==='attachAdded'){ PENDING.push({name:msg.name,path:msg.path,dataUrl:msg.dataUrl}); renderChips(); return; }
    if(msg.type!=='event') return;
    var ev=msg.ev;
    if(ev.t==='session'){ if(ev.model){ modelPill.textContent=cleanModel(ev.model); } }
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

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 24; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
