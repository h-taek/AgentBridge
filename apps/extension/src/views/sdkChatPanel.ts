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
import type { AgentAdapter, ChatEvent, Session, IR, CliKind } from '@agentbridge/core';
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
      this.post({ type: 'event', ev: { t: 'error', message: `어댑터를 못 찾음: ${adapterPath} (core build 필요)` } });
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
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      output.warn(`SdkChatPanel: 세션 시작 실패 — ${m}`);
      this.post({ type: 'event', ev: { t: 'error', message: `세션 시작 실패: ${m}` } });
    }
  }

  private async onMessage(msg: { type: string; text?: string; id?: string; approve?: boolean }): Promise<void> {
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
    }
  }

  private post(msg: { type: 'ready'; sessionId: string; model?: string; injected?: boolean } | { type: 'event'; ev: ChatEvent }): void {
    void this.panel.webview.postMessage(msg);
  }

  private html(_webview: vscode.Webview): string {
    const nonce = makeNonce();
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return `<!doctype html><html lang="ko"><head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  * { box-sizing: border-box; }
  body { margin:0; height:100vh; display:flex; flex-direction:column;
    font:13px/1.55 var(--vscode-font-family); color:var(--vscode-editor-foreground); background:var(--vscode-editor-background); }
  header { display:flex; gap:6px; align-items:center; padding:8px 12px; border-bottom:1px solid var(--vscode-panel-border); }
  header .title { font-weight:600; }
  header .chip { font-size:11px; opacity:.7; border:1px solid var(--vscode-panel-border); border-radius:9px; padding:0 7px; }
  header .spacer { flex:1; }
  #log { flex:1; overflow-y:auto; padding:14px 12px; display:flex; flex-direction:column; gap:12px; }
  .turn { display:flex; flex-direction:column; gap:3px; }
  .role { font-size:11px; opacity:.6; }
  .bubble { padding:8px 11px; border:1px solid var(--vscode-panel-border); border-radius:7px; white-space:pre-wrap; }
  .user .bubble { background:var(--vscode-textBlockQuote-background); align-self:flex-start; }
  .thinking { font-size:12px; opacity:.65; border-left:2px solid var(--vscode-panel-border); padding:2px 0 2px 8px; white-space:pre-wrap; }
  .tool { font-size:12px; font-family:var(--vscode-editor-font-family),monospace; color:var(--vscode-textLink-foreground);
    background:var(--vscode-textCodeBlock-background); border-radius:5px; padding:3px 7px; }
  .approval { border:1px solid var(--vscode-inputValidation-warningBorder,#cc9); background:var(--vscode-inputValidation-warningBackground,rgba(200,180,0,.08)); border-radius:7px; padding:8px 10px; }
  .approval-title { font-weight:600; font-size:12px; }
  .approval-detail { font-size:11px; opacity:.75; font-family:var(--vscode-editor-font-family),monospace; white-space:pre-wrap; margin:4px 0; max-height:120px; overflow:auto; }
  .approval-actions { display:flex; gap:6px; margin-top:4px; }
  .approval-actions button { font:inherit; padding:4px 12px; border-radius:6px; border:1px solid transparent; cursor:pointer; }
  .ap-yes { background:var(--vscode-button-background); color:var(--vscode-button-foreground); }
  .ap-no { background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); }
  .caret { display:inline-block; width:6px; height:14px; background:var(--vscode-editor-foreground); margin-left:1px; vertical-align:-2px; animation:blink 1s steps(2) infinite; }
  @keyframes blink { 50% { opacity:0; } }
  footer { border-top:1px solid var(--vscode-panel-border); padding:8px 10px; display:flex; gap:6px; align-items:flex-end; }
  #input { flex:1; resize:none; height:36px; font:inherit; padding:7px 9px; border-radius:7px;
    color:var(--vscode-input-foreground); background:var(--vscode-input-background); border:1px solid var(--vscode-input-border,transparent); }
  button { font:inherit; padding:7px 12px; border-radius:7px; cursor:pointer; border:1px solid var(--vscode-button-border,transparent);
    color:var(--vscode-button-foreground); background:var(--vscode-button-background); }
  button:disabled { opacity:.5; cursor:default; }
  #stop { color:var(--vscode-button-secondaryForeground); background:var(--vscode-button-secondaryBackground); }
</style></head>
<body>
  <header>
    <span class="title">AgentBridge</span>
    <span class="chip" id="model">claude</span>
    <span class="chip" id="sid">session …</span>
    <span class="chip" id="ctx"></span>
    <span class="spacer"></span>
    <span class="chip">SDK · 실험</span>
  </header>
  <div id="log"></div>
  <footer>
    <textarea id="input" placeholder="메시지 입력 · Enter 전송" disabled></textarea>
    <button id="stop" disabled>중단</button>
    <button id="send" disabled>전송</button>
  </footer>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const stopBtn = document.getElementById('stop');
  let cur = null, busy = false;

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function bottom() { log.scrollTop = log.scrollHeight; }
  function addTurn(role, label) { const t = el('div', 'turn ' + role); t.appendChild(el('div', 'role', label)); log.appendChild(t); bottom(); return t; }
  function startAssistant() {
    const t = addTurn('assistant', 'claude');
    const bubble = el('div', 'bubble'), textSpan = el('span', null, ''), caret = el('span', 'caret');
    bubble.appendChild(textSpan); bubble.appendChild(caret); t.appendChild(bubble);
    cur = { turn: t, bubble: bubble, textSpan: textSpan, caret: caret, thinking: null, deltas: 0 }; bottom();
  }
  function setBusy(b) { busy = b; input.disabled = b; sendBtn.disabled = b; stopBtn.disabled = !b; }
  function endTurn() { if (cur && cur.caret) cur.caret.remove(); cur = null; setBusy(false); input.focus(); }
  function sendMsg() {
    const text = input.value.trim(); if (!text || busy) return;
    addTurn('user', '나').appendChild(el('div', 'bubble', text));
    input.value = ''; setBusy(true); startAssistant();
    vscode.postMessage({ type: 'send', text: text });
  }

  sendBtn.addEventListener('click', sendMsg);
  stopBtn.addEventListener('click', function () { vscode.postMessage({ type: 'interrupt' }); });
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); } });

  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (msg.type === 'ready') {
      document.getElementById('sid').textContent = 'session ' + String(msg.sessionId || '').slice(0, 8);
      if (msg.model) document.getElementById('model').textContent = msg.model;
      if (msg.injected) document.getElementById('ctx').textContent = '📎 맥락 주입됨';
      setBusy(false); input.focus(); return;
    }
    if (msg.type !== 'event') return;
    const ev = msg.ev;
    if (ev.t === 'session') {
      document.getElementById('sid').textContent = 'session ' + String(ev.sessionId || '').slice(0, 8);
      if (ev.model) document.getElementById('model').textContent = ev.model;
    } else if (ev.t === 'text' && ev.final === false) {
      if (!cur) startAssistant(); cur.textSpan.textContent += ev.text; cur.deltas++; bottom();
    } else if (ev.t === 'text' && ev.final === true) {
      if (cur && cur.deltas === 0) { cur.textSpan.textContent += ev.text; bottom(); }
    } else if (ev.t === 'thinking') {
      if (cur) { if (!cur.thinking) { cur.thinking = el('div', 'thinking', ''); cur.turn.insertBefore(cur.thinking, cur.bubble); } cur.thinking.textContent += ev.text; bottom(); }
    } else if (ev.t === 'tool') {
      if (cur) { cur.turn.insertBefore(el('div', 'tool', ev.name + '  ' + JSON.stringify(ev.input).slice(0, 80)), cur.bubble); bottom(); }
    } else if (ev.t === 'approval') {
      const box = el('div', 'approval');
      box.appendChild(el('div', 'approval-title', '🔐 ' + ev.title));
      if (ev.detail) box.appendChild(el('div', 'approval-detail', ev.detail));
      const row = el('div', 'approval-actions');
      const yes = el('button', 'ap-yes', '승인'); const no = el('button', 'ap-no', '거부');
      yes.addEventListener('click', function () { vscode.postMessage({ type: 'respondApproval', id: ev.id, approve: true }); box.remove(); });
      no.addEventListener('click', function () { vscode.postMessage({ type: 'respondApproval', id: ev.id, approve: false }); box.remove(); });
      row.appendChild(yes); row.appendChild(no); box.appendChild(row);
      (cur ? cur.turn : log).appendChild(box); bottom();
    } else if (ev.t === 'turn_end') {
      endTurn();
    } else if (ev.t === 'error') {
      if (!cur) startAssistant(); cur.textSpan.textContent += '\\n[오류] ' + ev.message; endTurn();
    }
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
