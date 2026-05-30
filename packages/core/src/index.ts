// @agentbridge/core — shared logic for the desktop app and the VS Code extension.
//
// Phase 1: 공유 타입과 유틸리티
//   - CLI 종류
//   - IR 스키마 + 검증
//   - TurnRecord 스키마 + cap 상수
//   - POSIX shell quote

export * from './shared/cli';
export * from './shared/ir';
export * from './shared/turns';
export * from './shellQuote';
