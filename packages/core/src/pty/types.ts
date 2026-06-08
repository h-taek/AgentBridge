// PTY spawn 옵션 — 호스트가 실제 node-pty / spawn 호출에 사용.

import type { CliKind } from '../shared/cli';
import type { CodexSessionSnapshot } from '../cliAdapter/codexSessionWatcher';

export interface SpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  terminalName: string;
  model?: CliKind;
  workspaceId?: string;
  sessionId?: string;
  modelSessionId?: string;
  codexSessionSnapshot?: CodexSessionSnapshot;
  agyWatchUuid?: { excludeUuids: Set<string> };
}
