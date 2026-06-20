// interrupt 헤드리스 검증(claude) — 긴 출력 도중 interrupt() → 스트림이 조기 종료되나.
//   (core build 후) node packages/core/sdk-slice/interrupt-test.mjs
import { claudeAdapter } from '../dist/sdkAdapter/claudeAdapter.js';

const session = await claudeAdapter.start({ cwd: process.cwd(), workspaceId: 'interrupt-test', detail: 'compact' });

let deltas = 0, interrupted = false, ended = false, endReason = '';
process.stdout.write('stream: ');
const stream = session.send('Count from 1 to 200, one number per line, slowly. Do not stop early.');
for await (const ev of stream) {
  if (ev.t === 'text' && ev.final === false) {
    deltas++;
    process.stdout.write('·');
    if (deltas === 5 && !interrupted) {
      interrupted = true;
      console.log('\n  ⏹  interrupt() at delta 5');
      await session.interrupt();
      process.stdout.write('  after-interrupt: ');
    }
  } else if (ev.t === 'turn_end') { ended = true; endReason = ev.reason; process.stdout.write(` [end:${ev.reason}]`); }
  else if (ev.t === 'error') process.stdout.write(` [ERR:${ev.message.slice(0,50)}]`);
}
await session.end();

// 200까지 안 셌으면(델타가 200줄보다 훨씬 적게 끝) interrupt가 먹은 것. turn_end도 와야 정상 종료.
console.log(`\n\ndeltas=${deltas}, interrupted=${interrupted}, ended=${ended} (reason=${endReason})`);
const ok = interrupted && ended && deltas < 200; // 조기 종료
console.log('INTERRUPT', ok ? 'PASS ✓' : 'FAIL ✗', `| 200 미만 델타로 종료=${deltas < 200}`);
process.exit(ok ? 0 : 1);
