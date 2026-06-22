// agy 어댑터(AgentAdapter/Session) 라이브 증명 — run-adapter.mjs(claude)와 동형.
//   ANTIGRAVITY_HARNESS_PATH=<localharness> node packages/core/sdk-slice/run-agy-adapter.mjs
import fs from 'fs';
import { agyAdapter, readAllTurns } from '../dist/index.js';

// .env → process.env.GEMINI_API_KEY (어댑터가 읽음)
const envPath = new URL('../../../.env', import.meta.url);
let key = fs.readFileSync(envPath, 'utf8').trim();
if (key.includes('=')) key = key.split('=').slice(1).join('=').trim();
process.env.GEMINI_API_KEY = key.replace(/^["']|["']$/g, '');

import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
const root = await fsp.mkdtemp(join(tmpdir(), 'agy-p1-'));
const captured = [];
const session = await agyAdapter.start({ cwd: process.cwd(), workspaceId: 'agy-ws', detail: 'compact', onTurn: (t) => captured.push(t) });

async function turn(label, text) {
  let deltas = 0, finalText = '';
  process.stdout.write(`\n[${label}] "${text}"\n  stream: `);
  for await (const e of session.send(text)) {
    if (e.t === 'text' && e.final === false) { deltas++; process.stdout.write('·'); }
    else if (e.t === 'text' && e.final === true) finalText += e.text;
    else if (e.t === 'thinking') process.stdout.write('~');
    else if (e.t === 'tool') process.stdout.write(`[tool:${e.name}:${e.status}]`);
    else if (e.t === 'turn_end') process.stdout.write(` [end:${e.reason}]`);
    else if (e.t === 'error') process.stdout.write(` [ERR:${e.message}]`);
  }
  console.log(`\n  → deltas=${deltas}, final="${finalText.trim().slice(0, 80)}"`);
  return { deltas, finalText: finalText.trim() };
}

const t1 = await turn('turn1', 'My name is Hyeongtae. Reply with exactly: noted');
const t2 = await turn('turn2', 'What is my name? Reply with only the name.');
await session.end();

void readAllTurns; // (영속은 호스트 SdkCapture 몫 — 여기선 onTurn이 받은 TurnRecord를 직접 검증)
console.log('\n=== 검증 ===');
console.log('captured onTurn =', captured.length, '| ids =', captured.map((t) => t.id), '| sessionId =', session.sessionId);
const multiTurnOK = /hyeongtae/i.test(t2.finalText);
const streamingOK = t1.deltas > 0 || t2.deltas > 0;
const captureOK = captured.length === 2 && captured.every((t) => typeof t.id === 'string' && t.id.startsWith('agy:') && t.assistantBody);
console.log('멀티턴 맥락 =', multiTurnOK, '| 스트리밍 =', streamingOK, '| 캡처2턴 =', captureOK);
console.log('\nAGY-ADAPTER', multiTurnOK && streamingOK && captureOK ? 'PASS ✓' : 'FAIL ✗');
await fsp.rm(root, { recursive: true, force: true });
process.exit(multiTurnOK && streamingOK && captureOK ? 0 : 1);
