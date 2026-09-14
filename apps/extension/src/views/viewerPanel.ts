import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import { startViewerServer, watchServedFiles, buildViewerPrompt } from '@agentbridge/core';
import type { ViewerServer, ViewerWatch, PickedElement } from '@agentbridge/core';
import { assetRootUri, assetRootPath } from '../core/assetRoot';
import * as output from '../log/output';
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
// 사용자가 치는 글과 세션 이름은 iframe 안에 두지 않는다. 인라인 패널과 세션 선택 창은 웹뷰가
// 그리고, 안쪽은 요소의 화면 좌표만 보낸다(spec 3.4).
//
// 화면은 docs/0.7.0/plan/mockups/viewer-ui.html에서 합의한 것을 옮긴 것이다.

type ViewerState = 'missing' | 'serverError';

// 선택창이 열려 있는 동안 세션 목록을 다시 세는 주기.
const SESSION_POLL_MS = 1000;

interface FromWebview {
  t?: string;
  origin?: string;
  sessionId?: string;
  el?: PickedElement;
  note?: string;
  open?: boolean;
}

// 웹뷰가 로드하는 이미지. 모델 로고는 세션 목록·탭이 쓰는 것과 같은 파일이다.
export interface ViewerAssets {
  claude: string;
  codex: string;
  agy: string;
  brand: string;
}

export class HtmlViewerProvider implements vscode.CustomReadonlyEditorProvider, vscode.Disposable {
  static readonly viewType = 'agentbridge.htmlViewer';

  // 패널 하나에 뷰어 하나. VS Code가 같은 패널로 resolve를 다시 부르면(탭 이동·복원) 뷰어가
  // 둘이 되고, 메시지 수신기도 둘이 되어 보낸 것이 두 번 간다.
  private readonly live = new Map<vscode.WebviewPanel, Viewer>();
  private active: Viewer | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  // 커스텀 에디터는 문서 모델을 우리가 만든다. 뷰어는 읽기 전용이라 uri 말고 들 것이 없다.
  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: (): void => undefined };
  }

  resolveCustomEditor(doc: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
    const existing = this.live.get(panel);
    if (existing) {
      output.log(`viewer: resolve 재호출 — 기존 뷰어를 쓴다 (${doc.uri.fsPath})`);
      this.active = existing;
      return;
    }

    const viewer = new Viewer(doc.uri, panel, this.extensionUri);
    this.live.set(panel, viewer);
    this.active = viewer;
    output.log(`viewer: resolve ${doc.uri.fsPath}`);
    panel.onDidChangeViewState(() => {
      if (panel.active) this.active = viewer;
    });
    panel.onDidDispose(() => {
      this.live.delete(panel);
      if (this.active === viewer) this.active = undefined;
      viewer.dispose();
    });
    viewer.start();
  }

  // 소스로 돌아가는 명령이 쓴다. activeCustomEditorId는 어느 뷰 타입인지만 알려주고 무엇을
  // 열고 있는지는 안 알려준다.
  activeUri(): vscode.Uri | undefined {
    return this.active?.uri;
  }

  // 익스텐션이 내려갈 때 남은 서버를 전부 내린다. 탭 닫힘만 처리하면 창을 통째로 닫을 때
  // 포트가 남는다(spec 3.5).
  dispose(): void {
    for (const viewer of this.live.values()) viewer.dispose();
    this.live.clear();
  }
}

class Viewer {
  private server: ViewerServer | undefined;
  private watch: ViewerWatch | undefined;
  private disposed = false;
  private started = false;
  private panelOpen = false;
  private pendingReload = false;
  private sessions: ViewerSession[] = [];
  // 선택창이 열려 있는 동안만 도는 목록 갱신. 세션은 다른 탭에서 아무 때나 생기고 닫히는데
  // 그것을 알려 주는 이벤트가 없어 짧게 다시 센다.
  private poll: NodeJS.Timeout | undefined;
  private lastList = '';

  constructor(
    readonly uri: vscode.Uri,
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
  ) {}

