// 0.6.0 사용량 조회 3단계 — 요청 명세.
//
// 세 벤더 모두 헤더가 게이트다. agy는 User-Agent에 'antigravity'가 없으면 403이 나고(research/01),
// codex는 계정 헤더를 계정이 있을 때만 실어야 한다. 그래서 헤더 구성 자체를 테스트로 못박는다.
import { strict as assert } from 'assert';
import { buildUsageRequest } from '@agentbridge/core';

describe('usage/endpoints', () => {
  describe('claude', () => {
    const req = buildUsageRequest('claude', { accessToken: 'sk-ant-x' });

    it('oauth usage 엔드포인트를 GET한다', () => {
      assert.equal(req.method, 'GET');
      assert.equal(req.url, 'https://api.anthropic.com/api/oauth/usage');
      assert.equal(req.body, undefined);
    });

    it('Bearer 토큰과 beta 헤더를 싣는다', () => {
      assert.equal(req.headers.Authorization, 'Bearer sk-ant-x');
      assert.equal(req.headers['anthropic-beta'], 'oauth-2025-04-20');
    });

    it('벤더 User-Agent를 그대로 보낸다', () => {
      assert.match(req.headers['User-Agent'], /^claude-code\//);
    });
  });

  describe('codex', () => {
    it('wham usage 엔드포인트를 GET한다', () => {
      const req = buildUsageRequest('codex', { accessToken: 'jwt' });
      assert.equal(req.method, 'GET');
      assert.equal(req.url, 'https://chatgpt.com/backend-api/wham/usage');
    });

    it('계정 id가 있으면 ChatGPT-Account-Id를 싣는다', () => {
      const req = buildUsageRequest('codex', { accessToken: 'jwt', accountId: 'acct-1' });
      assert.equal(req.headers['ChatGPT-Account-Id'], 'acct-1');
    });

    it('계정 id가 없으면 그 헤더를 싣지 않는다', () => {
      const req = buildUsageRequest('codex', { accessToken: 'jwt', accountId: null });
      assert.equal('ChatGPT-Account-Id' in req.headers, false);
    });

    it('originator와 beta 헤더를 싣는다', () => {
      const req = buildUsageRequest('codex', { accessToken: 'jwt' });
      assert.equal(req.headers['OpenAI-Beta'], 'codex-1');
      assert.equal(req.headers.originator, 'Codex Desktop');
    });
  });

  describe('agy', () => {
    const req = buildUsageRequest('agy', { accessToken: 'ya29.x' });

    it('retrieveUserQuotaSummary를 POST한다', () => {
      assert.equal(req.method, 'POST');
      assert.equal(
        req.url,
        'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
      );
    });

    // prod 호스트는 200을 내지만 이 계정을 처음 보는 것처럼 답한다 — 네 버킷이 전부 100%이고
    // resetTime이 부를 때마다 밀린다. agy 자신을 그 호스트로 띄워도 100%가 나온다(research/05).
    // 값이 틀린 채로 그럴듯하게 보이는 종류의 고장이라 회귀로 박아 둔다.
    it('prod 호스트를 쓰지 않는다 — 사용량이 안 담겨 온다', () => {
      assert.equal(req.url.startsWith('https://daily-'), true);
      assert.equal(req.url.includes('//cloudcode-pa'), false);
    });

    it('본문은 빈 객체로 고정한다', () => {
      assert.equal(req.body, '{}');
      assert.equal(req.headers['Content-Type'], 'application/json');
    });

    it("User-Agent에 'antigravity'가 들어간다", () => {
      assert.match(req.headers['User-Agent'], /antigravity/);
    });

    // 설치본이 CLOUD_CODE_URL로 백엔드를 바꿔 놓았으면 우리도 따라간다. 우리가 보는 사용량과
    // CLI가 보는 사용량이 갈리면 안 된다.
    it('baseUrl을 주면 그 호스트로 간다', () => {
      const custom = buildUsageRequest('agy', {
        accessToken: 'ya29.x',
        baseUrl: 'https://cloudcode-pa.googleapis.com',
      });
      assert.equal(
        custom.url,
        'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
      );
    });

    it('baseUrl 끝의 슬래시를 흘리지 않는다', () => {
      const custom = buildUsageRequest('agy', {
        accessToken: 'ya29.x',
        baseUrl: 'https://example.test/',
      });
      assert.equal(custom.url, 'https://example.test/v1internal:retrieveUserQuotaSummary');
    });

    it('빈 baseUrl은 기본 호스트로 떨어진다', () => {
      assert.equal(
        buildUsageRequest('agy', { accessToken: 'ya29.x', baseUrl: null }).url,
        req.url,
      );
    });
  });
});
