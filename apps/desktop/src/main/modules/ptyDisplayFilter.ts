// PTY display filter — ptySessionId-keyed registry over core PtyDisplayFilter.
//
// 알고리즘(ANSI/C0 strip → plain indexOf → emit/drop, watchdog 포함)은 core
// packages/core/src/ptyDisplayFilter.ts의 PtyDisplayFilter 클래스 단일 구현을 쓴다.
// 데스크탑은 IPC 라이프사이클이 ptySessionId를 키로 쓰므로(클래스 인스턴스 핸들을 IPC
// 너머로 들고 다닐 수 없음) 세션별 인스턴스를 Map에 보관하고 stateless 함수로 감싼다.
// (V-15 — 과거엔 알고리즘을 desktop에 복붙해 "두 파일 같이 고쳐야 함" 위험이 있었음.)
//
// 배경: codex 0.130.0 + gemini는 hook `additionalContext`를 TUI에 visible developer
// message로 렌더링(suppressOutput no-op, openai/codex#15497·#16933). 워크어라운드로
// `<agentbridge-context>…</agentbridge-context>` 블록을 PTY→renderer/turnRecorder 경로에서
// 제거한다. replay.log엔 raw 그대로 (포렌식/디버그).

import log from 'electron-log/main'
import { PtyDisplayFilter } from '@agentbridge/core'

const filters = new Map<string, PtyDisplayFilter>()

const logger = { log: (m: string) => log.info(m), warn: (m: string) => log.warn(m) }

export function registerDisplayFilter(ptySessionId: string): void {
  filters.set(ptySessionId, new PtyDisplayFilter({ logger }))
}

export function unregisterDisplayFilter(ptySessionId: string): void {
  const f = filters.get(ptySessionId)
  if (f) f.dispose()
  filters.delete(ptySessionId)
}

// 등록 안 된 세션은 pass-through. 호출자는 항상 returned value를 사용.
export function filterDisplayData(ptySessionId: string, data: string): string {
  const f = filters.get(ptySessionId)
  return f ? f.filter(data) : data
}
