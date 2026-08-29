// PTY spawn 옵션 — 호스트가 실제 node-pty / spawn 호출에 사용.

import type { CliKind } from '../shared/cli';

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
  // 훅이 이 세션의 native id를 쓰는 파일(<워크스페이스>/sessions/<세션 id>/captured.json).
  // claude는 우리가 id를 발급하므로 없다. 호스트가 captureSessionIdFromHook으로 감시한다.
  hookCaptureFilePath?: string;
}
