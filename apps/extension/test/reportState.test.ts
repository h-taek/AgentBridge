// 0.5.0 4단계 W4 — 서브에이전트 완료 미읽음 판정.
// 규칙 근거: docs/0.5.0/spec/01_orca_adoption.md B-6 "메인이 완료를 아는 법"·"기다리지 않았을 때".
import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  resolveTurnSignalFile,
  resolveReportReadFile,
  readReportReadAt,
  markReported,
  isUnread,
  listUnread,
} from '@agentbridge/core';

async function writeSignal(
  ws: string,
  sessionId: string,
  opts: { complete: boolean; at: number },
): Promise<void> {
  const dir = join(ws, 'sessions', sessionId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    resolveTurnSignalFile(ws, sessionId),
    JSON.stringify({
      agent: 'claude',
      event: 'Stop',
      sessionId,
      transcriptPath: '/t',
      complete: opts.complete,
      at: opts.at,
    }),
  );
}

describe('reportState — 서브 완료 미읽음 판정', () => {
  const SID = 'sess-report-1';
  let ws: string;

  beforeEach(async () => {
    ws = await fs.mkdtemp(join(tmpdir(), 'ab-reportstate-'));
    await fs.mkdir(join(ws, 'sessions', SID), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('신호가 없으면 미읽음이 아니다', async () => {
    assert.equal(await isUnread(ws, SID), false);
  });

  it('complete=true 신호가 오면 미읽음이다', async () => {
    await writeSignal(ws, SID, { complete: true, at: 100 });
    assert.equal(await isUnread(ws, SID), true);
  });

  it('complete=false 신호는 미읽음이 아니다', async () => {
    // 서브를 기다리며 멈춘 지점에서도 신호가 오지만, 그때는 아직 다 끝나지 않았다는 표시가 있다.
    await writeSignal(ws, SID, { complete: false, at: 100 });
    assert.equal(await isUnread(ws, SID), false);
  });

  it('markReported 뒤에는 미읽음이 아니고, 그 뒤 새 신호가 오면 다시 미읽음이다', async () => {
    await writeSignal(ws, SID, { complete: true, at: 100 });
    assert.equal(await isUnread(ws, SID), true);

    await markReported(ws, SID, 150);
    assert.equal(await isUnread(ws, SID), false);
    assert.equal(await readReportReadAt(ws, SID), 150);

    await writeSignal(ws, SID, { complete: true, at: 200 });
    assert.equal(await isUnread(ws, SID), true);
  });

  it('markReported는 원자적으로 쓴다 — tmp 잔재를 안 남긴다', async () => {
    await markReported(ws, SID, 42);
    const dirEntries = await fs.readdir(join(ws, 'sessions', SID));
    assert.deepEqual(dirEntries, [resolveReportReadFile(ws, SID).split('/').pop()]);
  });

  it('listUnread — 미읽음인 것만 입력 순서대로 낸다', async () => {
    const A = 'sub-a';
    const B = 'sub-b';
    const C = 'sub-c';
    await writeSignal(ws, A, { complete: true, at: 100 }); // 미읽음
    await writeSignal(ws, B, { complete: false, at: 100 }); // 미완 — 대상 아님
    await writeSignal(ws, C, { complete: true, at: 100 });
    await markReported(ws, C, 200); // 이미 읽음

    const result = await listUnread(ws, [C, A, B]);
    assert.deepEqual(result, [A]);
  });

  it('깨진 report-read.json은 안 읽은 것으로 떨어진다', async () => {
    await writeSignal(ws, SID, { complete: true, at: 100 });
    await fs.writeFile(resolveReportReadFile(ws, SID), '{ not json');
    assert.equal(await readReportReadAt(ws, SID), 0);
    assert.equal(await isUnread(ws, SID), true);
  });
});
