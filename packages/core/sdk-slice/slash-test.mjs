// 6-4 검증: claude init이 slash_commands를 'commands' ChatEvent로 방출하나.
import { claudeAdapter } from '../dist/sdkAdapter/claudeAdapter.js';
const s = await claudeAdapter.start({ cwd: process.cwd(), workspaceId:'slash-ws', detail:'compact' });
let cmds = null;
for await (const e of s.send('Reply with exactly: hi')) {
  if (e.t === 'commands') cmds = e.commands;
  else if (e.t === 'approval') s.respondApproval(e.id, false);
}
await s.end();
console.log('commands 이벤트 수신 =', Array.isArray(cmds));
console.log('개수 =', cmds ? cmds.length : 0);
console.log('예시 =', cmds ? cmds.slice(0, 12).join(', ') : '(none)');
const ok = Array.isArray(cmds) && cmds.length > 0;
console.log('\nPHASE-6-4', ok ? 'PASS ✓' : 'FAIL ✗');
process.exit(ok ? 0 : 1);
