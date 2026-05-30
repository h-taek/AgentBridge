// AgentBridge가 지원하는 CLI 종류.

export type CliKind = 'claude' | 'codex' | 'agy';

export const CLI_DISPLAY_NAME: Record<CliKind, string> = {
  claude: 'Claude',
  codex: 'Codex',
  agy: 'Antigravity',
};
