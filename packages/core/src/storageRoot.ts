// AgentBridge 통일 저장소 루트 (V-12).
//
// 이 값은 제품 규칙이다. 호스트 앱이 다른 경로를 주입할 수 없다 — 주입 구조를 남겨두면
// 미래의 실수 하나로 저장소가 다시 갈라진다 (V-12 재발). 테스트만 rootPathForTesting으로 우회.
//
// 0.5.0에서 숨김을 뗐다(B-1). 사용자가 직접 들어가 보는 폴더이기 때문이다.
// 옛 루트는 getLegacyStorageRoot()로 남는다 — 장기 메모리만 복사해 오고 지우지는 않는다.

import { homedir } from 'os';
import { join } from 'path';

export function getStorageRoot(): string {
  return join(homedir(), 'agentbridge');
}

export function getLegacyStorageRoot(): string {
  return join(homedir(), '.agentbridge');
}
