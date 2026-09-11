import { strict as assert } from 'assert';
import { queueSend } from '../src/views/viewerSend';

describe('viewerSend.queueSend', () => {
  it('같은 세션의 전송은 겹치지 않는다', async () => {
    const marks: string[] = [];
    const a = queueSend('s1', () => { marks.push('a'); return true; }, 40);
    const b = queueSend('s1', () => { marks.push('b'); return true; }, 40);
    const started = Date.now();
    assert.deepEqual(await Promise.all([a, b]), [true, true]);
    assert.deepEqual(marks, ['a', 'b']);
    assert.ok(Date.now() - started >= 40);
  });

  it('다른 세션은 서로 기다리지 않는다', async () => {
    const started = Date.now();
    await Promise.all([
      queueSend('x', () => true, 200),
      queueSend('y', () => true, 200),
    ]);
    assert.ok(Date.now() - started < 200);
  });

  it('전송 실패를 그대로 돌려준다', async () => {
    assert.equal(await queueSend('s2', () => false, 10), false);
  });

  it('앞의 전송이 실패해도 뒤가 돈다', async () => {
    const results = await Promise.all([
      queueSend('s3', () => false, 10),
      queueSend('s3', () => true, 10),
    ]);
    assert.deepEqual(results, [false, true]);
  });

  it('보내는 쪽이 던져도 줄이 막히지 않는다', async () => {
    const bad = queueSend('s4', () => { throw new Error('죽었다'); }, 10);
    await assert.rejects(bad);
    assert.equal(await queueSend('s4', () => true, 10), true);
  });
});
