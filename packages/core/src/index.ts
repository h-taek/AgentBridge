// @agentbridge/core — shared logic for the desktop app and the VS Code extension.

// 공유 타입
export * from './shared/cli';
export * from './shared/ir';
export * from './shared/turns';

// 순수 유틸
export * from './shellQuote';

// IR module
export * from './irModule/parse';
export * from './irModule/prompt';

// turnRecorder
export * from './turnRecorder/sliceAssistant';
