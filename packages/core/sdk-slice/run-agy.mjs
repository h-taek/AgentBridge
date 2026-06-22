// agy localharness 클라이언트 라이브 증명 (repo 코드 dist 사용).
//   ANTIGRAVITY_HARNESS_PATH=<localharness> node packages/core/sdk-slice/run-agy.mjs
import fs from 'fs';
import { startHarness } from '../dist/sdkAdapter/localharness/client.js';

const ENV = new URL('../../../.env', import.meta.url);
let key = fs.readFileSync(ENV, 'utf8').trim();
if (key.includes('=')) key = key.split('=').slice(1).join('=').trim();
key = key.replace(/^["']|["']$/g, '');

const client = await startHarness({ apiKey: key, model: 'gemini-3.5-flash', cwd: process.cwd() });
let acc = '';
let final = '';
client.onEvent((ev) => {
  const su = ev.stepUpdate;
  if (su) {
    if (su.textDelta) { acc += su.textDelta; process.stdout.write('·'); }
    if (su.text && su.state === 'STATE_DONE' && su.source === 'SOURCE_MODEL') final = su.text;
  } else if (ev.trajectoryStateUpdate?.state === 'STATE_IDLE') {
    console.log('\n=== IDLE — deltas len=' + acc.length + ' final="' + String(final).trim().slice(0, 60) + '" ===');
    console.log('PASS', /pong/i.test(final) ? '✓' : '(no pong?)');
    client.end();
    process.exit(0);
  } else if (ev.error || ev.stepUpdate?.error) {
    console.log('ERROR ev:', JSON.stringify(ev).slice(0, 300));
  }
});
client.sendInput('Reply with exactly one word: PONG');
setTimeout(() => { console.log('timeout'); client.end(); process.exit(1); }, 75000);
