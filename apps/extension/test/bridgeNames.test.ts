// 0.5.0 3단계 — 서브 이름 발급(순수 로직). 근거: docs/0.5.0/spec/01_orca_adoption.md B-7 "이름".
import { strict as assert } from 'assert';
import { BRIDGE_NAMES, issueBridgeName, type NameUsage } from '@agentbridge/core';

describe('BRIDGE_NAMES 불변식', () => {
  it('500개다', () => {
    assert.equal(BRIDGE_NAMES.length, 500);
  });

  it('중복이 없다', () => {
    assert.equal(new Set(BRIDGE_NAMES).size, 500);
  });

  it('전부 kebab-case ascii다', () => {
    for (const name of BRIDGE_NAMES) {
      assert.match(name, /^[a-z0-9-]+$/, `이름이 규격을 벗어남: ${name}`);
    }
  });
});

describe('issueBridgeName — 유일성 3면', () => {
  it('live·folders·branches 각각에 있는 이름은 피한다', () => {
    const result = issueBridgeName({
      live: [BRIDGE_NAMES[0]],
      folders: [BRIDGE_NAMES[1]],
      branches: [BRIDGE_NAMES[2]],
      usage: [],
    });
    assert.notEqual(result, BRIDGE_NAMES[0]);
    assert.notEqual(result, BRIDGE_NAMES[1]);
    assert.notEqual(result, BRIDGE_NAMES[2]);
    // 셋 다 피한 뒤 목록 순서상 다음으로 비어 있는 이름이다.
    assert.equal(result, BRIDGE_NAMES[3]);
  });
});

describe('issueBridgeName — 재사용 우선순위', () => {
  it('한 번도 안 쓴 이름이 있으면 목록 순서대로 그것부터 고른다', () => {
    const usage: NameUsage[] = [
      { name: BRIDGE_NAMES[0], lastUsedAt: 1000 },
      { name: BRIDGE_NAMES[1], lastUsedAt: 2000 },
    ];
    const result = issueBridgeName({ live: [], folders: [], branches: [], usage });
    // 0·1은 쓴 적이 있으므로 건너뛰고, 목록 순서상 다음인 2가 처음 나오는 미사용 이름이다.
    assert.equal(result, BRIDGE_NAMES[2]);
  });

  it('전부 쓴 적이 있으면 마지막 사용이 가장 오래된 것부터 고른다', () => {
    // 마지막 이름일수록 오래전에 쓴 것으로 만든다 — 목록 순서와 반대라
    // "목록 순서라서 먼저 나온다"는 우연과 구별된다.
    const usage: NameUsage[] = BRIDGE_NAMES.map((name, i) => ({
      name,
      lastUsedAt: BRIDGE_NAMES.length - i,
    }));
    const result = issueBridgeName({ live: [], folders: [], branches: [], usage });
    assert.equal(result, BRIDGE_NAMES[BRIDGE_NAMES.length - 1]);
  });

  it('같은 이름의 사용 이력이 여러 번 있으면 가장 최근 값을 남긴다', () => {
    // BRIDGE_NAMES[0]을 마지막에 다시 썼다고 기록하면(가장 최근) 더는 최적임(가장 오래됨) 후보가 아니다.
    const usage: NameUsage[] = [
      ...BRIDGE_NAMES.map((name, i) => ({ name, lastUsedAt: i + 1 })),
      { name: BRIDGE_NAMES[0], lastUsedAt: BRIDGE_NAMES.length + 1000 },
    ];
    const result = issueBridgeName({ live: [], folders: [], branches: [], usage });
    assert.notEqual(result, BRIDGE_NAMES[0]);
    assert.equal(result, BRIDGE_NAMES[1]);
  });
});

describe('issueBridgeName — 숫자 접미사(최후 수단)', () => {
  it('빈 이름이 하나라도 있으면 접미사로 안 넘어간다', () => {
    const allButOne = BRIDGE_NAMES.filter((_, i) => i !== 250);
    const result = issueBridgeName({ live: [], folders: allButOne, branches: [], usage: [] });
    assert.equal(result, BRIDGE_NAMES[250]);
  });

  it('500개가 다 찼을 때만 -2가 나온다', () => {
    const result = issueBridgeName({ live: [], folders: BRIDGE_NAMES, branches: [], usage: [] });
    assert.equal(result, `${BRIDGE_NAMES[0]}-2`);
  });

  it('접미사 후보도 3면 검사를 통과해야 한다', () => {
    const result = issueBridgeName({
      live: [],
      folders: BRIDGE_NAMES,
      branches: [`${BRIDGE_NAMES[0]}-2`],
      usage: [],
    });
    assert.equal(result, `${BRIDGE_NAMES[1]}-2`);
  });
});
