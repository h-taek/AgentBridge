// 수직 슬라이스 라이브 증명: claude SDK → ChatEvent → TurnRecord → SdkCapture → turns.jsonl(디스크)
//   → 하류(turns:updated emit + scheduler.checkAndRun). 키 없이(~/.claude 구독).
//   (core build 후) node packages/core/sdk-slice/run-adapter.mjs
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { claudeAdapter, SdkCapture, readAllTurns } from '../dist/index.js';

// 기존 CaptureSession 테스트와 동일한 fake scheduler — 하류 입구가 쳐졌는지만 기록.
function fakeScheduler() {
  const calls = { updated: 0, ran: 0 };
  return {
    calls,
    events: { emit: () => { calls.updated++; } },
    checkAndRun: async () => { calls.ran++; },
  };
}

const root = await fs.mkdtemp(join(tmpdir(), 'sdk-slice-'));
const sched = fakeScheduler();
const capture = new SdkCapture({
  workspaceId: 'slice-ws',
  workspaceRoot: root,
  workspacePath: process.cwd(),
  model: 'claude',
  scheduler: sched,
});

const session = await claudeAdapter.start({
  cwd: process.cwd(),
  workspaceId: 'slice-ws',
  detail: 'compact',
  onTurn: (t) => capture.accept(t), // 어댑터가 await → accept 완료까지 대기
});

console.log('=== claudeAdapter.send (키 없음) ===');
for await (const e of session.send('Reply with exactly: ADAPTER_OK')) {
  console.log(' •', e.t, JSON.stringify(e).slice(0, 110));
}

// onTurn(=capture.accept)은 send 제너레이터 안에서 await됨 → 여기 도달 시 appendTurn 완료.
const persisted = await readAllTurns(root);
console.log('\n=== turns.jsonl (디스크에서 재독) ===');
console.log('workspaceRoot =', root);
console.log('turns =', persisted.length, JSON.stringify(persisted[0]));
console.log('\n=== 하류 트리거 ===');
console.log('turns:updated emit =', sched.calls.updated, '| checkAndRun 호출 =', sched.calls.ran);

const ok =
  persisted.length === 1 &&
  persisted[0].model === 'claude' &&
  persisted[0].id.startsWith('claude:') &&
  sched.calls.updated >= 1 &&
  sched.calls.ran >= 1;
console.log('\nSLICE', ok ? 'PASS ✓' : 'FAIL ✗');

await fs.rm(root, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
