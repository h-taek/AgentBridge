import { strict as assert } from 'assert';
import { parseConversationFilename } from '../src/core/cliAdapter/agyResume';

// agy CLI 2026-06-02 업데이트로 conversation 저장 포맷이 .pb(protobuf) → .db(SQLite)로 변경됨.
// 구버전 .pb만 인식하던 정규식이 캡처/resume/청소를 전부 놓치던 회귀(V-17 실기 검증 발견)의 재발 방지.
describe('agyResume', () => {
  describe('parseConversationFilename', () => {
    it('recognizes new .db conversation files (agy CLI 2026-06-02+)', () => {
      assert.equal(
        parseConversationFilename('8a82d55e-6ab2-4338-9430-e08224f02216.db'),
        '8a82d55e-6ab2-4338-9430-e08224f02216',
      );
    });

    it('recognizes legacy .pb conversation files', () => {
      assert.equal(
        parseConversationFilename('a247c86e-e5fb-420c-b4ff-1596b7bf367e.pb'),
        'a247c86e-e5fb-420c-b4ff-1596b7bf367e',
      );
    });

    it('normalizes uppercase UUID/extension to lowercase', () => {
      assert.equal(
        parseConversationFilename('A247C86E-E5FB-420C-B4FF-1596B7BF367E.DB'),
        'a247c86e-e5fb-420c-b4ff-1596b7bf367e',
      );
    });

    it('rejects non-UUID filenames and unknown extensions', () => {
      assert.equal(parseConversationFilename('not-a-uuid.db'), null);
      assert.equal(parseConversationFilename('a247c86e-e5fb-420c-b4ff-1596b7bf367e.txt'), null);
      assert.equal(parseConversationFilename('a247c86e-e5fb-420c-b4ff-1596b7bf367e.db.bak'), null);
      assert.equal(parseConversationFilename(''), null);
    });
  });
});
