// 공유 채팅 헤더 — SDK/PTY 두 웹뷰가 같은 소스로 헤더 바 + 세션/모델 오버레이를 그린다.
//   외관 = SDK 크롬(AgentBridge 타이틀·모델 뱃지·시계/＋ stroke 아이콘)
//   로직·오버레이 = PTY 이식(세션 목록 검색/rename/delete, 모델 선택 드롭다운) — 마크업·CSS·JS 그대로.
// 각 패널이 자기 HTML 템플릿에 끼워 넣는다:
//   <style>에 CHAT_HEADER_CSS, <body> 최상단에 chatHeaderHtml(model),
//   <script>(acquireVsCodeApi() 호출 뒤)에 chatHeaderScript(...). acquireVsCodeApi는 패널이 1회만 부르고
//   여기 IIFE에 `vscode`로 넘긴다(웹뷰당 1회 제약).
// 호스트(패널)가 받아야 하는 메시지: getSessions(→{type:'sessions',sessions}) · openSession ·
//   renameSession · deleteSession · newSessionWithModel.
import type { CliKind } from '@agentbridge/core';

const CLOCK_SVG =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
const PLUS_SVG =
  '<svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
const SEARCH_SVG =
  '<svg viewBox="0 0 16 16"><path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85zm-5.242.156a5 5 0 1 1 0-10 5 5 0 0 1 0 10z"/></svg>';

// 헤더 바(SDK 외관) + PTY 오버레이 마크업. 버튼 id는 PTY 스크립트 호환(btnSelectSession/btnNewSession).
// 뱃지는 id="badge"를 유지(기존 SDK 코드가 모델명으로 갱신).
export function chatHeaderHtml(model: CliKind): string {
  return `<header>
  <span class="title">AgentBridge</span>
  <span class="badge" id="badge">${model}</span>
  <span class="sp"></span>
  <button class="hbtn" id="btnSelectSession" title="History">${CLOCK_SVG}</button>
  <button class="hbtn" id="btnNewSession" title="New session">${PLUS_SVG}</button>
  <div class="sp-overlay" id="spOverlay"></div>
  <div class="session-panel" id="sessionPanel">
    <div class="sp-search"><div class="sp-search-wrap">${SEARCH_SVG}<input type="text" id="spSearchInput" placeholder="Search sessions..." /></div></div>
    <div class="sp-list" id="spList"></div>
  </div>
  <div class="model-panel" id="modelPanel">
    <div class="mp-item" data-model="claude"><span class="mp-item-dot" style="background:#d97757"></span><span class="mp-item-name">Claude</span><span class="mp-item-desc">Anthropic</span></div>
    <div class="mp-item" data-model="codex"><span class="mp-item-dot" style="background:#5D8AF9"></span><span class="mp-item-name">Codex</span><span class="mp-item-desc">OpenAI</span></div>
    <div class="mp-item" data-model="agy"><span class="mp-item-dot" style="background:#8e6cef"></span><span class="mp-item-name">Antigravity</span><span class="mp-item-desc">Google</span></div>
  </div>
</header>`;
}

