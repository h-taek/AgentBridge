import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { getSessions, type SessionMeta } from '../core/sessionRegistry';
import * as workspaceStore from '../core/workspaceStore';
import {
  readSessionActivityInputs,
  computeSessionActivity,
  type SessionActivity,
} from '@agentbridge/core';
import { buildSessionRows, type SessionRowView } from './sessionsViewModel';
import type { UsageStore } from '../core/usage/usageStore';
import { buildUsageStrip, type UsageStripView } from './usageViewModel';

// 세션 목록. 0.6.0에서 기본 트리를 웹뷰로 바꿨다 — 사용량 줄을 헤더 바로 아래 한 줄로 두려면
// 이 자리가 우리가 그릴 수 있는 면이어야 했다. 별도 뷰로 두면 섹션 하나가 늘고, 확장은 뷰의
// 최소 높이를 못 정해서 한 줄짜리 내용에 142px이 잡힌다.
//
// 트리가 공짜로 해주던 것(접기, 우클릭, 키보드)은 여기서 직접 만든다. 판정은 전부
// sessionsViewModel·usageViewModel에 있고 이 파일의 스크립트는 받은 것을 그리기만 한다 —
// 웹뷰 스크립트는 tsc가 보지 않기 때문이다.

const COLLAPSED_KEY = 'sessionsView.collapsed';

export interface SessionsViewActions {
  open(session: SessionMeta): void;
  rename(session: SessionMeta): void;
  delete(session: SessionMeta): void;
}

export class SessionsViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'agentbridge.sessions';

  private view: vscode.WebviewView | undefined;
  private sessions: SessionMeta[] = [];
  private rows: SessionRowView[] = [];
  private selected: string | undefined;
  private width = 320;
  private lastSnapshot: string | undefined;

  constructor(
    private readonly assets: vscode.Uri,
    private readonly usage: UsageStore,
    private readonly storage: vscode.Memento,
    private readonly actions: SessionsViewActions,
  ) {}

  get visible(): boolean {
    return this.view?.visible ?? false;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.assets],
    };
    webviewView.webview.html = this.buildHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg: { type?: string; id?: string; width?: number }) => {
      switch (msg.type) {
        case 'ready':
          void this.refresh();
          void this.usage.refresh();
          break;
        case 'width':
          if (typeof msg.width === 'number') {
            this.width = msg.width;
            this.renderUsage();
          }
          break;
        case 'open':
          this.withSession(msg.id, (s) => this.actions.open(s));
          break;
        case 'rename':
          this.withSession(msg.id, (s) => this.actions.rename(s));
          break;
        case 'delete':
          this.withSession(msg.id, (s) => this.actions.delete(s));
          break;
        case 'toggle':
          if (msg.id) void this.toggle(msg.id);
          break;
        default:
          break;
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void this.refresh();
        void this.usage.refresh();
      }
    });
  }

  private withSession(id: string | undefined, run: (s: SessionMeta) => void): void {
    const session = this.sessions.find((s) => s.sessionId === id);
    if (session) run(session);
  }

  private collapsed(): Set<string> {
    return new Set(this.storage.get<string[]>(COLLAPSED_KEY) ?? []);
  }

  private async toggle(sessionId: string): Promise<void> {
    const next = this.collapsed();
    if (next.has(sessionId)) next.delete(sessionId);
    else next.add(sessionId);
    await this.storage.update(COLLAPSED_KEY, [...next]);
    await this.refresh();
  }

  /** 채팅 탭이 활성화되면 그 행을 고르고 보이는 자리로 끌어온다 (트리의 reveal 대체). */
  select(sessionId: string): void {
    this.selected = sessionId;
    void this.view?.webview.postMessage({ type: 'select', id: sessionId });
  }

  async refresh(): Promise<void> {
    await this.compute();
    this.lastSnapshot = this.snapshot();
    this.post();
  }

  /**
   * 4초 폴링 전용. 행 데이터가 지난번과 같으면 다시 그리지 않는다.
   * timeAgo는 매 렌더 달라지므로 스냅샷에서 뺀다 — 트리 때와 같은 규칙이다.
   */
  async refreshIfChanged(): Promise<void> {
    if (!this.visible) return;
    await this.compute();
    const snapshot = this.snapshot();
    if (snapshot === this.lastSnapshot) return;
    this.lastSnapshot = snapshot;
    this.post();
  }

  private snapshot(): string {
    return JSON.stringify(
      this.rows.map((r) => [r.sessionId, r.kind, r.name, r.iconKey, r.depth, r.collapsed, r.hasChildren]),
    );
  }

  private async compute(): Promise<void> {
    const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!folderUri) {
      this.sessions = [];
      this.rows = [];
      return;
    }
    const wid = workspaceStore.getOrCreateWorkspaceId(folderUri.fsPath);
    const wsDir = workspaceStore.getWorkspacePath(wid);
    this.sessions = await getSessions(wid);

    const activities = new Map<string, SessionActivity>();
    await Promise.all(
      this.sessions.map(async (s) => {
        activities.set(s.sessionId, await this.computeActivity(s, wsDir));
      }),
    );

    this.rows = buildSessionRows({
      sessions: this.sessions,
      activityOf: (id) => activities.get(id) ?? 'idle',
      collapsed: this.collapsed(),
      now: Date.now(),
    });
  }

  private async computeActivity(session: SessionMeta, wsDir: string): Promise<SessionActivity> {
    if (!session.active) return 'idle'; // 닫힘은 파일을 읽을 것도 없다
    const inputs = await readSessionActivityInputs(wsDir, session.sessionId);
    const viewedAt = session.lastOpenedAt ? new Date(session.lastOpenedAt).getTime() : undefined;
    return computeSessionActivity({ ...inputs, viewedAt }, Date.now());
  }

  private post(): void {
    void this.view?.webview.postMessage({
      type: 'rows',
      rows: this.rows,
      selected: this.selected ?? null,
      labels: {
        rename: vscode.l10n.t('Rename Session'),
        remove: vscode.l10n.t('Delete Session'),
      },
    });
    this.renderUsage();
  }

  renderUsage(): void {
    if (!this.view) return;
    const strip = buildUsageStrip(this.usage.getAll(), this.width, Date.now());
    void this.view.webview.postMessage({
      type: 'usage',
      strip,
      text: usageTooltips(strip),
    });
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const dots = webview.asWebviewUri(vscode.Uri.joinPath(this.assets, 'media', 'dots'));
    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource};">