  // 여기서 기다리지 않는다. VS Code는 resolveCustomEditor가 끝나야 웹뷰 다리를 완성하므로,
  // 이 함수 안에서 웹뷰의 첫 메시지를 기다리면 그 메시지가 영영 안 온다(실측). 화면만 띄우고
  // 나가고, 나머지는 출처가 도착했을 때 이어 간다.
  start(): void {
    const webview = this.panel.webview;
    webview.options = { enableScripts: true, localResourceRoots: [assetRootUri(this.extensionUri)] };
    webview.onDidReceiveMessage((msg: FromWebview) => void this.onMessage(msg));

    // 1단계 — 기동 화면. iframe도 frame-src도 아직 없다.
    webview.html = buildViewerHtml(this.assets(), webview.cspSource);
  }

  // 웹뷰가 자기 출처를 알려 왔다. 받았다고 답하고 서버를 띄운다. 웹뷰는 답이 올 때까지
  // 다시 말하므로 이 자리는 여러 번 불릴 수 있다 — 첫 번째만 일한다.
  private async onOrigin(origin: string): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;
    this.post({ t: 'ack' });
    output.log(`viewer: origin=${origin} uri=${this.uri.fsPath}`);
    if (!origin || origin === 'null') {
      this.setState('serverError', vscode.l10n.t('Could not read the webview origin.'));
      return;
    }

    const webview = this.panel.webview;
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
      // 화면에는 한 줄만 띄우고 원인은 출력 채널에 남긴다.
      output.error(`viewer: 서버 기동 실패 — ${String(err)}`);
      this.setState('serverError', vscode.l10n.t('Failed to start viewer server'));
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
    webview.html = buildViewerHtml(
      this.assets(),
      webview.cspSource,
      this.server.port,
      `${this.server.origin}/${rel}`,
    );

    output.log(`viewer: ${this.server.origin}/${rel}`);