// SDK 헤더 크롬 CSS + PTY 오버레이 CSS(그대로). --accent 등 모델 포인트색은 각 패널 base CSS가 정의(중복 회피).
// header에 position:relative — 오버레이가 top:100%로 헤더 기준 위치를 잡게 한다.
export const CHAT_HEADER_CSS = `
  header{display:flex;gap:7px;align-items:center;padding:1px 10px;border-bottom:1px solid var(--vscode-panel-border);position:relative}
  .title{font-weight:500;font-size:12px}
  .badge{background:var(--accent);color:#1b1b1d;border-radius:999px;padding:1px 5px;font-size:11px;font-weight:800;letter-spacing:.2px;text-transform:capitalize;line-height:1.35}
  .sp{flex:1}
  .hbtn{width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;border:none;background:none;color:var(--vscode-foreground);cursor:pointer;border-radius:7px}
  #btnNewSession{margin-left:-5px}
  .hbtn:hover{background:var(--vscode-toolbar-hoverBackground)}
  /* PTY 오버레이 (이식 — 마크업·CSS·로직 통째) */
  .session-panel{display:none;position:absolute;top:100%;right:8px;width:320px;max-height:400px;background:var(--vscode-editorWidget-background,#252526);border:1px solid var(--vscode-widget-border,#444);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.4);z-index:100;overflow:hidden;flex-direction:column}
  .session-panel.open{display:flex}
  .sp-search{padding:8px;border-bottom:1px solid var(--vscode-widget-border,#333)}
  .sp-search input{width:100%;padding:6px 8px 6px 28px;border:1px solid var(--vscode-input-border,#444);border-radius:6px;background:var(--vscode-input-background,#1e1e1e);color:var(--vscode-input-foreground,#ccc);font-size:12px;outline:none}
  .sp-search input:focus{border-color:var(--vscode-focusBorder,#007fd4)}
  .sp-search-wrap{position:relative}
  .sp-search-wrap svg{position:absolute;left:8px;top:50%;transform:translateY(-50%);width:14px;height:14px;fill:var(--vscode-descriptionForeground);pointer-events:none}
  .sp-list{overflow-y:auto;max-height:320px;padding:4px 0}
  .sp-item{display:flex;align-items:center;gap:8px;padding:3px 12px;min-height:26px;cursor:pointer;font-size:12px;color:var(--vscode-foreground)}
  .sp-item:hover{background:var(--vscode-list-hoverBackground,rgba(255,255,255,0.06))}
  .sp-item.active{background:var(--vscode-list-activeSelectionBackground,#094771)}
  .sp-item-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sp-item-desc{font-size:11px;color:var(--vscode-descriptionForeground);white-space:nowrap}
  .sp-item-actions{display:none;gap:2px}
  .sp-item:hover .sp-item-actions{display:flex}
  .sp-item:hover .sp-item-desc{display:none}
  .sp-item-actions button{background:transparent;border:none;color:var(--vscode-descriptionForeground);cursor:pointer;width:20px;height:20px;border-radius:4px;display:flex;align-items:center;justify-content:center;padding:0}
  .sp-item-actions button:hover{background:rgba(255,255,255,0.1);color:var(--vscode-foreground)}
  .sp-item-actions button svg{width:14px;height:14px;fill:currentColor}
  .sp-empty{padding:20px;text-align:center;color:var(--vscode-descriptionForeground);font-size:12px}
  .sp-overlay{display:none;position:fixed;inset:0;z-index:99}
  .sp-overlay.open{display:block}
  .model-panel{display:none;position:absolute;top:100%;right:8px;width:180px;background:var(--vscode-editorWidget-background,#252526);border:1px solid var(--vscode-widget-border,#444);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.4);z-index:100;overflow:hidden;padding:4px 0}
  .model-panel.open{display:block}
  .mp-item{display:flex;align-items:center;gap:6px;padding:4px 10px;cursor:pointer;font-size:12px;color:var(--vscode-foreground)}
  .mp-item:hover{background:var(--vscode-list-hoverBackground,rgba(255,255,255,0.06))}
  .mp-item-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
  .mp-item-name{flex:1}
  .mp-item-desc{font-size:11px;color:var(--vscode-descriptionForeground)}`;

