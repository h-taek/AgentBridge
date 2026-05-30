# 마이그레이션 계획 — 두 레포 → 모노레포

## 출발점 (실측 — 2026-05-30)

| 항목 | 상태 |
|---|---|
| `resources/bin/agentbridge-memory.js` | **byte-identical** (383줄, 100% 일치) |
| `src/shared/{ir,turns,ipc}.ts` (app) ↔ `src/shared/types.ts` (extension) | 같은 스키마, 파일 분할 구조만 다름 |
| `turnRecorder/` | 양쪽 평행 존재, 거의 동일 |
| `irModule/` (parse, prompt) | 양쪽 평행 존재 |
| `cliAdapter/` | 양쪽 평행 존재 |
| `hookInstaller.ts` | 양쪽 존재 |
| `compactionScheduler.ts` | 양쪽 존재 |
| `refineDispatcher.ts` | 양쪽 존재 |
| `shellQuote.ts` | 익스텐션에만, 앱은 inline `shellQuoteIfNeeded` (POSIX escape 잘못됨) |

## 진행 상태 (2026-05-30 종료 시점)

### ✅ Phase 0 — 인프라
- pnpm workspaces + changesets 셋업
- `packages/core` 스캐폴드
- `agentbridge-memory.js`를 `packages/core/bin/`으로 이관 (byte-identical)

### ✅ Phase 1 — 공유 타입과 순수 유틸
- `shared/cli`: CliKind + display names
- `shared/ir`: IR 스키마 + IR_CAP + validateIR
- `shared/turns`: TurnRecord + TURN_CAP + COMPACTION_TRIGGER + TURNS_ROTATE + TURNS_ASSISTANT_DETAIL_CAP
- `shellQuote`: POSIX 정확 escape (extension 버전 채택)

### ✅ Phase 2 — 순수 함수 모듈
- `irModule/prompt`: buildCompactionPrompt
- `irModule/parse`: parseRefineOutput + assembleIR (gitInfo 주입형으로 refactor — git probe는 호스트가 책임)
- `turnRecorder/sliceAssistant`: 6단계 PTY pipeline
- `Buffer.byteLength` 의존 제거 → ES2022 순수 함수

### ✅ Phase 3 — 사이드이펙트 모듈 (DI)
공통 인터페이스:
- `Logger` (log/warn) + `noopLogger`
- `Clock` (now/isoNow) + `systemClock`

이관 완료:
- `turnsStore` — workspaceRoot 인자, maxArchiveSnapshots 파라미터, Logger 주입
- `workspaceStore` — `createWorkspaceStore(globalStoragePath, opts)` 팩토리
- `hookStatusStore` — `createHookStatusStore()` 팩토리 (EventEmitter 내장)
- `attachmentStore` — cwd 인자 전달, vscode.workspaceFolders 의존 제거
- `sessionRegistry` — `createSessionRegistry({ logger, onAfterDelete })` 팩토리
- `hookInstaller` — `createHookInstaller({ helperPath, globalStoragePath, logger })` 팩토리
- `envProbe` — `createEnvProbe({ logger })` 팩토리
- `ptyDisplayFilter` — `PtyDisplayFilter` 클래스, constructor에 Logger 옵션
- `refineHeadless` — `runRefineSpawn` 함수, Logger 인자
- `refineDispatcher` — `runRefine({ order, singleCandidate, envProbe, logger })` (refinePolicy 해석은 호스트)
- `compactionScheduler` — `createCompactionScheduler({ notifications, envProbe, gitProbe, resolveRefineOrder, maxArchiveSnapshots, events, logger })`
- `turnRecorder/index` — `TurnRecorder` 클래스, scheduler/sessionRegistry/getAssistantDetail 주입
- `cliAdapter` — `createCliAdapters({ envProbe, hookInstaller, hookStatusStore, workspaceClaudeDir, logger })`
- `cliAdapter/codexSessionWatcher` — snapshotCodexSessions, captureNewThreadId
- `cliAdapter/agyResume` — resolveResumeArgs, snapshotAgyConversations, watchForNewConversationUuid
- `pty/types` — SpawnOptions

