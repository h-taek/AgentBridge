import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import { startViewerServer, watchServedFiles, buildViewerPrompt } from '@agentbridge/core';
import type { ViewerServer, ViewerWatch, PickedElement } from '@agentbridge/core';
import { assetRootUri, assetRootPath } from '../core/assetRoot';
import { getActivePanel, getAllPanels } from './chatPanel';
import { getSessions } from '../core/sessionRegistry';
import * as workspaceStore from '../core/workspaceStore';
import { candidateSessions, docRelativePath, type ViewerSession } from './viewerSessions';
import { queueSend } from './viewerSend';

// HTML 뷰어 (0.7.0 spec 3.1·3.4). 에이전트가 만든 로컬 HTML을 앱 안에서 보고, 요소를 짚어
// 고른 세션에 되돌려준다.
//
// 웹뷰에 HTML을 직접 넣지 않는다. 127.0.0.1의 정적 서버가 서빙하고 웹뷰는 그것을 iframe으로
// 싣는다 — 그 페이지는 에이전트가 쓴 코드라 우리 출처 안에 들이지 않는다(spec 3.1).
//
// 기동이 두 단계인 이유는 웹뷰 출처를 알려주는 API가 없어서다. Webview에 origin이 없고
// cspSource는 `'self' https://*.<cdn>` 문자열이라 출처가 아니다. 그래서 기동 화면을 먼저 띄워
// 웹뷰에게 window.origin을 묻고, 받은 값으로 서버를 띄운 뒤 포트를 frame-src에 박아 HTML을
// 다시 만든다. 출처는 (뷰 타입, 익스텐션 id)로 정해져 다시 띄워도 같은 값이 온다.
//
// 사용자가 치는 글과 세션 이름은 iframe 안에 두지 않는다. 인라인 패널은 웹뷰가 그리고, 안쪽은
// 요소의 화면 좌표만 보낸다(spec 3.4).

// 웹뷰가 출처를 알려줄 때까지 기다리는 상한. 이보다 늦으면 서버를 띄우지 않는다 — 출처를
// 모르는 채로 띄우면 짚기 스크립트가 아무 메시지나 받게 된다.
const ORIGIN_TIMEOUT_MS = 5000;

type ViewerState = 'starting' | 'ready' | 'missing' | 'serverError' | 'noAgent';

interface FromWebview {
  t?: string;
  origin?: string;
  sessionId?: string;
  el?: PickedElement;
  note?: string;
  open?: boolean;
}

export class HtmlViewerProvider implements vscode.CustomReadonlyEditorProvider, vscode.Disposable {
  static readonly viewType = 'agentbridge.htmlViewer';

  private readonly live = new Set<Viewer>();
  private active: Viewer | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  // 커스텀 에디터는 문서 모델을 우리가 만든다. 뷰어는 읽기 전용이라 uri 말고 들 것이 없다.
  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: (): void => undefined };
  }

  async resolveCustomEditor(doc: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
    const viewer = new Viewer(doc.uri, panel, this.extensionUri);
    this.live.add(viewer);
    this.active = viewer;
    panel.onDidChangeViewState(() => {
      if (panel.active) this.active = viewer;
    });
    panel.onDidDispose(() => {
      this.live.delete(viewer);
      if (this.active === viewer) this.active = undefined;
      viewer.dispose();
    });
    await viewer.start();
  }

  // 소스로 돌아가는 명령이 쓴다. activeCustomEditorId는 어느 뷰 타입인지만 알려주고 무엇을
  // 열고 있는지는 안 알려준다.
  activeUri(): vscode.Uri | undefined {
    return this.active?.uri;
  }

  // 익스텐션이 내려갈 때 남은 서버를 전부 내린다. 탭 닫힘만 처리하면 창을 통째로 닫을 때
  // 포트가 남는다(spec 3.5).
  dispose(): void {
    for (const viewer of [...this.live]) viewer.dispose();
    this.live.clear();
  }
}

class Viewer {
  private server: ViewerServer | undefined;
  private watch: ViewerWatch | undefined;
  private disposed = false;
  private panelOpen = false;
  private pendingReload = false;
  private sessions: ViewerSession[] = [];

  constructor(
    readonly uri: vscode.Uri,
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
  ) {}

