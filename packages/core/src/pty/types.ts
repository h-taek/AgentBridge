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
  // 훅이 이 세션의 턴 종료 신호를 쓰는 파일. 셋 다 있다 — 턴 기록의 트리거다 (0.5.0 A-2).
  turnSignalFilePath?: string;
  // 이 세션이 서브라면 부모의 세션 id (0.5.0 B-6). 호스트가 레코드와 기록의 뿌리를 정할 때 쓴다.
  parentSessionId?: string;
  // 첫 턴이 시작된 뒤 호스트가 입력으로 넣을 명령. agy는 --remote-control을 켠 채 -i로 띄우면
  // 첫 턴을 화면에 그리지 않아서, 그때는 원격 컨트롤을 기동 인자 대신 이것으로 켠다.
  commandAfterTurnStart?: string;
}