### ✅ Phase 4 — 검증
- `pnpm install` 통과
- `pnpm exec tsc -p packages/core` 컴파일 통과 (dist 산출물 정상 생성)
- `@types/node` devDep 등록

## ✅ Phase 5 — 진행 상황

### 5.1 익스텐션 (03_AgentBridge_Extension → apps/extension/)
- 원본 소스 전체를 apps/extension/으로 복사
- 모든 중복 모듈을 thin facade로 교체 (호출처 변경 0)
- src/core/coreInstances.ts에서 모든 코어 인스턴스를 한 곳에서 셋업
- activate(context) 첫 줄에서 initializeCore(context) 호출
- **`pnpm exec tsc -p apps/extension` 풀빌드 PASS, out/extension.js 생성 확인**
- 사용자 검증 대기: F5 실행 → chat 동작 / hook 설치 / 모델 전환 확인

### 5.2 데스크탑 (02_AgentBridge_App → apps/desktop/) — 부분 진행
- 원본 소스 전체를 apps/desktop/으로 복사 + @agentbridge/core dep 등록
- shared/{ir, turns} → 코어 re-export (CliKind는 shared/ipc에 그대로)
- main/modules/irModule/{prompt, parse} → 코어 facade
- main/modules/cliAdapter/codexSessionWatcher → 코어 re-export
- **`npm run typecheck` (node + web) PASS**
- 사용자 검증 대기: `pnpm dev`로 Electron 윈도우 동작 / IR refine 동작 확인

### 5.3 데스크탑 — 남은 cutover (per-module 인터페이스 매핑 필요)
데스크탑 측이 익스텐션과 다르게 진화한 API들. 각각 어떻게 매핑할지 결정 후 모듈 단위로 진행:

| 모듈 | desktop API | core API | 차이 |
|---|---|---|---|
| `modules/turnsStore.ts` | `archiveCompactedTurns`, `readRecentTurns` 등 | `stage/commit/abortArchive` 2-phase | 2-phase commit 도입 또는 core에 1-step API 추가 |
| `modules/workspaceStore.ts` | `ensureWorkspaceDirs`, `getWorkspacePaths`, `createWorkspace`, `listWorkspaces` 등 | `createWorkspaceStore` 팩토리(`getOrCreate`, `getWorkspacePath`) | 데스크탑 전용 워크스페이스 메타(title, lastActive 등)는 core가 모름 — 어댑터 레이어 필요 |
| `modules/envProbe.ts` | `probeEnvOnce`(캐시), `getCliPath`, `getShellPath` | `createEnvProbe`(probe/getShellEnv) | 데스크탑은 캐시·CLI별 path 분리 — wrapper로 매핑 가능 |
| `modules/ptyDisplayFilter.ts` | `registerDisplayFilter(sessionId)`, `filterDisplayData` 등 — sessionId별 인스턴스 레지스트리 | `PtyDisplayFilter` 클래스 | 데스크탑이 레지스트리 wrapper 유지하면서 내부에서 코어 인스턴스 사용 |
| `modules/hookInstaller.ts` | desktop 자체 구현 | `createHookInstaller` | helperPath/globalStoragePath 주입 매핑 필요 |
| `modules/compactionScheduler.ts` | desktop 자체 + cliQuotaTracker 통합 | `createCompactionScheduler` | quotaTracker는 desktop-only — 콜백 hook 추가 검토 |
| `modules/refineDispatcher.ts` | desktop 자체 + quota 측정 통합 | `runRefine` 함수형 | quotaTracker 통합 분리 필요 |
| `modules/cliAdapter/{claude,codex,agy}Adapter.ts` | desktop 시그니처 다름 | `createCliAdapters` factory set | 시그니처 맞추기 |
| `modules/cliAdapter/agyResume.ts` | desktop에 추가 함수 다수 (`snapshotAgyImplicit`, `deleteAgy*` 등) | core는 subset | core에 추가 export 또는 desktop wrapper 유지 |
| `modules/cliAdapter/refineHeadless.ts` | desktop 자체 | `runRefineSpawn` | 매핑 가능 |
| `modules/turnRecorder/{index, sliceAssistant}` | desktop 자체 | core (DI 형태) | turnRecorder 생성자 시그니처 변경 |
| `main/ipc/attachHandlers.ts` `shellQuoteIfNeeded` | inline 함수, POSIX escape 잘못됨 | `quoteArg` (정확) | import 교체 (정정 효과 포함) |

