// 제어문자가 턴 기록과 정제 프롬프트로 새어 들어가는 것 (2026-09-03 실사용에서 잡힘).
//
// 실제로 난 일: 도구 인자에 NUL이 한 번 섞였고, 그 턴이 기록 맨 앞에 박혔다. 압축은 항상 가장
// 오래된 덩어리부터 처리하고 프롬프트를 argv로 넘기는데, Node의 spawn은 NUL이 든 인자를 거부한다
// (ERR_INVALID_ARG_VALUE). 그래서 매번 같은 자리에서 실패했고, 실패하면 아무것도 안 지워지므로
// 그 뒤 5일치 147턴이 통째로 밀렸다. 경고는 세션당 한 번만 떠서 조용히 쌓였다.
//
// 두 겹으로 막는다 — 기록에 안 들어가게, 그리고 이미 들어간 기록이 있어도 프롬프트가 나갈 때.
import { strict as assert } from 'assert';
import { toolArgString, buildRefineSpawnRequest, stripControlChars } from '@agentbridge/core';

const NUL = String.fromCharCode(0);
const BEL = String.fromCharCode(7);
const DEL = String.fromCharCode(127);

describe('제어문자 제거 (stripControlChars)', () => {
  it('NUL을 지운다', () => {
    assert.equal(stripControlChars(`a${NUL}b`), 'ab');
  });

  it('줄바꿈과 탭은 남긴다 — 본문의 모양이다', () => {
    assert.equal(stripControlChars('a\nb\tc'), 'a\nb\tc');
  });

  it('그 밖의 C0와 DEL도 지운다', () => {
    assert.equal(stripControlChars(`a${BEL}b${DEL}c`), 'abc');
  });

  it('멀쩡한 문자열은 그대로 둔다', () => {
    assert.equal(stripControlChars('한글 ok — 그대로'), '한글 ok — 그대로');
  });
});

describe('턴 기록에 제어문자가 안 들어간다', () => {
  it('도구 인자의 NUL이 걸러진다', () => {
    const arg = toolArgString(`{"command":"echo ${NUL} hi"}`);
    assert.equal(arg.includes(NUL), false);
    assert.match(arg, /echo/);
  });

  it('객체 인자도 같은 규칙을 탄다', () => {
    const arg = toolArgString({ command: `a${NUL}b` });
    assert.equal(arg.includes(NUL), false);
  });
});

describe('정제 프롬프트가 나갈 때 한 번 더 막는다', () => {
  // 이미 기록에 박힌 NUL이 있어도 압축이 영원히 막히지 않아야 한다.
  const poisoned = `# Task${NUL}\n본문`;

  it('claude — argv에 NUL이 없다', () => {
    const req = buildRefineSpawnRequest('claude', poisoned);
    assert.equal(req.args.some((a) => a.includes(NUL)), false);
    assert.equal(req.args.some((a) => a.includes('# Task')), true);
  });

  it('agy — argv에 NUL이 없다', () => {
    const req = buildRefineSpawnRequest('agy', poisoned);
    assert.equal(req.args.some((a) => a.includes(NUL)), false);
  });

  it('codex — stdin으로 가는 것도 씻는다', () => {
    const req = buildRefineSpawnRequest('codex', poisoned);
    assert.equal((req.stdinPayload ?? '').includes(NUL), false);
    assert.match(req.stdinPayload ?? '', /# Task/);
  });
});
