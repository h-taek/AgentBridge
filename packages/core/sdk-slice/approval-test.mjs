// 승인 라운드트립 헤드리스 검증(codex, approvalPolicy=untrusted라 모든 명령 전 승인 요청).
// 'approval' 이벤트 → respondApproval(true) → 명령 진행. (검증 후 정책은 on-request로 되돌림)
//   (core build 후) node packages/core/sdk-slice/approval-test.mjs
import { codexAdapter } from '../dist/sdkAdapter/codexAdapter.js';

const session = await codexAdapter.start({ cwd: process.cwd(), workspaceId: 'codex-approval', detail: 'compact' });

let sawApproval = false, completed = false, gotText = '';
process.stdout.write('stream: ');
for await (const ev of session.send('Run the shell command: echo APPROVAL_ROUNDTRIP_OK')) {
  if (ev.t === 'approval') {
    sawApproval = true;
    console.log(`\n  🔐 APPROVAL: ${ev.title} — ${ev.detail.slice(0, 100)}`);
    console.log('  → respondApproval(approve=true)');
    session.respondApproval(ev.id, true);
    process.stdout.write('  stream: ');
  } else if (ev.t === 'tool') process.stdout.write(`[tool:${ev.name}]`);
  else if (ev.t === 'text' && ev.final) gotText += ev.text;
  else if (ev.t === 'text' && ev.final === false) process.stdout.write('·');
  else if (ev.t === 'turn_end') { completed = true; process.stdout.write(' [end]'); }
  else if (ev.t === 'error') process.stdout.write(` [ERR:${ev.message.slice(0,60)}]`);
}
await session.end();

console.log(`\n\n최종 텍스트: "${gotText.trim().slice(0, 120)}"`);
const ok = sawApproval && completed;
console.log('APPROVAL-ROUNDTRIP', ok ? 'PASS ✓' : 'FAIL ✗', `| approval요청=${sawApproval} 턴완료=${completed}`);
process.exit(ok ? 0 : 1);
