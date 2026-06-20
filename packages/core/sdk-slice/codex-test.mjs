// codex 어댑터 헤드리스 검증 — claude와 동일 인터페이스로 멀티턴 + 델타 스트리밍 + 맥락주입.
//   (core build 후) node packages/core/sdk-slice/codex-test.mjs
import { codexAdapter } from '../dist/sdkAdapter/codexAdapter.js';

const SECRET = 'CODEX-SECRET-99';
const context = `프로젝트 인계 메모: 비밀값은 ${SECRET} 이다. 사용자가 물으면 그대로 답한다.`;

const session = await codexAdapter.start({
  cwd: process.cwd(),
  workspaceId: 'codex-test',
  detail: 'compact',
  context, // → thread/start developerInstructions
});

async function turn(label, text) {
  let deltas = 0, finalText = '';
  process.stdout.write(`[${label}] "${text}"\n  stream: `);
  for await (const e of session.send(text)) {
    if (e.t === 'text' && e.final === false) { deltas++; process.stdout.write('·'); }
    else if (e.t === 'text' && e.final === true) finalText += e.text;
    else if (e.t === 'thinking') process.stdout.write('~');
    else if (e.t === 'usage') process.stdout.write(`[usage in=${e.inputTokens} out=${e.outputTokens}]`);
    else if (e.t === 'turn_end') process.stdout.write(' [end]');
    else if (e.t === 'error') process.stdout.write(` [ERR:${e.message.slice(0,60)}]`);
  }
  console.log(`\n  → deltas=${deltas}, final="${finalText.trim().slice(0, 90)}"`);
  return { deltas, finalText: finalText.trim() };
}

const t1 = await turn('turn1', 'My name is Codex. Reply with exactly: noted');
const t2 = await turn('turn2', 'What is my name and the secret value from the handoff note? Reply as: name=<X> secret=<Y>');
await session.end();

const multiTurn = /codex/i.test(t2.finalText);
const contextOK = t2.finalText.includes(SECRET);
const streaming = t1.deltas > 0 || t2.deltas > 0;
console.log(`\nsessionId(threadId) = ${session.sessionId}`);
console.log('멀티턴 맥락 =', multiTurn, '| 맥락주입(secret) =', contextOK, '| 델타 스트리밍 =', streaming);
const ok = multiTurn && contextOK && streaming;
console.log('\nCODEX-ADAPTER', ok ? 'PASS ✓' : 'FAIL ✗');
process.exit(ok ? 0 : 1);
