import { strict as assert } from 'assert';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { bumpTurnCount, readTurnCount, isProposalTurn, turnCountPath } from '@agentbridge/core';

async function tmpSession(): Promise<string> {
  const dir = join(tmpdir(), `ab-turncount-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

describe('turnCounter — 세션 단위 턴 수 (0.6.0 spec/03 §2-1)', () => {
  it('파일이 없으면 0이다', async () => {
    assert.equal(await readTurnCount(await tmpSession()), 0);
  });

  it('올린 값이 그대로 읽힌다', async () => {
    const dir = await tmpSession();
    assert.equal(await bumpTurnCount(dir), 1);
    assert.equal(await bumpTurnCount(dir), 2);
    assert.equal(await readTurnCount(dir), 2);
  });

  it('폴더가 없어도 만들어 쓴다 — 훅이 첫 신호를 놓치지 않는다', async () => {
    const dir = join(await tmpSession(), 'not-yet');
    assert.equal(await bumpTurnCount(dir), 1);
    assert.equal(await readTurnCount(dir), 1);
  });

  it('깨진 파일은 0으로 떨어진다 — 카운터 때문에 훅이 죽지 않는다', async () => {
    const dir = await tmpSession();
    await fsp.writeFile(turnCountPath(dir), '{ not json', 'utf8');
    assert.equal(await readTurnCount(dir), 0);
    assert.equal(await bumpTurnCount(dir), 1);
  });

  it('세션 폴더를 못 정하면(빈 경로) 아무것도 안 쓰고 0을 낸다', async () => {
    assert.equal(await bumpTurnCount(''), 0);
    assert.equal(await readTurnCount(''), 0);
  });

  it('다섯 턴마다 제안 턴이다 — 0은 아니다', () => {
    assert.equal(isProposalTurn(0), false);
    assert.equal(isProposalTurn(4), false);
    assert.equal(isProposalTurn(5), true);
    assert.equal(isProposalTurn(6), false);
    assert.equal(isProposalTurn(10), true);
  });
});