  async start(): Promise<void> {
    const webview = this.panel.webview;
    webview.options = { enableScripts: true, localResourceRoots: [assetRootUri(this.extensionUri)] };
    webview.onDidReceiveMessage((msg: FromWebview) => void this.onMessage(msg));

    // 1단계 — 기동 화면. iframe도 frame-src도 아직 없다.
    webview.html = buildViewerHtml();

    const origin = await this.awaitOrigin();
    if (this.disposed) return;
    if (!origin || origin === 'null') {
      this.setState('serverError', vscode.l10n.t('Could not read the webview origin.'));
      return;
    }

    const folder = vscode.workspace.getWorkspaceFolder(this.uri);
    if (!folder) {
      this.setState(
        'serverError',
        vscode.l10n.t('The viewer serves files inside the workspace folder only.'),
      );
      return;
    }

    try {
      this.server = await startViewerServer({
        root: folder.uri.fsPath,
        webviewOrigin: origin,
        pickerPath: path.join(assetRootPath(this.extensionUri.fsPath), 'out', 'viewerPicker.js'),
      });
    } catch (err) {
      this.setState('serverError', String(err));
      return;
    }
    if (this.disposed) {
      void this.server.close();
      return;
    }

    // 2단계 — 받은 포트만 frame-src에 넣고 iframe을 싣는다.
    const rel = path
      .relative(folder.uri.fsPath, this.uri.fsPath)
      .split(path.sep)
      .map(encodeURIComponent)
      .join('/');
    webview.html = buildViewerHtml(this.server.port, `${this.server.origin}/${rel}`);

    this.watch = watchServedFiles(() => this.onFileChange());
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.watch?.close();
    void this.server?.close();
  }

  // ── 메시지 ───────────────────────────────────────────────────────────────

  private originResolve: ((origin: string) => void) | undefined;

  private awaitOrigin(): Promise<string> {
    return new Promise((resolve) => {
      this.originResolve = resolve;
      setTimeout(() => resolve(''), ORIGIN_TIMEOUT_MS);
    });
  }

  private async onMessage(msg: FromWebview): Promise<void> {
    switch (msg.t) {
      case 'origin':
        this.originResolve?.(msg.origin ?? '');
        this.originResolve = undefined;
        return;
      case 'pageReady':
        // 페이지가 부른 파일이 이제 서버에 기록돼 있다. 감시 대상은 서빙 루트가 아니라 이 집합이다.
        if (this.server) this.watch?.update(this.server.servedFiles());
        return;
      case 'panel':
        this.panelOpen = !!msg.open;
        // 패널이 열려 있는 동안 미뤄 둔 갱신은 접힐 때 적용한다(spec 3.4).
        if (!this.panelOpen && this.pendingReload) {
          this.pendingReload = false;
          this.post({ t: 'reload' });
        }
        return;
      case 'pickSession':
        await this.pickSession();
        return;
      case 'send':
        await this.send(msg);
        return;
      default:
        return;
    }
  }

  private async pickSession(): Promise<void> {
    this.sessions = await this.candidates();
    if (this.sessions.length === 0) {
      this.setState('noAgent');
      this.post({ t: 'session', sessionId: '' });
      return;
    }
    this.post({
      t: 'sessions',
      list: this.sessions.map((s) => ({ sessionId: s.sessionId, name: s.name })),
    });
    const picked = await vscode.window.showQuickPick(
      this.sessions.map((s) => ({ label: s.name, description: s.model, id: s.sessionId })),
      { title: vscode.l10n.t('Send picked elements to which session?') },
    );
    this.post({ t: 'session', sessionId: picked?.id ?? '' });
  }

  private async candidates(): Promise<ViewerSession[]> {
    const folder = vscode.workspace.getWorkspaceFolder(this.uri);
    if (!folder) return [];
    const workspaceId = workspaceStore.getOrCreateWorkspaceId(folder.uri.fsPath);
    const meta = await getSessions(workspaceId);
    const names = new Map(meta.map((m) => [m.sessionId, m.name]));
    const all = getAllPanels().map((p) => ({
      sessionId: p.sessionId,
      name: names.get(p.sessionId) ?? p.model,
      model: p.model,
      cwd: p.cwd,
      alive: p.alive,
    }));
    return candidateSessions(all, this.uri.fsPath);
  }