권장 진행 방식: 위 표를 위→아래로 한 줄씩 진행. 각 줄마다:
1. desktop wrapper 작성 (코어를 import하면서 desktop API 시그니처 유지)
2. `npm run typecheck` PASS
3. `pnpm dev`로 동작 확인
4. 커밋

## 🟡 원래의 Phase 5 — 앱 실제 이관 (남은 작업)

### 왜 여기서 멈췄나
양쪽 앱이 실제 동작하는지 검증하려면:
- 익스텐션: VS Code에서 launch (F5 / `code --extensionDevelopmentPath`) 후 chat panel 동작 확인
- 데스크탑: `pnpm dev` 후 메인/렌더러 빌드 + Electron 윈도우에서 동작 확인

이 검증을 안 하고 코드만 옮기면 *조용히 깨진* 상태가 만들어진다. 사용자가 직접 실행해서
검증하면서 끊어가는 것이 안전.

### Phase 5 단계별 체크리스트

각 앱에 대해 모듈 하나씩 옮기고 매번 빌드 + 실행 검증.

#### 5.1 익스텐션 (03_AgentBridge_Extension → apps/extension/)
1. **준비**
   - `apps/extension/package.json` 작성: name `@agentbridge/extension`, `"@agentbridge/core": "workspace:*"`, 나머지 deps는 원본 package.json에서 복사.
   - `apps/extension/tsconfig.json` 작성: `extends: ../../tsconfig.base.json`, rootDir/outDir.
   - 원본 `src/` 전체를 `apps/extension/src/`로 복사.
2. **단순 치환** (낮은 위험)
   - `src/shared/types.ts` 삭제 → import를 `@agentbridge/core`로
   - `src/shared/shellQuote.ts` 삭제 → import를 `@agentbridge/core`로
   - `src/core/turnRecorder/sliceAssistant.ts` 삭제 → import 변경
   - `src/core/turnRecorder/constants.ts` 삭제 → import 변경
   - `src/core/irModule/{parse,prompt}.ts` 삭제 → import 변경
   - `pnpm typecheck`로 검증, F5로 익스텐션 실행 확인.
3. **저장소 모듈** (중간 위험 — 인터페이스 주입 필요)
   - `extension.ts`의 `activate()`에서 코어 인스턴스 생성:
     ```ts
     const log = { log: (m) => output.log(m), warn: (m) => output.warn(m) };
     const workspaceStore = createWorkspaceStore(context.globalStorageUri.fsPath, { logger: log });
     const hookStatusStore = createHookStatusStore();
     const envProbe = createEnvProbe({ logger: log });
     const hookInstaller = createHookInstaller({
       helperPath: path.join(context.extensionPath, 'resources/bin/agentbridge-memory.js'),
       globalStoragePath: workspaceStore.getGlobalStoragePath(),
       logger: log,
     });
     const sessionRegistry = createSessionRegistry({
       logger: log,
       onAfterDelete: (wid, sid) => cleanupSessionAttachments(workspaceCwd, sid, { logger: log }),
     });
     const cliAdapters = createCliAdapters({ envProbe, hookInstaller, hookStatusStore, workspaceClaudeDir: (wid) => workspaceStore.getWorkspacePath(wid), logger: log });
     ```
   - 원본 `src/core/{turnsStore, workspaceStore, sessionRegistry, hookStatusStore, attachmentStore, hookInstaller, envProbe}.ts` 삭제 → import 치환
   - `pnpm typecheck` + F5로 활성화·hook 설치 확인.