    this.watch = watchServedFiles(() => this.onFileChange());
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopPoll();
    this.watch?.close();
    void this.server?.close();
  }

  // 상태 화면의 재시도. 처음부터 다시 건다 — 기동 화면을 새로 넣으면 웹뷰가 자기 출처를 다시
  // 알려 오고 그때 서버를 새로 띄운다.
  private retry(): void {
    if (this.disposed) return;
    this.watch?.close();
    this.watch = undefined;
    void this.server?.close();
    this.server = undefined;
    this.started = false;
    this.panel.webview.html = buildViewerHtml(this.assets(), this.panel.webview.cspSource);
  }

  private assets(): ViewerAssets {
    const root = assetRootUri(this.extensionUri);
    const uri = (...seg: string[]): string =>
      this.panel.webview.asWebviewUri(vscode.Uri.joinPath(root, ...seg)).toString();
    const kind = vscode.window.activeColorTheme.kind;
    const light =
      kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight;
    return {
      claude: uri('media', 'logos', 'claude.svg'),
      codex: uri('media', 'logos', 'codex.svg'),
      agy: uri('media', 'logos', 'agy.svg'),
      brand: uri('media', light ? 'icon-light.svg' : 'icon-dark.svg'),
    };
  }

  // ── 메시지 ───────────────────────────────────────────────────────────────

  private async onMessage(msg: FromWebview): Promise<void> {
    switch (msg.t) {
      case 'origin':
        await this.onOrigin(msg.origin ?? '');
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
        await this.pushSessions(true);
        if (!this.poll) this.poll = setInterval(() => void this.pushSessions(false), SESSION_POLL_MS);
        return;
      case 'pickerClosed':
        this.stopPoll();
        return;
      case 'send':
        await this.send(msg);
        return;
      case 'retry':
        this.retry();
        return;
      default:
        return;
    }
  }

  // 고를 수 있는 세션을 웹뷰에 넘긴다. 고르는 화면은 웹뷰가 그린다 — 뷰어는 오른쪽 편집기
  // 그룹에 있는데 IDE 기본 선택창은 창 맨 위에 떠서 눈이 엉뚱한 데로 간다.
  //
  // force가 아니면 목록이 실제로 달라졌을 때만 보낸다. 안 그러면 창이 열려 있는 내내 같은
  // 목록을 다시 그려 선택이 흔들린다.
  private async pushSessions(force: boolean): Promise<void> {
    if (this.disposed) return;
    this.sessions = await this.candidates();
    const list = this.sessions.map((s) => ({ sessionId: s.sessionId, name: s.name, model: s.model }));
    const sig = JSON.stringify(list);
    if (!force && sig === this.lastList) return;
    this.lastList = sig;
    this.post({ t: 'sessions', list });
  }

  private stopPoll(): void {
    if (!this.poll) return;
    clearInterval(this.poll);
    this.poll = undefined;
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
      this.post({ t: 'sent', ok: false, error: vscode.l10n.t('Session is not running') });
      return;
    }
    // 문서 경로는 고른 세션의 작업 디렉터리 기준이다. 세션마다 답이 다를 수 있어 고른 뒤에 센다.
    const text = buildViewerPrompt(docRelativePath(session.cwd, this.uri.fsPath), el, msg.note ?? '');
    output.log(`viewer: send → ${sessionId} 줄 ${el.line} (${text.length}자)`);
    const ok = await queueSend(sessionId, () => panel.sendPrompt(text));
    this.post(
      ok
        ? { t: 'sent', ok: true }
        : { t: 'sent', ok: false, error: vscode.l10n.t('Could not send to that session') },
    );
  }

  private onFileChange(): void {
    // 바뀐 것이 문서 자신의 사라짐일 수 있다. 그때 다시 그리라고 하면 iframe에 404가 뜬다.
    if (!fs.existsSync(this.uri.fsPath)) {
      this.setState('missing', path.basename(this.uri.fsPath));
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
export function buildViewerHtml(
  assets: ViewerAssets,
  cspSource: string,
  port?: number,
  src = '',
): string {
  const nonce = getNonce();
  const frameSrc = port ? ` frame-src http://127.0.0.1:${port};` : '';
  const text = {
    agent: vscode.l10n.t('Agent mode'),
    noSession: vscode.l10n.t('No running sessions'),
    noSessionHere: vscode.l10n.t('No running sessions in current folder'),
    pick: vscode.l10n.t('Select session'),
    note: vscode.l10n.t('Describe changes'),
    info: vscode.l10n.t('Element info'),
    send: vscode.l10n.t('Send'),
    fresh: vscode.l10n.t('New version available'),
    loading: vscode.l10n.t('Loading'),
    missing: vscode.l10n.t('File not found: {0}'),
    retry: vscode.l10n.t('Retry'),
    close: vscode.l10n.t('Close'),
    line: vscode.l10n.t('Line'),
    ancestor: vscode.l10n.t('(ancestor)'),
    noBridge: vscode.l10n.t('The viewer could not reach the extension.'),
  };
  return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src ${cspSource};${frameSrc}">
<style nonce="${nonce}">
  :root{
    --ed: var(--vscode-editor-background);
    --widget: var(--vscode-editorWidget-background);
    --wborder: var(--vscode-widget-border, rgba(128,128,128,.35));
    --fg: var(--vscode-foreground);
    --dim: var(--vscode-descriptionForeground);
    --input: var(--vscode-input-background);
    --iborder: var(--vscode-input-border, transparent);
    --btn: var(--vscode-button-background);
    --btnfg: var(--vscode-button-foreground);
    --sbtn: var(--vscode-button-secondaryBackground);
    --sbtnfg: var(--vscode-button-secondaryForeground);
    --hover: var(--vscode-list-hoverBackground);
    --sel: var(--vscode-list-activeSelectionBackground);
    --selfg: var(--vscode-list-activeSelectionForeground);
    --focus: var(--vscode-focusBorder);
    --err: var(--vscode-errorForeground);
    --ok: var(--vscode-testing-iconPassed, #73c991);
    --pborder: var(--vscode-panel-border, rgba(128,128,128,.25));
    --pick: #ff8c00;
  }
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{height:100%}
  body{display:flex;flex-direction:column;background:var(--ed);color:var(--fg);
    font-family:var(--vscode-font-family);font-size:13px}
  [hidden]{display:none !important}

  #stage{position:relative;flex:1 1 auto;min-height:0}
  #frame{width:100%;height:100%;border:0;display:block;background:#fff}

  /* ── 하단 바 ── */
  #bar{display:flex;align-items:center;gap:9px;height:30px;padding:0 10px;
    border-top:1px solid var(--pborder);flex-shrink:0}
  #bar.lock{opacity:.55}
  #sw{width:26px;height:14px;border-radius:999px;background:var(--input);
    border:1px solid var(--iborder);position:relative;flex-shrink:0;cursor:pointer}
  #sw i{position:absolute;top:1px;left:1px;width:10px;height:10px;border-radius:999px;
    background:var(--dim)}
  #sw.on{background:var(--btn);border-color:var(--btn)}
  #sw.on i{left:13px;background:var(--btnfg)}
  #bar.lock #sw{cursor:default}
  #lab{font-size:11.5px;color:var(--dim)}
  #bar.on #lab{color:var(--fg)}
  #sp{flex:1}
  #fresh{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--ok)}
  #why{font-size:11px;color:var(--dim)}
  #sess{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:var(--fg)}
  #sess img{width:10.5px;height:10.5px;display:block}
  #sess b{font-weight:400}
  #bar:not(.on) #sess{color:var(--dim);opacity:.75}

  /* ── 세션 선택 ── */
  #scrim{position:absolute;inset:0;background:rgba(0,0,0,.45);z-index:4;
    display:flex;align-items:center;justify-content:center}
  #modal{width:300px;max-width:90%;background:var(--widget);border:1px solid var(--wborder);
    border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.5);overflow:hidden}
  #modal .hd{font-size:10px;line-height:1;letter-spacing:.06em;text-transform:uppercase;
    color:var(--dim);padding:6px 12px 5px;border-bottom:1px solid var(--wborder)}
  #list{padding:4px 0;max-height:240px;overflow-y:auto}
  #none{padding:12px;font-size:11.5px;color:var(--dim)}
  .opt{display:flex;align-items:center;gap:8px;padding:7px 12px;cursor:pointer}
  .opt:hover{background:var(--hover)}
  .opt.sel{background:var(--sel);color:var(--selfg)}
  .opt img{width:11px;height:11px;flex-shrink:0;display:block}
  .opt .nm{font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .opt .sub{margin-left:auto;font-size:11px;color:var(--dim);white-space:nowrap}

  /* ── 인라인 패널 ── */
  #panel{position:absolute;z-index:3;width:296px;background:var(--widget);
    border:1px solid var(--wborder);border-radius:6px;box-shadow:0 6px 18px rgba(0,0,0,.45)}
  #nub{position:absolute;top:-5px;left:22px;width:8px;height:8px;background:var(--widget);
    border-left:1px solid var(--wborder);border-top:1px solid var(--wborder);transform:rotate(45deg)}
  #who{display:flex;align-items:center;gap:6px;padding:8px 9px 7px;position:relative}
  #who img{width:11px;height:11px;display:block;flex-shrink:0}
  #whoname{font-size:12px;color:var(--fg)}
  /* ▸·▾ 문자는 글자 상자 안에서 아래로 치우쳐 그려진다. 상자를 가운데 놓아도 잉크가 안 맞아
     테두리로 직접 그린다 — 도형이 상자를 꽉 채우므로 중앙이 정확하다 */
  .cv{display:inline-flex;align-items:center;justify-content:center;width:12px;height:12px;
    flex-shrink:0;color:var(--dim)}
  .cv::before{content:'';display:block;border-style:solid;border-color:transparent}
  .cv.down::before{border-width:3.5px 3px 0 3px;border-top-color:currentColor}
  .cv.right::before{border-width:3px 0 3px 3.5px;border-left-color:currentColor}
  #more.open .cv.right::before{border-width:3.5px 3px 0 3px;border-top-color:currentColor;
    border-left-color:transparent}
  #who .sp{flex:1}
  #pickbtn{display:inline-flex;align-items:center;gap:6px;cursor:pointer}
  #x{width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;
    border-radius:3px;color:var(--dim);font-size:12px;cursor:pointer}
  #x:hover{background:var(--hover);color:var(--fg)}
  /* 폭은 가장 긴 세션 이름이 정한다. 고정값이면 짧은 이름에선 허전하고 긴 이름은 잘린다 */
  #drop{position:absolute;top:27px;left:8px;width:max-content;min-width:140px;max-width:260px;
    background:var(--widget);border:1px solid var(--wborder);border-radius:5px;
    box-shadow:0 6px 18px rgba(0,0,0,.5);padding:3px 0;z-index:5}
  #drop .opt{padding:5px 10px}
  #drop .nm{overflow:visible;text-overflow:clip}
  #note{display:block;width:calc(100% - 18px);margin:0 9px;min-height:54px;resize:none;
    background:var(--input);border:1px solid var(--iborder);border-radius:3px;padding:6px 7px;
    font-family:inherit;font-size:12px;color:var(--vscode-input-foreground)}
  #note:focus{outline:none;border-color:var(--focus)}
  #foot{display:flex;align-items:center;gap:8px;padding:8px 9px 9px}
  #foot .sp{flex:1}
  #send{flex-shrink:0}
  #more{display:inline-flex;align-items:center;gap:5px;min-width:0;font-size:11px;
    color:var(--dim);cursor:pointer;white-space:nowrap}
  #mlabel{flex-shrink:0}
  #sep{width:1px;height:9px;background:currentColor;opacity:.4;flex-shrink:0}
  #more.open #sep,#more.open #brief{display:none}
  #brief{font-weight:400;font-family:var(--vscode-editor-font-family);font-size:10.5px;
    min-width:0;overflow:hidden;text-overflow:ellipsis}
  #detail{margin:0 9px 9px;padding:7px 8px;background:var(--input);border-radius:3px;
    font-family:var(--vscode-editor-font-family);font-size:10.5px;line-height:1.65;
    color:var(--dim);white-space:pre-wrap;word-break:break-all}
  #warn{margin:0 9px 9px;font-size:11px;color:var(--err)}
  .btn{font-size:11.5px;line-height:1.45;padding:1.5px 10px;border:0;border-radius:3px;
    font-family:inherit;background:var(--btn);color:var(--btnfg);cursor:pointer}
  .btn.sec{background:var(--sbtn);color:var(--sbtnfg)}
  .btn:disabled{opacity:.5;cursor:default}

  /* ── 상태 화면 ── */
  #state{position:absolute;inset:0;z-index:2;background:var(--ed);display:flex;
    flex-direction:column;align-items:center;justify-content:center;gap:7px;padding:22px;
    text-align:center}
  #state img{width:38px;height:38px;display:block;margin-bottom:3px}
  #state .bname{font-size:11.5px;font-weight:700;color:var(--fg);letter-spacing:.01em}
  #msg{font-size:11.5px;color:var(--dim);max-width:280px;margin-top:2px}
  #load{font-size:11px;color:var(--dim)}
  /* 셋이 같은 1.2초 타임라인을 공유한다. 33%에 둘째, 66%에 셋째가 켜지고 한 바퀴 끝에 하나로 돌아간다 */
  #load i{font-style:normal;animation:1.2s infinite}
  #load i:nth-child(1){animation-name:d1}
  #load i:nth-child(2){animation-name:d2}
  #load i:nth-child(3){animation-name:d3}
  @keyframes d1{0%,100%{opacity:1}}
  @keyframes d2{0%,32.9%{opacity:0}33%,100%{opacity:1}}
  @keyframes d3{0%,65.9%{opacity:0}66%,100%{opacity:1}}
