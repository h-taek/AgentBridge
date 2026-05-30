# AgentBridge 코드 검증 통합 보고서 — 2026-05-22

3개 모델(Claude / Codex / Gemini)이 독립 수행한 검증 결과를 코드와 대조해 통합한 단일 보고서. 각 보고서의 critical 클레임은 모두 파일 read + grep + `node -e` 실측으로 재검증했고, 결과만 본문에 실었다.

- 대상 브랜치: `main` (HEAD `f7c5219`, working tree v0.0.4 누적)
- 범위: `src/` 전체 (62 파일 / 15,301 LOC) + 빌드 스크립트 + preload + IPC
- 원칙: **수정 없음, 분석만**. 모든 클레임은 출처(C=Claude, X=Codex, G=Gemini) 표기 + 파일:라인 + 검증 근거 포함.

---

## 0. 한눈 요약

| 영역 | 결과 |
| --- | --- |
| `tsc --noEmit` (node + web) | ✅ 통과 |
| `eslint .` | ❌ 14 errors / 13 warnings (대부분 `scripts/`, `.deepsource-local/`, `SessionTabs.tsx`) |
| `npm audit --audit-level=moderate` | ✅ 0 vulnerabilities |
| `npm outdated` | electron / vite / typescript / xterm major outdated |
| 보안 | **Critical 2건 / High 2건 / 방어 강화 2건** |
| 데드코드 | 5건 (컴포넌트 1 + 함수 4) |
| 리소스/Race | Low 2건 (실제 영향 미미하나 polish 가치) |
| React | SessionTabs.tsx ref-during-render 5건 + set-state-in-effect 1건 |
| 의존성 보안 | npm audit 0 vulnerabilities, major outdated 다수 |

**위협 모델 정정:** 초기 Claude 보고서는 "renderer는 외부 origin 안 로드 → IPC 입력 검증 defense-in-depth"라 critical 0으로 평가했으나, `window.electron` 노출이 curated `window.agentbridge` 우회 통로를 열고, 미사용 `pty:start`가 임의 명령 실행 표면으로 남아있어 **renderer 단일 진입점이 뚫리면 즉시 RCE/임의 삭제 경로**가 성립. 따라서 IPC 검증은 defense-in-depth가 아닌 **1차 방어선**으로 격상.

---

## 1. Critical (Codex)