4. **오케스트레이터** (높은 위험)
   - compactionScheduler / refineDispatcher / refineHeadless / turnRecorder/index 치환
   - `activate()`에 `createCompactionScheduler({...})` 추가, resolveRefineOrder는 익스텐션의 `getConfig()` 결과를 매핑.
   - notifications는 익스텐션의 기존 notifications.ts를 인터페이스로 어댑팅.
   - chatPanel에서 TurnRecorder 생성 시 scheduler/sessionRegistry/getAssistantDetail 전달.
   - 실 chat 동작 (claude/codex/agy 각 1턴) 확인.
5. **cliAdapter**
   - `src/core/cliAdapter/*` 삭제 → `cliAdapters.claude.buildSpawnOptions(...)` 형태로 치환.
   - 3개 CLI 모두 spawn + resume 동작 확인.
6. **마지막**
   - resources/bin/agentbridge-memory.js는 코어가 dist/bin/에 보유. 익스텐션 build 시 코어의 bin을 자기 resources에 복사하거나, hook command에서 코어 패키지 경로를 직접 사용.

#### 5.2 데스크탑 앱 (02_AgentBridge_App → apps/desktop/)
같은 순서. Electron main process가 host. renderer는 IPC로 main에 위임.

#### 5.3 마무리
- 양쪽 모두 동작 확인 후 03_AgentBridge_Extension, 02_AgentBridge_App을 archive (README에서 deprecated 표시 + .gitignore에 추가, 또는 별도 archive/ 폴더로 이동).
- changesets 첫 릴리스: `@agentbridge/extension`와 `@agentbridge/desktop`이 독립 버전으로 publish 가능한지 확인.

## 알려진 이슈 (이관 중 마주칠 것)

코어로 옮기면서 발견되었으나 별도 PR에서 다룰 항목:

- **AGY_TOOL_PREFIX_RE 미앵커** (`turnRecorder/sliceAssistant.ts`) — `✓ Reading 완료` 같은 prose가 tool call로 오분류. `'^(' + ... + ')$'`로 수정 필요. (faithful copy 상태)
- **첫 compaction 시 raw turn 폐기** (`compactionScheduler`) — currentIR이 null일 때 archive 없이 oldest 삭제. 새 ir로 아카이브하도록 수정 필요.
- **턴 append vs compaction rewrite 경합** (`turnsStore.appendTurn` ↔ `compactionScheduler.checkAndRun`) — workspace 단위 mutex 도입 필요.
- **dispose 시 awaiting turn 누락** — `TurnRecorder.dispose()`가 awaiting 상태도 flush하도록 이미 코어에서 수정함. 익스텐션/앱이 `disposeAndFlush()` 호출하도록 cutover.
- **디스크락이 진짜 CAS 아님** — `fs.open(lockPath, 'wx')` 배타 생성으로 교체.

자세한 내용: 원본 익스텐션의 `docs/CODE_REVIEW_2026-05-29.md`.

## 원칙 (재확인)

1. **원본 두 레포는 마이그레이션 완료까지 그대로 둔다.** 롤백 가능 상태 유지.
2. **각 단계는 독립적으로 mergeable.** 컴파일 통과 + 동작 검증 없이 다음 단계로 진행하지 않는다.
3. **코어는 `vscode` / `electron` 직접 import 금지.** 호스트가 인터페이스 구현체를 주입.
4. **차이가 드러나는 모듈은 옮길 때 통일.** 한쪽 버전 채택 + 차이 사유 코멘트.
