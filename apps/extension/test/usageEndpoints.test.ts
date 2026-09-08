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
      assert.equal(req.url, 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary');
    });

    it('본문은 빈 객체로 고정한다', () => {
      assert.equal(req.body, '{}');
      assert.equal(req.headers['Content-Type'], 'application/json');
    });

    it("User-Agent에 'antigravity'가 들어간다", () => {
      assert.match(req.headers['User-Agent'], /antigravity/);
    });

    it('daily- 접두사 호스트를 쓰지 않는다', () => {
      assert.equal(req.url.includes('daily-'), false);
    });
  });
});