// PTY 오버레이 JS(이식). 각 패널의 기존 `vscode`를 IIFE 인자로 받아 재사용(acquireVsCodeApi 재호출 금지).
// ownSessionIdJs = 현재 AgentBridge sessionId의 JS 리터럴(예: JSON.stringify(this.sessionId)) — 목록서 현재 세션 .active 표시.
export function chatHeaderScript(ownSessionIdJs: string): string {
  return `
(function(vscode){
  var sessionPanel = document.getElementById('sessionPanel');
  var modelPanel = document.getElementById('modelPanel');
  var spOverlay = document.getElementById('spOverlay');
  var spList = document.getElementById('spList');
  var spSearchInput = document.getElementById('spSearchInput');
  var allSessions = [];
  function esc(s){ if(!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
  function togglePanel(open){
    var isOpen = open !== undefined ? open : !sessionPanel.classList.contains('open');
    modelPanel.classList.remove('open');
    sessionPanel.classList.toggle('open', isOpen);
    spOverlay.classList.toggle('open', isOpen);
    if(isOpen){ spSearchInput.value=''; vscode.postMessage({type:'getSessions'}); setTimeout(function(){spSearchInput.focus();},50); }
  }
  function toggleModelPanel(open){
    var isOpen = open !== undefined ? open : !modelPanel.classList.contains('open');
    sessionPanel.classList.remove('open');
    modelPanel.classList.toggle('open', isOpen);
    spOverlay.classList.toggle('open', isOpen);
  }
  function renderSessions(sessions){
    if(sessions.length===0){ spList.innerHTML='<div class="sp-empty">No sessions found</div>'; return; }
    spList.innerHTML = sessions.map(function(s){
      var desc = s.active ? 'active' : (s.lastActiveAt || '');
      return '<div class="sp-item'+(s.sessionId===${ownSessionIdJs}?' active':'')+'" data-sid="'+esc(s.sessionId)+'" data-wid="'+esc(s.workspaceId)+'" data-model="'+esc(s.model)+'">'
        + '<span class="sp-item-name">'+esc(s.name)+'</span>'
        + '<span class="sp-item-desc">'+esc(desc)+'</span>'
        + '<div class="sp-item-actions">'
        + '<button class="sp-rename" title="Rename"><svg viewBox="0 0 16 16"><path d="M13.23 1h-1.46L3.52 9.25l-.16.22L1 13.59 2.41 15l4.12-2.36.22-.16L15 4.23V2.77L13.23 1zM2.41 13.59l1.51-3 1.45 1.45-2.96 1.55zm3.83-2.06L4.47 9.76l6.69-6.69 1.77 1.77-6.69 6.69z"/></svg></button>'
        + '<button class="sp-delete" title="Delete"><svg viewBox="0 0 16 16"><path d="M14 2H10C10 0.897 9.103 0 8 0C6.897 0 6 0.897 6 2H2C1.724 2 1.5 2.224 1.5 2.5C1.5 2.776 1.724 3 2 3H2.54L3.349 12.708C3.456 13.994 4.55 15 5.84 15H10.159C11.449 15 12.543 13.993 12.65 12.708L13.459 3H13.999C14.275 3 14.499 2.776 14.499 2.5C14.499 2.224 14.275 2 13.999 2H14ZM8 1C8.551 1 9 1.449 9 2H7C7 1.449 7.449 1 8 1ZM11.655 12.625C11.591 13.396 10.934 14 10.16 14H5.841C5.067 14 4.41 13.396 4.346 12.625L3.544 3H12.458L11.656 12.625H11.655ZM7 5.5V11.5C7 11.776 6.776 12 6.5 12C6.224 12 6 11.776 6 11.5V5.5C6 5.224 6.224 5 6.5 5C6.776 5 7 5.224 7 5.5ZM10 5.5V11.5C10 11.776 9.776 12 9.5 12C9.224 12 9 11.776 9 11.5V5.5C9 5.224 9.224 5 9.5 5C9.776 5 10 5.224 10 5.5Z"/></svg></button>'
        + '</div></div>';
    }).join('');
  }
  var btnSel = document.getElementById('btnSelectSession');
  if(btnSel) btnSel.addEventListener('click', function(e){ e.stopPropagation(); togglePanel(); });
  var btnNew = document.getElementById('btnNewSession');
  if(btnNew) btnNew.addEventListener('click', function(e){ e.stopPropagation(); toggleModelPanel(); });
  spOverlay.addEventListener('click', function(){ togglePanel(false); toggleModelPanel(false); });
  spSearchInput.addEventListener('input', function(){
    var q = spSearchInput.value.toLowerCase();
    var filtered = q ? allSessions.filter(function(s){return s.name.toLowerCase().includes(q);}) : allSessions;
    renderSessions(filtered);
  });
  spList.addEventListener('click', function(e){
    var item = e.target.closest('.sp-item');
    if(!item) return;
    var renameBtn = e.target.closest('.sp-rename');
    var deleteBtn = e.target.closest('.sp-delete');
    if(renameBtn){ vscode.postMessage({type:'renameSession',sessionId:item.dataset.sid,workspaceId:item.dataset.wid}); return; }
    if(deleteBtn){ vscode.postMessage({type:'deleteSession',sessionId:item.dataset.sid,workspaceId:item.dataset.wid}); return; }
    vscode.postMessage({type:'openSession',sessionId:item.dataset.sid,workspaceId:item.dataset.wid,model:item.dataset.model});
    togglePanel(false);
  });
  modelPanel.addEventListener('click', function(e){
    var item = e.target.closest('.mp-item');
    if(!item) return;
    vscode.postMessage({type:'newSessionWithModel',model:item.dataset.model});
    toggleModelPanel(false);
  });
  window.addEventListener('message', function(e){
    var msg = e.data;
    if(msg && msg.type==='sessions'){
      allSessions = msg.sessions || [];
      var q = spSearchInput.value.toLowerCase();
      var filtered = q ? allSessions.filter(function(s){return s.name.toLowerCase().includes(q);}) : allSessions;
      renderSessions(filtered);
    }
  });
})(vscode);
`;
}