  private async send(msg: FromWebview): Promise<void> {
    const sessionId = msg.sessionId ?? '';
    const el = msg.el;
    if (!sessionId || !el) return;
    const session = this.sessions.find((s) => s.sessionId === sessionId);
    const panel = getActivePanel(sessionId);
    if (!session || !panel || !panel.alive) {
      this.post({
        t: 'sent',
        ok: false,
        error: vscode.l10n.t('That session is not running anymore.'),
      });
      return;
    }
    // 문서 경로는 고른 세션의 작업 디렉터리 기준이다. 세션마다 답이 다를 수 있어 고른 뒤에 센다.
    const text = buildViewerPrompt(docRelativePath(session.cwd, this.uri.fsPath), el, msg.note ?? '');
    const ok = await queueSend(sessionId, () => panel.sendPrompt(text));
    this.post(
      ok
        ? { t: 'sent', ok: true }
        : {
            t: 'sent',
            ok: false,
            error: vscode.l10n.t('Could not put the prompt into that session.'),
          },
    );
  }

  private onFileChange(): void {
    // 바뀐 것이 문서 자신의 사라짐일 수 있다. 그때 다시 그리라고 하면 iframe에 404가 뜬다.
    if (!fs.existsSync(this.uri.fsPath)) {
      this.setState('missing');
      return;
    }
    if (this.panelOpen) {
      // 사용자가 글을 쓰는 중이다. 지금 다시 그리면 쓰던 글과 짚은 요소가 함께 사라진다.
      this.pendingReload = true;
      this.post({ t: 'stale' });
      return;
    }
    this.post({ t: 'reload' });
  }

  private setState(state: ViewerState, detail?: string): void {
    this.post({ t: 'state', state, detail });
  }

  private post(msg: unknown): void {
    if (!this.disposed) void this.panel.webview.postMessage(msg);
  }
}

// ── 화면 ───────────────────────────────────────────────────────────────────
//
// 그리기를 수명 밖으로 뺀 이유는 검사다. 웹뷰 스크립트는 템플릿 문자열 안이라 tsc가 안 보므로
// 렌더된 HTML을 뽑아 파서에 태워야 하는데, 그러려면 패널 없이 부를 수 있어야 한다.
//
// port가 없으면 1단계(기동 화면), 있으면 2단계(iframe)다.
export function buildViewerHtml(port?: number, src = ''): string {
  const nonce = getNonce();
  const frameSrc = port ? ` frame-src http://127.0.0.1:${port};` : '';
  const text = {
    starting: vscode.l10n.t('Starting the viewer…'),
    missing: vscode.l10n.t('That file is gone.'),
    noAgent: vscode.l10n.t('Agent mode needs a running session whose working folder holds this file.'),
    stale: vscode.l10n.t('A newer version is on disk. It loads when this panel closes.'),
    read: vscode.l10n.t('Read'),
    agent: vscode.l10n.t('Agent'),
    send: vscode.l10n.t('Send'),
    note: vscode.l10n.t('What should change here?'),
    detail: vscode.l10n.t('Sent with it'),
    line: vscode.l10n.t('Line'),
    ancestor: vscode.l10n.t('(ancestor)'),
  };
  return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';${frameSrc}">
<style nonce="${nonce}">
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { height:100%; }
  body {
    display:flex; flex-direction:column;
    background: var(--vscode-editor-background);
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: 13px;
  }
  #stage { position:relative; flex:1 1 auto; min-height:0; }
  #frame { width:100%; height:100%; border:0; display:block; background:#fff; }
  #status {
    position:absolute; inset:0; display:none; align-items:center; justify-content:center;
    padding:24px; text-align:center; white-space:pre-wrap;
    background: var(--vscode-editor-background);
    color: var(--vscode-descriptionForeground);
  }
  #status.on { display:flex; }
  #bar {
    display:flex; align-items:center; gap:10px; padding:5px 10px;
    border-top:1px solid var(--vscode-panel-border, rgba(128,128,128,.25));
  }
  button {
    font-family:inherit; font-size:12px; padding:2px 10px; border:0; border-radius:2px;
    color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
    cursor:pointer;
  }
  button.on { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button:disabled { opacity:.5; cursor:default; }
  #hint { color: var(--vscode-descriptionForeground); font-size:12px; }
  #panel {
    position:absolute; z-index:2; width:320px; padding:8px;
    border:1px solid var(--vscode-focusBorder); border-radius:4px;
    background: var(--vscode-editorWidget-background);
    box-shadow:0 2px 8px rgba(0,0,0,.3);
  }
  #panel[hidden] { display:none; }
  #who { width:100%; text-align:left; margin-bottom:6px; }
  #note {
    width:100%; height:64px; resize:none; padding:4px; font-family:inherit; font-size:12px;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border:1px solid var(--vscode-input-border, transparent);
  }
  #detail { margin-top:6px; font-size:11px; color: var(--vscode-descriptionForeground); }
  #meta { white-space:pre-wrap; word-break:break-all; margin-top:4px; }
  #warn { margin-top:6px; font-size:11px; color: var(--vscode-errorForeground); }
  #warn[hidden] { display:none; }
  #send { margin-top:6px; }
  #list { list-style:none; margin-top:4px; }
  #list[hidden] { display:none; }
  #list li { padding:3px 4px; cursor:pointer; border-radius:2px; }
  #list li:hover { background: var(--vscode-list-hoverBackground); }
