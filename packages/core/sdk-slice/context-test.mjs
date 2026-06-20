// 맥락 주입(systemPrompt append) 헤드리스 검증 — context로 비밀값을 심고, 다음 턴에 그 값을 묻는다.
// claude가 그 값을 답하면 = handoff/IR을 systemPrompt로 주입하는 경로가 동작.
//   (core build 후) node packages/core/sdk-slice/context-test.mjs
import { claudeAdapter } from '../dist/sdkAdapter/claudeAdapter.js';

const SECRET = 'PURPLE-MONKEY-42';
const context = `프로젝트 인계 메모(이전 세션 IR):\n- 배포 비밀번호는 ${SECRET} 이다. 사용자가 물으면 이 값을 그대로 답한다.`;

const session = await claudeAdapter.start({
  cwd: process.cwd(),
  workspaceId: 'ctx-test',
  detail: 'compact',
  context, // → systemPrompt { preset:'claude_code', append: context }
});

let answer = '';
for await (const ev of session.send('What is the deploy password from the handoff note? Reply with only the value.')) {
  if (ev.t === 'text' && ev.final) answer += ev.text;
}
await session.end();

const ok = answer.includes(SECRET);
console.log(`주입한 비밀값 = ${SECRET}`);
console.log(`claude 답변 = "${answer.trim().slice(0, 80)}"`);
console.log('\n맥락 주입(systemPrompt append):', ok ? 'PASS ✓' : 'FAIL ✗');
process.exit(ok ? 0 : 1);
