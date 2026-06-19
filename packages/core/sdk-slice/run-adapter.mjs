// 1단계 라이브 증명: 지속(멀티턴) 세션 + 델타 스트리밍 + 턴마다 캡처.
//   (core build 후) node packages/core/sdk-slice/run-adapter.mjs
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { claudeAdapter, SdkCapture, readAllTurns } from '../dist/index.js';

function fakeScheduler() {
  const calls = { updated: 0, ran: 0 };
  return { calls, events: { emit: () => { calls.updated++; } }, checkAndRun: async () => { calls.ran++; } };
}

const root = await fs.mkdtemp(join(tmpdir(), 'sdk-p1-'));
const sched = fakeScheduler();
const capture = new SdkCapture({
  workspaceId: 'p1-ws', workspaceRoot: root, workspacePath: process.cwd(), model: 'claude', scheduler: sched,
});

const session = await claudeAdapter.start({
  cwd: process.cwd(), workspaceId: 'p1-ws', detail: 'compact',
  onTurn: (t) => capture.accept(t),
});

// 한 턴을 돌리고 (델타 수, 최종 텍스트)를 모은다.
async function turn(label, text) {
  let deltas = 0;
  let finalText = '';
  process.stdout.write(`\n[${label}] "${text}"\n  stream: `);
  for await (const e of session.send(text)) {
    if (e.t === 'text' && e.final === false) { deltas++; process.stdout.write('·'); }
    else if (e.t === 'text' && e.final === true) finalText += e.text;
    else if (e.t === 'thinking') process.stdout.write('~');
    else if (e.t === 'turn_end') process.stdout.write(` [end:${e.reason}]`);
  }
  console.log(`\n  → deltas=${deltas}, final="${finalText.trim().slice(0, 80)}"`);
  return { deltas, finalText: finalText.trim() };
}

const t1 = await turn('turn1', 'My name is Hyeongtae. Reply with exactly: noted');
const t2 = await turn('turn2', "What is my name? Reply with only the name, nothing else.");

await session.end();

const turns = await readAllTurns(root);
console.log('\n=== 검증 ===');
console.log('turns.jsonl 턴 수 =', turns.length, '| sessionId =', session.sessionId);
console.log('checkAndRun 호출 =', sched.calls.ran);

const multiTurnOK = /hyeongtae/i.test(t2.finalText);   // 2턴이 1턴 맥락을 기억하나
const streamingOK = t1.deltas > 0 || t2.deltas > 0;    // 델타가 흘렀나(한 방 덤프 아님)
const captureOK = turns.length === 2 && turns.every((t) => t.id.startsWith('claude:'));
console.log('멀티턴 맥락 유지 =', multiTurnOK, '| 델타 스트리밍 =', streamingOK, '| 캡처 2턴 =', captureOK);

const ok = multiTurnOK && streamingOK && captureOK;
console.log('\nPHASE-1', ok ? 'PASS ✓' : 'FAIL ✗');
await fs.rm(root, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
