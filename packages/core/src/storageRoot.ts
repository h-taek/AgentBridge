// AgentBridge 통일 저장소 루트 — 데스크탑/익스텐션이 같은 곳을 본다 (V-12).
//
// 이 값은 제품 규칙이다. 호스트 앱이 다른 경로를 주입할 수 없다 — 주입 구조를 남겨두면
// 미래의 실수 하나로 저장소가 다시 갈라진다 (V-12 재발). 테스트만 rootPathForTesting으로 우회.

import { homedir } from 'os';
import { join } from 'path';

export function getStorageRoot(): string {
  return join(homedir(), '.agentbridge');
}
