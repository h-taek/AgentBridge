// apps/extension/test/transcriptReader.util.test.ts
import { strict as assert } from 'assert';
import {
  utf8ByteLength,
  applyDetailCap,
  deterministicTurnId,
  toolArgString,
  TURNS_ASSISTANT_DETAIL_CAP,
} from '@agentbridge/core';

describe('transcriptReader/util', () => {
  it('utf8ByteLength: ascii 1B, 한글 3B, surrogate 4B', () => {
    assert.equal(utf8ByteLength('ab'), 2);
    assert.equal(utf8ByteLength('가'), 3);
    assert.equal(utf8ByteLength('😀'), 4);
  });

  it('applyDetailCap compact: 긴 본문을 head+tail로 자른다', () => {
    // cap(SSOT)을 초과하도록 본문 길이를 cap에서 파생 — 하드코딩 매직넘버 대신.
    const body = 'x'.repeat(TURNS_ASSISTANT_DETAIL_CAP.compact.chars + 500);
    const out = applyDetailCap(body, 'compact');
    assert.ok(out.length < body.length);
    assert.ok(out.includes('…[truncated]…'));
  });

  it('applyDetailCap: 짧은 본문은 그대로', () => {
    assert.equal(applyDetailCap('short', 'compact'), 'short');
  });

  it('deterministicTurnId: 같은 입력 같은 결과', () => {
    const a = deterministicTurnId('claude', 'uuid-1');
    const b = deterministicTurnId('claude', 'uuid-1');
    assert.equal(a, b);
    assert.notEqual(a, deterministicTurnId('claude', 'uuid-2'));
  });

  it('toolArgString: 객체를 JSON으로 직렬화하고 cap', () => {
    assert.equal(toolArgString({ file_path: '/x' }), '{"file_path":"/x"}');
    const long = toolArgString({ cmd: 'a'.repeat(1000) });
    assert.ok(long.length <= 500 + 1); // TURN_CAP.toolCallArgChars + '…'
    assert.ok(long.endsWith('…'));
  });
});