### C1. `window.electron`이 범용 `ipcRenderer` 노출
- 위치: [src/preload/index.ts:332](src/preload/index.ts#L332) — `contextBridge.exposeInMainWorld('electron', electronAPI)`
- 분석: `@electron-toolkit/preload`의 `electronAPI`는 `ipcRenderer.invoke / send / on / sendSync`를 그대로 노출한다. curated `window.agentbridge` API는 의미가 줄어들고, renderer는 모든 `ipcMain.handle` 채널을 임의 페이로드로 호출 가능.
- 영향: renderer 측 임의 코드 실행 사고(공급망/XSS sink/예: 미래 BrowserView) 1건 발생 시 즉시 모든 IPC 표면이 노출됨.
- 권장: `window.electron` 제거. renderer는 `window.agentbridge`의 명시 메서드만 사용. main 핸들러는 sender ownership을 검증.

### C2. 미사용 `pty:start` IPC가 임의 명령 실행 표면
- 위치: handler [src/main/index.ts:201](src/main/index.ts#L201), preload [src/preload/index.ts](src/preload/index.ts), spawn [src/main/modules/ptySession.ts:84](src/main/modules/ptySession.ts#L84)
- 검증: `grep agentbridge.pty.start | pty.start(` → 0건. renderer 코드 어디에서도 사용하지 않음.
- 분석: `startPty(req, event.sender)`가 `req.command / args / cwd / env`를 그대로 `node-pty.spawn`에 전달. sender 검증·command allowlist·cwd 제한 없음.
- 영향: **C1과 결합 시** `window.electron.ipcRenderer.invoke('pty:start', { command: '/bin/sh', args: ['-c', '...'] })`만으로 임의 명령 실행. 또한 이 세션은 `sessionActive`에 등록 안 되어 kill/ownership 정상 경로 밖.
- 권장: `IpcChannel.PtyStart` 핸들러와 preload 노출 제거. 내부 main 호출 전용으로 전환. 필요 시 command allowlist + sender workspace claim 검증.

---

## 2. High

### H1. `workspaceId / sessionId` path traversal (Codex)
- 위치: [src/main/modules/workspaceStore.ts:100](src/main/modules/workspaceStore.ts#L100) (`getWorkspacePaths`), [src/main/modules/workspaceStore.ts:119](src/main/modules/workspaceStore.ts#L119) (`getSessionPaths`)
- 검증 (실측 `node -e`): `path.join('/Users/me/userData/workspaces', '../../etc')` → `/Users/me/etc`. 즉 `path.join`이 `..` 부분을 정규화 collapse해 prefix를 escape함.
- 파괴적 호출부: [workspaceStore.ts:284](src/main/modules/workspaceStore.ts#L284) `deleteWorkspace` (`fs.rm({recursive:true, force:true})`), [:358](src/main/modules/workspaceStore.ts#L358) `deleteSession`
- 노출 핸들러: `handleWorkspacesDelete` [workspacesHandlers.ts:107](src/main/ipc/workspacesHandlers.ts#L107), `handleSessionsClose(permanent:true)` [:259](src/main/ipc/workspacesHandlers.ts#L259), `handleMemoryReset` [memoryHandlers.ts:260](src/main/ipc/memoryHandlers.ts#L260)
- 영향: `workspaceId=".."`로 호출하면 userData 상위 디렉토리 삭제 가능.
- 권장: workspaceId/sessionId에 UUID 정규식(`/^[0-9a-f-]{36}$/i`) 검증. `getWorkspacePaths/getSessionPaths` 내부에서 `path.resolve` 후 root prefix 재확인. destructive handler는 sender 윈도우의 workspace claim 확인 추가.

### H2. Hook 설치 실패가 silent — IR 주입 비활성 상태로 진행 (Codex)
- 위치: [src/main/ipc/workspacesHandlers.ts:386-409](src/main/ipc/workspacesHandlers.ts#L386-L409), helper [hookInstaller.ts:460](src/main/modules/hookInstaller.ts#L460)
- 분석: 주석은 "실패는 throw — hook 없이 spawn하면 inject 0이라 차별점 핵심(매 메시지 IR 주입) 동작 안 함"이라 명시되어 있으나, 실제 코드는 `try/catch`로 로그만 남기고 spawn을 계속함.
- 영향: AgentBridge 핵심 가치(매 메시지 IR 주입)가 silent disabled. 사용자는 일반 CLI 세션처럼 보이는 화면에서 context handoff가 작동한다고 오해. helper binary 누락·권한·schema 변경 같은 문제 조기 발견 실패.
- 권장: 실패 시 spawn 중단 + UI에 명시 오류, 또는 "메모리 주입 비활성" degraded 상태를 세션/UI에 표시.

---

## 3. Medium

### M1. SessionTabs.tsx ref-during-render + set-state-in-effect (3개 보고서 공통)
- 위치: [src/renderer/src/components/SessionTabs.tsx:122, 250, 256, 298, 304](src/renderer/src/components/SessionTabs.tsx#L122)
- 분석:
  - L122 `useEffect`에서 `setVisibleCount(openSessions.length)` — cascading renders
  - L250/256/298/304 — `{overflowOpen && overflowBtnRef.current && createPortal(...)}` + IIFE 안에서 `getBoundingClientRect()` 호출. ref.current는 렌더 단계에서 stable하지 않음 → 첫 표시 1프레임 깜빡임 가능.
- 권장: 버튼 rect를 state로 저장 + click/`useLayoutEffect`에서 갱신. render 중 ref 접근 제거.

### M2. `cliQuotaTracker` cleanup의 `await capturePromise` race (Gemini)
- 위치: [src/main/modules/cliQuotaTracker.ts:639-664](src/main/modules/cliQuotaTracker.ts#L639) — finalize → cleanup
- 분석: cleanup이 `captureCtrl.abort()` 직후 `await capturePromise` — capture 함수가 abort signal 무시하고 file watch polling에 머무르면 finalize hang. PROBE_TIMEOUT 후에도 cleanup이 끝나지 않으면 좀비 잔존.
- 영향: 실제로 capture가 신호 무시할 확률 낮음 (codex thread_id watch는 짧은 timeout). 하지만 발동 시 background task 누적.
- 권장: `await Promise.race([capturePromise, sleep(N)])` 가드.

---

## 4. Defense-in-depth (Low → Medium 격상 가능)

### D1. workspace-scoped 핸들러에 sender 윈도우 소유권 검증 부재 (Claude)
- 누락 위치: `handleWorkspacesGet` [workspacesHandlers.ts:76](src/main/ipc/workspacesHandlers.ts#L76), `handleWorkspacesDelete` [:107](src/main/ipc/workspacesHandlers.ts#L107), `handleArchiveLoad/Delete` [memoryHandlers.ts:103,143](src/main/ipc/memoryHandlers.ts#L103), `handleMemoryReset` [:260](src/main/ipc/memoryHandlers.ts#L260), `handleIrLoad/Refine` [irHandlers.ts:86-87](src/main/ipc/irHandlers.ts#L86)
- 기존 패턴: PTY 핸들러 `senderOwnsPtySession` [index.ts:192-225](src/main/index.ts#L192), 파일 첨부 `senderWorkspaceId !== req.workspaceId` (`attachHandlers.ts`).
- 영향: C1+C2 시나리오에서 한 윈도우가 다른 윈도우 워크스페이스를 임의 조작 가능.
- 권장: 공통 헬퍼 `assertSenderOwnsWorkspace(event, workspaceId)`를 추출해 일괄 적용.

### D2. archive 경로 basename 검증 순서 — 안전하나 오해 소지 (Claude)
- 위치: [memoryHandlers.ts:103-138, 143-178](src/main/ipc/memoryHandlers.ts#L103)
- 현재 3중 가드 (basename pattern → lstat symlink reject → realpath prefix). 마지막 realpath prefix가 궁극 차단선이라 실제 안전. basename 검사가 호도될 인상이라 헬퍼 추출로 의도 명확화 권장.

---

## 5. 데드코드 (3개 보고서 합산 — 5건 확정)

| # | 위치 | 상태 | 출처 |
| --- | --- | --- | --- |
| 1 | [RefineSettingsPanel.tsx:60](src/renderer/src/components/RefineSettingsPanel.tsx#L60) 261 LOC | export 1, JSX 사용 0 | C |
| 2 | [workspaceStore.ts:294](src/main/modules/workspaceStore.ts#L294) `cleanupEmptyWorkspaces` | export 1, 호출 0. 주석엔 "부팅 시 1회 정리" 의도 명시되어 있으나 진입점 누락 | G |
| 3 | [workspaceStore.ts:495](src/main/modules/workspaceStore.ts#L495) `readWorkspacePrimaryReplay` | export 1, 호출 0 | G |
| 4 | [workspacePath.ts:10](src/main/modules/workspacePath.ts#L10) `normalizeWorkspacePath` | export 1, import 0 | X |
| 5 | [workspacePath.ts:29](src/main/modules/workspacePath.ts#L29) `validateWorkspacePath` | export 1, import 0 | X |

**#4, #5는 단순 데드코드 이상 의미** — `createWorkspace`가 `input.workspacePath`를 그대로 저장하는 흐름에 정규화/검증 모듈이 적용되지 않음. 사용자가 `~/...`, 따옴표, escape된 경로를 넣으면 spawn cwd 실패 가능.

**의도된 잔재 (삭제 X):**
- `gemini` 토큰 — `InstructionFileKind`의 `GEMINI.md`, `hookInstaller.cleanupLegacyGeminiSettings`, `workspaceStore`의 contextId→workspaceId 마이그레이션. agy rebrand 호환을 위해 의도 보존.

---

## 6. Renderer React (M1 외)

### Unused eslint-disable directives — 4건 (warning)
- [workspacesHandlers.ts:648](src/main/ipc/workspacesHandlers.ts#L648), [AppShell.tsx:92](src/renderer/src/components/AppShell.tsx#L92), [IrPanel.tsx:282](src/renderer/src/components/IrPanel.tsx#L282), [XtermView.tsx:125,127](src/renderer/src/components/XtermView.tsx#L125)
- 원인: ESLint 9 룰셋 변화로 더 이상 발동하지 않는 disable comment. 단순 삭제 가능.

---

## 7. ESLint 설정 / 도구 스크립트 (3개 공통)

- `.deepsource-local/*.mjs` — 로컬 임시 도구지만 ESLint 대상에 포함됨 (prettier + return-type 4건)
- `scripts/patch-electron-name.cjs` — CommonJS 스크립트에 TS 룰 적용되어 require-imports 3건 + return-type 3건
- 권장: `eslint.config.mjs`에 `ignores: ['.deepsource-local/**', 'scripts/**/*.cjs', 'out/**', 'dist/**']`

---

## 8. 의존성 (Codex)

`npm audit --audit-level=moderate` → 0 vulnerabilities. `npm outdated` 주요:

| 패키지 | current | latest |
| --- | --- | --- |
| electron | 39.8.10 | 42.2.0 |
| vite | 7.3.3 | 8.0.14 |
| typescript | 5.9.3 | 6.0.3 |
| @xterm/xterm | 5.5.0 | 6.0.0 |
| @vitejs/plugin-react | 5.2.0 | 6.0.2 |

major 업그레이드는 ESLint/lint compiler에 영향 큼 — 기능 수정과 분리해 진행 권장.

---

## 9. 문서/주석 잔재 (Codex)

- README, CHANGELOG, 일부 `src/shared/ipc.ts` 주석에 Gemini 기준 설명 잔존. legacy 호환 설명과 현재 동작 설명이 섞여 신규 기여자/사용자가 혼동 가능.
- 권장: 사용자 문서는 agy/Antigravity 기준 재정리, legacy 호환 주석엔 `(legacy)` 표시.

---

## 10. 양호 — 기존 방어 (참고)

- 외부 URL allowlist: `ALLOWED_EXTERNAL_HOSTS = Set(['github.com'])` ([windowManager.ts:11](src/main/modules/windowManager.ts#L11)). `setWindowOpenHandler`로 onclick/window.open 모두 deny.
- `app:openPath` allowlist: userData OR workspace path prefix ([index.ts:155-170](src/main/index.ts#L155-L170)).
- `webPreferences`: `contextIsolation:true / nodeIntegration:false` ([windowManager.ts:86-91](src/main/modules/windowManager.ts#L86-L91)).
- `pty:write / resize / kill`은 `senderOwnsPtySession` 검증 통과 필수 ([index.ts:192-225](src/main/index.ts#L192)).
- archive load/delete 3중 가드(basename + lstat symlink reject + realpath prefix).
- settings/refine 정책 값 enum validator 방어.
- 파일 첨부 핸들러 sender workspace claim 검증.
- atomic write 패턴: `ir.json`, `turns.jsonl` 모두 `.tmp` → `rename`.
- `before-quit` 1.5초 hard exit timeout으로 stdio pipe hang 회피.
- `startPty` 잔존 session 강제정리 — 같은 sessionId 재spawn 시 SIGKILL + map 교체.
- typecheck node/web 양쪽 통과, `any` 사용 0건.

---

## 11. 최종 우선순위

| # | 이슈 | 출처 | 심각도 | 비용 |
| --- | --- | --- | --- | --- |
| 1 | C1 — `window.electron` 노출 제거 | X | **Critical** | 30분 (preload index 1줄 + d.ts 정리) |
| 2 | C2 — `pty:start` IPC 제거 또는 내부 전용화 | X | **Critical** | 30~60분 |
| 3 | H1 — workspaceId/sessionId UUID 정규식 + prefix guard | X | **High** | 1~2시간 (validator + 호출부 검증) |
| 4 | H2 — Hook 설치 실패 시 spawn 중단 또는 UI degraded 표시 | X | **High** | 1시간 |
| 5 | M1 — SessionTabs ref-during-render + cascading effect | C/X/G | **Medium** | 1시간 |
| 6 | M2 — cliQuotaTracker `Promise.race` 가드 | G | **Medium** | 30분 |
| 7 | D1 — workspace 소유권 검증 헬퍼 추출 + 일괄 적용 | C | **Low→Med** | 1시간 |
| 8 | 데드코드 5건 — 사용/삭제 결정 | C/G/X | **Low** | 30분 + 결정 |
| 9 | ESLint ignore + unused disable 정리 | C/X | **Low** | 15분 |
| 10 | D2 — archive 검증 헬퍼 추출 | C | **Low** | 15분 |
| 11 | killPtyAsync onExit Disposable dispose | G | **Low** | 15분 |
| 12 | 의존성 major 업그레이드 | X | **Low** | 별도 계획 |
| 13 | 문서/주석 agy 기준 정리 | X | **Low** | 결정 사항 |

**총평**: 1~4번을 한 묶음으로 처리하면 위협 모델이 "renderer compromise = RCE"에서 "curated IPC만 노출"로 격상. v0.0.4 베타 종료 전 권장. 5~7번은 안정성·UX 폴리시. 나머지는 정리 작업.

---

## 12. 부록 — 검증 로그 (서브에이전트 false alarm 처리)

3개 보고서 + 1차 서브에이전트 보고에서 잘못 보고된 항목을 코드 대조로 기각한 기록.

| 클레임 | 출처 | 검증 결과 |
| --- | --- | --- |
| `javascript:` URL 우회 가능 | C 1차 | ❌ false. `windowManager.ts:21`이 `protocol !== 'https:' && protocol !== 'http:'` reject. `new URL('javascript:alert(1)').protocol === 'javascript:'`이라 차단됨. |
| CLI 어댑터 command injection (workspaceId argv 주입) | C 1차 | ❌ false. workspaceId는 main `randomUUID()`, `quoteArg()` escape. **단** H1으로 인해 renderer가 임의 string 주입 가능 → quoteArg 견고성 별도 검증 필요. |
| shell 세션 cwd 검증 부재 | C 1차 | ⚠️ 형식상 true이나 메타 기반이라 사용자 수정 불가. 현재 안전. |
| `ptySession.ts:225 onExit 누적` | C 1차 | ⚠️ 부분 정정. `killPtyAsync` 재호출은 line 219 early return이라 누적 안 됨 (C 보고). 단 timeout 발화 후 PTY가 늦게 exit하면 listener 미해제 — 실제 PTY 객체 GC되면 같이 해제되지만 polish 가치 있음 (G 보고). 통합 결과 **Low로 채택**. |
| `setTimeout(KILL_GRACE).unref()` 누적 | C 1차 | ❌ false. timer unref + `process.kill(pid, 0)` 존재 확인 → 실 누수 없음. |
| `inflightProbes delete 타이밍` race | C 1차 | ❌ false. `inflightProbes[cli] = p` 동기 배치. 같은 tick 후속 caller는 항상 p 본다. |
| `compactionScheduler inFlight cleanup` | C 1차 | ❌ false. try/finally로 보장. |
| Unicode NFC 정규화 — 타 OS 포팅 시 위험 | G | ⚠️ 정상이지만 macOS 한정 가정. **현재 제품 범위 macOS only**라 영향 없음. 향후 cross-platform 계획 시 재검토. |
| Metadata/data 파일 state desync (`ir.json` vs `workspace.json`) | G | ⚠️ 이론상 가능. 개별 atomic write는 안전하지만 `withWorkspaceLock` 범위 밖. 실 발동 빈도 매우 낮음, **현재 우선순위 최하**. |

---

## 13. 분석에 쓰지 않은 영역

- `out/`, `dist/`, `node_modules/`, `probe/`, `tmp_asar/` — 빌드 산출/일시.
- 빌드 결과물(`build:mac`) 실행 검증 미실시.
- E2E/통합 테스트 부재 — 코드베이스 테스트 파일 0개. 본 보고서는 정적 분석 + 코드 read 한정.
- preload `electron-toolkit/preload` 패키지 내부 구현 audit 미실시.

---

**보고서 작성:** Claude + Codex + Gemini 통합본 (각 보고서 cross-verification 완료)
**보고서 작성일:** 2026-05-22
**다음 액션:** P1~P4 묶음 처리 후 v0.0.5 베타 태깅 권장. 모든 작업은 별도 세션에서 명시 신호 받고 진행.
