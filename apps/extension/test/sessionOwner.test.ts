import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  acquireOwnership,
  updateOwnerSize,
  releaseOwnership,
  readOwner,
  isOwnerAlive,
  isSessionOwned,
  requestTransfer,
  readTransferRequest,
  clearTransferRequest,
  ownerPath,
  transferRequestPath,
} from '@agentbridge/core';

describe('sessionOwner', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'agentbridge-owner-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('acquireOwnership가 owner.json을 올바른 필드로 쓴다', async () => {
    await acquireOwnership(dir, { app: 'desktop', cols: 100, rows: 30 });
    const owner = await readOwner(dir);
    assert.ok(owner);
    assert.equal(owner!.app, 'desktop');
    assert.equal(owner!.pid, process.pid);
    assert.equal(owner!.cols, 100);
    assert.equal(owner!.rows, 30);
    assert.equal(typeof owner!.acquiredAt, 'number');
  });

  it('acquireOwnership을 두 번 부르면 나중 호출이 덮어쓴다 (선점 guard 없음 — 호출자 책임)', async () => {
    await acquireOwnership(dir, { app: 'desktop', cols: 100, rows: 30 });
    await acquireOwnership(dir, { app: 'extension', cols: 80, rows: 24 });
    const owner = await readOwner(dir);
    assert.equal(owner!.app, 'extension');
    assert.equal(owner!.cols, 80);
  });

  it('readOwner는 owner.json이 없으면 null을 반환한다', async () => {
    assert.equal(await readOwner(dir), null);
  });

  it('readOwner는 손상된 owner.json에 대해 null을 반환한다', async () => {
    await fs.writeFile(ownerPath(dir), '{not json', 'utf8');
    assert.equal(await readOwner(dir), null);
  });

  it('readOwner는 스키마가 어긋난 owner.json(파싱은 되나 필드 불량)에 null을 반환한다', async () => {
    await fs.writeFile(ownerPath(dir), JSON.stringify({ app: 'other', pid: 'nope' }), 'utf8');
    assert.equal(await readOwner(dir), null);
  });

  it('isOwnerAlive는 살아있는 pid(자기 자신)에 true, 죽은 pid에 false', async () => {
    await acquireOwnership(dir, { app: 'extension', cols: 80, rows: 24 });
    const owner = await readOwner(dir);
    assert.equal(isOwnerAlive(owner!), true);
    assert.equal(isOwnerAlive({ ...owner!, pid: 999999999 }), false);
  });

  it('isSessionOwned: owner.json + 생존 pid면 true', async () => {
    await acquireOwnership(dir, { app: 'desktop', cols: 100, rows: 30 });
    assert.equal(await isSessionOwned(dir), true);
  });

  it('isSessionOwned: owner.json 없으면 false', async () => {
    assert.equal(await isSessionOwned(dir), false);
  });

  it('isSessionOwned: pid가 죽었으면 false (가져갈 수 있음)', async () => {
    await fs.writeFile(
      ownerPath(dir),
      JSON.stringify({ app: 'desktop', pid: 999999999, acquiredAt: Date.now(), cols: 100, rows: 30 }),
      'utf8',
    );
    assert.equal(await isSessionOwned(dir), false);
  });

  it('updateOwnerSize가 cols/rows만 갱신하고 나머지는 보존한다', async () => {
    await acquireOwnership(dir, { app: 'desktop', cols: 100, rows: 30 });
    const before = await readOwner(dir);
    await updateOwnerSize(dir, 120, 40);
    const after = await readOwner(dir);
    assert.equal(after!.cols, 120);
    assert.equal(after!.rows, 40);
    assert.equal(after!.app, 'desktop');
    assert.equal(after!.pid, before!.pid);
    assert.equal(after!.acquiredAt, before!.acquiredAt);
  });

  it('updateOwnerSize는 owner.json이 없으면 no-op (파일 생성 안 함)', async () => {
    await updateOwnerSize(dir, 120, 40);
    assert.equal(existsSync(ownerPath(dir)), false);
  });

  it('releaseOwnership이 owner.json을 삭제하고, 이미 없어도 throw하지 않는다', async () => {
    await acquireOwnership(dir, { app: 'desktop', cols: 100, rows: 30 });
    await releaseOwnership(dir);
    assert.equal(existsSync(ownerPath(dir)), false);
    await releaseOwnership(dir);
    assert.equal(existsSync(ownerPath(dir)), false);
  });

  it('transfer-request write/read/clear', async () => {
    assert.equal(await readTransferRequest(dir), null);
    await requestTransfer(dir, 'extension');
    const req = await readTransferRequest(dir);
    assert.ok(req);
    assert.equal(req!.requestedBy, 'extension');
    assert.equal(req!.pid, process.pid);
    assert.equal(typeof req!.requestedAt, 'number');
    assert.equal(existsSync(transferRequestPath(dir)), true);
    await clearTransferRequest(dir);
    assert.equal(await readTransferRequest(dir), null);
    assert.equal(existsSync(transferRequestPath(dir)), false);
  });

  it('readTransferRequest는 requestedBy가 불량이면 null을 반환한다', async () => {
    await fs.writeFile(
      transferRequestPath(dir),
      JSON.stringify({ requestedBy: 'nope', pid: 1, requestedAt: 1 }),
      'utf8',
    );
    assert.equal(await readTransferRequest(dir), null);
  });
});
