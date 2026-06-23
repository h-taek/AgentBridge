// 웹뷰 마크다운 렌더러 — markdown-it을 esbuild로 브라우저 IIFE 번들(out/webview/markdown.js)해
// sdkChatPanel 웹뷰가 nonce 단 <script src>로 로드한다. 인라인 md()가 window.renderMarkdown에 위임.
//   html:false   → 원문 raw HTML 이스케이프 (모델·파일 내용發 XSS 차단)
//   breaks:true  → 단일 개행도 <br> (LLM 출력은 줄 단위 의미가 있어 기존 직접파서 동작 유지)
//   linkify:true → 맨 URL 자동 링크 (클릭은 패널이 가로채 openExternal로 외부 오픈)
// 스트리밍(미완성 마크다운: 안 닫힌 코드펜스·절반만 온 표)은 markdown-it이 관대하게 렌더.
import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

(globalThis as Record<string, unknown>).renderMarkdown = function (src: unknown): string {
  return md.render(typeof src === 'string' ? src : String(src ?? ''));
};
