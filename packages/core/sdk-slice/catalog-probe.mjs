// 설정 카탈로그 1차+2차 — claude SDK 실응답 probe (배선 전 shape 확정).
//   (core build 불필요 — SDK 직접) node packages/core/sdk-slice/catalog-probe.mjs
// raw Query 메서드를 직접 호출해 각 항목의 실제 응답 구조를 덤프한다.
import { query } from '@anthropic-ai/claude-agent-sdk';

// 입력 스트림(streaming-input mode) — 일부 메서드는 init(첫 입력) 이후라야 의미값.
function makeInput() {
  const items = [];
  let resolve = null;
  let closed = false;
  const q = {
    push(v) { items.push(v); if (resolve) { const r = resolve; resolve = null; r(); } },
    close() { closed = true; if (resolve) { const r = resolve; resolve = null; r(); } },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (items.length) { yield items.shift(); continue; }
        if (closed) return;
        await new Promise((r) => (resolve = r));
      }
    },
  };
  return q;
}

function dump(label, v) {
  console.log(`\n──── ${label} ────`);
  if (v === undefined) { console.log('  (undefined)'); return; }
  if (v === null) { console.log('  (null)'); return; }
  if (Array.isArray(v)) {
    console.log(`  Array(${v.length})`);
    if (v.length) console.log('  [0] keys:', Object.keys(v[0] ?? {}).join(', '));
    console.log('  ', JSON.stringify(v.slice(0, 3), null, 2).slice(0, 1600));
    return;
  }
  if (typeof v === 'object') {
    console.log('  keys:', Object.keys(v).join(', '));
    console.log('  ', JSON.stringify(v, null, 2).slice(0, 2400));
    return;
  }
  console.log('  ', JSON.stringify(v));
}

async function tryCall(label, fn) {
  try { dump(label, await fn()); }
  catch (e) { console.log(`\n──── ${label} ────\n  ✗ ${e instanceof Error ? e.message : String(e)}`); }
}

const input = makeInput();
const q = query({
  prompt: input,
  options: {
    cwd: process.cwd(),
    canUseTool: async () => ({ behavior: 'deny', message: 'probe' }),
  },
});

// q의 실제 메서드 목록(이 SDK 버전서 무엇이 callable인지 확정)
const methods = new Set();
for (let o = q; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
  for (const k of Object.getOwnPropertyNames(o)) if (typeof q[k] === 'function') methods.add(k);
}
console.log('=== q 메서드 목록 ===\n  ' + [...methods].sort().join(', ') + '\n');
console.log('  usage 존재?', typeof q.usage, '| getContextUsage?', typeof q.getContextUsage, '| setMaxThinkingTokens?', typeof q.setMaxThinkingTokens, '| mcpServerStatus?', typeof q.mcpServerStatus, '| rewindFiles?', typeof q.rewindFiles);

// 백그라운드로 메시지를 계속 소비(컨트롤 응답 처리하려면 루프가 살아있어야 함 — break 금지).
let initSeen = false, resultSeen = false;
const pump = (async () => {
  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init') {
      initSeen = true;
      console.log('=== init 도착 ===');
      console.log('  session_id:', m.session_id, '| model:', m.model);
      console.log('  init keys:', Object.keys(m).join(', '));
      console.log('  output_style:', m.output_style, '| available_output_styles:', JSON.stringify(m.available_output_styles));
      if (m.agents) console.log('  agents:', JSON.stringify(m.agents).slice(0, 300));
      if (m.fast_mode_state !== undefined) console.log('  fast_mode_state:', JSON.stringify(m.fast_mode_state));
    } else if (m.type === 'result') {
      resultSeen = true;
    }
  }
})().catch((e) => console.log('pump err:', e?.message));

console.log('### BEFORE 첫 턴 (입력 전) ###');
await tryCall('accountInfo() [before]', () => q.accountInfo());

// 첫 턴 — init 트리거
input.push({ type: 'user', message: { role: 'user', content: 'Reply with exactly: hi' }, parent_tool_use_id: null });

// 턴 완료 대기(최대 ~40s) — 단, pump는 계속 살아있음
for (let i = 0; i < 400 && !resultSeen; i++) await new Promise((r) => setTimeout(r, 100));

console.log('\n\n### AFTER 첫 턴 (pump 살아있는 상태로 컨트롤 호출) ###');
await tryCall('accountInfo()', () => q.accountInfo());
// 실험 usage — Account 화면(Session/Weekly/기여도 분석) 출처 후보
const expUsage = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET';
if (typeof q[expUsage] === 'function') {
  await tryCall('usage_EXPERIMENTAL().rate_limits.limits', async () => { const u = await q[expUsage](); return u.rate_limits?.limits; });
  await tryCall('usage_EXPERIMENTAL().behaviors  ← 기여도 분석/Skills·Subagents·Plugins?', async () => { const u = await q[expUsage](); return u.behaviors; });
}
if (typeof q.getContextUsage === 'function') {
  await tryCall('getContextUsage().apiUsage  ← 한도 데이터 있나', async () => { const u = await q.getContextUsage(); return u.apiUsage; });
}
await tryCall('initializationResult().available_output_styles', async () => { const r = await q.initializationResult(); return { output_style: r.output_style, available_output_styles: r.available_output_styles }; });
await tryCall('supportedAgents()', () => q.supportedAgents());
if (typeof q.mcpServerStatus === 'function') await tryCall('mcpServerStatus()', () => q.mcpServerStatus());
if (typeof q.setMaxThinkingTokens === 'function') await tryCall('setMaxThinkingTokens(0)', async () => { await q.setMaxThinkingTokens(0); return 'ok'; });

input.close();
await pump;
process.exit(0);