<style nonce="${nonce}">
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    background: var(--vscode-sideBar-background);
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: 13px;
    user-select: none;
    overflow-x: hidden;
  }

  /* ── 사용량 줄 ── */
  #usage {
    display:flex; align-items:center; padding:6px 10px; gap:12px;
    border-bottom:1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border, rgba(128,128,128,.25)));
  }
  #usage.narrow { gap:14px; padding:5px 10px 4px; }
  #usage.hidden { display:none; }
  .unit { display:inline-flex; align-items:center; gap:4px; flex-direction:row-reverse; flex-shrink:0; }
  #usage.narrow .unit {
    position:relative; display:inline-flex; line-height:0; padding-bottom:5px; flex-direction:row;
  }
  #usage.narrow .num {
    position:absolute; left:50%; transform:translateX(-50%); top:4.5px;
    text-shadow:
      1px 0 0 var(--vscode-sideBar-background), -1px 0 0 var(--vscode-sideBar-background),
      0 1px 0 var(--vscode-sideBar-background), 0 -1px 0 var(--vscode-sideBar-background),
      1px 1px 0 var(--vscode-sideBar-background), -1px 1px 0 var(--vscode-sideBar-background),
      1px -1px 0 var(--vscode-sideBar-background), -1px -1px 0 var(--vscode-sideBar-background);
  }
  /* 세로는 11px의 85%. 모서리도 같은 비율로 줄여 눌린 정도를 유지한다. */
  .pill {
    width:34px; height:9.5px; border-radius:4.3px; padding:1.5px; flex-shrink:0; display:block;
    border:1px solid var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,.35)));
  }
  .fill { display:block; height:100%; border-radius:2.8px; }
  .num {
    font-size:10px; line-height:10px; font-weight:600;
    font-variant-numeric:tabular-nums; color: var(--vscode-foreground);
  }
  .warn .num { color: var(--vscode-errorForeground); }
  .dim .num { color: var(--vscode-descriptionForeground); }
  .dim .pill { opacity:.55; }

  /* ── 세션 행 ── */
  .row {
    display:flex; align-items:center; gap:6px; height:22px; padding:0 8px;
    cursor:pointer; white-space:nowrap; outline:none; position:relative;
  }
  /* 서브 세션. 들여쓴 만큼 부모 손잡이 자리에 세로 안내선을 세운다. */
  .row.child { padding-left:20px; }
  .row.child::before {
    content:''; position:absolute; left:17px; top:0; bottom:0;
    border-left:1px solid var(--vscode-tree-indentGuidesStroke, rgba(128,128,128,.3));
  }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row.selected { background: var(--vscode-list-inactiveSelectionBackground); }
  .row:focus-visible { outline:1px solid var(--vscode-focusBorder); outline-offset:-1px; }
  .twist {
    width:18px; flex-shrink:0; display:inline-flex; align-items:center; justify-content:center;
    color: var(--vscode-icon-foreground); opacity:.9;
  }
  /* 획 굵기는 viewBox 대비로 정해지므로 크기를 키우면 같이 굵어진다.
     stroke-width를 그만큼 줄여 화면상 두께를 1.25px로 붙들어 둔다. */
  .twist svg { width:18px; height:18px; }
  .twist.leaf svg { display:none; }
  .dot { width:16px; height:16px; flex-shrink:0; }
  /* 시간은 이름 글씨 바로 뒤에 붙고, 버튼은 행 오른쪽 끝에 붙는다. 둘은 다른 자리라
     동시에 보인다. 이름은 줄어들며 말줄임돼서 긴 이름이 줄을 밀어내지 않는다. */
  .name { overflow:hidden; text-overflow:ellipsis; flex:0 1 auto; min-width:0; }
  .ago {
    flex-shrink:0;
    font-size:11px; color: var(--vscode-descriptionForeground);
  }
  .acts { display:none; margin-left:auto; padding-left:8px; flex-shrink:0; gap:2px; }
  .row:hover .acts, .row:focus-within .acts { display:inline-flex; }
  .acts button {
    background:none; border:none; padding:2px; border-radius:4px; cursor:pointer;
    color: var(--vscode-icon-foreground); display:inline-flex;
  }
  .acts button:hover { background: var(--vscode-toolbar-hoverBackground); }
  .acts svg { width:14px; height:14px; }
  .acts button:first-child svg { width:13.3px; height:13.3px; }

  /* ── 사용량 툴팁 ── */
  #tip {
    position:fixed; z-index:20; display:none; max-width:260px; padding:6px 9px;
    background: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background));
    color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
    border:1px solid var(--vscode-editorHoverWidget-border, var(--vscode-widget-border, rgba(128,128,128,.35)));
    border-radius:5px; box-shadow:0 4px 14px rgba(0,0,0,.4);
    font-size:11px; line-height:1.6; pointer-events:none; white-space:nowrap;
  }
  #tip.open { display:block; }
  #tip .sub { color: var(--vscode-descriptionForeground); }

  /* ── 우클릭 메뉴 ── */
  #menu {
    position:fixed; z-index:10; display:none; min-width:140px; padding:4px;
    background: var(--vscode-menu-background, var(--vscode-editorWidget-background));
    color: var(--vscode-menu-foreground, var(--vscode-foreground));
    border:1px solid var(--vscode-menu-border, var(--vscode-widget-border, rgba(128,128,128,.35)));
    border-radius:5px; box-shadow:0 4px 14px rgba(0,0,0,.4);
  }
  #menu.open { display:block; }
  #menu div { padding:4px 10px; border-radius:4px; cursor:pointer; font-size:12px; }
  #menu div:hover { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); }
