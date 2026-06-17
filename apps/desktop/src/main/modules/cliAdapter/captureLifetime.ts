import type { SpawnInteractiveHooks } from './types'

// 세션 id 캡처 워처의 수명을 PTY 생명주기에 묶는 공통 배선. 데스크탑 모든 어댑터가 이 한 구현을
// 공유한다 — 컨트롤러 생성 + onExit에서 abort를 어댑터마다 따로 적다가 빠뜨리는 일(agy 데스크탑
// 구멍, 0.4.0 수정)을 막기 위함. **무엇을** 캡처하는지(codex captureNewThreadId /
// agy watchForNewConversationUuid)는 CLI별이라 어댑터가 signal만 받아 직접 호출한다.
//
// 익스텐션은 chatPanel이 패널 dispose로 같은 역할을 하므로 이 헬퍼는 데스크탑 전용(트리거가
// PTY onExit). 캡처가 실제로 도는 spawn에서만 호출해야 한다(불필요한 onExit 래핑 회피).
export function createCaptureLifetime(hooks: SpawnInteractiveHooks): {
  signal: AbortSignal
  hooks: SpawnInteractiveHooks
} {
  const ctrl = new AbortController()
  return {
    signal: ctrl.signal,
    hooks: {
      ...hooks,
      onExit: (info) => {
        ctrl.abort()
        hooks.onExit?.(info)
      }
    }
  }
}
