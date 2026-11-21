// replay.log 경로 헬퍼 — screenReplay와 분리해 무거운 가상 터미널 의존성이
// 훅 헬퍼(agentbridge-memory.js) 번들에 딸려 들어가지 않게 한다.

import { join } from 'path';

export function replayLogPath(sessionDir: string): string {
  return join(sessionDir, 'replay.log');
}

// replay.log를 다시 그릴 탭 크기. owner.json과 달리 PTY가 끝나도 지우지 않는다 — 끝난 서브를
// 다른 크기로 재생하면 다시 그린 자리가 어긋나 줄이 겹친다(0.8.0 research/08 §5).
export function replaySizePath(sessionDir: string): string {
  return join(sessionDir, 'replay-size.json');
}
