// 0.6.0 사용량 조회 2단계 — 자격증명 읽기.
//
// 읽기만 한다. 쓰지 않고 지우지 않고 갱신하지 않는다. 반환값에 리프레시 토큰을 싣지 않는 것도
// 계약이라 테스트로 못박는다 — 한 번 새면 되돌릴 수 없는 종류다.
import { strict as assert } from 'assert';
import { join } from 'path';
import {
  readClaudeCredential,
  readCodexCredential,
  readAgyCredential,
  type CredentialIO,
} from '../src/core/usage/credentials';

const HOME = '/Users/tester';

function io(opts: {
  keychain?: Record<string, string>;
  files?: Record<string, string>;
  env?: Record<string, string | undefined>;
}): CredentialIO {
  const keychain = opts.keychain ?? {};
  const files = opts.files ?? {};
  return {
    readKeychain: (service, account) => keychain[account ? `${service}/${account}` : service] ?? null,
    readTextFile: (path) => files[path] ?? null,
    env: opts.env ?? {},
    home: HOME,
  };
}

const claudeBlob = (token: string) =>
  JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: 'rt-secret' } });

const agyBlob = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    token: {
      access_token: 'ya29.token',
      token_type: 'Bearer',
      refresh_token: 'rt-secret',
      expiry: '2026-09-07T19:14:18.669227+09:00',
      ...over,
    },
    auth_method: 'consumer',
  });

const b64 = (s: string) => 'go-keyring-base64:' + Buffer.from(s, 'utf8').toString('base64');

describe('usage/credentials', () => {
  describe('claude', () => {
    it('Keychain의 claudeAiOauth.accessToken을 읽는다', () => {
      const c = readClaudeCredential(io({ keychain: { 'Claude Code-credentials': claudeBlob('sk-ant-x') } }));
      assert.equal(c?.accessToken, 'sk-ant-x');
    });

    it('Keychain이 없으면 ~/.claude/.credentials.json을 본다', () => {
      const c = readClaudeCredential(
        io({ files: { [join(HOME, '.claude', '.credentials.json')]: claudeBlob('sk-ant-file') } }),
      );
      assert.equal(c?.accessToken, 'sk-ant-file');
    });

    it('Keychain이 있으면 파일보다 먼저다', () => {
      const c = readClaudeCredential(
        io({
          keychain: { 'Claude Code-credentials': claudeBlob('sk-ant-keychain') },
          files: { [join(HOME, '.claude', '.credentials.json')]: claudeBlob('sk-ant-file') },
        }),
      );
      assert.equal(c?.accessToken, 'sk-ant-keychain');
    });

    it('CLAUDE_CONFIG_DIR이 있으면 그 폴더의 파일을 본다', () => {
      const c = readClaudeCredential(
        io({
          env: { CLAUDE_CONFIG_DIR: '/custom/claude' },
          files: { '/custom/claude/.credentials.json': claudeBlob('sk-ant-custom') },
        }),
      );
      assert.equal(c?.accessToken, 'sk-ant-custom');
    });

    it('Keychain 값이 깨졌으면 파일로 넘어간다', () => {
      const c = readClaudeCredential(
        io({
          keychain: { 'Claude Code-credentials': 'not json' },
          files: { [join(HOME, '.claude', '.credentials.json')]: claudeBlob('sk-ant-file') },
        }),
      );
      assert.equal(c?.accessToken, 'sk-ant-file');
    });

    it('아무 데도 없으면 null이다', () => {
      assert.equal(readClaudeCredential(io({})), null);
    });

    it('토큰이 빈 문자열이면 null이다', () => {
      assert.equal(readClaudeCredential(io({ keychain: { 'Claude Code-credentials': claudeBlob('') } })), null);
    });

    it('리프레시 토큰을 싣지 않는다', () => {
      const c = readClaudeCredential(io({ keychain: { 'Claude Code-credentials': claudeBlob('sk-ant-x') } }));
      assert.equal(JSON.stringify(c).includes('rt-secret'), false);
    });
  });

  describe('codex', () => {
    const authPath = join(HOME, '.codex', 'auth.json');
    const blob = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { id_token: 'idt', access_token: 'jwt-token', refresh_token: 'rt-secret', account_id: 'acct-1' },
    });

    it('~/.codex/auth.json의 access_token과 account_id를 읽는다', () => {
      const c = readCodexCredential(io({ files: { [authPath]: blob } }));
      assert.equal(c?.accessToken, 'jwt-token');
      assert.equal(c?.accountId, 'acct-1');
    });

    it('CODEX_HOME이 있으면 그 폴더를 본다', () => {
      const c = readCodexCredential(
        io({ env: { CODEX_HOME: '/custom/codex' }, files: { '/custom/codex/auth.json': blob } }),
      );
      assert.equal(c?.accessToken, 'jwt-token');
    });

    it('account_id가 없으면 null로 둔다', () => {
      const c = readCodexCredential(
        io({ files: { [authPath]: JSON.stringify({ tokens: { access_token: 'jwt-token' } }) } }),
      );
      assert.equal(c?.accessToken, 'jwt-token');
      assert.equal(c?.accountId, null);
    });

    it('파일이 없으면 null이다', () => {
      assert.equal(readCodexCredential(io({})), null);
    });

    it('깨진 JSON이면 null이다', () => {
      assert.equal(readCodexCredential(io({ files: { [authPath]: '{' } })), null);
    });

    it('리프레시 토큰을 싣지 않는다', () => {
      const c = readCodexCredential(io({ files: { [authPath]: blob } }));
      assert.equal(JSON.stringify(c).includes('rt-secret'), false);
    });
  });

  describe('agy', () => {
    const slot = 'gemini/antigravity';

    it('go-keyring-base64 접두사를 벗기고 디코딩해 읽는다', () => {
      const c = readAgyCredential(io({ keychain: { [slot]: b64(agyBlob()) } }));
      assert.equal(c?.accessToken, 'ya29.token');
    });

    it('만료 시각을 epoch ms로 준다', () => {
      const c = readAgyCredential(io({ keychain: { [slot]: b64(agyBlob()) } }));
      assert.equal(c?.expiresAt, Date.parse('2026-09-07T19:14:18.669227+09:00'));
    });

    it('접두사 없이 평문 JSON이어도 읽는다', () => {
      const c = readAgyCredential(io({ keychain: { [slot]: agyBlob() } }));
      assert.equal(c?.accessToken, 'ya29.token');
    });

    it('만료 시각이 없으면 null로 둔다', () => {
      const c = readAgyCredential(io({ keychain: { [slot]: b64(JSON.stringify({ token: { access_token: 'ya29.x' } })) } }));
      assert.equal(c?.accessToken, 'ya29.x');
      assert.equal(c?.expiresAt, null);
    });

    it('Keychain 항목이 없으면 null이다', () => {
      assert.equal(readAgyCredential(io({})), null);
    });

    it('디코딩 결과가 JSON이 아니면 null이다', () => {
      assert.equal(readAgyCredential(io({ keychain: { [slot]: b64('not json') } })), null);
    });

    it('리프레시 토큰을 싣지 않는다', () => {
      const c = readAgyCredential(io({ keychain: { [slot]: b64(agyBlob()) } }));
      assert.equal(JSON.stringify(c).includes('rt-secret'), false);
    });
  });
});
