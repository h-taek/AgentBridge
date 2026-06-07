// apps/extension/test/transcriptReader.agy.test.ts
import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { join } from 'path';
import { agyConsume, EMPTY_CARRY, type ReaderCtx, type AgyStepRow } from '@agentbridge/core';

const CTX: ReaderCtx = { workspaceId: 'w1', sessionId: 's1', detail: 'full' };
const DIR = join(__dirname, 'fixtures/transcript/agy-steps');

async function loadSteps(): Promise<AgyStepRow[]> {
  const files = (await fs.readdir(DIR)).filter((f) => f.endsWith('.bin'));
  const rows = await Promise.all(
    files.map(async (f) => {
      const [idx, stepType] = f.replace('.bin', '').split('_').map(Number);
      return { idx, stepType, payload: await fs.readFile(join(DIR, f)) };
    }),
  );
  return rows.sort((a, b) => a.idx - b.idx);
}

describe('agyReader (real fixture)', () => {
  it('멀티턴: step_type 14마다 user 턴, 도구는 호출-id로 페어링, 90/101 필터', async () => {
    const steps = await loadSteps();
    const { turns, carry } = agyConsume(steps, EMPTY_CARRY, CTX);
    // 4개 user 턴 중 마지막은 carry로 열려 있을 수 있음 → 최소 3개 닫힘
    assert.ok(turns.length >= 3, `expected >=3 turns, got ${turns.length}`);
    // 사용자 텍스트가 주입분이 아니어야 함
    for (const t of turns) {
      assert.ok(!t.user.includes('agentbridge-context'));
      assert.ok(t.user.length > 0);
    }
    // 적어도 한 턴은 view_file 또는 run_command 도구를 가짐
    const allTools = turns.flatMap((t) => t.toolCalls.map((c) => c.tool));
    assert.ok(allTools.some((n) => n === 'view_file' || n === 'run_command'), `tools: ${allTools}`);
    // 도구 결과 요약이 호출-id 페어링으로 채워짐
    const withSummary = turns.flatMap((t) => t.toolCalls).filter((c) => c.summary);
    assert.ok(withSummary.length > 0, 'expected at least one tool call with a paired summary');
    void carry;
  });
});

// step_type별 실제 래퍼 필드(f19/f20/f5)를 손으로 인코딩한 db 비의존 안전망.
function varint(n: number): Buffer {
  const bytes: number[] = [];
  while (n > 0x7f) {
    bytes.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  bytes.push(n);
  return Buffer.from(bytes);
}
function pbStr(field: number, text: string): Buffer {
  const body = Buffer.from(text, 'utf8');
  return Buffer.concat([varint((field << 3) | 2), varint(body.length), body]);
}
function pbMsg(field: number, inner: Buffer): Buffer {
  return Buffer.concat([varint((field << 3) | 2), varint(inner.length), inner]);
}

describe('agyReader (synthetic)', () => {
  it('step_type 14=user(f19.f2), 15=assistant(f20.f1) 텍스트, 90=주입 필터', () => {
    const steps = [
      { idx: 0, stepType: 14, payload: pbMsg(19, pbStr(2, '합성 질문')) },
      { idx: 1, stepType: 90, payload: pbMsg(103, pbStr(1, '<agentbridge-context> 주입')) },
      { idx: 2, stepType: 15, payload: pbMsg(20, pbStr(1, '합성 답변')) },
      { idx: 3, stepType: 14, payload: pbMsg(19, pbStr(2, '둘째 질문')) },
    ];
    const { turns } = agyConsume(steps, EMPTY_CARRY, CTX);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].user, '합성 질문');
    assert.equal(turns[0].assistantBody, '합성 답변');
    assert.equal(turns[0].id, 'agy:s1#0');
  });

  it('도구 호출(f20.f7) + 실행 step(f5.f4.f1 call-id, f5.f31 summary) 페어링', () => {
    const toolCall = pbMsg(
      20,
      pbMsg(7, Buffer.concat([pbStr(1, 'call1'), pbStr(2, 'view_file'), pbStr(3, '{"AbsolutePath":"/x"}')])),
    );
    const execStep = pbMsg(5, Buffer.concat([pbMsg(4, pbStr(1, 'call1')), pbStr(31, 'Viewing x file')]));
    const steps = [
      { idx: 0, stepType: 14, payload: pbMsg(19, pbStr(2, '질문')) },
      { idx: 1, stepType: 15, payload: toolCall },
      { idx: 2, stepType: 8, payload: execStep },
      { idx: 3, stepType: 14, payload: pbMsg(19, pbStr(2, '다음 질문')) },
    ];
    const { turns } = agyConsume(steps, EMPTY_CARRY, CTX);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].toolCalls.length, 1);
    assert.equal(turns[0].toolCalls[0].tool, 'view_file');
    assert.equal(turns[0].toolCalls[0].arg, '{"AbsolutePath":"/x"}');
    assert.equal(turns[0].toolCalls[0].summary, 'Viewing x file');
  });
});