</style>
</head>
<body>
<div id="stage">
  ${port ? `<iframe id="frame" src="${src}" title="preview"></iframe>` : ''}

  <div id="state">
    <img src="${assets.brand}" alt=""/>
    <div class="bname">AgentBridge</div>
    <div id="load">${escapeHtml(text.loading)}<i>.</i><i>.</i><i>.</i></div>
    <div id="msg" hidden></div>
    <button id="again" class="btn sec" hidden>${escapeHtml(text.retry)}</button>
  </div>

  <div id="panel" hidden>
    <div id="nub"></div>
    <div id="who">
      <span id="pickbtn"><img id="wholog" src="${assets.claude}" alt=""/><span id="whoname"></span><span class="cv down"></span></span>
      <span class="sp"></span>
      <span id="x" title="${escapeHtml(text.close)}">&#10005;</span>
      <div id="drop" hidden></div>
    </div>
    <textarea id="note" placeholder="${escapeHtml(text.note)}"></textarea>
    <div id="foot">
      <span id="more"><span class="cv right"></span><span id="mlabel">${escapeHtml(text.info)}</span><span id="sep"></span><b id="brief"></b></span>
      <span class="sp"></span>
      <button id="send" class="btn">${escapeHtml(text.send)}</button>
    </div>
    <div id="detail" hidden></div>
    <div id="warn" hidden></div>
  </div>

  <div id="scrim" hidden>
    <div id="modal">
      <div class="hd">${escapeHtml(text.pick)}</div>
      <div id="list"></div>
      <div id="none" hidden>${escapeHtml(text.noSessionHere)}</div>
    </div>
  </div>