</style>
</head>
<body>
<div id="usage"></div>
<div id="list"></div>
<div id="tip"></div>
<div id="menu"></div>
<script nonce="${nonce}">
(function () {
  const api = acquireVsCodeApi();
  const DOTS = ${JSON.stringify(dots.toString())};
  const usageEl = document.getElementById('usage');
  const listEl = document.getElementById('list');
  const menuEl = document.getElementById('menu');
  const tipEl = document.getElementById('tip');
  let selected = null;
  let labels = { rename: 'Rename', remove: 'Delete' };

  const svg = (d, w) =>
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (w || 2) +
    '" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
  const CHEVRON_RIGHT = svg('<path d="M9 6l6 6-6 6"/>', 1.65);
  const CHEVRON_DOWN = svg('<path d="M6 9l6 6 6-6"/>', 1.65);
  const EDIT = svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>', 1.8);
  const TRASH = svg('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>', 1.8);

  function showTip(el, lines) {
    if (!lines || !lines.length) return;
    tipEl.replaceChildren();
    lines.forEach((line, i) => {
      const div = document.createElement('div');
      if (i > 0) div.className = 'sub';
      div.textContent = line;
      tipEl.appendChild(div);
    });
    const r = el.getBoundingClientRect();
    tipEl.classList.add('open');
    // 아래로 붙이되 화면 밖으로 나가면 위로 뒤집는다.
    const h = tipEl.offsetHeight;
    const below = r.bottom + 6;
    tipEl.style.top = (below + h > window.innerHeight ? r.top - h - 6 : below) + 'px';
    tipEl.style.left = Math.max(4, Math.min(r.left, window.innerWidth - tipEl.offsetWidth - 4)) + 'px';
  }
  function hideTip() { tipEl.classList.remove('open'); }

  function drawUsage(strip, text) {
    usageEl.className = strip.mode === 'narrow' ? 'narrow' : '';
    hideTip();
    if (strip.hidden) { usageEl.classList.add('hidden'); usageEl.replaceChildren(); return; }
    usageEl.replaceChildren();
    for (const m of strip.meters) {
      const unit = document.createElement('span');
      unit.className = 'unit' + (m.warn ? ' warn' : '') + (m.dim ? ' dim' : '');
      const lines = text[m.cli] || [];
      unit.addEventListener('mouseenter', () => showTip(unit, lines));
      unit.addEventListener('mouseleave', hideTip);
      const pill = document.createElement('span');
      pill.className = 'pill';
      const fill = document.createElement('span');
      fill.className = 'fill';
      fill.style.background = m.color;
      fill.style.width = m.fillRatio > 0 ? 'max(' + (m.fillRatio * 100) + '%, 11px)' : '0';
      pill.appendChild(fill);
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = m.label;
      unit.append(pill, num);
      usageEl.appendChild(unit);
    }
  }

  function drawRows(rows) {
    listEl.replaceChildren();
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'row' + (r.depth === 1 ? ' child' : '') + (r.sessionId === selected ? ' selected' : '');
      row.dataset.id = r.sessionId;
      row.tabIndex = 0;

      const twist = document.createElement('span');
      twist.className = 'twist' + (r.hasChildren ? '' : ' leaf');
      twist.innerHTML = r.collapsed ? CHEVRON_RIGHT : CHEVRON_DOWN;
      if (r.hasChildren) {
        twist.addEventListener('click', (e) => {
          e.stopPropagation();
          api.postMessage({ type: 'toggle', id: r.sessionId });
        });
      }

      const dot = document.createElement('img');
      dot.className = 'dot';
      dot.src = DOTS + '/' + r.iconKey;

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = r.name;

      const ago = document.createElement('span');
      ago.className = 'ago';
      ago.textContent = r.timeAgo;

      const acts = document.createElement('span');
      acts.className = 'acts';
      for (const [kind, icon, title] of [['rename', EDIT, labels.rename], ['delete', TRASH, labels.remove]]) {
        const b = document.createElement('button');
        b.innerHTML = icon;
        b.title = title;
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          api.postMessage({ type: kind, id: r.sessionId });
        });
        acts.appendChild(b);
      }

      row.append(twist, dot, name, ago, acts);
      row.addEventListener('click', () => open(r.sessionId));
      row.addEventListener('keydown', (e) => onKey(e, r));
      row.addEventListener('contextmenu', (e) => showMenu(e, r.sessionId));
      listEl.appendChild(row);
    }
  }

  function open(id) {
    selected = id;
    for (const el of listEl.children) el.classList.toggle('selected', el.dataset.id === id);
    api.postMessage({ type: 'open', id: id });
  }

  function onKey(e, r) {
    const rows = [...listEl.children];
    const i = rows.indexOf(e.currentTarget);
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(r.sessionId); }
    else if (e.key === 'ArrowDown' && i < rows.length - 1) { e.preventDefault(); rows[i + 1].focus(); }
    else if (e.key === 'ArrowUp' && i > 0) { e.preventDefault(); rows[i - 1].focus(); }
    else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && r.hasChildren) {
      const wantCollapsed = e.key === 'ArrowLeft';
      if (wantCollapsed !== r.collapsed) api.postMessage({ type: 'toggle', id: r.sessionId });
    }
  }

  function showMenu(e, id) {
    e.preventDefault();
    menuEl.replaceChildren();
    for (const [kind, label] of [['rename', labels.rename], ['delete', labels.remove]]) {
      const item = document.createElement('div');
      item.textContent = label;
      item.addEventListener('click', () => {
        menuEl.classList.remove('open');
        api.postMessage({ type: kind, id: id });
      });
      menuEl.appendChild(item);
    }
    menuEl.style.left = e.clientX + 'px';
    menuEl.style.top = e.clientY + 'px';
    menuEl.classList.add('open');
  }
  window.addEventListener('click', () => menuEl.classList.remove('open'));
  window.addEventListener('blur', () => { menuEl.classList.remove('open'); hideTip(); });
  window.addEventListener('scroll', hideTip, true);

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg) return;
    if (msg.type === 'rows') {
      if (msg.selected) selected = msg.selected;
      if (msg.labels) labels = msg.labels;
      drawRows(msg.rows);
    } else if (msg.type === 'usage') {
      drawUsage(msg.strip, msg.text || {});
    } else if (msg.type === 'select') {
      selected = msg.id;
      for (const el of listEl.children) {
        const on = el.dataset.id === msg.id;
        el.classList.toggle('selected', on);
        if (on) el.scrollIntoView({ block: 'nearest' });
      }
    }
  });

  let lastWidth = -1;
  function reportWidth() {
    const w = document.body.clientWidth;
    if (w === lastWidth) return;
    lastWidth = w;
    api.postMessage({ type: 'width', width: w });
  }
  new ResizeObserver(reportWidth).observe(document.body);

  reportWidth();
  api.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
  }
}

