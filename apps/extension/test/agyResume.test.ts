import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveResumeArgs } from '@agentbridge/core';

// agy는 없는 conversation id를 줘도 거부하지 않고 경고만 찍은 뒤 자기 id로 새 대화를 만든다
// (research 06 §6). 그래서 resume 전에 대화 파일이 실재하는지 우리가 확인해야 한다.
// 포맷은 둘이다 — agy CLI 2026-06-02 업데이트로 .pb(protobuf) → .db(SQLite)로 바뀌었고,
// .db만/.pb만 인식하면 resume이 통째로 깨진다(V-17 실기 검증 발견).
describe('agyResume — resume 대상 실재 확인', () => {
  const UUID = 'a247c86e-e5fb-420c-b4ff-1596b7bf367e';
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'ab-agy-conv-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('.db 대화 파일이 있으면 resume 인자를 만든다', async () => {
    await fs.writeFile(join(dir, `${UUID}.db`), 'x');
    assert.deepEqual(await resolveResumeArgs({ sessionId: UUID, conversationsDir: dir }), [
      '--conversation',
      UUID,
    ]);
  });

  it('구버전 .pb 대화 파일도 인식한다', async () => {
    await fs.writeFile(join(dir, `${UUID}.pb`), 'x');
    assert.deepEqual(await resolveResumeArgs({ sessionId: UUID, conversationsDir: dir }), [
      '--conversation',
      UUID,
    ]);
  });

  it('대화 파일이 없으면 거절한다 — 조용히 새 대화가 되는 것을 막는다', async () => {
    await assert.rejects(
      () => resolveResumeArgs({ sessionId: UUID, conversationsDir: dir }),
      /찾을 수 없습니다/,
    );
  });

  it('빈 파일은 대화로 치지 않는다', async () => {
    await fs.writeFile(join(dir, `${UUID}.db`), '');
    await assert.rejects(() => resolveResumeArgs({ sessionId: UUID, conversationsDir: dir }));
  });

  it('id가 비어 있으면 거절한다', async () => {
    await assert.rejects(() => resolveResumeArgs({ sessionId: null, conversationsDir: dir }));
  });
});
