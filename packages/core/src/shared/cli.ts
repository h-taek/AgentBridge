// AgentBridge가 지원하는 CLI 종류.

export type CliKind = 'claude' | 'codex' | 'agy';

/** 화면과 폴링이 도는 순서. 바꾸면 사이드바 사용량 줄의 알약 순서가 같이 바뀐다. */
export const CLI_KINDS: readonly CliKind[] = ['claude', 'codex', 'agy'];

export const CLI_DISPLAY_NAME: Record<CliKind, string> = {
  claude: 'Claude',
  codex: 'Codex',
  agy: 'Antigravity',
};
