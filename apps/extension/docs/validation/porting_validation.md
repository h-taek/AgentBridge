# AgentBridge Extension 포팅 통합 검증 보고서

> 원본 Electron 앱(`02_AgentBridge_App/src`) 대비 VSCode 익스텐션(`03_AgentBridge_Extension/src`) 1:1 포팅 검증.
> 통합 출처: `docs/Claude.md`, `docs/Codex.md`, `docs/Gemini.md`
> 작성일: 2026-05-23

---

## 0. 최종 판정

- **컴파일**: `npx tsc --noEmit` → exit 0 통과
- **Helper smoke**: `agentbridge-memory.js` (claude/codex/agy) JSON 출력 정상, `<agentbridge-context>` sentinel 포함
- **node-pty smoke**: `pty.spawn` 정상 (`exitCode:0`)
- **CLI 경로**: `claude`, `codex`, `agy`, `node` 모두 PATH에서 확인
- **런타임 기능**: **미달**. 세션 resume, turnRecorder 품질, PTY 표시/기록 필터, refine quota, 명령 핸들러 등 핵심 로직 누락
- **Extension Development Host(F5)**: GUI 검증 필요 — 사용자 수행 항목

---

## 1. Critical 버그 (1:1 로직 누락)

| # | 영역 | 위치 | 문제 |
|---|---|---|---|
| C1 | **turnRecorder가 sliceAssistant 파이프라인 전체 건너뜀** | [src/core/turnRecorder.ts:78-128](../src/core/turnRecorder.ts#L78-L128) | ANSI 1줄 strip + body cap만 수행. tool-call 추출(⏺/⊶/✓), 모델별 chrome 필터(스피너·박스·❯/›·Tip/PATH), connected-line dedup, streamingPrefixDedup 전부 누락. `toolCalls: []` 하드코딩 → refine 프롬프트에 raw TUI 노이즈 + tool 증거 없이 진입. 원본은 `turnRecorder/index.ts`(432줄) + `sliceAssistant.ts`(351줄) |
| C2 | **codex/agy resume 미동작** | [src/core/cliAdapter/codexAdapter.ts:20](../src/core/cliAdapter/codexAdapter.ts#L20), [src/core/cliAdapter/agyAdapter.ts:22](../src/core/cliAdapter/agyAdapter.ts#L22) | `resumeSessionId` 파라미터를 받고도 args에 반영하지 않음(`args: []`). 세션 재오픈 시 항상 새 thread/conversation 생성. `codexSessionWatcher`(`~/.codex/sessions` snapshot + thread_id capture) / `agyResume`(`last_conversations.json` polling + UUID capture) 미포팅 |
| C4 | **명령 팔레트 Refine/Reset 명령이 no-op** | [src/extension.ts:164,168](../src/extension.ts#L164) | `agentbridge.refineMemory`는 `notifyIRUpdated`만 호출(재그리기), 실제 refine 트리거 없음. `agentbridge.resetMemory`도 패널 포커스만 |
| C5 | **mid-stream Enter turn flush 없음** | [src/core/turnRecorder.ts](../src/core/turnRecorder.ts) | assistant_active 중 다음 사용자 입력이 오면 직전 turn이 유실. Ctrl-C(0x03), bracketed paste, backspace, ANSI 이스케이프 입력 필터링 누락 |
| C6 | **ptyDisplayFilter 청크 경계 부분 태그 누출 + 기록 오염** | [src/core/ptyDisplayFilter.ts:8-35](../src/core/ptyDisplayFilter.ts#L8-L35), [src/views/chatPanel.ts](../src/views/chatPanel.ts) | `<agentbridge-cont` 같은 부분 태그가 청크 끝에서 잘리면 그대로 PTY로 출력. 또한 recorder가 raw PTY data를 먼저 받고 화면 출력만 필터링 → `<agentbridge-context>` 블록이 `turns.jsonl`/compaction 입력에 섞임. `HIDDEN_MARKER` 미삽입으로 sliceAssistant chrome 필터와 연계 안 됨 |
| C7 | **codex `config.toml` 마커 블록 없음** | [src/core/hookInstaller.ts:131-166](../src/core/hookInstaller.ts#L131-L166) | key 존재만 체크. 사용자가 `hooks = false`로 두면 갱신 안 함. AgentBridge 소유 블록 식별/제거 불가. shell-safe quote escape, helper binary 존재 가드, content 보존 정책도 부분만 구현 |
| C8 | **env keep-out 누락** | [src/core/envProbe.ts](../src/core/envProbe.ts) | `OPENAI_API_KEY` / `GEMINI_SYSTEM_MD` 필터 없음 → codex가 API key 모드로 빠지고 agy system prompt 오염. `TERM=xterm-256color` / `COLORTERM=truecolor` 미설정 |
| C9 | **on-disk compaction lock 없음** | [src/core/compactionScheduler.ts:43-144](../src/core/compactionScheduler.ts#L43-L144) | 메모리 `inFlight` Set만 존재. 다중 VSCode 창/프로세스 간 동시 compaction → `ir.json`/`turns.jsonl` 파일 손상 위험. 원본은 `workspace.json` `compactionInProgress` CAS + `LOCK_STALE_MS=5min`. 수동 컴팩션 명령도 유실 |

---

## 2. 아키텍처 정합성 결함

### 2.1 Pseudoterminal 데드 코드
- [src/pty/pseudoterminal.ts](../src/pty/pseudoterminal.ts)의 `CliPseudoterminal`(`vscode.Pseudoterminal` 구현)는 어디서도 인스턴스화되지 않음
- [src/views/chatPanel.ts:159](../src/views/chatPanel.ts#L159)는 `WebviewPanel + xterm.js`에서 직접 `pty.spawn('/bin/zsh', ...)` 호출
- `ChatPanel`은 `pseudoterminal.ts`에서 `SpawnOptions` 타입만 import
- 설계 목표였던 `vscode.window.createTerminal({ pty })` 통합 터미널 경로가 미적용

### 2.2 `CliKind` 타입 중복 정의
- [src/shared/types.ts:1](../src/shared/types.ts#L1)과 [src/core/hookInstaller.ts:6](../src/core/hookInstaller.ts#L6)에 동일 유니온 타입이 독립 선언 → 신규 어댑터 추가 시 불일치 위험

### 2.3 IR parse 차이
- [src/core/irModule/parse.ts](../src/core/irModule/parse.ts): `coerceFiles`의 `lastReadAt`/`fullOutputRef` 보존 누락, `assembleIR`에 `execFileSync` git probe 추가(이벤트 루프 블록)

---

## 3. 포팅 필요 기능 (사용자 컨펌 완료)

| 영역 | 원본 위치 | 비고 |
|---|---|---|
| **3개 CLI 네이티브 세션 파일 청소** | `claudeAdapter.ts:180-220` (`hasNativeSession`/`deleteNativeSession`) | claude `~/.claude/projects/**/<uuid>.jsonl` 외에 **codex/agy 네이티브 세션 파일도 동일하게 삭제**되어야 함. 세션 delete 시 파일 잔존 금지 — codex/agy용 동등 함수 신규 작성 필요 |
| Quota tracking + refine fallback | `cliQuotaTracker.ts`, refineDispatcher | quota 감지 / forced fallback 기록 / background quota probe / `RefineFailedError`. `quota:updated` 브로드캐스트 포함 |
| Hook-disabled badge ("메모리 비활성") | `hookDisabledReason` 표시 | |
| Drag-and-drop 파일 첨부 | `attachHandlers.ts` + xterm drop zone | |
| Tab 정렬(lastChattedAt) / inline rename / model 로고 | `SessionTabs.tsx` | VSCode 에디터 탭 위에 커스텀 UI 필요 |

---

## 4. 미세 차이 (확인 필요)

| 항목 | 위치 | 차이 |
|---|---|---|
| Codex refine model hint | [src/core/refineDispatcher.ts:22-26](../src/core/refineDispatcher.ts#L22-L26) | ORIG `gpt-5.4-mini` vs EXT `gpt-4.1-mini` |
| Claude refine model hint | 동일 | ORIG `claude-haiku-4-5` vs EXT `claude-haiku-4-5-20251001` — 날짜 suffix `--model` 유효성 검증 필요 |
| `assembleIR` 동기 git probe | [src/core/irModule/parse.ts:166-176](../src/core/irModule/parse.ts#L166-L176) | `execFileSync` 추가 |
| `workspaces.json` 비원자적 쓰기 | [src/core/workspaceStore.ts](../src/core/workspaceStore.ts) | atomic write 없음 + UUID 경로 가드 부재 |
| 5초 spawn grace timer | turnRecorder | EXT에만 존재 (의도면 OK) |
| `turnsStore` 레코드 수(1000) rotation | [src/core/turnsStore.ts:80-102](../src/core/turnsStore.ts#L80-L102) | size(5MB) 조건만 적용, maxRecords 미적용 |

---

## 5. 임계값 / 상수 일치표

| 상수 | ORIG | EXT | 일치 |
|---|---|---|---|
| `IDLE_FLUSH_MS` | 1500 | 1500 | ✓ |
| Assistant buffer hard cap | 1 MB | 없음 | ✗ |
| Spawn grace | 없음 | 5 s | ✗ (EXT 신규) |
| `countThreshold` | 6 | 6 | ✓ |
| `bytesThreshold` | 12 KB | 12 KB | ✓ |
| `keepRecent` | 3 | 3 | ✓ |
| `COMPACTION_TIMEOUT_MS` | 60 s | 60 s | ✓ |
| `LOCK_STALE_MS` | 5 min | 없음 | ✗ |
| `TURNS_ROTATE.maxBytes` | 5 MB | 5 MB | ✓ |
| `TURNS_ROTATE.maxRecords` | 1000 | 미적용 | ✗ |
| `TURN_CAP.userBytes` | 8 KB | 8 KB | ✓ |
| `IR_CAP` | 5/5/3/3/3 | 5/5/3/3/3 | ✓ |
| Claude refine model | `claude-haiku-4-5` | `claude-haiku-4-5-20251001` | ? |
| Codex refine model | `gpt-5.4-mini` | `gpt-4.1-mini` | ✗ |

---

## 6. 정상 포트 / 의도된 적응

- `refineHeadless` — spawn opts/timeout/abort/SIGTERM→SIGKILL 동일 (어댑터에서 제거되고 `refineDispatcher.ts`의 `runRefine`으로 통합)
- `compactionScheduler` 임계값 (6 turn / 12 KB / keepRecent 3)
- `irModule/prompt.ts` evidence/format rules, IR_SCHEMA_GUIDE
- `workspaceLock` Promise 체인
- Settings 4종 (`refine.policy`, `refine.priorityOrder`, `refine.fixedCli`, `turns.assistantDetail`)
- `envProbe.ts` → `extension.ts:checkAvailability`에서 어댑터 `isAvailable()` 직접 호출로 일원화
- HomePane / TitleBar / AppShell / windowManager / appUpdater 미포팅 (VSCode 호스트 모델에서 정상)
- **Memory Reset이 archive까지 삭제** ([src/views/memoryPanel.ts:184-187](../src/views/memoryPanel.ts#L184-L187)) — 의도된 정책 변경 (원본은 archive 보존, EXT는 전체 삭제)
- **IR 패널 카드 3종 미포팅** — Instructions / Refine-Quota / TurnFlow 카드 의도된 단순화 ("N turns recorded"만 유지)
- **Archive 상호작용 미포팅** — IR Detail modal(6-section 뷰어), Archive→Current 프로모션, 개별 archive 삭제 의도된 제외 (archive는 read-only 스냅샷)
- **Codex trust persistent banner 미포팅** — toast 1회로 다운그레이드 의도
- `cleanupLegacyGeminiSettings` 미포팅 — 신규 설치만 가정
- `coerceFiles`의 `lastReadAt` 보존 미포팅 — 의도된 drop

---

## 7. 해결 방안 (사용자 컨펌 완료, 2026-05-23)

### Critical
| # | 해결 방안 |
|---|---|
| C1 | 원본 `sliceAssistant.ts`(351줄, 6단계 파이프라인) 전체 이식 → `turnRecorder`에 통합. toolCalls 추출 / chrome 필터 / dedup 완전 복원 |
| C2 | 원본 `codexSessionWatcher`(`~/.codex/sessions` snapshot + polling) + `agyResume`(`last_conversations.json` polling) 전부 이식 + `codexAdapter`/`agyAdapter`의 `resumeSessionId` → args 조립 복원 |
| C4 | `agentbridge.refineMemory` / `agentbridge.resetMemory` 명령을 MemoryPanel webview 메시지와 **동일 동작**으로 연결 (실제 refine 트리거, archive-보존 reset) |
| C5 | 원본 사용자 입력 state machine 전체 이식 (ANSI / bracketed paste / backspace / Ctrl-C / mid-stream Enter flush) |
| C6 | 부분 태그 carry-over 버퍼 + `HIDDEN_MARKER` 삽입. `chatPanel`에서 filtered 스트림을 recorder에도 공급해 `<agentbridge-context>` 블록이 `turns.jsonl`에 섞이지 않도록 |
| C7 | 원본 `# AgentBridge BEGIN/END` 마커 블록 머지 전체 이식 (소유 구간 식별 / content 보존 / shell-safe quote escape / helper binary 존재 가드) |
| C8 | 원본 envProbe 동등 — `OPENAI_API_KEY` / `GEMINI_SYSTEM_MD` 스트립 + `TERM=xterm-256color` / `COLORTERM=truecolor` 세트 |
| C9 | `workspace.json`의 `compactionInProgress` CAS 락 + `LOCK_STALE_MS=5min` 도입 (다중 창/IDE fork 동시 사용 시 파일 손상 방지) |

### 아키텍처
| 항목 | 해결 방안 |
|---|---|
| `CliPseudoterminal` 데드 코드 | `src/pty/pseudoterminal.ts` **제거**. `SpawnOptions` 타입만 `shared/`로 이동. WebviewPanel + xterm.js 런타임 유지 |
| `CliKind` 중복 정의 | `hookInstaller.ts:6`의 로컬 선언 제거 → `shared/types.ts`의 `CliKind` import로 단일화 |

### 포팅 필요 기능
| 항목 | 해결 방안 |
|---|---|
| 3 CLI 네이티브 세션 파일 청소 | claude/codex/agy 모두 **명시적 세션 delete 시에만** native 파일 제거 (창 단순 close에서는 보존) |
| Quota tracking + refine fallback | **dispatcher fallback 메커니즘만** 이식 (refine 실패 시 fallback CLI로 전환). `cliQuotaTracker`/background probe/agy footer % 캡처는 제외 |
| Hook-disabled badge | `hookDisabledReason`을 webview까지 전파 + Memory Panel에 badge 표시 |
| Drag-and-drop 파일 첨부 | ChatPanel webview xterm drop zone — 원본 `attachHandlers` 이식 |
| Tab 정렬 / rename / 모델 로고 | VSCode 에디터 탭은 그대로, **좌측 사이드 패널 세션 리스트 UI**에서 정렬·rename·로고 제공 |

### 미세 차이
| 항목 | 해결 방안 |
|---|---|
| Codex refine model | `gpt-4.1-mini` → `gpt-5.4-mini`로 원본과 동기화 |
| Claude refine model | `claude-haiku-4-5-20251001` 날짜 suffix가 `--model`에 유효한지 테스트 → 결과에 따라 원본(`claude-haiku-4-5`)으로 정렬 |
| `assembleIR` git probe | `execFileSync` → `execFile`(비동기)로 전환, 이벤트 루프 블록 제거 |
| `workspaces.json` atomic write | tmp → rename atomic write + UUID 경로 가드 추가 |
| `turnsStore` rotation | `maxRecords=1000` 조건 추가 (현재 size 5MB만 적용) |
| Assistant buffer hard cap | 1 MB cap 추가 — runaway 버퍼 폭주 방지 |

---

## 8. 권장 조치 우선순위

1. **C1** — turnRecorder에 sliceAssistant 파이프라인(6단계) 이식 → refine 품질·toolCalls 복원
2. **C2** — codex/agy resume 인자 조립 + `codexSessionWatcher` / `agyResume` 포팅
3. **C4** — `refineMemory` / `resetMemory` 명령 핸들러 실제 동작 연결
4. **C8** — env keep-out (`OPENAI_API_KEY`, `GEMINI_SYSTEM_MD`) + `TERM` / `COLORTERM`
5. **C7** — codex `config.toml` 마커 블록 + content 보존
6. **C5 / C6** — mid-stream Enter flush + ptyDisplayFilter 경계 처리 + filtered data를 recorder에도 공급
7. **C9** — `workspace.json` CAS 락 + `LOCK_STALE_MS` 도입
8. **아키텍처** — `CliPseudoterminal` 활용(또는 제거), `CliKind` 단일화
9. **3 CLI 네이티브 세션 파일 청소** — claude/codex/agy 모두 세션 delete 시 native 파일 제거
10. **Quota tracking + refine fallback** — `cliQuotaTracker`, quota 감지/forced fallback/background probe
11. **나머지 기능 포팅** — Hook-disabled badge, Drag-and-drop, Tab 정렬/rename/로고
12. **미세 차이** — refine model hint 검증, `assembleIR` git probe 비동기화

---

## 9. Extension Dev Host 라이브 검증 결과 (2026-05-23)

전체 Cmd+R/F5 사이클을 거치며 사용자가 수동 검증한 결과.

### 통과
| 항목 | 검증 방법 | 결과 |
|---|---|---|
| C1 sliceAssistant 파이프라인 | 6턴 채팅 → `turns.jsonl` 검사 | toolCalls 추출 + chrome 노이즈 제거 ✓ |
| C2 codex/agy resume | 세션 닫고 다시 열어 이전 대화 기억 | claude/codex/agy 모두 thread/conversation ID 보존 ✓ |
| C3 Reset이 archive까지 삭제 (의도된 정책) | Memory 패널 Reset | IR + turns + archive 일괄 삭제 ✓ |
| C4 명령 팔레트 Refine/Reset | `AgentBridge: Refine Memory` / `Reset Memory` 실행 | refineDispatcher 실제 동작 + IR 갱신 ✓ |
| C5 mid-stream Enter / Backspace | 응답 중 새 메시지 Enter / `abcde` BS×2 `xy` Enter | turn 2개 정상 기록 / user="abcxy" ✓ |
| C5 Ctrl-C | 응답 중 Ctrl+C | 응답 중단 + turn flush ✓ |
| C6 hook context 은닉 | `[hook context hidden]` marker + `turns.jsonl` grep | raw `<agentbridge-context>` 0개 매치 ✓ |
| C7 codex 마커 블록 충돌 회피 | `<cwd>/.codex/config.toml`에 기존 `[features]` 주입 → 새 codex 세션 | `skipping marker block` log + 사용자 키 100% 보존 + codex 정상 시작 + hook 정상 작동 ✓ |
| C8 env keep-out | `!echo "TERM=$TERM ... OPENAI=${OPENAI_API_KEY:-EMPTY}"` | `TERM=xterm-256color COLORTERM=truecolor OPENAI=EMPTY GEMINI=EMPTY` ✓ |
| C9 다중 프로세스 CAS 락 | 가짜 fresh lock 주입 → 6턴 / stale lock 자동 override | `another process holds the lock, skipping` + `stale lock detected — overriding` ✓ |
| 3 CLI 네이티브 청소 | claude/codex/agy 각각 세션 delete | `~/.claude/projects/.../<sid>.jsonl`, `~/.codex/sessions/.../*-<thread>.jsonl`, `~/.gemini/antigravity-cli/conversations/<uuid>.pb` 삭제 ✓ |
| Quota fallback | agy 바이너리 이동 → priority 정책 1순위 실패 시뮬 | `agy failed → codex succeeded` fallback ✓ |
| Hook-disabled badge | helper binary 이동 → 새 세션 | "메모리 비활성 · Claude" 배지 노출 + 클릭 시 modal로 상세 + Copy/Open Output ✓ |
| DnD 첨부 (Shift+drop) | Finder에서 이미지 Shift+드래그 | `<cwd>/.agentbridge/attachments/<sid>/<ts>-<name>` 저장 + `@<relative-path>` 입력 + .gitignore 자동 추가 ✓ |
| 사이드패널 동기화 | 탭 전환·새 세션·닫힌 세션 클릭 | TreeView selection이 활성 탭 sessionId로 reveal ✓ |
| 사이드패널 흐림 상태 | extension activate 시 어떤 panel도 없음 | `resetAllSessionsActive` 호출 → 모두 dim → 패널 생성 시 active로 ✓ |
| 사이드패널 inline 액션 | 세션 hover | `$(edit)` 연필 + `$(trash)` 휴지통 아이콘 노출 + 컨텍스트 메뉴 동일 항목 (Enter/F2 keybinding 제거) ✓ |
| Compaction 트리거 + Archive | 6턴 × 2회 | 1차 ir.json만, 2차 `archive/compressed_*.jsonl` 생성 ✓ |
| 임계값 일치 | 6 turn / 12 KB / IDLE_FLUSH_MS=1.5s / 1MB cap / LOCK_STALE_MS=5min | 로그에서 모두 확인 ✓ |

### 보강 사항 (검증 도중 발견)
| 이슈 | 조치 |
|---|---|
| `spawnGraceDone` 5초 동안 사용자 입력 drop | grace 제거 (원본도 없음) — [turnRecorder/index.ts](../src/core/turnRecorder/index.ts) |
| awaiting 상태에서 새 Enter 시 이전 user text 덮어쓰기 | `awaiting`도 mid-stream flush 대상 추가 |
| chunk 경계의 partial ANSI sequence (focus events `\e[O`/`\e[I`) → user buffer 누수 | `inputCarry` + `isCompleteAnsiSequence` 도입, SS3(`ESC O <final>`) 3바이트 처리 |
| sessions.json read-modify-write race로 손상 | `withWriteLock(workspaceId)` mutex 추가, JSON parse 실패 시 `*.broken.<ts>.bak` 백업 |
| 세션 delete 시 다른 세션까지 사라지는 cascade | `markDeleted` flag로 onDispose → markSessionClosed cascade 차단 |
| panel.dispose 시 webview 탭이 안 닫힘 | `dispose()`에 `this.panel.dispose()` 추가 (재귀 guard 있음) |
| 새 panel `onDidChangeViewState` 초기 active 미발화 → selection 미동기화 | 50ms 지연 후 sessionId fire 추가 |
| hookStatus 변경 시 Memory 패널 미갱신 | `hookStatusEvents` EventEmitter → memoryProvider.notifyIRUpdated 연결 |
| `~/.codex/config.toml` 사용자 글로벌 클로버 위험 ($HOME cwd fallback) | `assertWorkspaceCwd` + extension.ts에서 워크스페이스 폴더 강제 |
| Webview sandbox로 `File.path` 없음 (Finder 드래그) | FileReader→base64→host 쓰기→`@<cwd-relative-path>` 입력 방식 |
| 첨부 파일 누적 | session delete cleanup + activate 시 TTL=1시간 stale cleanup |
| agy `last_conversations.json` cache stale (UUID 캡처 실패) | conversations/*.pb 디렉토리 snapshot diff로 교체 |

### 사후 관찰 (배포 후 모니터링 항목)
| 항목 | 상태 |
|---|---|
| Codex 화면 간헐 freeze | 사용자 보고 "백그라운드 codex는 정상, PTY 화면만 freeze". `ptyDisplayFilter`에 in-block watchdog(5s) + warn 로그 추가하여 자동 복구 + 진단 가능. 재현/원인 추적은 라이브 모니터링 |
| codex `Working (0s · esc to interrupt)` 응답 지연 | codex CLI 자체 모델 응답 지연 가능성 — extension 외 영역 |

---

## 10. 완료 기준

- [x] 원본 앱의 모든 core 모듈에 대해 extension 대응 파일 확인
- [x] 의도적 차이 vs 누락 분류
- [x] `npx tsc --noEmit` 통과
- [x] Helper / node-pty / CLI PATH smoke 통과
- [x] 누락된 핵심 로직 포팅 (권장 조치 1~12 전부)
- [x] Extension Dev Host에서 3모델 세션 + compaction + 메모리 패널 + DnD + hook-badge + 사이드패널 동기화 동작 확인
- [ ] codex 간헐 freeze 라이브 모니터링 (watchdog로 자동 복구 + 진단 로그 확보)
- [ ] 불필요한 코드 정리 (`pty/pseudoterminal.ts` 활용/제거, `CliKind` 통합)
- [ ] Extension Development Host에서 3모델 세션 + 6턴 + compaction + 메모리 패널 Refine/Reset + 세션 rename/delete 시나리오 확인
