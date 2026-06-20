// @agentbridge/core — shared logic for the desktop app and the VS Code extension.

// 공유 타입
export * from './shared/cli.js';
export * from './shared/ir.js';
export * from './shared/turns.js';
export * from './shared/global.js';
export * from './globalPaths.js';
export * from './globalMarkdown.js';
export * from './globalValidate.js';
export * from './globalStore.js';
export * from './proposalStore.js';
export * from './proposalParse.js';
export * from './proposalPrompt.js';
export * from './proposalCursor.js';
export * from './proposalPass.js';
export * from './globalSearch.js';
export * from './globalInject.js';

// 순수 유틸
export * from './shellQuote.js';
export * from './cliGlobalDirs.js';

// IR module
export * from './irModule/parse.js';
export * from './irModule/prompt.js';

// 사이드이펙트 추상화
export * from './interfaces.js';

// 저장소
export * from './storageRoot.js';
export * from './fileLock.js';
export * from './workspaceId.js';
export * from './turnsStore.js';
export * from './irStore.js';
export * from './workspaceStore.js';
export * from './hookStatusStore.js';
export * from './sessionRegistry.js';
export * from './sessionOwner.js';
export * from './fileTail.js';
export * from './transcriptReader/types.js';
export * from './transcriptReader/util.js';
export * from './transcriptReader/claudeReader.js';
export * from './transcriptReader/codexReader.js';
export * from './transcriptReader/agyReader.js';
export * from './transcriptReader/watcher.js';
export * from './transcriptReader/manager.js';
export * from './transcriptReader/resolvePath.js';
export * from './transcriptReader/captureManager.js';
export * from './sessionFileWatcher.js';
export * from './ownerWatcher.js';
// attachmentStore는 데스크탑 미사용 (외부 경로 직접 입력 방식) — 2026-06-01 apps/extension/src/core/로 이전.
// workspaceStore는 sessionRegistry/turnRecorder 통합과 함께 Phase 6에서 재정리 예정 (현재 데스크탑은
// 자체 824줄 구현 중인데, 그 안 750줄이 sessionRegistry/lock/legacy 마이그레이션이고 진짜 본체는 ~50줄).

// 환경 / PTY
export * from './envProbe.js';
export * from './ptyDisplayFilter.js';

// hook
export * from './hookInstaller.js';

// refine
export * from './refineHeadless.js';
export * from './refineDispatcher.js';
export * from './refineCliArgs.js';
export * from './refineHome.js';

// compaction
export * from './compactionScheduler.js';

// quota
export * from './quotaTracker.js';

// PTY 공용 타입
export * from './pty/types.js';

// CLI 어댑터
export * from './cliAdapter/index.js';
export * from './cliAdapter/codexSessionWatcher.js';
export * from './cliAdapter/agyResume.js';

// SDK 어댑터 (rearch/sdk-gui)
// 주의: claudeAdapter는 ESM 전용 SDK(@anthropic-ai/claude-agent-sdk)를 정적 import한다. 배럴에 노출하면
// 코어를 번들하는 호스트(esbuild/electron-vite)가 SDK를 통째로 끌어들여 CJS require(ESM)로 터진다.
// 그래서 claudeAdapter는 여기서 export하지 않고, 호스트가 dist/sdkAdapter/claudeAdapter.js를 런타임
// 동적 import로만 로드한다(공식 클로드 익스텐션과 동일 패턴). 타입은 types.js로 충분히 공개된다.
export * from './sdkAdapter/types.js';
export * from './sdkAdapter/sdkCapture.js';
// codexAdapter는 SDK-free(child_process+JSON)라 배럴 OK — 호스트가 정적 import. (claudeAdapter만 ESM SDK라 비노출)
export * from './sdkAdapter/codexAdapter.js';