</div>

<div id="bar" class="lock">
  <span id="sw"><i></i></span><span id="lab">${escapeHtml(text.agent)}</span>
  <span id="sp"></span>
  <span id="why" hidden></span>
  <span id="fresh" hidden>&#10003; ${escapeHtml(text.fresh)}</span>
  <span id="sess" hidden><img alt=""/><b></b></span>
</div>

<script nonce="${nonce}">
const vs = acquireVsCodeApi();
const SERVER_ORIGIN = ${port ? JSON.stringify(`http://127.0.0.1:${port}`) : "''"};
const TEXT = ${JSON.stringify(text)};
const LOGO = ${JSON.stringify({ claude: assets.claude, codex: assets.codex, agy: assets.agy })};

const $ = (id) => document.getElementById(id);
const state = $('state'), load = $('load'), msg = $('msg'), again = $('again');

const showState = (line, retry) => {
  state.hidden = false;
  load.hidden = !!line;
  msg.hidden = !line;
  msg.textContent = line || '';
  again.hidden = !retry;
};
again.addEventListener('click', () => vs.postMessage({ t: 'retry' }));

if (!SERVER_ORIGIN) {
  // 1단계 — 출처를 알려주는 API가 없어 웹뷰가 자기 출처를 직접 보고한다.
  let acked = false, tries = 0;
  window.addEventListener('message', (e) => {
    const d = e.data || {};
    if (d.t === 'ack') { acked = true; return; }
    if (d.t === 'state') showState(d.detail || '', d.state === 'serverError');
  });
  // 뜨자마자 보낸 메시지는 익스텐션 쪽 다리가 아직 안 걸려 있으면 사라진다. 받았다는 답이
  // 올 때까지 다시 말한다.
  const announce = () => {
    if (acked) return;
    tries += 1;
    if (tries > 40) { showState(TEXT.noBridge, false); return; }
    vs.postMessage({ t: 'origin', origin: window.origin });
    setTimeout(announce, 250);
  };
  announce();
} else {
  const stage = $('stage'), frame = $('frame'), bar = $('bar'), sw = $('sw');
  const why = $('why'), fresh = $('fresh'), sess = $('sess');
  const panel = $('panel'), drop = $('drop'), pickbtn = $('pickbtn');
  const wholog = $('wholog'), whoname = $('whoname'), x = $('x');
  const note = $('note'), more = $('more'), brief = $('brief'), detail = $('detail');
  const warn = $('warn'), send = $('send');
  const scrim = $('scrim'), list = $('list'), none = $('none');

  let ready = false;          // 짚기 스크립트가 떴다
  let agent = false;
  let picked = null;          // { el, rect }
  let sessions = [];
  let sessionId = '';
  let picker = '';            // '' | 'modal' | 'drop' — 무엇이 열려 있나
  const base = frame.src;

  // 페이지가 떴으면 기동 화면을 걷는다. 짚기 스크립트가 안 와도 읽기는 돼야 한다 —
  // 그 경우 토글만 잠긴 채로 남는다.
  frame.addEventListener('load', () => { state.hidden = true; });

  const toFrame = (m) => { if (frame.contentWindow) frame.contentWindow.postMessage(m, SERVER_ORIGIN); };
  const logoOf = (model) => LOGO[model] || LOGO.claude;

  const drawSess = () => {
    const s = sessions.find((v) => v.sessionId === sessionId);
    sess.hidden = !s;
    if (!s) return;
    sess.querySelector('img').src = logoOf(s.model);
    sess.querySelector('b').textContent = s.name;
    wholog.src = logoOf(s.model);
    whoname.textContent = s.name;
  };

  const setPanel = (open) => {
    panel.hidden = !open;
    vs.postMessage({ t: 'panel', open: open });
    if (!open) {
      picked = null; note.value = ''; warn.hidden = true; closePicker();
      detail.hidden = true; more.classList.remove('open');
      send.disabled = false;
    }
  };

  const setMode = (on) => {
    agent = on;
    sw.classList.toggle('on', on);
    bar.classList.toggle('on', on);
    toFrame({ ab: 'mode', mode: on ? 'agent' : 'read' });
    if (!on) setPanel(false);
  };

  // 안쪽이 준 좌표는 iframe 뷰포트 기준이다. iframe의 자리를 더해 웹뷰 좌표로 옮기고,
  // 패널이 웹뷰 밖으로 나가면 안쪽으로 당긴다 — 패널은 항상 온전히 보여야 한다.
  const place = (rect) => {
    const box = frame.getBoundingClientRect();
    const sb = stage.getBoundingClientRect();
    const w = panel.offsetWidth || 296, h = panel.offsetHeight || 170;
    let px = box.left - sb.left + rect.x;
    let py = box.top - sb.top + rect.y + rect.h + 6;
    px = Math.max(4, Math.min(px, sb.width - w - 4));
    py = Math.max(4, Math.min(py, sb.height - h - 4));
    panel.style.left = px + 'px';
    panel.style.top = py + 'px';
  };

  const row = (s, into, withModel, onPick) => {
    const el = document.createElement('div');
    el.className = 'opt' + (s.sessionId === sessionId ? ' sel' : '');
    const img = document.createElement('img'); img.src = logoOf(s.model); el.appendChild(img);
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = s.name;
    el.appendChild(nm);
    if (withModel) {
      const sub = document.createElement('span'); sub.className = 'sub'; sub.textContent = s.model;
      el.appendChild(sub);
    }
    el.addEventListener('click', () => onPick(s));
    into.appendChild(el);
  };

  // 목록은 창이 열려 있는 동안 익스텐션이 계속 밀어 준다. 다른 탭에서 세션이 생기거나
  // 닫히면 창을 닫았다 열지 않아도 따라온다.
  const openPicker = (which) => {
    picker = which;
    vs.postMessage({ t: 'pickSession' });
  };
  const closePicker = () => {
    if (!picker) return;
    picker = '';
    scrim.hidden = true;
    drop.hidden = true;
    vs.postMessage({ t: 'pickerClosed' });
  };
  const drawPicker = () => {
    list.innerHTML = '';
    drop.innerHTML = '';
    for (const s of sessions) {
      row(s, list, true, (v) => { sessionId = v.sessionId; drawSess(); closePicker(); setMode(true); });
      row(s, drop, false, (v) => { sessionId = v.sessionId; drawSess(); closePicker(); });
    }
    const empty = sessions.length === 0;
    none.hidden = !empty;
    why.hidden = !empty;
    why.textContent = empty ? TEXT.noSession : '';
    bar.classList.toggle('lock', empty);
    scrim.hidden = picker !== 'modal';
    drop.hidden = picker !== 'drop';
  };

  sw.addEventListener('click', () => {
    if (!ready || bar.classList.contains('lock')) return;
    if (agent) { setMode(false); return; }
    if (sessionId) { setMode(true); return; }
    openPicker('modal');
  });
  pickbtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (picker === 'drop') closePicker();
    else openPicker('drop');
  });
  x.addEventListener('click', () => setPanel(false));
  more.addEventListener('click', () => {
    detail.hidden = !detail.hidden;
    more.classList.toggle('open', !detail.hidden);
  });
  send.addEventListener('click', () => {
    if (!picked || !sessionId || send.disabled) return;
    // 답이 올 때까지 잠근다. 엔터와 클릭이 겹치면 같은 요소가 두 번 간다.
    send.disabled = true;
    vs.postMessage({ t: 'send', sessionId: sessionId, el: picked.el, note: note.value });
  });
  note.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send.click(); }
    if (e.key === 'Escape') setPanel(false);
  });
  scrim.addEventListener('click', (e) => { if (e.target === scrim) closePicker(); });
  document.addEventListener('click', (e) => {
    if (picker === 'drop' && !drop.contains(e.target) && !pickbtn.contains(e.target)) closePicker();
    if (!panel.hidden && !panel.contains(e.target) && e.target !== sw) setPanel(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (picker) closePicker();
    else if (!panel.hidden) setPanel(false);
  });

  window.addEventListener('message', (e) => {
    if (e.origin !== SERVER_ORIGIN) {
      // 익스텐션이 보낸 것. 웹뷰 출처는 우리 것이라 페이지가 흉내 낼 수 없다.
      const d = e.data || {};
      if (d.t === 'state') {
        if (d.state === 'missing') showState(TEXT.missing.replace('{0}', d.detail || ''), false);
        else if (d.state === 'serverError') showState(d.detail || '', true);
      } else if (d.t === 'sessions') {
        sessions = d.list || [];
        // 고른 세션이 목록에서 사라졌다(탭이 닫혔다). 보낼 곳이 없으므로 읽기로 돌아간다.
        if (sessionId && !sessions.some((v) => v.sessionId === sessionId)) {
          sessionId = '';
          drawSess();
          if (agent) setMode(false);
        }
        drawPicker();
      } else if (d.t === 'reload') {
        fresh.hidden = true;
        frame.src = base + (base.indexOf('?') === -1 ? '?' : '&') + 'ab=' + Date.now();
      } else if (d.t === 'stale') {
        fresh.hidden = false;
      } else if (d.t === 'sent') {
        send.disabled = false;
        if (d.ok) setPanel(false);
        else { warn.textContent = d.error || ''; warn.hidden = false; }
      }
      return;
    }
    // 안쪽(iframe)에서 온 것.
    const d = e.data || {};
    if (d.ab === 'ready') {
      ready = true;
      state.hidden = true;
      bar.classList.remove('lock');
      vs.postMessage({ t: 'pageReady' });
      // 다시 그린 페이지 안의 스크립트는 읽기 모드로 시작한다. 밖이 에이전트 모드면 다시
      // 말해 줘야 한다 — 안 하면 모드는 켜져 보이는데 오버레이가 안 뜬다.
      if (agent) toFrame({ ab: 'mode', mode: 'agent' });
    } else if (d.ab === 'pick') {
      picked = { el: d.el, rect: d.rect };
      brief.textContent = TEXT.line + ' ' + d.el.line;
      detail.textContent = [
        TEXT.line + ' ' + d.el.line + (d.el.lineIsAncestor ? ' ' + TEXT.ancestor : ''),
        d.el.selector,
        d.el.tag,
      ].join('\\n');
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
