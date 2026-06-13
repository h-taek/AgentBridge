import { strict as assert } from 'assert';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  collectProposalTurns, readProposalState, writeProposalCursor,
  bumpCompactionCount, shouldRunProposalPass, appendTurn,
  type TurnRecord,
} from '@agentbridge/core';

async function ws(): Promise<string> {
  return fsp.mkdtemp(join(tmpdir(), 'ab-cur-'));
}
const turn = (id: string, at: string, user = 'hi'): TurnRecord => ({
  id, model: 'claude', completedAt: at, user, assistantBody: 'ok', toolCalls: [],
  userBytes: 2, assistantBodyBytes: 2,
} as TurnRecord);

describe('proposalCursor', () => {
  it('커서 없으면 모든 턴 수집, 새 커서 = 마지막 turn id', async () => {
    const root = await ws();
    await appendTurn(root, turn('a', '2026-06-13T00:00:01Z'));
    await appendTurn(root, turn('b', '2026-06-13T00:00:02Z'));
    const r = await collectProposalTurns(root);
    assert.equal(r.newCount, 2);
    assert.equal(r.newCursor, 'b');
    assert.equal(r.turns.length, 2);
  });

  it('커서(turn id) 이후 새 턴 + 직전 2턴 맥락', async () => {
    const root = await ws();
    for (let i = 1; i <= 5; i++) await appendTurn(root, turn(String(i), `2026-06-13T00:00:0${i}Z`));
    await writeProposalCursor(root, '3'); // 1..3 처리됨
    const r = await collectProposalTurns(root);
    assert.equal(r.newCount, 2);                 // 4,5
    assert.deepEqual(r.turns.map((t) => t.id), ['2', '3', '4', '5']); // 직전 2(2,3) + 새 2(4,5)
    assert.equal(r.newCursor, '5');
  });

  it('새 턴 없으면 newCount 0', async () => {
    const root = await ws();
    await appendTurn(root, turn('a', '2026-06-13T00:00:01Z'));
    await writeProposalCursor(root, 'a');
    const r = await collectProposalTurns(root);
    assert.equal(r.newCount, 0);
  });

  it('compactionCount 증가 + N번째에만 true', async () => {
    const root = await ws();
    const hits: boolean[] = [];
    for (let i = 0; i < 6; i++) { await bumpCompactionCount(root); hits.push(await shouldRunProposalPass(root, 3)); }
    assert.deepEqual(hits, [false, false, true, false, false, true]);
  });

  it('시각 없는 턴(agy식 completedAt="")도 id 커서로 수집·전진', async () => {
    const root = await ws();
    const dir = join(root, 'archive');
    await fsp.mkdir(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'ir_snapshot', archivedAt: 'x', ir: {} }),
      JSON.stringify(turn('arch1', '')),
    ];
    await fsp.writeFile(join(dir, 'compressed_2026.jsonl'), lines.join('\n') + '\n', 'utf8');
    await appendTurn(root, turn('live1', ''));
    const r = await collectProposalTurns(root);
    assert.deepEqual(r.turns.map((t) => t.id), ['arch1', 'live1']);
    assert.equal(r.newCursor, 'live1'); // completedAt이 비어도 id 커서는 전진
  });
});
