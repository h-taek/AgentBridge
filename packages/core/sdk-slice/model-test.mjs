// 6-3 라이브 증명: claude listModels()가 실제 모델 카탈로그를 주고 setModel이 라이브로 먹히나.
//   (core build 후) node packages/core/sdk-slice/model-test.mjs
import { claudeAdapter } from '../dist/sdkAdapter/claudeAdapter.js';

const session = await claudeAdapter.start({ cwd: process.cwd(), workspaceId: 'model-ws', detail: 'compact' });

async function turn(text) {
  let txt = '';
  for await (const e of session.send(text)) {
    if (e.t === 'text' && e.final === true) txt += e.text;
    else if (e.t === 'approval') session.respondApproval(e.id, false);
  }
  return txt.trim();
}

// 1) 첫 턴으로 init 발생 → 현재 모델 확정
await turn('Reply with exactly: hi');
let models = await session.listModels();
console.log('listModels:', models.map((m) => m.id + (m.current ? ' *' : '')).join(' | '));
const curBefore = models.find((m) => m.current);
const other = models.find((m) => !m.current);

let switched = false;
let turn2OK = false;
if (other) {
  // 2) 다른 모델로 전환
  await session.setModel(other.id);
  models = await session.listModels();
  const curAfter = models.find((m) => m.current);
  switched = Boolean(curAfter) && curAfter.id === other.id;
  console.log(`setModel: ${curBefore?.id} → ${other.id} | current now = ${curAfter?.id}`);
  // 3) 전환 후 턴이 정상 완료되나
  const r = await turn('Reply with exactly: ok');
  turn2OK = /ok/i.test(r);
} else {
  console.log('(모델이 1개뿐 — 전환 스킵)');
}

await session.end();

console.log('\n=== 검증 ===');
const listOK = models.length >= 1 && models.filter((m) => m.current).length === 1;
console.log('모델 카탈로그(≥1, current 1개) =', listOK);
console.log('setModel로 current 이동      =', switched);
console.log('전환 후 턴 정상 완료          =', turn2OK);

const ok = listOK && switched && turn2OK;
console.log('\nPHASE-6-3', ok ? 'PASS ✓ (모델 목록+전환 라이브)' : 'FAIL ✗');
process.exit(ok ? 0 : 1);
