// 사용량 엔드포인트의 요청 명세. 순수 함수라 네트워크를 건드리지 않는다.
//
// 세 요청 모두 해당 CLI가 실제로 보내는 헤더를 그대로 보낸다. 헤더가 게이트라 지어내면 막힌다 —
// agy는 User-Agent에 'antigravity' 부분문자열이 없으면 403이 난다(research/01 §4).
// 벤더 UA는 상수로 두고, 벤더가 바꾸면 우리도 따라 바꾼다.

import type { CliKind } from '../shared/cli';

export interface UsageRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}

export interface UsageRequestInput {
  accessToken: string;
  accountId?: string | null;
}

const USER_AGENT: Record<CliKind, string> = {
  claude: 'claude-code/2.1.0',
  codex: 'codex-cli',
  agy: 'antigravity-cli/1.1.27 (darwin; arm64)',
};

export function buildUsageRequest(cli: CliKind, input: UsageRequestInput): UsageRequest {
  const auth = `Bearer ${input.accessToken}`;

  if (cli === 'claude') {
    return {
      url: 'https://api.anthropic.com/api/oauth/usage',
      method: 'GET',
      headers: {
        Authorization: auth,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': USER_AGENT.claude,
      },
    };
  }

  if (cli === 'codex') {
    const headers: Record<string, string> = {
      Authorization: auth,
      'User-Agent': USER_AGENT.codex,
      'OpenAI-Beta': 'codex-1',
      originator: 'Codex Desktop',
    };
    // 계정 id는 있을 때만 싣는다.
    if (input.accountId) headers['ChatGPT-Account-Id'] = input.accountId;
    return { url: 'https://chatgpt.com/backend-api/wham/usage', method: 'GET', headers };
  }

  return {
    url: 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT.agy,
    },
    // 다른 필드를 실으면 400이 난다.
    body: '{}',
  };
}
