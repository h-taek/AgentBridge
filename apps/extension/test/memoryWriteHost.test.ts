// 0.5.0 6단계 후속 — 모델의 지식 쓰기가 호스트를 거친다.
//
// 파일 자체는 CLI도 쓸 수 있다. 호스트를 거치는 이유는 쓴 것이 그 자리에서 화면에 뜨게
// 하려는 것이다 — 뱃지와 목록을 쥔 쪽이 곧 쓰는 쪽이 된다.
// 봉투는 다른 프로세스에서 JSON으로 건너오므로 모양을 믿지 않고 확인한다.
import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  parseMemoryWriteRequest,
  applyMemoryWrite,
  WriteError,
  readProposals,
  getGlobalDir,
} from '@agentbridge/core';

const addPayload = {
  op: 'add',
  scope: 'user',
  profileId: 'default',
  category: 'workflows',
  fields: { title: '제목', summary: '요약', body: '본문' },
};

describe('memory write — 봉투 확인', () => {
  it('정상 add 봉투를 통과시킨다', () => {
    const req = parseMemoryWriteRequest(addPayload);
    assert.equal(req.op, 'add');
    assert.equal(req.profileId, 'default');
    assert.equal(req.fields.title, '제목');
  });

  it('정상 update 봉투를 통과시킨다', () => {
    const req = parseMemoryWriteRequest({ ...addPayload, op: 'update', id: 'workflows/foo' });
    assert.equal(req.op, 'update');
    assert.equal(req.id, 'workflows/foo');
  });

  it('모르는 종류는 거절한다', () => {
    assert.throws(() => parseMemoryWriteRequest({ ...addPayload, op: 'delete' }), WriteError);
  });

  it('봉투가 아예 아니면 거절한다', () => {
    assert.throws(() => parseMemoryWriteRequest(null), WriteError);
    assert.throws(() => parseMemoryWriteRequest('add'), WriteError);
  });

  it('프로필이나 범위가 없으면 거절한다', () => {
    assert.throws(() => parseMemoryWriteRequest({ ...addPayload, profileId: '' }), WriteError);
    assert.throws(() => parseMemoryWriteRequest({ ...addPayload, scope: 'team' }), WriteError);
  });

  it('update에 식별자가 없으면 거절한다', () => {
    assert.throws(() => parseMemoryWriteRequest({ ...addPayload, op: 'update' }), WriteError);
  });
});

describe('memory write — 호스트가 실제로 쓴다', () => {
  let storageRoot: string;

  beforeEach(async () => {
    storageRoot = await fs.mkdtemp(join(tmpdir(), 'agentbridge-memwrite-'));
  });

  afterEach(async () => {
    await fs.rm(storageRoot, { recursive: true, force: true });
  });

  it('add가 제안 큐에 들어간다', async () => {
    const out = await applyMemoryWrite(storageRoot, parseMemoryWriteRequest(addPayload));
    assert.match(out, /제안 큐/);
    const queued = await readProposals(getGlobalDir(storageRoot), 'default', 'user');
    assert.equal(queued.length, 1);
    assert.equal(queued[0].title, '제목');
  });

  it('없는 항목을 고치려 하면 거절하고 큐를 안 건드린다', async () => {
    await assert.rejects(
      () => applyMemoryWrite(storageRoot, parseMemoryWriteRequest({ ...addPayload, op: 'update', id: 'workflows/none' })),
      WriteError,
    );
    const queued = await readProposals(getGlobalDir(storageRoot), 'default', 'user');
    assert.equal(queued.length, 0);
  });
});
