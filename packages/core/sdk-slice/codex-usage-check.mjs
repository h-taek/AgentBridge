// codex getAccountUsage() 어댑터 경유 검증.
import { codexAdapter } from '../dist/sdkAdapter/codexAdapter.js';
const s = await codexAdapter.start({ cwd: process.cwd(), workspaceId: 'cx-ws', detail: 'compact' });
const u = await s.getAccountUsage();
console.log('account:', JSON.stringify(u.account));
console.log('limits :', u.limits.map((l) => `${l.label} ${l.percent}% (reset ${l.resetsAt ?? '—'})`).join(' | ') || '(없음)');
console.log('contributors:', u.contributors ? 'present' : '(없음 — 예상대로)');
await s.end();
const ok = Boolean(u.account.email) && u.limits.some((l) => /Session/.test(l.label)) && u.limits.some((l) => /Weekly/.test(l.label));
console.log('\nCODEX getAccountUsage', ok ? 'PASS ✓' : 'FAIL ✗');
process.exit(ok ? 0 : 1);
