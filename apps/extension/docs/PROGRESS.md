# AgentBridge Extension - Progress Report

> 2026-05-26 기준 진행 상황. 원본 Electron 앱(02_AgentBridge_App)에서 VSCode/Antigravity IDE 익스텐션으로의 포팅 작업 기록.
> 마지막 업데이트: 2026-05-26 (v0.1.6 안정화 및 정리)

---

## v0.1.6 안정화 및 정리 (2026-05-25)

### 목적
- v0.1.6은 신규 UX 추가가 아니라 **출력 안정성 보강 + 코드 품질 정리** 릴리스로 정리.
- 직전 실험 변경은 모두 되돌리고, 마지막 커밋 기준으로 실제 필요한 정리만 다시 적용.
- 렌더러 깨짐 이슈는 같은 릴리스 안에서 의존성 업그레이드만으로 해결 (코드 로직 변경 없음). xterm.js 업스트림 패치(PR #5883)를 가져오는 형태.

### 커밋
- `8ceccdf fix(v0.1.6): codex hook 컨텍스트 출력 freeze 해결`
  - codex 세션에서 hook context 주입 직후 화면 출력이 멈추는 문제를 안정화.
  - PTY 출력 필터가 context block 경계를 놓쳤을 때 무기한 suppress 상태로 남지 않도록 watchdog 동작 보강.
  - watchdog 대기 시간을 5초에서 1초로 줄여 극단 케이스에서도 멈춤 체감 시간을 단축.
- `2e53897 chore(v0.1.6): remove unused code`
  - knip 기준으로 사용되지 않는 내부 export와 레거시 helper 제거.
  - 정적 분석 설정을 실제 프로젝트 구조에 맞게 정리.
  - package-lock 루트 메타데이터를 `package.json`의 v0.1.6 정보와 동기화.
- `fix(v0.1.6): xterm WebGL 글리프 깨짐 해결 (업스트림 패치 반영)`
  - 채팅 출력이 누적된 뒤(약 60% 시점부터) 일부 글자가 다른 글리프로 잘못 표시되던 현상 해결.
  - 원인은 xterm.js WebGL 렌더러의 두 가지 버그: (1) atlas page merge 후 같은 index에 새 page가 들어가도 version이 우연히 일치해 texture rebind를 skip, (2) `_updateModel` 도중 merge가 일어나면 이미 작성된 셀의 `texturePage`가 pre-merge index를 가리킨 채 남는 stale 참조. xterm.js 이슈 #5847 / 수정 PR #5883.
  - 우리 측 수정은 없음. 패치가 포함된 첫 베타 (`@xterm/xterm 6.1.0-beta.220`, `@xterm/addon-webgl 0.20.0-beta.219`) 로 업그레이드.
  - peer 정합성을 위해 `@xterm/addon-fit`(0.12.0-beta.220), `@xterm/addon-unicode11`(0.10.0-beta.220) 도 동일 베타 트랙으로 정렬.
- `1c81871 fix(v0.1.6): refine fallback 알림 문구를 실제 사유 기반으로 정정`
  - 기존 `notifyAgyFallback`이 미설치/쿼터/응답 파싱 실패 등 모든 경로를 "Antigravity CLI not installed"로 단정해 사용자가 오해할 수 있던 문제 해결.
  - `dispatch.fallbackReason`/`triedCli`를 알림에 전달, 사유별 분기(`unavailable` / `quota` / `spawn-error`) 적용.
  - agy 외 CLI로 fallback된 경우에만 토큰 소모 가능성 안내.

### 디버그 보조 (main 머지 제외, `debug/shell-pty` 브랜치 보존)
- `agentbridge.openDebugShell` 커맨드: model/workspace/session 없이 raw zsh를 `ChatPanel`에 띄워 PTY 렌더러를 직접 자극. `TurnRecorder`/`sessionRegistry`/compaction 모두 우회.
- `GHOSTING_REPRO.txt`: 한글 11,172자 음절 전수, truecolor 배경/전경, diff-like 빨강/초록 배경, CJK 혼합 등 7가지 재현 스크립트 모음.
- ghosting 회귀 의심 시 `git checkout debug/shell-pty`로 복원.

### xterm 의존성 업그레이드 상세
- `package.json` 4개 항목을 베타 트랙으로 정확 고정(`^` 제거).
  - `@xterm/xterm`: `^6.0.0` → `6.1.0-beta.220`
  - `@xterm/addon-webgl`: `^0.19.0` → `0.20.0-beta.219` (fix 포함된 첫·유일 베타, 2026-05-21 publish)
  - `@xterm/addon-fit`: `^0.11.0` → `0.12.0-beta.220` (peer 정렬)
  - `@xterm/addon-unicode11`: `^0.9.0` → `0.10.0-beta.220` (peer 정렬)
- exact 고정 이유: 베타 트랙은 거의 매일 신규 베타가 publish되므로 `^` 두면 install 시점에 더 새 베타로 튀어 예기치 못한 회귀 가능.
- 베타 의존 자체가 리스크지만 stable 릴리스 일정이 잡혀 있지 않아 우회 불가. stable 발매 시 회귀 점검 후 즉시 전환 예정.

### 코드 품질 정리 상세
- `src/core/cliAdapter/agyResume.ts`
  - 현재 런타임 경로에서 호출되지 않는 conversation cache 조회 helper 제거.
  - resume 인자 생성에 필요한 agy UUID 감지 경로는 유지.
  - 제거 후 남은 내부 helper까지 정리해 `noUnusedLocals` 컴파일 에러가 없도록 처리.
- `src/core/turnsStore.ts`
  - 현재 코드에서 호출되지 않는 legacy archive helper 제거.
  - JSONL append/read/rewrite, rotation, archive listing 등 실제 사용 경로는 변경 없음.
- `src/settings/config.ts`
  - 외부로 공개할 필요 없는 설정 타입을 내부 타입으로 전환.
  - 현재 사용되지 않는 body cap 조회 helper 제거.
  - 실제 설정 조회, 캐시, configuration change 처리 경로는 유지.
- `src/core/envProbe.ts`
  - 외부 export가 필요 없는 keep-out env 목록을 내부 상수로 전환.
  - shell env probe, PATH 구성, TERM/COLORTERM 주입 동작은 변경 없음.
- `src/core/refineDispatcher.ts`
  - refine 실패 표현에 쓰이는 error class를 내부 구현으로 제한.
  - priority/fixed/active/off 정책과 fallback 체인은 변경 없음.
- `src/shared/types.ts`
  - 내부에서만 쓰는 IR metadata 타입 export 제거.
  - IR/TurnRecord/CLI_DISPLAY_NAME 등 실제 공유 타입과 상수는 유지.
- `knip.json`
  - 더 이상 entry로 유지할 필요 없는 항목과 불필요한 ignore 설정 정리.
  - xterm 관련 의존성 ignore는 유지. webview HTML에서 직접 로드되는 구조라 정적 import로 탐지되지 않기 때문.
- `package-lock.json`
  - 마지막 커밋의 `package.json` 버전/라이선스와 루트 metadata를 맞춤.
  - 의존성 버전 변경 없음.

### 검증 결과
- `npm run compile` 통과.
  - TypeScript 컴파일 기준 미사용 symbol 정리 후 오류 없음.
- `npx knip` 통과.
  - 현재 프로젝트 기준 잔여 미사용 export/dependency 경고 없음.
- `git diff -- src/views/chatPanel.ts package.json` 결과 없음.
  - 터미널 UI, xterm/WebGL 설정, package manifest는 데드 코드 정리 커밋에서 변경되지 않았음을 확인.
- `git diff --stat HEAD` 기준 정리 커밋 전 변경량은 8개 파일, 10 insertions, 47 deletions.

### 영향 범위
- 런타임 기능/동작 변경 없음.
  - 삭제된 항목은 현재 VS Code extension 내부에서 호출되지 않는 코드로 확인.
  - 이 프로젝트는 내부 TS 모듈을 외부 라이브러리 API로 배포하는 구조가 아니므로 외부 import 소비자 영향 없음.
- 자체 xterm 초기화 코드(`src/views/chatPanel.ts`) 변경 없음.
  - 렌더러 설정·addon 로드 순서·fontFamily·lineHeight 등 모두 그대로.
  - 깨짐 해결은 전적으로 업스트림 패치(PR #5883)에 의존.
- 패키지 베타 의존 추가.
  - stable 릴리스 출시 시 같은 fix가 포함된 stable로 즉시 전환 예정.

### 남은 작업
- 베타 업그레이드 후 회귀 검증 (실제 사용자 시나리오).
  - 한글 IME 입력 / Shift+Enter 멀티라인.
  - 테마 전환 시 색 갱신.
  - 세션 복구 / 탭 전환 후 복귀 (WebGL context loss 동작).
  - 장시간 스트리밍 후 글리프 깨짐 비재현 확인.
- xterm.js stable 릴리스 모니터링.
  - PR #5883이 포함된 stable(예상: `@xterm/xterm 6.1.0`, `@xterm/addon-webgl 0.20.0`) 발매 시 베타 의존 해제.
- M6.7 잔여 코드 품질 검사.
  - 화이트박스 테스트 보강.
  - 코드 리뷰 관점의 위험 경로 재점검.

---

## v0.1.4 UX 보강 (2026-05-24)

### Added
- **Shift+Enter 멀티라인 입력** — 원본 `XtermView.tsx`의 CJK IME race 회피 상태머신 그대로 이식 (50ms dedupe / 200ms fallback, `compositionstart`/`end` 추적, `\x1b\r` 전송)
- **세션 자동 복구** — `WebviewPanelSerializer` 등록, webview `setState`로 sessionId/model/workspaceId/modelSessionId 영속화. IDE 재시작 시 `buildOpts(..., resumeSessionId)`로 SpawnOptions 재구성 → `ChatPanel.revive` → 어댑터가 `--resume` 자동 처리. `activationEvents`에 `onWebviewPanel:agentbridge.chat` 추가
- **PTY 테마 동기화** — xterm.js theme를 `--vscode-terminal-ansi*` CSS 변수에서 동적 해석. `MutationObserver`로 body의 style/class 변화 감지(50ms 디바운스) → `term.options.theme` 재할당으로 IDE 테마 전환 시 라이브 색상 갱신
- **설정 `agentbridge.memory.maxArchiveSnapshots`** — IR 스냅샷 보관 개수 사용자 지정 (number, default 15, min 1, max 100). `config.ts`에 캐시 + `onDidChangeConfiguration` 자동 갱신, `turnsStore.maxArchiveSnapshots()` 동적 조회

### Changed
- **챗 패널 배치 정책** — 활성 에디터 컬럼이 단일이면 `Beside`로 우측 split 생성, 이미 split이 있으면 가장 오른쪽 컬럼에 **탭으로** 누적 (`vscode.window.tabGroups.all` 검사)
- **Memory 패널 레이아웃 정비** — 패널 내부 헤더(MEMORY 타이틀 + Refine/Reset 버튼) 제거, `package.json`의 `view/title` 메뉴에 `agentbridge.refineMemory` (`$(sparkle)`) / `agentbridge.resetMemory` (`$(trash)`) 등록해 VS Code 네이티브 타이틀바로 이동. status 영역(`2 turns`/`30m ago`/`Claude`) baseline 정렬·우측 정렬·크기 위계, 섹션 헤더 슬레이트 블루(`#7DA1C7`) accent, Decisions/Tests/Pending 위·아래 라벨/값 구조 + Files 좌·우 배지/경로 유지, 상태 배지 회색 솔리드 통일, `(exit 0)` 인라인 표기, 구분선 2px 강화
- **IR 스냅샷 자동 정리** — `commitArchive` 후 + `listArchives` 호출 시 `maxArchiveSnapshots()` 초과분 자동 unlink. 기존 누적 파일도 패널 로드 시 즉시 정리됨
- **Refine 우선순위 설정 검증** — `package.json` schema에 `minItems: 3` / `maxItems: 3` / `uniqueItems: true` 추가 (설정 UI에서 "Add Item" 비활성). `refineDispatcher.resolveOrder`에 `[...new Set(...)]` 가드로 중복 모델 시도 방지

### Fixed
- **사이드바 강제 전환 방지** — 챗 탭 활성화 시 `treeView.reveal()`을 호출하던 코드가 트리뷰가 안 보이는 상태일 때 사이드바를 AgentBridge로 강제 전환시켰음. `treeView.visible` 가드 추가로 다른 사이드바(Explorer 등) 사용 시 화면 보호

---

## 마일스톤 진행 현황

| 마일스톤 | 상태 | 비고 |
|---|---|---|
| M0 부트스트랩 | **완료** | 스켈레톤, node-pty, helper binary, .vscodeignore |
| M1 단일 CLI PTY (claude) | **완료** | Pseudoterminal + claudeAdapter + envProbe |
| M2 Hook + IR 자동 주입 | **완료** | hookInstaller (claude settings.json 격리) |
| M3 3모델 통합 | **완료** | codex + agy 어댑터, hook merge, 모델 QuickPick |
| M4 Turn 캡처 + Compaction | **완료** | turnRecorder, compactionScheduler, refineDispatcher, irModule |
| M5 메모리 Webview View | **완료** | memoryPanel (inline HTML, React 미사용), 실시간 갱신 |
| M6 사용자 설정 + 마무리 | **완료** | 4개 configuration, 알림 7종, 세션 관리 UI |
| **M6.5 원본 비교 + 포팅 보강** | **완료** | C1~C9 + 부가 기능 14종 + 부수 보강 12종 (라이브 검증 통과) |
| **M6.7 전체 코드 품질 검사** | **진행 중** | 정적 분석 및 미사용 코드 정리 1차 완료. 화이트박스 테스트와 리뷰는 다음 단계 |
| M7 패키징 + 게시 | 미착수 | 코드 품질 검사 통과 후 진행 |

---

## 완성된 모듈 목록 (25개 파일)

### Core

| 파일 | 원본 대응 | 설명 |
|---|---|---|
| `src/extension.ts` | `main/index.ts` | 활성화 진입점. 모든 커맨드/뷰 등록 |
| `src/shared/types.ts` | `shared/ir.ts` + `shared/turns.ts` | IR/TurnRecord 타입, CLI_DISPLAY_NAME, 임계값 상수 |
| `src/core/workspaceStore.ts` | `modules/workspaceStore.ts` | globalStorage UUID 매핑 |
| `src/core/workspaceLock.ts` | `modules/workspaceLock.ts` | Promise 체인 기반 동시성 제어 |
| `src/log/output.ts` | `electron-log` 대체 | OutputChannel 래퍼 |

### CLI Adapters

| 파일 | 원본 대응 | 주요 변경 |
|---|---|---|
| `src/core/cliAdapter/claudeAdapter.ts` | `modules/cliAdapter/claudeAdapter.ts` | `claudeSessionFileExists()` 비동기 jsonl 존재 확인 추가 (resume 에러 해결) |
| `src/core/cliAdapter/codexAdapter.ts` | `modules/cliAdapter/codexAdapter.ts` | terminalName → 'Codex' (session ID 제거) |
| `src/core/cliAdapter/agyAdapter.ts` | `modules/cliAdapter/agyAdapter.ts` | terminalName → 'Antigravity' (session ID 제거) |
| `src/core/envProbe.ts` | `modules/envProbe.ts` + `modules/cliAdapter/env.ts` | zsh 로그인 셸 env 캡처, PATH probe 통합 |

### Hook System

| 파일 | 원본 대응 | 설명 |
|---|---|---|
| `src/core/hookInstaller.ts` | `modules/hookInstaller.ts` | claude(globalStorage 격리 settings.json), codex(cwd hooks.json + config.toml merge), agy(cwd .agents/hooks.json merge) |
| `resources/bin/agentbridge-memory.js` | 동일 | 원본 그대로 복사 |

### Turn Capture + Compaction Pipeline

| 파일 | 원본 대응 | 설명 |
|---|---|---|
| `src/core/turnRecorder.ts` | `modules/turnRecorder/index.ts` + `sliceAssistant.ts` | PTY idle 감지 기반 turn 플러시. sliceAssistant 로직 인라인 통합 |
| `src/core/turnsStore.ts` | `modules/turnsStore.ts` | JSONL append/read/rewrite + rotation + archive listing |
| `src/core/compactionScheduler.ts` | `modules/compactionScheduler.ts` | count>=6 OR 12KB 임계, EventEmitter 기반 ir:updated / turns:updated |
| `src/core/refineDispatcher.ts` | `modules/refineDispatcher.ts` | priority/fixed/active/off 정책, fallback 체인, IR parse 검증 |
| `src/core/refineHeadless.ts` | `modules/cliAdapter/refineHeadless.ts` | child_process spawn + line parser + timeout/abort |
| `src/core/irModule/prompt.ts` | `modules/irModule/prompt.ts` | compaction 프롬프트 (evidence rules + language rule + format rules) |
| `src/core/irModule/parse.ts` | `modules/irModule/parse.ts` | JSON 파서 + IR 구조 coercion + git probe |
| `src/core/ptyDisplayFilter.ts` | `modules/ptyDisplayFilter.ts` | `<agentbridge-context>` 태그 필터링 |

### Views

| 파일 | 원본 대응 | 설명 |
|---|---|---|
| `src/views/chatPanel.ts` | `renderer/XtermView.tsx` + `SessionTabs.tsx` | WebviewPanel + xterm.js + node-pty 직접 spawn. 세션 드롭다운 패널 내장 |
| `src/views/memoryPanel.ts` | `renderer/IrPanel.tsx` | WebviewView (사이드바). IR 표시 + 아카이브 히스토리 + Refine/Reset 아이콘 버튼 |
| `src/views/sessionTreeView.ts` | `renderer/LeftSidebar.tsx` 일부 | TreeDataProvider. 컬러 dot SVG 아이콘 (런타임 생성) |
| `src/pty/pseudoterminal.ts` | — (Electron은 직접 xterm 사용) | VSCode Pseudoterminal API 어댑터 (현재 chatPanel 직접 PTY 방식으로 대체) |

### Settings + Notifications

| 파일 | 원본 대응 | 설명 |
|---|---|---|
| `src/settings/config.ts` | `modules/settings.ts` | vscode.workspace.getConfiguration 어댑터 |
| `src/core/notifications.ts` | — (Electron dialog 대체) | 7종 알림 (cli-not-found, refine-failed, agy-fallback 등). 세션/영구 mute |
| `src/core/sessionRegistry.ts` | `ipc/workspacesHandlers.ts` + `cliAdapter/*` deleteNativeSession | sessions.json CRUD + CLI native 세션 파일 완전 삭제 |

---

## 주요 UI 작업 내역

### 1. "Agy" → "Antigravity" 전면 변경
- `CLI_DISPLAY_NAME` 상수 추가 (`shared/types.ts`)
- 기본 세션 이름: `Claude`, `Codex`, `Antigravity` (번호 없이 모델명만)
- agyAdapter terminalName, codexAdapter terminalName에서 session ID 제거

### 2. 세션 트리뷰 아이콘 → 컬러 dot SVG
- 원본 앱의 모델 로고 대신 7px 컬러 dot로 변경 (원본 앱 LeftSidebar 패턴)
- 런타임 SVG 생성: `media/dots/dot-{model}[-closed].svg`
- 색상: claude=#d97757, codex=#5D8AF9, agy=#8e6cef
- 비활성 세션: opacity 0.4

### 3. Chat Panel 헤더 + 드롭다운 패널
- 헤더: 모델 배지 + 세션 이름 + 세션 선택 버튼(시계 아이콘, 22px) + 새 세션 버튼(+, 18px)
- 배경색: `--vscode-panel-background` (헤더, 바디, xterm, terminal-container 통일)
- 세션 드롭다운 패널: 검색, 세션 목록, 호버 시 rename/delete 액션
- 모델 선택 드롭다운 패널: + 버튼 클릭 시 Claude/Codex/Antigravity 선택 (컬러 dot + 회사명 표시, QuickPick 미사용)
- 두 패널은 배타적 (하나 열면 다른 하나 닫힘)
- postMessage 기반 extension ↔ webview 통신

### 4. Memory Panel 리팩토링
- 기존 Refine/Reset 전체 폭 버튼 → 헤더 우측 아이콘 버튼 (sparkle + Codicon trash)
- Refine 중 스피너 애니메이션
- 아카이브 히스토리: `compressed_*.jsonl`에서 IR 스냅샷 메타 추출, 카드 형태로 표시
- 가장 최신 아카이브를 현재 IR로 프로모션 (ir.json 없을 때)
- "more" 토글 클라이언트 사이드 처리 (reload 없이)

### 5. 실시간 메모리 패널 갱신
- 이벤트 체인: turnRecorder flush → turns:updated → memoryPanel.notifyIRUpdated()
- compaction 완료 → ir:updated → memoryPanel.notifyIRUpdated()
- 패널 visible 시 자동 sendIR()

### 6. 세션 트리뷰 UX 개선
- 세션 이름 옆 보조 텍스트: 항상 `timeAgo(lastActiveAt)` 표시 (active 세션 포함)
- Hover 시 inline 액션 아이콘 노출 — `$(edit)` 연필(rename) + `$(trash)` 휴지통(delete)
- Rename 클릭 → `vscode.window.showInputBox`로 새 이름 입력 (VSCode TreeView API는 inline 편집 미지원, 모달 사용)
- Active/비활성 세션 dot 아이콘 (모델별 색상, 비활성은 opacity 0.4)
- 헤더 + 아이콘: 커스텀 14x14 SVG (`add-small.svg`)로 크기 축소

### 7. 에디터 탭바 아이콘 분리
- 세션 패널 헤더 +: `$(add)` Codicon 유지 (세션 패널 전용 커맨드)
- 에디터 탭바: AgentBridge 아이콘 (`icon-dark.svg`/`icon-light.svg`) 사용 (별도 커맨드 `newSessionFromTab`)
- 두 버튼이 독립적으로 동작하도록 커맨드 분리

### 8. 세션 완전 삭제 (Native Session Cleanup)
- 원본 앱의 `deleteNativeSession` 로직 포팅
- Claude: `~/.claude/projects/*/<sessionId>.jsonl` 삭제 (모든 프로젝트 폴더 탐색)
- Codex: `~/.codex/sessions/YYYY/MM/DD/*-<sessionId>.jsonl` 삭제 (날짜 트리 전체 탐색)
- Agy: `~/.gemini/antigravity-cli/conversations/<sessionId>.pb` 삭제
- 삭제 시 열린 ChatPanel도 함께 닫음 (PTY 프로세스 kill)

### 9. 메모리 리셋 완전 삭제
- 리셋 시 `ir.json` + `turns.jsonl` + `archive/` 디렉토리 내 모든 파일 삭제
- 아카이브 잔존으로 인한 IR 프로모션 문제 해결

---

## 주요 버그 수정

### Claude 세션 Resume 에러
- **증상**: `No conversation found with session ID ...` 에러
- **원인**: Claude는 메시지 교환 전까지 `~/.claude/projects/<encoded-cwd>/<UUID>.jsonl` 파일을 생성하지 않음. `--resume`으로 시작하면 파일이 없어서 에러 발생
- **수정**: 원본 앱의 `claudeSessionFileExists()` 로직 포팅. `~/.claude/projects/*/` 하위에서 jsonl 존재 확인 후, 없으면 `--session-id`로 fallback

### Compaction Parse 실패 진단
- refine 응답의 assistantText가 비정상일 때 raw response 첫 500자를 로그에 출력하도록 보강
- saveIR 성공 시 intent.goal 첫 50자 로그 추가

### Workspace Fallback
- workspace folder 없을 때 HOME fallback 적용 (SessionTreeProvider, MemoryPanel 둘 다)

### 에디터-하단 패널 간 검은 줄
- **증상**: chatPanel과 하단 패널(출력/터미널) 사이에 검은 공간 발생
- **원인**: xterm이 행 단위 렌더링 시 남는 하단 픽셀의 배경색 불일치
- **수정**: `#terminal-container`에 패널 배경색 명시, `.xterm-viewport`에 `background-color: inherit` 적용

---

## 원본 앱 대비 설계 차이

| 영역 | 원본 (Electron) | 익스텐션 (VSCode) |
|---|---|---|
| PTY 렌더링 | renderer 프로세스의 xterm.js | WebviewPanel 내 xterm.js + extension host의 node-pty 직접 spawn |
| UI 프레임워크 | React + Tailwind | 인라인 HTML (CSP 제약으로 React 번들 미사용) |
| IPC | electron ipcMain/ipcRenderer | postMessage (webview ↔ extension host) |
| 설정 | electron-store | vscode.workspace.getConfiguration |
| 알림 | Electron dialog / tray | vscode.window.showXxxMessage + globalState mute |
| 세션 관리 | 좌측 사이드바 React 컴포넌트 | TreeDataProvider + chatPanel 내 드롭다운 |
| 메모리 표시 | 우측 사이드바 React 컴포넌트 | WebviewView (Activity Bar 하단 패널) |
| 자동 업데이트 | electron-updater | 마켓플레이스 자동 업데이트 (M7) |

---

## M6.5 보강 작업 (2026-05-23 완료)

라이브 검증 사이클에서 원본 비교 검증 + 누락 포팅 + 발견된 부수 이슈를 모두 수정. 자세한 결과는 [VALIDATION.md §9](./VALIDATION.md).

### 핵심 포팅
- **C1** turnRecorder + sliceAssistant 6-stage 파이프라인 전체 이식 (toolCalls / chrome 필터 / dedup / 1MB cap)
- **C2** codexSessionWatcher + agyResume + adapter resume args (thread_id / conversation UUID 캡처)
- **C4** 명령 팔레트 Refine/Reset 실제 동작 연결
- **C5** 사용자 입력 state machine 전체 (ANSI / bracketed paste / BS / Ctrl-C / mid-stream Enter flush)
- **C6** ptyDisplayFilter carry-over + HIDDEN_MARKER + recorder filtered feed
- **C7** codex config.toml 마커 블록 머지 (충돌 회피 + 사용자 콘텐츠 보존)
- **C8** envProbe keep-out (OPENAI_API_KEY / GEMINI_SYSTEM_MD) + TERM/COLORTERM 세트
- **C9** workspace.json CAS 락 + LOCK_STALE_MS=5min

### 부가 기능
- 3 CLI 네이티브 세션 파일 청소 (claude/codex/agy 모두 delete 시)
- Refine fallback (`RefineFailedError` + 다음 후보 CLI로 전환)
- Hook-disabled badge (Memory 패널 상단, 클릭 시 modal 상세)
- Shift+Drag-and-Drop 파일 첨부 (Finder 외부 드래그 — base64 → `<cwd>/.agentbridge/attachments/` 저장 + `@relative-path` 입력 + .gitignore 자동 추가)
- 사이드패널 세션 동기화 (탭 전환·새 세션·resume 시 selection reveal, active/dim 토글)

### 부수 보강 (검증 중 발견)
- spawnGrace 5초 입력 drop 제거 (원본도 없는 EXT 신규 버그)
- awaiting 상태 mid-stream flush 추가 (이전 user text 손실 방지)
- chunk 경계 partial ANSI sequence carry (focus events `\e[O`/`\e[I` 누수 방지) + SS3 3바이트 처리
- sessionRegistry per-workspace mutex + 손상 JSON 백업
- ChatPanel `markDeleted` flag로 delete cascade 차단
- panel.dispose 시 webview 탭 자동 닫기
- Initial active state fire (50ms 지연)
- hookStatusEvents → Memory 패널 즉시 갱신
- $HOME cwd guard (글로벌 config.toml 클로버 방지)

### 미세 차이 적용
- Codex refine model `gpt-5.4-mini`, Claude `claude-haiku-4-5`
- `assembleIR` git probe → `execFile`(비동기)
- `workspaces.json` atomic write + UUID 가드
- `turnsStore` maxRecords=1000 rotation 조건 추가
- Assistant buffer 1MB hard cap

### 사후 관찰
- **codex 화면 간헐 freeze** — `ptyDisplayFilter`에 in-block watchdog(5s) + warn 로그 추가하여 자동 복구 + 진단 가능. 라이브 모니터링 항목.

---

## 미착수 항목

- **M6.7 전체 코드 품질 검사 잔여분** (화이트박스 테스트 + 코드 리뷰)
- M7 패키징 + 마켓플레이스 게시
- `.vsix` 크기 최적화 (node-pty prebuilds 정리)
- GitHub Actions CI/CD
- 릴리스 문서 지속 갱신
- 다른 OS (Linux/Windows) 지원
