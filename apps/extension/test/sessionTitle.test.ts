// 자동 세션 이름 — 첫 user 턴 텍스트를 잘라 세션 title로. deriveSessionTitle(순수 절단)
// + maybeAutoNameSession(첫 nameable 턴으로 1회 명명, 기존 title 보호).
import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { appendTurn, deriveSessionTitle, maybeAutoNameSession, type TurnRecord } from '@agentbridge/core';

function makeTurn(id: string, user: string): TurnRecord {
  return {
    id,
    workspaceId: 'w1',
    sessionId: 's1',
    model: 'claude',
    startedAt: '2026-06-25T00:00:00.000Z',
    completedAt: '2026-06-25T00:00:01.000Z',
    user,
    userBytes: Buffer.byteLength(user),
    assistantBody: '',
    assistantBodyBytes: 0,
    toolCalls: [],
  };
}

describe('deriveSessionTitle', () => {
  it('짧은 텍스트는 그대로 돌려준다', () => {
    assert.equal(deriveSessionTitle('로그인 401 봐줘'), '로그인 401 봐줘');
  });

  it('빈 문자열·공백만이면 null', () => {
    assert.equal(deriveSessionTitle(''), null);
    assert.equal(deriveSessionTitle('   \n\t  '), null);
  });

  it('줄바꿈·탭·연속 공백을 단일 스페이스로 접고 trim', () => {
    assert.equal(deriveSessionTitle('  로그인\n\n401   토큰\t만료  '), '로그인 401 토큰 만료');
  });

  it('40 코드포인트 초과면 40에서 자르고 … 를 붙인다', () => {
    const long = 'a'.repeat(45);
    assert.equal(deriveSessionTitle(long), 'a'.repeat(40) + '…');
  });

  it('정확히 40 코드포인트면 … 없이 그대로', () => {
    const exact = 'b'.repeat(40);
    assert.equal(deriveSessionTitle(exact), exact);
  });

  it('이모지 경계를 깨지 않는다 (코드포인트 단위 절단)', () => {
    // 39 글자 + 이모지 1개(= 40번째 코드포인트) + 뒤 추가 → 이모지가 온전히 포함되고 … 붙음
    const text = 'x'.repeat(39) + '😀' + 'yyy';
    const out = deriveSessionTitle(text);
    assert.equal(out, 'x'.repeat(39) + '😀' + '…');
    assert.ok(!out!.includes('�'), '대체문자(surrogate 분리) 없어야 함');
  });

  it('슬래시 명령은 원문 그대로 보존한다', () => {
    assert.equal(deriveSessionTitle('/clear'), '/clear');
  });
});

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), 'sesstitle-'));
}

describe('maybeAutoNameSession', () => {
  it('title이 없으면 첫 턴 user 텍스트로 채운다', async () => {
    const root = await tmpRoot();
    await appendTurn(root, makeTurn('t1', '로그인이 자꾸 401 뜨는데 토큰 만료 로직 봐줘'));
    let title: string | undefined;
    await maybeAutoNameSession({
      workspaceRoot: root,
      getCurrentTitle: async () => title,
      setTitle: async (t) => {
        title = t;
      },
    });
    assert.equal(title, '로그인이 자꾸 401 뜨는데 토큰 만료 로직 봐줘');
  });

  it('이미 title이 있으면 절대 덮어쓰지 않는다', async () => {
    const root = await tmpRoot();
    await appendTurn(root, makeTurn('t1', '새 첫 턴'));
    let called = 0;
    await maybeAutoNameSession({
      workspaceRoot: root,
      getCurrentTitle: async () => '사용자가 직접 지은 이름',
      setTitle: async () => {
        called++;
      },
    });
    assert.equal(called, 0);
  });

  it('첫 턴이 비어 있으면 건너뛰고 다음 nameable 턴을 쓴다', async () => {
    const root = await tmpRoot();
    await appendTurn(root, makeTurn('t1', '   \n  '));
    await appendTurn(root, makeTurn('t2', '두 번째가 진짜 질문'));
    let title: string | undefined;
    await maybeAutoNameSession({
      workspaceRoot: root,
      getCurrentTitle: async () => title,
      setTitle: async (t) => {
        title = t;
      },
    });
    assert.equal(title, '두 번째가 진짜 질문');
  });

  it('턴이 하나도 없으면 아무것도 하지 않는다', async () => {
    const root = await tmpRoot();
    let called = 0;
    await maybeAutoNameSession({
      workspaceRoot: root,
      getCurrentTitle: async () => undefined,
      setTitle: async () => {
        called++;
      },
    });
    assert.equal(called, 0);
  });
});