</style>
</head>
<body>
<div id="stage">
  ${port ? `<iframe id="frame" src="${src}" title="preview"></iframe>` : ''}
  <div id="status" class="on">${escapeHtml(text.starting)}</div>
  <div id="panel" hidden>
  <button id="who"></button>
  <ul id="list" hidden></ul>
  <textarea id="note" placeholder="${escapeHtml(text.note)}"></textarea>
  <details id="detail"><summary>${escapeHtml(text.detail)}</summary><div id="meta"></div></details>
  <div id="warn" hidden></div>
  <button id="send">${escapeHtml(text.send)}</button>
  </div>
</div>
<div id="bar">
  <button id="toggle" disabled>${escapeHtml(text.agent)}</button>
  <span id="hint"></span>
</div>
<script nonce="${nonce}">
const vs = acquireVsCodeApi();
const SERVER_ORIGIN = ${port ? JSON.stringify(`http://127.0.0.1:${port}`) : "''"};
const TEXT = ${JSON.stringify(text)};

if (!SERVER_ORIGIN) {
  // 1단계 — 출처를 알려주는 API가 없어 웹뷰가 자기 출처를 직접 보고한다.
  vs.postMessage({ t: 'origin', origin: window.origin });
} else {
  const stage = document.getElementById('stage');
  const frame = document.getElementById('frame');
  const status = document.getElementById('status');
  const toggle = document.getElementById('toggle');
  const hint = document.getElementById('hint');
  const panel = document.getElementById('panel');
  const who = document.getElementById('who');
  const list = document.getElementById('list');
  const note = document.getElementById('note');
  const meta = document.getElementById('meta');
  const warn = document.getElementById('warn');
  const send = document.getElementById('send');

  let ready = false;        // 짚기 스크립트가 떴다
  let agent = false;
  let sessionId = '';
  let sessions = [];
  let picked = null;        // { el, rect }
  let base = frame.src;

  const say = (msg) => {
  status.textContent = msg || '';
  status.classList.toggle('on', !!msg);
  };
  const toFrame = (msg) => {
  if (frame.contentWindow) frame.contentWindow.postMessage(msg, SERVER_ORIGIN);
  };
  const setPanel = (open) => {
  panel.hidden = !open;
  vs.postMessage({ t: 'panel', open: open });
  if (!open) { picked = null; warn.hidden = true; note.value = ''; list.hidden = true; }
  };
  const setMode = (on) => {
  agent = on;
  toggle.classList.toggle('on', on);
  toggle.textContent = on ? TEXT.read : TEXT.agent;
  toFrame({ ab: 'mode', mode: on ? 'agent' : 'read' });
  if (!on) setPanel(false);
  };
  // 안쪽이 준 좌표는 iframe 뷰포트 기준이다. iframe의 자리를 더해 웹뷰 좌표로 옮기고,
  // 패널이 웹뷰 밖으로 나가면 안쪽으로 당긴다 — 패널은 항상 온전히 보여야 한다.
  const place = (rect) => {
  const box = frame.getBoundingClientRect();
  const stageBox = stage.getBoundingClientRect();
  const w = panel.offsetWidth || 320;
  const h = panel.offsetHeight || 160;
  let x = box.left - stageBox.left + rect.x;
  let y = box.top - stageBox.top + rect.y + rect.h + 6;
  x = Math.max(4, Math.min(x, stageBox.width - w - 4));
  y = Math.max(4, Math.min(y, stageBox.height - h - 4));
  panel.style.left = x + 'px';
  panel.style.top = y + 'px';
  };
  const drawWho = () => {
  const found = sessions.find((s) => s.sessionId === sessionId);
  who.textContent = found ? found.name : '';
  list.innerHTML = '';
  for (const s of sessions) {
    const li = document.createElement('li');
    li.textContent = s.name;
    li.addEventListener('click', () => { sessionId = s.sessionId; list.hidden = true; drawWho(); });
    list.appendChild(li);
  }
  };

  toggle.addEventListener('click', () => {
  if (!ready) return;
  if (agent) { setMode(false); return; }
  vs.postMessage({ t: 'pickSession' });     // 짚을 때마다 묻지 않기 위해 앞에서 한 번 받는다
  });
  who.addEventListener('click', () => { list.hidden = !list.hidden; });
  send.addEventListener('click', () => {
  if (!picked || !sessionId) return;
  vs.postMessage({ t: 'send', sessionId: sessionId, el: picked.el, note: note.value });
  });
  note.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send.click(); }
  if (e.key === 'Escape') setPanel(false);
  });
  document.addEventListener('click', (e) => {
  if (!panel.hidden && !panel.contains(e.target) && e.target !== toggle) setPanel(false);
  });

  window.addEventListener('message', (e) => {
  if (e.origin !== SERVER_ORIGIN) {
    // 익스텐션이 보낸 것. 웹뷰 출처는 우리 것이라 페이지가 흉내 낼 수 없다.
    const d = e.data || {};
    if (d.t === 'state') {
      if (d.state === 'noAgent') { ready = false; toggle.disabled = true; hint.textContent = TEXT.noAgent; setMode(false); }
      else if (d.state === 'missing') say(TEXT.missing);
      else if (d.state === 'serverError') say(d.detail || '');
    } else if (d.t === 'sessions') {
      sessions = d.list || [];
      drawWho();
    } else if (d.t === 'session') {
      if (d.sessionId) { sessionId = d.sessionId; drawWho(); setMode(true); }
    } else if (d.t === 'reload') {
      hint.textContent = '';
      frame.src = base + (base.indexOf('?') === -1 ? '?' : '&') + 'ab=' + Date.now();
    } else if (d.t === 'stale') {
      hint.textContent = TEXT.stale;
    } else if (d.t === 'sent') {
      if (d.ok) setPanel(false);
      else { warn.textContent = d.error || ''; warn.hidden = false; }
    }
    return;
  }
  // 안쪽(iframe)에서 온 것.
  const d = e.data || {};
  if (d.ab === 'ready') {
    ready = true;
    toggle.disabled = false;
    say('');
    vs.postMessage({ t: 'pageReady' });
  } else if (d.ab === 'pick') {
    picked = { el: d.el, rect: d.rect };
    meta.textContent = TEXT.line + ' ' + d.el.line + (d.el.lineIsAncestor ? ' ' + TEXT.ancestor : '') +
      '\\n' + d.el.selector + '\\n' + d.el.tag;
    warn.hidden = true;
    setPanel(true);
    place(d.rect);
    note.focus();
  } else if (d.ab === 'rect') {
    if (!panel.hidden) place(d.rect);
  } else if (d.ab === 'dismiss') {
    setPanel(false);
  }
  });
}
</script>
</body>
</html>`;
}

function getNonce(): string {
  return randomBytes(16).toString('base64');
}

// 웹뷰 HTML 템플릿에 끼워 넣는 표시값은 모두 이 함수를 거친다. 지금 넣는 것은 우리 번들의
// 문구뿐이지만, 값의 출처가 바뀌어도 안전하도록 방어 계층을 유지한다.
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
