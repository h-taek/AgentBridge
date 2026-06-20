// 설정 1차 엔진 검증 — claude getAccountUsage()/setThinking()를 어댑터 경유로 라이브 확인.
//   (core build 후) node packages/core/sdk-slice/catalog-engine-test.mjs
import { claudeAdapter } from '../dist/sdkAdapter/claudeAdapter.js';

const s = await claudeAdapter.start({ cwd: process.cwd(), workspaceId: 'cat-ws', detail: 'compact' });

function showUsage(label, u) {
  console.log(`\n[${label}]`);
  console.log('  account:', JSON.stringify(u.account));
  console.log('  limits :', u.limits.length ? u.limits.map((l) => `${l.label} ${l.percent}% (reset ${l.resetsAt ?? '—'})`).join(' | ') : '(없음)');
  if (u.contributors) {
    const d = u.contributors.day;
    console.log('  contributors.day.behaviors:', d.behaviors.map((b) => `${b.key}:${b.pct}`).join(', '));
    console.log('  contributors.week.skills  :', u.contributors.week.skills.map((x) => `${x.name}:${x.pct}`).join(', ') || '(없음)');
  } else console.log('  contributors: (없음)');
}

console.log('### before any send (패널을 send 전에 여는 경우) ###');
showUsage('before', await s.getAccountUsage());

// Thinking 토글 — 던지지 않으면 통과
let thinkOK = true;
try { await s.setThinking(false); await s.setThinking(true); } catch (e) { thinkOK = false; console.log('setThinking 실패:', e?.message); }
console.log('\nsetThinking(false/true) =', thinkOK ? 'OK' : 'FAIL');

// 한 턴 보낸 뒤 다시
for await (const e of s.send('Reply with exactly: hi')) { if (e.t === 'approval') s.respondApproval(e.id, false); }
console.log('\n### after one send ###');
const after = await s.getAccountUsage();
showUsage('after', after);

await s.end();

const accountOK = Boolean(after.account.email) && Boolean(after.account.plan);
const limitsOK = after.limits.some((l) => /Session/.test(l.label)) && after.limits.some((l) => /Weekly/.test(l.label));
const contribOK = Boolean(after.contributors?.day?.behaviors?.length);
console.log('\n=== 검증 ===');
console.log('계정정보(email+plan) =', accountOK, '| 한도(Session+Weekly) =', limitsOK, '| 기여도 분석 =', contribOK, '| thinking 토글 =', thinkOK);
const ok = accountOK && limitsOK && contribOK && thinkOK;
console.log('\nCATALOG-1차(Account+Thinking)', ok ? 'PASS ✓' : 'FAIL ✗');
process.exit(ok ? 0 : 1);
