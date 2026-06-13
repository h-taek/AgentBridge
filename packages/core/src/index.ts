// @agentbridge/core — shared logic for the desktop app and the VS Code extension.

// 공유 타입
export * from './shared/cli';
export * from './shared/ir';
export * from './shared/turns';
export * from './shared/global';

// 순수 유틸
export * from './shellQuote';
export * from './cliGlobalDirs';

// IR module
export * from './irModule/parse';
export * from './irModule/prompt';

// 사이드이펙트 추상화
export * from './interfaces';

// 저장소
export * from './storageRoot';
export * from './fileLock';
export * from './workspaceId';
export * from './turnsStore';
export * from './irStore';
export * from './workspaceStore';
export * from './hookStatusStore';
export * from './sessionRegistry';
export * from './sessionOwner';
export * from './fileTail';
export * from './transcriptReader/types';
export * from './transcriptReader/util';
export * from './transcriptReader/claudeReader';
export * from './transcriptReader/codexReader';
export * from './transcriptReader/agyReader';
export * from './transcriptReader/watcher';
export * from './transcriptReader/manager';
export * from './transcriptReader/resolvePath';
export * from './transcriptReader/captureManager';
export * from './sessionFileWatcher';
export * from './ownerWatcher';
// attachmentStore는 데스크탑 미사용 (외부 경로 직접 입력 방식) — 2026-06-01 apps/extension/src/core/로 이전.
// workspaceStore는 sessionRegistry/turnRecorder 통합과 함께 Phase 6에서 재정리 예정 (현재 데스크탑은
// 자체 824줄 구현 중인데, 그 안 750줄이 sessionRegistry/lock/legacy 마이그레이션이고 진짜 본체는 ~50줄).

// 환경 / PTY
export * from './envProbe';
export * from './ptyDisplayFilter';

// hook
export * from './hookInstaller';

// refine
export * from './refineHeadless';
export * from './refineDispatcher';
export * from './refineCliArgs';
export * from './refineHome';

// compaction
export * from './compactionScheduler';

// quota
export * from './quotaTracker';

// PTY 공용 타입
export * from './pty/types';

// CLI 어댑터
export * from './cliAdapter/index';
export * from './cliAdapter/codexSessionWatcher';
export * from './cliAdapter/agyResume';
