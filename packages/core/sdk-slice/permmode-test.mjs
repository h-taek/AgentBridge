// 6-2 라이브 증명: setPermissionMode가 실 SDK 동작을 바꾸나 (모드 대비).
//   acceptEdits → 파일 쓰기 자동 승인 → 파일 생김.   plan → 읽기 전용 → 파일 안 생김.
//   (core build 후) node packages/core/sdk-slice/permmode-test.mjs
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { claudeAdapter } from '../dist/sdkAdapter/claudeAdapter.js'; // 배럴 비노출 — 전용 경로 로드

const root = await fs.mkdtemp(join(tmpdir(), 'sdk-permmode-'));

const session = await claudeAdapter.start({
  cwd: root, // temp 격리 — 레포에 파일 안 만들게
  workspaceId: 'perm-ws',
  detail: 'compact',
});

// 턴을 돌리며 승인 요청이 오면 즉시 허용(행 방지). plan 차단은 SDK 레벨이라 허용해도 안 써짐.
async function turn(label, text, deadlineMs = 120000) {
  let finalText = '';
  process.stdout.write(`\n[${label}] "${text.slice(0, 50)}…"\n  stream: `);
  const run = (async () => {
    for await (const e of session.send(text)) {
      if (e.t === 'text' && e.final === false) process.stdout.write('·');
      else if (e.t === 'text' && e.final === true) finalText += e.text;
      else if (e.t === 'tool') process.stdout.write(`[tool:${e.name}]`);
      else if (e.t === 'approval') { process.stdout.write('[approval→allow]'); session.respondApproval(e.id, true); }
      else if (e.t === 'turn_end') process.stdout.write(` [end:${e.reason}]`);
      else if (e.t === 'error') process.stdout.write(`[err:${e.message}]`);
    }
  })();
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('turn timeout')), deadlineMs));
  await Promise.race([run, timeout]).catch((err) => process.stdout.write(`\n  ! ${err.message}`));
  console.log(`\n  → final="${finalText.trim().slice(0, 60)}"`);
}

// 1) acceptEdits — 쓰기 자동 승인
await session.setPermissionMode('acceptEdits');
await turn('acceptEdits', 'Create a file named ACCEPT.txt containing the word hello in the current working directory. Then reply: done.');
const acceptExists = existsSync(join(root, 'ACCEPT.txt'));

// 2) plan — 읽기 전용(변경 금지)
await session.setPermissionMode('plan');
await turn('plan', 'Create a file named PLAN.txt containing the word hello in the current working directory. Then reply: done.');
const planExists = existsSync(join(root, 'PLAN.txt'));

await session.end();

console.log('\n=== 검증 ===');
console.log('acceptEdits → ACCEPT.txt 생성 =', acceptExists, '(기대: true)');
console.log('plan        → PLAN.txt   생성 =', planExists, '(기대: false)');

const ok = acceptExists && !planExists;
console.log('\nPHASE-6-2', ok ? 'PASS ✓ (권한 모드가 실제 동작을 바꿈)' : 'FAIL ✗');
await fs.rm(root, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
