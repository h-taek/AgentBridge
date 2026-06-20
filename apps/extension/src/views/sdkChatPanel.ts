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
    this.panel.webview.html = this.html(this.panel.webview);
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

  private async onMessage(msg: { type: string; text?: string; id?: string; approve?: boolean; mode?: PermissionMode }): Promise<void> {
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
    }
  }

  private post(msg: { type: 'ready'; sessionId: string; model?: string; injected?: boolean } | { type: 'event'; ev: ChatEvent } | { type: 'models'; list: ModelOption[] }): void {
    void this.panel.webview.postMessage(msg);
  }

  private html(_webview: vscode.Webview): string {
    const nonce = makeNonce();
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
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
  .turn.user{align-items:flex-end}
  .user .msg{background:var(--vscode-textBlockQuote-background);border-radius:12px;padding:9px 13px;max-width:80%;white-space:pre-wrap}
  .att{display:inline-flex;align-items:center;gap:5px;background:var(--vscode-textBlockQuote-background);border:1px solid var(--vscode-panel-border);border-radius:8px;padding:4px 8px;font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:5px}

  .item{display:flex;gap:9px}
  .dot{flex:none;width:7px;height:7px;border-radius:50%;margin-top:7px}
  .dot.tool{background:var(--accent)} .dot.text{background:var(--vscode-descriptionForeground);opacity:.6}
  .body{flex:1;min-width:0}
  details.think>summary{cursor:pointer;list-style:none;color:var(--vscode-descriptionForeground);font-size:12px;opacity:.85}
  details.think>summary::-webkit-details-marker{display:none}
  details.think>summary::after{content:" ▸";font-size:9px} details.think[open]>summary::after{content:" ▾"}
  details.think .tx{margin-top:4px;color:var(--vscode-descriptionForeground);white-space:pre-wrap;border-left:1px solid var(--vscode-panel-border);padding-left:9px}
  .tname{font-family:var(--vscode-editor-font-family),monospace;color:var(--vscode-descriptionForeground);font-size:12px}
  .tname .ok{color:var(--green);font-size:11px;margin-left:5px}
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

  .inbox{position:relative;z-index:2;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:14px;padding:4px 12px 8px}
  .inbox .chips{display:flex;gap:6px;margin-bottom:6px}
  #input{display:block;width:100%;background:none;border:none;color:var(--vscode-input-foreground);font:inherit;resize:none;outline:none;min-height:26px;max-height:160px;line-height:1.5;overflow-y:auto}
  #input::placeholder{color:var(--vscode-input-placeholderForeground)}
  .ctrls{display:flex;align-items:center;gap:9px;margin-top:7px}
  .ic{height:26px;min-width:24px;padding:0 2px;border-radius:7px;border:none;background:none;color:var(--vscode-foreground);cursor:pointer;font-size:17px;font-weight:700;line-height:1}
  .ic:hover{background:var(--vscode-toolbar-hoverBackground)}
  .pill{font-size:12px;font-weight:700;color:var(--vscode-foreground);border:none;border-radius:7px;padding:3px 6px;cursor:pointer}
  .pill:hover{background:var(--vscode-toolbar-hoverBackground)}
  .menu{position:fixed;display:none;z-index:10;background:var(--vscode-menu-background,var(--vscode-input-background));border:1px solid var(--vscode-menu-border,var(--vscode-input-border,var(--vscode-panel-border)));border-radius:8px;padding:4px;min-width:130px;box-shadow:0 6px 20px rgba(0,0,0,.4)}
  .mitem{padding:5px 10px;border-radius:5px;cursor:pointer;font-size:12px;color:var(--vscode-menu-foreground,var(--vscode-foreground));white-space:nowrap}
  .mitem:hover{background:var(--vscode-menu-selectionBackground,var(--vscode-toolbar-hoverBackground))}
  .mitem.cur{color:var(--accent);font-weight:700}
  #send{height:28px;min-width:32px;padding:0 8px;border-radius:8px;border:none;background:var(--accent);color:#1b1b1d;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
  #send.stop{background:var(--vscode-inputValidation-errorBorder,#d65b5b);color:#fff}
  .err{color:var(--vscode-errorForeground);font-size:12px;white-space:pre-wrap}
</style></head>
<body data-model="claude">
  <header>
    <span class="title">AgentBridge</span>
    <span class="badge" id="badge">claude</span>
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
          <span class="pill" id="permPill" title="Permission mode · Shift+Tab">default</span>
          <button id="send" title="Send" disabled><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20V6M6 12l6-6 6 6"/></svg></button>
        </div>
      </div>
    </div>
  </footer>
  <div id="modelMenu" class="menu"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const approvalSlot = document.getElementById('approvalSlot');
  const permPill = document.getElementById('permPill');
  const STATUS = { thinking:'Thinking…', working:'Working…', responding:'Responding…' };
  let cur = null, work = null, busy = false;

  // 권한 모드(6-2) — Shift+Tab / 칩 클릭으로 순환. 호스트가 claude=setPermissionMode / codex=approvalPolicy로 매핑.
  var PERM=['default','acceptEdits','plan'], PERM_LBL={'default':'default','acceptEdits':'accept edits','plan':'plan'}, permIdx=0;
  function cyclePerm(){ permIdx=(permIdx+1)%PERM.length; var m=PERM[permIdx]; permPill.textContent=PERM_LBL[m]; vscode.postMessage({type:'setPermissionMode',mode:m}); }
  permPill.addEventListener('click', cyclePerm);

  // 모델 선택(6-3) — 호스트가 listModels로 채운 목록을 칩 클릭 시 팝업으로. 선택 → setModel.
  const modelPill = document.getElementById('modelPill');
  const modelMenu = document.getElementById('modelMenu');
  var MODELS=[], userPickedModel=false;
  function closeModelMenu(){ modelMenu.style.display='none'; }
  function openModelMenu(){
    if(!MODELS.length) return;
    modelMenu.innerHTML='';
    MODELS.forEach(function(m){
      var it=el('div','mitem'+(m.current?' cur':''), m.label);
      it.addEventListener('click', function(ev){ ev.stopPropagation(); vscode.postMessage({type:'setModel',id:m.id}); modelPill.textContent=m.label; userPickedModel=true; MODELS.forEach(function(x){x.current=(x.id===m.id);}); closeModelMenu(); });
      modelMenu.appendChild(it);
    });
    var r=modelPill.getBoundingClientRect();
    modelMenu.style.left=r.left+'px';
    modelMenu.style.bottom=(window.innerHeight-r.top+6)+'px';
    modelMenu.style.display='block';
  }
  modelPill.addEventListener('click', function(ev){ ev.stopPropagation(); if(modelMenu.style.display==='block') closeModelMenu(); else openModelMenu(); });
  document.addEventListener('click', closeModelMenu);

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
  var STOP_SVG='<svg width="12" height="12" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor"/></svg>';
  function setBusy(b){ busy=b; input.disabled=b; sendBtn.disabled=false; sendBtn.classList.toggle('stop',b); sendBtn.innerHTML=b?STOP_SVG:SEND_SVG; }
  function newAssistantTurn(){ var t=el('div','turn assistant'); log.appendChild(t); cur={turn:t,textItem:null,raw:'',deltas:0,think:null}; bottom(); }
  function itemRow(dotCls){ var r=el('div','item'); r.appendChild(el('span','dot '+dotCls)); var b=el('div','body'); r.appendChild(b); cur.turn.appendChild(r); return b; }
  function closeText(){ if(cur&&cur.textItem){ cur.textItem.innerHTML = md(cur.raw); } cur && (cur.textItem=null, cur.raw=''); }

  function startWork(){
    if(work) return;
    var line=el('div','working'); var sp=el('span','tspin'); var st=el('span','shim',STATUS.working); var mt=el('span','wmeta','');
    line.appendChild(sp); line.appendChild(st); line.appendChild(mt); cur.turn.appendChild(line);
    work={line:line,st:st,mt:mt,t0:Date.now(),out:0,frame:0};
    work.spin=setInterval(function(){ var F=' .oO@* '; sp.textContent=F[work.frame%F.length]; work.frame++; tick(); },110);
    tick();
  }
  function tick(){ if(!work) return; var s=Math.floor((Date.now()-work.t0)/1000); work.mt.textContent='('+s+'s'+(work.out?(' · ↑ '+fmt(work.out)+' tokens'):'')+')'; }
  function setStatus(k){ if(work) work.st.textContent=STATUS[k]; }
  function fmt(n){ return n>=1000? (n/1000).toFixed(1).replace(/\\.0$/,'')+'k' : ''+n; }
  function stopWork(){ if(work){ clearInterval(work.spin); work.line.remove(); work=null; } }
  function cleanModel(m){ if(!m) return ''; var s=m.replace(/\\[.*?\\]/g,'').replace(/^(claude|codex)-/,''); var p=s.match(/^(opus|sonnet|haiku)-?(\\d+)-?(\\d+)?/i); return p? (p[1].charAt(0).toUpperCase()+p[1].slice(1)+' '+p[2]+(p[3]?'.'+p[3]:'')) : s; }
  function grow(){ input.style.height='auto'; input.style.height=Math.min(input.scrollHeight,160)+'px'; }

  function sendMsg(){
    var text=input.value.trim(); if(!text||busy) return;
    var t=el('div','turn user'); t.appendChild(el('div','msg',text)); log.appendChild(t);
    input.value=''; input.style.height='auto'; setBusy(true); newAssistantTurn(); startWork(); bottom();
    vscode.postMessage({type:'send',text:text});
  }
  sendBtn.addEventListener('click', function(){ busy? vscode.postMessage({type:'interrupt'}) : sendMsg(); });
  input.addEventListener('keydown', function(e){ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); sendMsg(); } else if(e.key==='Tab'&&e.shiftKey){ e.preventDefault(); cyclePerm(); } });
  input.addEventListener('input', grow);
  document.getElementById('newBtn').addEventListener('click', function(){ vscode.postMessage({type:'newSession'}); });
  document.getElementById('histBtn').addEventListener('click', function(){ vscode.postMessage({type:'history'}); });

  window.addEventListener('message', function(event){
    var msg=event.data;
    if(msg.type==='ready'){
      if(msg.model){ document.body.dataset.model=msg.model; document.getElementById('badge').textContent=msg.model; }
      setBusy(false); input.focus(); return;
    }
    if(msg.type==='models'){ MODELS=msg.list||[]; var cur=MODELS.filter(function(m){return m.current;})[0]; if(cur && modelPill.textContent==='Model') modelPill.textContent=cur.label; return; }
    if(msg.type!=='event') return;
    var ev=msg.ev;
    if(ev.t==='session'){ if(ev.model && !userPickedModel){ modelPill.textContent=cleanModel(ev.model); } }
    else if(ev.t==='text' && ev.final===false){
      if(!cur) newAssistantTurn();
      if(!cur.textItem){ cur.textItem=itemRow('text'); cur.raw=''; }
      cur.raw+=ev.text; cur.deltas++; cur.textItem.textContent=cur.raw; setStatus('responding'); bottom();
    }
    else if(ev.t==='text' && ev.final===true){
      if(!cur) newAssistantTurn();
      if(!cur.textItem){ cur.textItem=itemRow('text'); cur.raw=''; }
      if(cur.deltas===0) cur.raw=ev.text;
      cur.textItem.innerHTML=md(cur.raw); cur.textItem.className='body md'; cur.textItem=null; cur.raw=''; cur.deltas=0; bottom();
    }
    else if(ev.t==='thinking'){
      if(!cur) newAssistantTurn(); closeText();
      if(!cur.think){ var b=itemRow('text'); var d=el('details','think'); var sm=el('summary',null,'Thinking'); var tx=el('div','tx',''); d.appendChild(sm); d.appendChild(tx); b.appendChild(d); cur.think=tx; }
      cur.think.textContent+=ev.text; setStatus('thinking'); bottom();
    }
    else if(ev.t==='tool'){
      if(!cur) newAssistantTurn(); closeText(); cur.think=null;
      var b=itemRow('tool'); var nm=el('div','tname'); nm.textContent=ev.name+' '+(JSON.stringify(ev.input)||'').slice(0,70);
      if(ev.status==='done'){ var ok=el('span','ok','✓'); nm.appendChild(ok); }
      b.appendChild(nm); setStatus('working'); bottom();
    }
    else if(ev.t==='usage'){ if(work){ work.out=ev.outputTokens; tick(); } }
    else if(ev.t==='approval'){
      var box=el('div','approval'); var info=el('div'); info.appendChild(el('div','t','🔐 '+ev.title)); if(ev.detail) info.appendChild(el('div','d',ev.detail));
      var acts=el('div','aacts'); var no=el('button','an','Deny'); var yes=el('button','ay','Approve');
      no.addEventListener('click', function(){ vscode.postMessage({type:'respondApproval',id:ev.id,approve:false}); box.remove(); });
      yes.addEventListener('click', function(){ vscode.postMessage({type:'respondApproval',id:ev.id,approve:true}); box.remove(); });
      acts.appendChild(no); acts.appendChild(yes); box.appendChild(info); box.appendChild(acts); approvalSlot.appendChild(box);
    }
    else if(ev.t==='turn_end'){ closeText(); stopWork(); setBusy(false); input.focus(); }
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