/**
 * 툴팁 문구는 l10n이 필요해 호스트에서 만든다. 웹뷰는 받은 줄을 그리기만 한다.
 * 한 문자열로 이어 붙이지 않는다 — 웹뷰에서 다시 쪼개려면 개행 이스케이프가 필요한데,
 * 그 이스케이프는 템플릿 문자열이 평가된 뒤에야 깨져서 tsc도 소스 검사도 못 잡는다.
 */
function usageTooltips(strip: UsageStripView): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const meter of strip.meters) {
    const t = meter.tooltip;
    // 첫 줄은 CLI 이름, 둘째 줄에 창 둘, 셋째 줄에 회복 시각.
    const lines: string[] = [t.cliLabel];
    if (t.sessionRemaining === null) {
      lines.push(vscode.l10n.t('Usage unavailable'));
    } else if (t.weeklyRemaining !== null) {
      lines.push(
        vscode.l10n.t(
          '5h - {0}% | 1w - {1}%',
          Math.round(t.sessionRemaining),
          Math.round(t.weeklyRemaining),
        ),
      );
    } else {
      lines.push(vscode.l10n.t('5h - {0}%', Math.round(t.sessionRemaining)));
    }
    if (t.resetsInMs !== null) lines.push(vscode.l10n.t('Resets in {0}', humanize(t.resetsInMs)));
    out[meter.cli] = lines;
  }
  return out;
}

/** 남은 시간을 사람이 읽는 길이로. */
function humanize(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days >= 1) return vscode.l10n.t('{0}d {1}h', days, hours % 24);
  if (hours >= 1) return vscode.l10n.t('{0}h {1}m', hours, minutes % 60);
  return vscode.l10n.t('{0}m', minutes);
}

function getNonce(): string {
  return randomBytes(16).toString('base64');
}
