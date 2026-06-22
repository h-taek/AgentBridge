// SDK 어댑터 팩토리 — PTY `createCliAdapters`의 SDK 짝. model→AgentAdapter 선택을 코어 한 곳에 모은다.
// 호스트(익스텐션·데스크탑)는 이 set만 받아 `set[model]`로 어댑터를 꺼낸다 — 선택 로직·agy 처리 중복 0.
//
// 비대칭 봉인:
//   - claude: ESM 전용 SDK(@anthropic-ai/claude-agent-sdk)라 배럴 비노출 → 호스트가 번들 안전하게 정적
//             import해 주입(captureLifetime식 "호스트가 번들 민감 비트만 주입"). 그 한 줄만 호스트별.
//   - codex : SDK-free(child_process+JSON)라 코어가 직접 들고 온다.
//   - agy   : SDK 전경 채팅 미지원(Gemini API 키 필수) → 명시적 throw 스텁. 전경에선 호스트가 PTY로 라우팅.
import type { CliKind } from '../shared/cli.js';
import type { AgentAdapter, Session } from './types.js';
import { codexAdapter } from './codexAdapter.js';

export interface SdkAdapterSet {
  readonly claude: AgentAdapter;
  readonly codex: AgentAdapter;
  readonly agy: AgentAdapter;
}

export interface CreateSdkAdaptersOptions {
  // claude 어댑터 인스턴스 — 호스트가 정적 import해 주입(ESM 번들 경계).
  claude: AgentAdapter;
}

// agy SDK 전경 채팅 미지원 — 잘못 도달하면 명시적으로 실패(옛 `codex? : claude` 삼항의 agy→claude 오폴백 제거).
const agyAdapter: AgentAdapter = {
  id: 'agy',
  async start(): Promise<Session> {
    throw new Error('agy는 SDK 채팅을 지원하지 않습니다 — PTY 모드를 사용하세요.');
  },
};

export function createSdkAdapters(opts: CreateSdkAdaptersOptions): SdkAdapterSet {
  return {
    claude: opts.claude,
    codex: codexAdapter,
    agy: agyAdapter,
  } satisfies Record<CliKind, AgentAdapter>;
}
