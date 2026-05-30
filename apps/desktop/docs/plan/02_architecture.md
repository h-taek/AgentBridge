# 아키텍처

> Phase 3 — Plan / 문서 2: 모듈 경계 / 데이터 흐름 / IPC / 영속화

[01_mvp_scope.md](./01_mvp_scope.md)에서 확정한 1차 릴리즈를 코드 모듈 단위로 매핑한다. 구체 구현(클래스명, 함수 시그니처)은 Phase 4 구현 단계에서 결정하고, 본 문서는 모듈 경계와 데이터 흐름을 고정한다.

> **Phase 4 M0 capability probe([probe_results.md](./probe_results.md)) 결과로 I/O 모델은 *모델 B (PTY + xterm.js 임베드)*로 확정됐다.** 본 문서는 그 가정으로 작성. 메인 채팅 흐름은 PTY 인터랙티브 spawn + xterm.js raw forward이고, IR refine만 별도 헤드리스 spawn(stream-json).

> ⚠️ **Phase 4 M3 진입 시 architecture revision 발생** — probe 05~08 ([probe_results.md §7~10](./probe_results.md)) 및 [Subspace 분석](../research/04_subspace_injection_analysis.md) 결과로 M3+ 흐름이 *workspace + multi-tab + hook + gemini refine* 패러다임으로 진화. **§14**에 delta 정리. §1~§13은 M0~M2 (single-active handoff) 흐름의 정의로 보존.

## 1. 한눈에 보는 그림

```
┌──────────────────────────────── Electron Main Process ─────────────────────────────────┐
│                                                                                        │
│  ┌──────────────┐   ┌──────────────────────┐     ┌──────────────────────────────────┐  │
│  │ AppLifecycle │   │ ConversationStore    │     │ CLIAdapter                       │  │
│  │  - 창 관리     │   │  - 스레드 메타 영속   │     │  - Claude / Codex / Gemini        │  │
│  │  - 업데이트    │   │  - replay.log        │     │  - spawnInteractive (PTY)        │  │
│  └──────────────┘   │  - IR 영속            │     │  - spawnRefineIR (headless JSON) │  │
│         ▲           │  - sessionId 메타     │     │  - env / cwd / PATH 처리          │  │
│         │           └──────────────────────┘     └──────────────────────────────────┘  │
│         │                    ▲                              ▲                          │
│         │                    │                              │  PTY (node-pty) /        │
│         │                    │                              ↓  child_process.spawn     │
│         │                    │                  ┌─────────────────────────┐            │
│         │                    │                  │ External CLI processes  │            │
│         │                    │                  │  claude / codex /gemini │            │
│         │                    │                  └─────────────────────────┘            │
│         │                    │                                                         │
│         │           ┌──────────────────┐                                               │
│         │           │ IRModule         │                                               │
│         │           │  - schema 정의    │  (호출 방향 단방향: IPC 핸들러 → IRModule)        │
│         │           │  - 직렬화/검증     │  IRModule은 CLI를 부르지 않음 (순환 회피)         │
│         │           │  - 주입 페이로드   │                                               │
│         │           └──────────────────┘                                               │
│         │                    ▲                                                         │
│         │                    │                                                         │
│         │           ┌──────────────────────────────────┐                              │
│         │           │ IPC 핸들러 (Main)                  │                              │
│         │           │  pty:write / pty:resize            │                              │
│         │           │  chat:send (입력창 → PTY stdin)     │                              │
│         │           │  handoff:prepare / cancel / commit │  ← 얇은 orchestration          │
│         │           │  threads:* / settings:*            │                              │
│         │           └──────────────────────────────────┘                              │
│         │                IPC (contextBridge / preload)                                 │
└─────────┼──────────────────────────────────────────────────────────────────────────────┘
          │
┌─────────▼──────────────────── Renderer Process (sandboxed) ───────────────────────────┐
│                                                                                       │
│   ChatInputBox  XtermView   ModelSwitcher   IRReviewPanel   ThreadList   Settings     │
│                  └─ xterm.js 컴포넌트 (활성 모델 PTY raw bytes 렌더)                       │
│                                                                                       │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

설계 원칙:
- **Renderer는 사용자 입력/표시만**. CLI spawn·파일 I/O·LLM 호출은 모두 Main에서. contextIsolation/sandbox 활성 유지 ([03_desktop_framework.md §3.5](../research/03_desktop_framework.md)).
- **CLIAdapter는 두 spawn 모드를 분리**해 노출한다: `spawnInteractive`(PTY, 메인 채팅) + `spawnRefineIR`(헤드리스 stream-json, IR 정제 전용). 세 모델 분기는 어댑터 내부에 한정해 `ConversationStore`/`IRModule`은 모델 비의존.
- **IRModule은 모델 비의존이며 CLI를 호출하지 않는다**. IR 스키마/직렬화/검증만 담당. LLM 정제 호출이 필요한 흐름은 *IPC 핸들러*(Main 프로세스의 `handoff:prepare` 등)가 ConversationStore + IRModule + CLIAdapter를 *얇은 절차*로 묶어 처리한다(§4.2). 별도 orchestration 모듈을 두지 않음 — 1차 릴리즈 단순성.
- **xterm.js는 Renderer 측 표시 컴포넌트일 뿐**. PTY는 Main에서만 보유하고 raw bytes를 IPC 단방향 stream으로 Renderer에 push. Renderer는 사용자 키 입력을 IPC로 Main에 invoke해 PTY에 write.

## 2. 프로세스 모델

| 프로세스 | 책임 |
|---|---|
| Main | 앱 lifecycle, 창 관리, 메뉴, auto-update, 모든 PTY/child_process spawn, 파일 I/O, IPC handler |
| Renderer (단일 BrowserWindow) | UI 렌더(xterm.js / 채팅 입력창 / IR 검토 / 스레드 목록 / 설정). React (Phase 4 결정 — [01_mvp_scope.md §1](./01_mvp_scope.md)) |
| Utility process | **MVP 미사용**. 추후 IR 정제 LLM 호출이 무거워지면 utilityProcess로 격리 검토 ([03_desktop_framework.md §3.1](../research/03_desktop_framework.md)) |
| Child process | `claude` / `codex` / `gemini` CLI. 메인 채팅은 `node-pty`로 PTY spawn, IR refine은 일반 `child_process.spawn` |

PTY는 MVP에 포함됨. node-pty(또는 prebuilt 변종) + xterm.js 의존 추가 — [§10](#10-외부-의존-1차-릴리즈), [03_desktop_framework.md §9](../research/03_desktop_framework.md), [probe_results.md §4](./probe_results.md).

## 3. 모듈 경계

### 3.1 모듈 목록

| 모듈 | 위치 | 책임 | 의존 |
|---|---|---|---|
| `AppLifecycle` | Main | 창 생성, 메뉴, electron-updater, 첫 실행 안내, CLI 헬스체크 | electron, electron-updater |
| `CLIAdapter` | Main | 세 CLI별 spawn 두 모드: (1) `spawnInteractive`(PTY) — 메인 채팅, raw bytes 전달. (2) `spawnRefineIR`(헤드리스 stream-json) — IR refine. 환경변수/cwd 처리, lifecycle(SIGTERM→SIGKILL) | node-pty, child_process, EnvProbe |
| `ConversationStore` | Main | 스레드 메타/replay.log/사용자 메시지/IR을 사용자 머신에 영속화, 조회 API | fs |
| `IRModule` | Main | IR 스키마 정의, schema validation, 정제 프롬프트 빌드, 정제 결과 파싱, 주입 페이로드 직렬화. **순수 모듈 — CLI/파일 I/O 호출 없음** | 없음(순수 모듈) |
| `IPCBridge` | Main + preload | Renderer ↔ Main 통신 채널 정의(타입드 invoke/handle/send) + 핸들러가 도메인 모듈(ConversationStore / IRModule / CLIAdapter)을 조합해 chat·pty·handoff·threads·settings 흐름을 처리 | electron(ipcMain/ipcRenderer/contextBridge), ConversationStore, IRModule, CLIAdapter |
| `EnvProbe` | Main | macOS GUI PATH 캡처(`/bin/zsh -ilc 'echo -n $PATH'`), CLI 절대경로 감지, 인증 상태 헬스체크 | child_process |
| `UI` | Renderer | XtermView(xterm.js + fit/web-links 애드온), ChatInputBox, ModelSwitcher, IRReviewPanel, ThreadList, FirstRunGuide, Settings | IPCBridge(타입드 클라이언트), xterm |

### 3.2 의존 그래프

```
UI (Renderer) ──────► IPCBridge (Main IPC handlers)
                            │
                            │  IPC 핸들러는 chat/pty/handoff/threads/settings 흐름을 위해
                            │  아래 세 모듈을 *얇은 절차*로 조합한다.
                            ▼
        ┌──────────────────┬──────────────────┬──────────────────┐
        ▼                  ▼                  ▼                  ▼
ConversationStore       IRModule           CLIAdapter      AppLifecycle / EnvProbe
   (fs)              (순수 — CLI 미호출)      │
                                          ▼
                                   PTY processes (메인) + child processes (refine)
```

- **순환 의존 금지**: `IRModule`은 CLI를 호출하지 않는다. 정제 spawn은 IPC 핸들러가 직접 `CLIAdapter.spawnRefineIR`를 부른 뒤 결과 raw text를 `IRModule.parseRefineOutput`으로 넘긴다.
- `CLIAdapter`는 IRModule을 호출하지 않는다. 핸들러가 `IRModule.buildInjectionPayload`로 만든 페이로드를 입력으로 받기만 한다.
- 별도 orchestration 모듈(예: HandoffService)을 두지 않는다. 흐름이 복잡해져 단위 테스트 단위로 잡고 싶어지는 시점에 모듈로 추출하는 것을 후순위 옵션으로 둔다.

## 4. 데이터 흐름

### 4.1 사용자 메시지 — 활성 모델과 채팅

PTY 모드이므로 *spawn은 thread 활성화 시 1회*고, 이후 메시지는 PTY stdin으로 단순 write. CLI가 자체 stream으로 raw bytes 출력을 PTY에 쓰면 Main이 읽어 IPC로 Renderer에 push.

```
[사용자가 thread 선택 또는 새 thread 생성]
        │
        │ ipc.invoke('chat:openThread', { threadId })
        ▼
[Main IPC]  CLIAdapter.spawnInteractive(activeModel, { sessionId?, irPayload? })
              │ - sessionId == null && irPayload != null  → 새 세션 + IR 주입 (모델 전환 직후)
              │ - sessionId != null                       → 이어가기(--resume <id>) — IR 주입 없음
              │ - sessionId == null && irPayload == null  → 새 세션, IR 없음 (thread 첫 생성)
              ▼
            PTY ready. 활성 PTY 핸들을 thread별 세션 맵에 보관
              │
              │ child.onData((bytes) => ipc.send('pty:data', { threadId, bytes }))
              │ child.onExit((code) => ipc.send('pty:exit', { threadId, code }))
              ▼
[Renderer XtermView]  pty:data 수신 → xterm.write(bytes)

[사용자가 채팅 입력창에 메시지 입력 + Enter]
        │
        │ ipc.invoke('chat:send', { threadId, text })
        ▼
[Main IPC]  ConversationStore.appendUserMessage(threadId, text)   // IR 입력용 trajectory에 사용자 메시지만 기록
            CLIAdapter.write(threadId, text + '\r')               // PTY stdin으로 forward
        ▼
            CLI 자체 인터랙티브 흐름: 응답 + 도구 호출 다이얼로그(필요 시) → PTY 출력 → pty:data
                                     사용자가 다이얼로그에 직접 응답 (xterm.js 안에서 키 입력)

[사용자가 xterm.js 영역에 직접 키 입력 (예: 다이얼로그 numbered menu, Ctrl-C 등)]
        │
        │ xterm.onData((data) => ipc.invoke('pty:write', { threadId, data }))
        ▼
[Main IPC]  CLIAdapter.write(threadId, data)
```

핵심 차이 (이전 stream-json 가정 대비):
- **활성 PTY는 thread당 1개, long-lived**. 매 메시지마다 spawn 안 함.
- **stream-json 정규화 이벤트(§7.3)는 메인 채팅 흐름에서 사용 안 함**. raw bytes 그대로 xterm.js로 forward.
- **IR 주입은 `spawnInteractive` 시 1회**(모델 전환 직후 또는 thread의 활성 모델이 처음 spawn될 때). 같은 모델로 이어가는 메시지에는 주입하지 않음.
- **세션 ID 캡처**: Claude/Gemini는 우리가 `--session-id <UUID>`로 사전 통제하므로 캡처 불필요. Codex는 `thread_id`를 모르므로 spawn 직후 PTY에서 `\x1bP`(DCS) 같은 표준 시그널을 받기 어려움 — Codex의 thread_id는 *spawn 시 우리가 경로/이름으로 사전 통제하지 못하므로* CLI가 화면에 출력하는 `thread.started` 같은 이벤트 텍스트를 보고 캡처해야 한다. probe 04 시점에서는 PTY 인터랙티브에서 stream-json이 안 나오므로 다른 경로 필요 — M1 구현 시 `~/.codex/sessions/` 같은 native session 파일 경로 watch + 매핑 등으로 우회 ([§13.2](#132-m1m2-구현-중-실측으로-닫히는-항목-구현-결정에-영향)).

### 4.1.1 응답 중지 (사용자 트리거)

```
[Renderer ChatInputBox 또는 XtermView] 사용자가 응답 중지를 원함
        │
        │ 옵션 A: GUI "중지" 버튼 클릭
        │ 옵션 B: xterm.js에 직접 Ctrl-C 키 입력
        ▼
[Main IPC]
  옵션 A: CLIAdapter.write(threadId, '\x03')   // SIGINT (Ctrl-C 바이트) PTY stdin으로
  옵션 B: 위와 동일 — Renderer가 xterm 키 입력으로 \x03을 invoke('pty:write')로 보냄
        │
        │ 활성 CLI가 자체 인터럽트 처리 (현재 도구 호출/응답 중단)
        ▼
[Renderer XtermView] CLI가 그리는 "중단됨" 표시 그대로 노출
```

- AgentBridge는 인터럽트 자체에 별도 라벨링을 하지 않음 — CLI native 동작에 위임.
- thread 종료 / 모델 전환 / 앱 종료 시에는 PTY 핸들에 SIGTERM(grace 1초) → SIGKILL.
- **GUI 중지 버튼 활성화 휴리스틱**: PTY data chunk가 최근 ~800ms 안에 도착했으면 "생성 중"으로 간주해 버튼 활성화. 유휴 상태에서 비활성. 근거: claude TUI는 빈 입력 라인에서 Ctrl-C를 받으면 첫 번째는 라인 취소, 두 번째는 exit confirmation으로 동작 — 의도치 않은 세션 종료를 방지. xterm 직접 Ctrl-C 경로는 막지 않음(advanced 사용자가 native 의미 그대로 사용).
- **Ctrl-C 후 컨텍스트 거동 (claude 한정 — M1 실측)**: 응답 생성 중 Ctrl-C로 인터럽트하면 claude session은 *부분 응답을 그대로 assistant 턴으로 누적해 보관*. 다음 사용자 메시지를 보내면 claude는 "부분 응답 + 새 user 턴"으로 이어 생성. claude session API에 부분 턴 제거 수단이 없어 PTY 어댑터에서 우회 불가. UX 옵션 — (1) 그대로 노출(현재), (2) M2/M3에서 IR 검토·편집 모달(차별점 3)로 사용자가 부분 응답을 의도적으로 정리/제거할 수 있게 풀기. 1차 릴리즈는 (1) + 사용자 안내 문구로 진행, (2)는 IR 스키마 설계 시 자연스럽게 흡수 검토.

### 4.2 모델 전환 (차별점 3 핵심 흐름)

orchestration 모듈을 두지 않고 IPC 핸들러가 ConversationStore + IRModule + CLIAdapter를 *얇은 절차*로 묶는다. 모델 B에서는 PTY restart가 끼어 있어 흐름이 약간 더 복잡.

```
[Renderer ModelSwitcher] 사용자가 다른 모델 선택
        │
        │ (UI 상태: Switching:Preparing — 입력창 비활성, 진행 표시기, 경과 시간, from→to, 취소 버튼)
        │ ipc.invoke('handoff:prepare', { threadId, fromModel, toModel })
        ▼
[Main: handoff:prepare 핸들러]
        1. trajectory = ConversationStore.loadTrajectoryForRefine(threadId)
           (사용자 메시지 + replay.log에서 추출한 모델 응답 요약 + 직전 IR)
        2. currentIR = ConversationStore.loadIR(threadId)
        3. prompt = IRModule.buildRefinePrompt({ trajectory, currentIR, targetModel: toModel })
        4. raw = CLIAdapter.spawnRefineIR({ model: fromModel, prompt, abortSignal })
           (헤드리스 stream-json spawn — 메인 PTY와 별도. 활성 모델이 자기 자신의 trajectory를 정제)
        5. draftIR = IRModule.parseRefineOutput(raw)
        ▼
        정제된 IR draft (메모리에만 보관 — §5 / §4.2 draft 미복구 정책)
        │
        │ ipc.return draft → Renderer
        │ (UI 상태: Switching:Reviewing — IRReviewPanel 표시, 입력창 비활성)
        ▼
[Renderer IRReviewPanel] structured 필드(intent / decisions / files / commands / tests / pending)
                         + trajectory 요약을 사용자에게 표시
        │
        │ 사용자 편집(carry-forward 토글, 항목 수정/추가/제거)
        │
        │ ipc.invoke('handoff:commit', { threadId, editedIR, toModel })
        ▼
[Main: handoff:commit 핸들러]
        1. IRModule.validate(editedIR)                           — 실패 시 즉시 에러 반환
        2. ConversationStore.saveIRAtomic(threadId, editedIR)    — 실패 시 에러, 활성 모델 변경 없음
        3. ConversationStore.setActiveModelAtomic(threadId, toModel)
        4. CLIAdapter.killInteractive(threadId)                  — 기존 fromModel PTY SIGTERM(grace) → SIGKILL
        5. payload = IRModule.buildInjectionPayload(threadId, toModel)
        6. CLIAdapter.spawnInteractive(toModel, { sessionId: null, irPayload: payload })
                                                                  — 새 PTY spawn, IR을 첫 입력에 주입
        7. (Renderer XtermView가 새 PTY 핸들로 재초기화 — pty:data 수신 시작)
        │
        │ 다음 사용자 메시지부터: §4.1대로 PTY stdin write.
        │ 이후 thread 재진입 시: toModel의 sessionId(spawn 시 우리가 통제한 UUID 또는 캡처한 thread_id)로 --resume.
```

`handoff:cancel` 핸들러는 진행 중 정제 spawn(헤드리스)에 SIGTERM을 보내 abort. 메인 PTY·ConversationStore·IR·active model 모두 변경 없음.

- `IRReviewPanel`은 자동으로 뜬다 (사용자가 검토 단계를 끄지 않는 한). 사용자가 "이대로 전달" 버튼을 눌러도 명시적인 한 번의 클릭은 통과한다 — 차별점 3의 controllability를 1차 릴리즈에 박는다 ([02_model_integration.md §8.4](../research/02_model_integration.md)).
- handoff 준비는 LLM 호출을 포함하므로 지연을 허용한다. 목표 상한은 10초이며, 그동안 Renderer는 진행 상태와 경과 시간을 표시한다 ([02_nfr.md §3](../spec/02_nfr.md)).
- **IR draft는 디스크에 저장하지 않는다(메모리 보관).** 검토 도중 앱이 종료되면 draft는 소실되고, 재실행 시 활성 모델·이전 IR은 종료 직전 그대로 유지된다 — 사용자가 다시 모델 전환을 시도하면 prepare가 다시 동작.
- toModel에 처음 진입할 때만 IR을 주입한다. 같은 toModel로 두 번째 thread 진입(재시작)부터는 `--resume`만으로 합류.

### 4.2.1 모델 전환 UI 상태

| 상태 | 트리거 | UI 동작 | 입력창 / 모델 컨트롤 | 지속 시간 / 예산 |
|---|---|---|---|---|
| `Idle` | — | 활성 모델 라벨, xterm.js에 정상 채팅 표시 | 활성 / 활성 | — |
| `Streaming` | 활성 모델이 출력 중(휴리스틱 — 일정 시간 동안 PTY data 수신 중) | "중지" 버튼 표시 (xterm.js Ctrl-C도 가능) | 입력 비활성 / **모델 전환 비활성** | 응답 시간 |
| `Switching:Preparing` | 사용자가 다른 모델 선택 | 진행 표시기 + 경과 시간 + `from → to` + **취소** 버튼. xterm.js는 fromModel 화면 그대로 표시(읽기 전용 느낌) | 비활성 / 비활성 | **목표 ≤ 10초** |
| `Switching:Reviewing` (M3) | `handoff:prepare` 완료 | IR Review Panel 모달 overlay 표시 | 비활성 / 비활성 | 사용자 검토 시간 (제한 없음) |
| `Switching:Committing` | (M2) 자동 / (M3) "이대로 전달" | 짧은 진행 표시 — IR 저장 + PTY 재시작 | 비활성 / 비활성 | < 3초 (PTY 재spawn 포함, 목표) |
| `Switched` | 새 PTY ready | 새 모델 라벨로 전환, xterm.js 새 PTY 출력 표시, `Idle`로 복귀 | 활성 / 활성 | — |
| `Switching:Failed` | refine 실패 / commit 실패 / 새 PTY spawn 실패 | 에러 메시지 + "재시도 / 취소" | 액션 후 활성화 | — |

부수 정책:
- `Streaming` 상태 휴리스틱은 PTY data 도착 빈도 기반(예: 1초간 추가 data 없으면 idle로 간주). PTY는 stream-json처럼 명시 끝 마커가 없으므로 정확한 "응답 종료" 시점 감지는 휴리스틱.
- `Switching:Preparing`이 10초를 초과해도 자동 abort하지 않는다. 진행 표시기 옆에 "예상보다 오래 걸리고 있습니다 — 취소할 수 있습니다" 보조 안내만 추가.
- `Switching:Preparing` 중 취소 → refine spawn(헤드리스)에 SIGTERM(→ 1초 grace → SIGKILL). 메인 PTY는 손대지 않음 — fromModel 활성 그대로.
- `Switching:Failed`(refine 실패 / schema validation 실패 / 새 PTY spawn 실패) 시 활성 모델은 fromModel로 유지되고, 사용자가 재시도 또는 취소 선택. 새 PTY spawn 실패 시 fromModel PTY가 이미 kill됐으면 fromModel로 새 PTY spawn 복구 (best-effort).

### 4.3 첫 실행 / CLI 헬스체크

```
앱 첫 실행
   │
   ▼
EnvProbe.captureUserPath()       // /bin/zsh -ilc 'echo -n $PATH'
   │
   ▼
EnvProbe.locateCLIs(['claude','codex','gemini'])
   │
   ▼
EnvProbe.checkAuthState(...)     // claude --version / codex --version / gemini --version + 가능하면 미니멀 dry-run
   │
   ▼
[Renderer FirstRunGuide] 결과 표시 → 미설치/미인증 항목 안내 → 사용자가 절대경로 직접 입력 가능
   │
   ▼
설정 영속화 → 정상 사용
```

## 5. 영속화 — 디렉토리 구조

[01_ir.md §6](../research/01_ir.md), [01_mvp_scope.md §4](./01_mvp_scope.md) 결정 반영. macOS 표준 위치 사용. 모델 B 채택으로 **PTY raw replay log**가 추가됨.

```
~/Library/Application Support/AgentBridge/
├── settings.json                 # CLI 경로, PATH 캡처 결과, 전역 기본값, UI 설정
├── threads/
│   ├── <contextId>.json          # 스레드 메타: contextId, title, createdAt, activeModel, workspacePath,
│   │                             #             sessions: { claude?: <UUID>, codex?: <thread_id>, gemini?: <UUID> }
│   ├── <contextId>.user.jsonl    # 사용자 메시지 trajectory (AgentBridge가 송신한 사용자 입력만 라인 단위 append)
│   ├── <contextId>.replay.log    # 활성 PTY raw bytes append-only — thread 재진입 시 xterm.js에 replay
│   └── <contextId>.ir.json       # 현재 IR (structured 필드). 모델 전환 시점에만 갱신
├── artifacts/
│   └── <contextId>/
│       └── <artifactId>.<ext>    # 큰 tool output, 파일 스냅샷 등 (필요 시)
└── logs/
    └── ...
```

- 한 스레드 = 1 contextId = 4개 파일(meta / user.jsonl / replay.log / ir.json).
- 스레드 메타 1파일에 `sessions`를 담는다 — 한 번의 atomic rename으로 함께 커밋되도록.
- `permissionModes` 메타는 *제거*됨 — 모델 B 채택으로 권한 토글 자체가 사라짐(§11). thread 메타는 권한 모드를 저장하지 않는다.
- **`<contextId>.user.jsonl`** — AgentBridge가 PTY stdin으로 보낸 사용자 메시지(또는 xterm.js 안에서 사용자가 직접 친 자유 입력 중 우리가 메시지로 분리한 부분)를 라인 단위 기록. IR refine spawn의 trajectory 입력으로 사용. CLI 응답은 여기에 기록하지 않음.
- **`<contextId>.replay.log`** — 활성 PTY가 출력한 raw bytes를 그대로 append. xterm.js의 화면 상태를 thread 재진입 시 *되감기*용. 모델 응답·도구 호출·다이얼로그·사용자가 xterm.js에 친 키 입력 echo 등이 모두 섞여 있음. 회전(rotation) 정책: thread 종료 시 압축 또는 max size 초과 시 oldest truncate (Phase 4 결정).
- IR.trajectory 추출은 IRModule이 user.jsonl + replay.log + 직전 IR을 입력으로 받아 *모델 응답 본문에 가까운 텍스트*를 추출 — 정확한 추출 로직은 M2 구현 시 결정([§13.2](#132-m1m2-구현-중-실측으로-닫히는-항목-구현-결정에-영향)).
- 스레드 메타의 `sessions`는 모델별 CLI native session ID. spawn 시 `--session-id <UUID>`로 우리가 사전 통제하면 그 UUID 그대로 저장(Claude/Gemini), Codex는 spawn 후 캡처해 저장.
- IR은 단일 JSON 파일. handoff 시점마다 atomic rename으로 덮어쓰기. **IR draft는 디스크에 영속화하지 않음**(검토 도중 앱 종료 시 소실 — §4.2 정책).
- 파일 ref는 경로만 저장(내용 미복제) — 일관성/디스크 공간 ([01_mvp_scope.md §4](./01_mvp_scope.md)).

자체 클라우드/계정 없음 — [05_app_concept.md](../spec/05_app_concept.md) 일관.

## 6. IPC 패턴

### 6.1 채널 정의 원칙

- `ipcRenderer.invoke` / `ipcMain.handle` 기반 request-response가 기본.
- PTY raw bytes 스트리밍은 Main → Renderer 단방향 `webContents.send` 사용.
- 모든 채널은 preload에서 `contextBridge.exposeInMainWorld('agentBridge', { ... })`로 화이트리스트 노출. raw `ipcRenderer` 직접 노출 금지([03_desktop_framework.md §3.5](../research/03_desktop_framework.md)).

### 6.2 채널 카탈로그 (1차 릴리즈)

| 채널 | 방향 | payload | 비고 |
|---|---|---|---|
| `app:health` | invoke | — | EnvProbe 결과 반환 (CLI 위치, 인증 상태, PATH) |
| `settings:get` / `settings:set` | invoke | 부분 키 | settings.json |
| `threads:list` | invoke | — | 스레드 목록(메타) |
| `threads:create` | invoke | `{ initialModel, workspacePath }` | 새 스레드 + 활성 PTY spawn |
| `threads:open` | invoke | `{ threadId }` | 스레드 열기 — 활성 PTY spawn(--resume) + replay.log를 Renderer에 전달해 xterm.js 재구성 |
| `threads:close` | invoke | `{ threadId }` | 활성 PTY SIGTERM. 메타 보존 |
| `chat:send` | invoke | `{ threadId, text }` | 사용자 메시지를 PTY stdin으로 forward (개행 포함). user.jsonl에도 append |
| `pty:write` | invoke | `{ threadId, data }` | xterm.js가 받은 사용자 키 입력을 PTY stdin으로 forward (raw bytes) |
| `pty:resize` | invoke | `{ threadId, cols, rows }` | xterm.js fit add-on 변경에 맞춰 PTY 크기 조정 |
| `pty:data` | send (M→R) | `{ threadId, bytes }` | PTY 출력 raw bytes |
| `pty:exit` | send (M→R) | `{ threadId, code, signal }` | PTY 자식 종료 |
| `handoff:prepare` | invoke | `{ threadId, toModel }` | 정제된 IR draft 반환. 헤드리스 spawn은 Main에서 |
| `handoff:cancel` | invoke | `{ threadId }` | Switching:Preparing 중 refine spawn에 SIGTERM. 메인 PTY/활성 모델 유지 |
| `handoff:commit` | invoke | `{ threadId, editedIR, toModel }` | 사용자 편집 결과 저장 + 모델 전환 + 새 PTY spawn(IR 주입) |
| `update:status` | send (M→R) | electron-updater 이벤트 | 자동 업데이트 알림 |

이전 가정에 있던 `chat:delta` / `chat:done` / `chat:error` / `chat:stop` / `threads:setPermissionMode`는 모델 B 채택으로 *제거*됐다. 대체:
- 응답 스트리밍 → `pty:data` (raw bytes)
- 응답 완료 마커 → 없음 (PTY data idle 휴리스틱으로 UI 상태 결정)
- 응답 에러 → `pty:exit` 또는 PTY 출력에 CLI가 에러 텍스트
- 응답 중지 → `pty:write`로 `\x03`(Ctrl-C) 전송
- 권한 모드 토글 → 권한 토글 자체 삭제(§11)

### 6.3 IPC 타입 안전성

Phase 4에서 TypeScript로 채널 타입 정의를 단일 소스로 두고 preload·Main·Renderer 모두 import 한다(상세 구현 결정).

## 7. CLIAdapter 추상화

### 7.1 인터페이스 (개념)

세 모델별 구현이 동일하게 노출하는 함수 집합. 두 spawn 모드를 분리:

| 함수 | 책임 |
|---|---|
| `spawnInteractive({ threadId, sessionId?, irPayload? })` | PTY 인터랙티브 spawn. 새 세션이면 `--session-id <UUID>` + IR 주입(Claude는 `--append-system-prompt-file`, Codex/Gemini는 spawn 직후 stdin write). 이어가기는 `--resume <UUID|index>`. PTY 핸들을 thread별 맵에 보관 |
| `write(threadId, data)` | 활성 PTY의 stdin에 raw bytes write |
| `resize(threadId, cols, rows)` | 활성 PTY 크기 조정 |
| `killInteractive(threadId)` | 활성 PTY에 SIGTERM(grace 1초) → SIGKILL. 핸들 정리 |
| `spawnRefineIR({ model, prompt, abortSignal })` | 정제 프롬프트로 헤드리스 stream-json spawn(메인 PTY와 별도). raw text 반환 |
| `version()` | CLI 버전 |
| `healthcheck()` | 인증·실행 가능 여부 |

### 7.2 모델별 args 매핑

[probe_results.md §1, §4](./probe_results.md)에서 실측 확정. 두 spawn 모드를 분리.

#### 메인 채팅 (인터랙티브 PTY) — 모델 B 흐름

| 모델 | spawnInteractive args | IR 주입 위치 (새 세션 시에만) |
|---|---|---|
| Claude | 새 세션: `claude --session-id <UUID> --append-system-prompt-file <tmpIR>` <br>이어가기: `claude --resume <UUID>` <br>권한 모드 인자 없음 — CLI native default 흐름 사용 | `--append-system-prompt-file` 임시 파일 (hidden flag — probe 01 §1.3) |
| Codex | 새 세션: `codex` (워크스페이스 trust 다이얼로그가 첫 화면. 그 후 메인 prompt input 등장) <br>이어가기: `codex resume <thread_id>` (또는 `codex resume --last`) <br>권한 모드 인자 없음 | spawn 직후 trust 응답 → 메인 prompt 등장 후 IR 본문을 PTY stdin write → 사용자 첫 메시지 (UI는 자동 처리) |
| Gemini | 새 세션: `gemini --session-id <UUID> --skip-trust` <br>이어가기: `gemini --resume <idx> --skip-trust` (idx는 `gemini --list-sessions` 출력 파싱으로 우리 UUID에 해당하는 인덱스) <br>권한 모드 인자 없음 | spawn 직후 input box 등장 후 IR 본문을 PTY stdin write → 사용자 첫 메시지 |

세션 ID 통제:
- Claude: `--session-id <UUID>`로 우리가 사전 통제. thread 메타에 그대로 저장.
- Gemini: `--session-id <UUID>`로 사전 통제. 단 이어가기 시 `--resume`은 인덱스만 받으므로 `--list-sessions` 파싱으로 UUID → idx 매핑 필요(M1 구현).
- Codex: 사전 통제 불가. spawn 후 `~/.codex/sessions/` 디렉토리 watch 또는 다른 native 메커니즘으로 thread_id 캡처 — M1 구현 시 결정([§13.2](#132-m1m2-구현-중-실측으로-닫히는-항목-구현-결정에-영향)).

#### IR refine (헤드리스 stream-json) — 모델 B 흐름

| 모델 | spawnRefineIR args |
|---|---|
| Claude | `claude -p '<refinePrompt>' --output-format stream-json --verbose --permission-mode acceptEdits` |
| Codex | `printf '%s' '<refinePrompt>' \| codex exec --json --skip-git-repo-check -s read-only -` (stdin-only) |
| Gemini | `gemini -p '<refinePrompt>' -o stream-json --approval-mode auto_edit --skip-trust` |

refine spawn은 메인 PTY와 *별도 child_process*. 활성 모델 PTY 세션을 건드리지 않음 — `--resume`을 사용하지 않고 새 세션으로 spawn한 뒤 종료 후 폐기.

상세 raw 출력 예시는 [probe_results.md §1.3](./probe_results.md), 근거는 [01_ir.md §5](../research/01_ir.md), [02_model_integration.md §3, §5](../research/02_model_integration.md).

### 7.3 정규화된 이벤트 모델 (refine 한정)

세 CLI의 **refine 헤드리스 spawn** 출력 stream-json 이벤트를 다음으로 정규화한다(개념). 메인 채팅 흐름(PTY)에서는 **사용 안 함** — raw bytes를 xterm.js에 그대로 forward.

| 정규화 이벤트 | 매핑 (refine 한정) |
|---|---|
| `assistant.text` | Claude `assistant.message.content[].text` / Codex `item.completed.item.text` / Gemini `message.content` (assistant role) |
| `usage` | usage 필드 (input/output/cache) — refine 비용 추적용 |
| `error` | stderr 또는 비-zero exit |

refine 출력은 IRModule이 `parseRefineOutput`에서 `assistant.text` 누적 본문을 IR JSON으로 파싱.

[02_model_integration.md §3, §7](../research/02_model_integration.md), [probe_results.md §1.3](./probe_results.md).

### 7.4 lifecycle / 환경

- **메인 PTY (인터랙티브)**: thread당 1개 long-lived. thread 종료 / 모델 전환 / 앱 종료 시 SIGTERM → 1초 grace → SIGKILL.
- **refine spawn (헤드리스)**: 단발. 결과 받고 즉시 종료. 사용자 트리거 abort(`handoff:cancel`) 시 SIGTERM → 1초 grace → SIGKILL.
- **Claude 임시 IR 파일 정리**: `--append-system-prompt-file`에 넘기는 임시 파일은 `os.tmpdir()` 하위(macOS 기본 `/var/folders/...`)에 생성. 메인 PTY spawn 후에는 CLI가 이미 파일을 읽었으므로 즉시 삭제 안전. 비정상 종료로 남은 파일은 다음 spawn 직전 prefix 매칭으로 정리. IR은 평문이므로 사용자 머신 외부로 절대 송신되지 않으나, 디스크 잔존 시간을 최소화한다.
- env: 사용자 shell env 상속 + AgentBridge가 의도적으로 설정하는 키만 명시 추가. CLI 절대경로는 EnvProbe 결과 사용.
- **AgentBridge가 spawn env에 *추가하지 않는* 키**: `OPENAI_API_KEY`(Codex의 ChatGPT 구독 인증을 silently 무시하므로 — 사용자 shell에 이미 있는 경우에만 통과), `GEMINI_SYSTEM_MD`(Gemini의 system prompt를 full replacement로 덮어써 CLI 기본 동작을 silently 차단하므로 — 사용자가 의도적으로 export한 경우에만 통과). 추가 keep-out 후보는 M1/M2 실측 시점에 보강.
- cwd: 사용자가 지정한 워크스페이스 폴더. 1차 릴리즈는 자동 worktree 격리 없음.
- PTY 환경변수: `TERM=xterm-256color`, `COLORTERM=truecolor`. cols/rows 초기값은 xterm.js 컴포넌트 측 fit add-on 결과 기반.

## 8. IRModule 내부

### 8.1 스키마 (1차 릴리즈)

[01_ir.md §6-2](../research/01_ir.md)의 권고 스켈레톤을 그대로 채택:

```
IR = {
  contextId,
  meta: { createdAt, updatedAt, lastModel, workspacePath, gitBranch?, gitHead? },
  intent: { goal, role, constraints[] },
  decisions: [{ topic, choice, rationale, ts }],
  files: [{ path, status, lastReadAt, summary }],
  commands: [{ cmd, exitCode, summary, fullOutputRef? }],
  tests: [{ name, status, failureSummary }],
  pending: [{ task, blockers, nextStep }],
  trajectory: [{ role, contentCompressed, originalRef? }],   // 최근 10턴 원문, 그 이전 요약
  artifacts: [{ id, name, mediaType, ref }]
}
```

trajectory와 영속 파일들의 관계 (모델 B 가정):
- **`<contextId>.user.jsonl`**: 사용자 메시지 원천. AgentBridge가 PTY stdin으로 송신한 텍스트만 기록.
- **`<contextId>.replay.log`**: PTY raw bytes 전체 — 모델 응답·도구 호출·다이얼로그·키 echo 등 혼재.
- **IR.trajectory (IR 안)**: refine 시점에 `user.jsonl + replay.log`로부터 추출·압축한 스냅샷. 최근 10턴은 원문에 가깝게, 그 이전은 요약. handoff 시점에만 갱신되고, IR 검토 패널(§9)에 표시되어 사용자가 편집 가능.
- IR.trajectory는 derived 데이터이며, 다음 refine 때 user.jsonl + replay.log 원본에서 다시 생성된다(§8.2 재귀 압축 회피). 즉 IR.trajectory가 손상되어도 user.jsonl + replay.log만 있으면 복구 가능.

### 8.2 정제(refine) 동작

```
IRModule.refine(threadId, currentModel):
    1. ConversationStore에서 user.jsonl + replay.log + 직전 IR 로드
    2. replay.log에서 ANSI escape strip 후 모델 응답 본문 텍스트 추출 (휴리스틱 — M2 구현 시 결정)
    3. 사용자 메시지와 응답 텍스트를 시간순 trajectory로 합침
    4. 최근 10턴 원문 분리, 그 이전 turn은 요약 대상
    5. CLIAdapter.spawnRefineIR(...) — 현재 활성 모델이 자기 자신을 정제 (헤드리스 stream-json)
       (외부 LLM 호출 없음. 단발 spawn으로 structured 필드 추출)
    6. 결과를 IR draft로 반환 (Renderer로 전달되어 사용자 검토)
```

재귀 압축 회피: 매 handoff마다 원본(user.jsonl + replay.log)에서 다시 정제. "summary-of-summary" 만들지 않음 ([01_ir.md §6-3](../research/01_ir.md)).

replay.log → 모델 응답 텍스트 추출 휴리스틱 정확한 형태는 M2에서 정함. 첫 시도: ANSI strip → 사용자 echo 라인 제거 → CLI prompt(`> `, `❯ ` 등) 라인 제거 → 남은 본문을 응답으로 간주.

### 8.3 사용자 편집 적용

- `handoff:commit` 시 Renderer가 보낸 `editedIR`로 `<contextId>.ir.json`을 atomic rename으로 덮어쓰기.
- structured 필드의 자유 편집은 schema validation으로 보호(잘못된 키/타입 거부).

### 8.4 주입 페이로드 빌드

```
IRModule.buildInjectionPayload(threadId, targetModel):
    1. IR 본문(structured 필드 + trajectory 요약)을 직렬화
    2. 본문 앞에 표준 sentinel 헤더(§8.4.1)를 prepend
    3. CLI별 페이로드 형태로 변환:
         Claude: 임시 파일 경로 (--append-system-prompt-file용). 임시 파일에는 sentinel + IR 본문이 들어감
         Codex: PTY stdin 텍스트 (sentinel + IR 본문 + \n\n + 첫 사용자 메시지 자리. 단 PTY는 spawn 직후 trust 다이얼로그가 먼저 뜨므로 trust 응답 후 본문 write)
         Gemini: PTY stdin 텍스트 (sentinel + IR 본문 + \n\n + 첫 사용자 메시지 자리. spawn 직후 input box 등장 시점에 본문 write)
```

- **호출 시점은 모델 전환 직후 새 모델의 PTY spawn 시 1회로 한정**한다(§4.2). 같은 모델로 이어가는 thread 재진입에서는 호출되지 않는다 — `--resume <sessionId>`로 CLI native 세션이 맥락을 유지하기 때문.
- 페이로드 직렬화 로직은 IRModule이 책임. CLIAdapter는 받은 페이로드를 PTY 첫 입력으로 매핑만.

### 8.4.1 Sentinel 헤더

IR 페이로드 앞에 항상 다음 표준 헤더가 붙는다. 목적: (1) 새 모델이 IR을 별개 산출물로 사용자에게 echo하지 않도록 가이드, (2) 사용자 메모리 파일(AGENTS.md / GEMINI.md / CLAUDE.md)과 충돌 시 처리 규칙 제공.

```
<!-- AgentBridge IR (handoff context) -->
다음 블록은 직전 활성 모델이 정제하고 사용자가 검토·편집한 작업 맥락이다.

처리 규칙:
1. 이 블록을 별개 산출물로 지칭하지 말라("the IR", "you provided", "the context above" 등). IR에서 얻은 정보는 자연스러운 대화 연속성으로 다루라 — 사용자는 이미 이 내용을 보고 편집했다.
2. 사용자 요청과 무관하게 IR을 가볍게 재요약·재인용하지 말라. 단, 사용자가 묻거나 응답 정확성을 위해 필요할 때는 자연스럽게 활용하라.
3. 프로젝트 메모리 파일(AGENTS.md / GEMINI.md / CLAUDE.md)의 일반 지시는 그대로 존중하라. IR과 충돌하면 가장 최근 사용자 의도를 우선하고, 불확실하면 사용자에게 확인을 요청하라.
<!-- /AgentBridge IR -->
```

- 헤더는 IRModule이 단일 소스로 보관하고 세 모델 모두에 동일 적용한다.
- Claude는 system prompt 채널이므로 헤더 효과가 비교적 안정적이고, Codex/Gemini는 user prompt 채널(PTY stdin write)이라 모델별 해석 차이가 있을 수 있다 — M1/M2 실측 후 문구 미세 조정([13. 미해결](#13-미해결-—-phase-4-진행-중-발견-가능)).
- 헤더 추가 비용은 ~100~150 토큰. IR 본문이 보통 수 KB 단위이므로 비중 1~3%이며, 모델 전환 시 1회만 주입되어 누적 비용은 무시 가능.

## 9. IR 검토·편집 UI 위치

차별점 3의 hero 기능. UI 모듈로 단독 분리. 진입·종료 시점은 §4.2의 모델 전환 흐름 + §4.2.1 UI 상태 표(`Switching:Reviewing`)를 따른다.

| 항목 | 결정 |
|---|---|
| 진입 | 모델 전환 시 자동(MVP 기본). 정확히는 `handoff:prepare` 완료 → UI 상태가 `Switching:Reviewing`으로 전이될 때 표시(§4.2.1). 설정에서 "검토 없이 자동 핸드오프" 토글 제공 — 단 차별점 강조를 위해 기본값은 검토 ON |
| 표시 형태 | 모달 overlay (xterm.js 위에 띄움). 정보 밀도가 높아 모달 권장 |
| 표시 항목 | structured 필드 6개(intent / decisions / files / commands / tests / pending) + trajectory 요약 |
| 편집 UX | 항목별 carry-forward 토글 + 자유 텍스트 편집 + drag-reorder(필요 시) |
| 검증 | schema validation 통과한 경우만 commit 허용 |
| 액션 | "이대로 전달" / "취소(전환 중단)" |
| 데이터 소스 | `handoff:prepare`로 받은 draft. 사용자가 떠난 사이 추가 메시지는 발생하지 않음(전환 중에는 입력창 비활성, 메인 PTY는 fromModel 그대로 보존만) |

## 10. 외부 의존 (1차 릴리즈)

| 의존 | 용도 | 비고 |
|---|---|---|
| electron | 셸 | 메이저 버전은 Phase 4 셋업 시 결정 |
| electron-builder | 패키징/사이닝/노타리 + GitHub Releases publish | [01_mvp_scope.md §1](./01_mvp_scope.md) |
| electron-updater | auto-update | Sparkle 전환은 Phase 2 |
| TypeScript | 타입 안전 | [01_mvp_scope.md §1](./01_mvp_scope.md) |
| React | UI 프레임워크 | [01_mvp_scope.md §1](./01_mvp_scope.md) |
| Vite (electron-vite) | 빌드 도구 | [01_mvp_scope.md §1](./01_mvp_scope.md) |
| **node-pty (또는 prebuilt 변종)** | **MVP 채택**. 메인 채팅 PTY spawn ([probe_results.md §4](./probe_results.md)). Node v25 prebuilt 미제공이면 `@homebridge/node-pty-prebuilt-multiarch` 같은 prebuilt fork 사용. ASAR unpack 정책 추가 ([03_desktop_framework.md §9](../research/03_desktop_framework.md)) |
| **xterm.js + 애드온** | **MVP 채택**. Renderer 측 PTY 출력 렌더. 권장 애드온: `@xterm/addon-fit` (fit), `@xterm/addon-web-links` (URL 클릭) |
| 마크다운/코드 syntax 렌더 | 채팅 입력창 미리보기 + IR 검토 모달 본문 | Phase 4 결정 |
| `sindresorhus/fix-path` 또는 자체 PATH 캡처 | macOS GUI PATH 함정 ([03_desktop_framework.md §3.2](../research/03_desktop_framework.md)) | 둘 중 택일 또는 병행 |
| JSON schema validation | IR 검증 | zod / ajv 등 — Phase 4 결정 |
| 로깅 라이브러리 | electron-log 권고 | Phase 4 결정 |

## 11. 보안 / 데이터 위치

- contextIsolation, sandbox, nodeIntegration: false 유지([03_desktop_framework.md §3.5](../research/03_desktop_framework.md)).
- preload는 화이트리스트 채널만 노출. xterm.js의 키 입력은 raw bytes 그대로 `pty:write`로 전달되므로 *Renderer가 임의로 PTY를 조작할 수 있는 표면*은 PTY 자체 보안 모델과 동일.
- **AgentBridge는 자체 권한 시스템을 만들지 않는다. GUI 권한 토글 자체가 없다.** 모델 B 채택([probe_results.md §4](./probe_results.md))으로 메인 채팅은 CLI native 인터랙티브 모드의 권한 흐름을 그대로 사용 — 도구 호출 시 CLI가 xterm.js에 다이얼로그를 그리고, 사용자가 그 안에서 직접 키 응답한다(numbered menu / Y/N / 화살표 키 등). AgentBridge는 키 입력만 PTY stdin으로 forward.
- spawn 시 권한 모드 인자는 *명시 안 함* — CLI native default 흐름 유지. 사용자가 더 강한 권한(yolo / bypass / danger-full-access)을 원하면 *각 CLI를 자기 터미널에서 직접 띄워야 한다* — AgentBridge는 그 모드를 토글로 노출하지 않는다.
- 워크스페이스 폴더 선택은 사용자에게 명시적으로 받음 (PTY cwd로 사용).
- **IR refine spawn**(헤드리스, 백그라운드)은 도구 호출 자체를 안 하지만 spawn 시 권한 인자는 명시: Claude `--permission-mode acceptEdits`, Codex `-s read-only`, Gemini `--approval-mode auto_edit` ([01_mvp_scope.md §5](./01_mvp_scope.md), [probe_results.md §2.5](./probe_results.md)).
- 사용자 데이터는 `~/Library/Application Support/AgentBridge/` 하위에만 저장. AgentBridge 외부 서버에 어떤 사용자 데이터도 송신하지 않음 ([README.md](../../README.md)).
- 모델 응답은 각 CLI가 호출하는 외부 LLM 서비스에 의존 — 사용자에게 첫 실행 가이드에서 명시.

## 12. Phase 4 구현 단계에서 결정할 항목

본 문서가 고정한 모듈 경계는 Phase 4 시작 시점부터 구속력 있다. 다음은 Phase 4 셋업/M0 단계에서 결정한다.

1. ~~UI 프레임워크(React vs Vue), 빌드 도구(Vite vs webpack)~~ ✅ React + Vite + electron-vite 확정 ([01_mvp_scope.md §1](./01_mvp_scope.md))
2. TypeScript IPC 채널 타입 단일 소스 위치(common 패키지 vs 프로젝트 루트 types)
3. ~~electron-builder vs electron-forge 선택~~ ✅ electron-builder 확정
4. Electron 메이저 버전(node-pty ABI 호환 — Node v25 prebuilt 가용성과 함께 선택)
5. node-pty 패키지 선택: `node-pty` vs `@homebridge/node-pty-prebuilt-multiarch` vs `@lydell/node-pty` (현재 Node 버전 prebuilt 가용성 기준 — probe 04에서는 prebuilt-multiarch 사용)
6. JSON schema validation 라이브러리(zod / ajv 등)
7. xterm.js 버전 + 애드온 조합 (fit / web-links / search 등)
8. IR refine 프롬프트 정확한 문구(모델별 미세 차이)
9. replay.log → 모델 응답 텍스트 추출 휴리스틱 (M2 본격 결정. M1에서 첫 시도)
10. PTY 환경 변수 (TERM, COLORTERM, LANG 등) 정확한 값
11. 마크다운 렌더링/코드 highlight 라이브러리 (입력창 미리보기 + IR 모달용)
12. 로깅 라이브러리(electron-log 등)
13. PATH 캡처 명령 정확한 형태(`/bin/zsh -ilc` vs `-lc` 등 — 환경 케이스 검증)

## 13. 미해결 — Phase 4 진행 중 발견 가능

미해결 항목을 *닫히는 시점* 기준으로 두 그룹으로 분리한다.

### 13.1 M0 capability probe — 모두 닫힘 ✅

[probe_results.md](./probe_results.md) (2026-05-09 실측). 3건 모두 닫힘.

- ✅ **I/O 모델 결정** — **모델 B (PTY + xterm.js 임베드)** 확정. 근거: probe 03(PTY 헤드리스)에서는 stream-json 일관 출력 OK 확인. probe 04(PTY 인터랙티브)에서 세 CLI 모두 풀스크린 TUI 전용이고 stream-json 동시 출력 안 됨 → "다이얼로그 텍스트 GUI 모달 중재" 형태의 모델 A 불가. 모델 C(헤드리스 + 권한 토글)는 보안/원칙(CLI 기본 기능 제한 금지) 위배. 모델 B는 다이얼로그 *파싱 없이* xterm.js raw forward만 하므로 일정 영향 +1~2주로 축소 — 본 문서는 모델 B 가정으로 재작성됨.
- ✅ **각 CLI `--resume` 명령 형태 + sessionId 키 위치** — §7.2 표 (메인은 인터랙티브 PTY, refine은 헤드리스 stream-json). 세션 키는 Claude `session_id`(우리가 사전 통제), Codex `thread_id`(spawn 후 캡처 — M1 구현), Gemini `session_id`(우리가 사전 통제, 단 `--resume`은 인덱스).
- ✅ **권한 모드 토글 노출 범위** — *권한 토글 자체가 삭제됨*(§11). 메인 채팅은 CLI native 인터랙티브 권한 흐름. refine spawn은 정해진 권한 인자 사용.

### 13.2 M1/M2 구현 중 실측으로 닫히는 항목 (구현 결정에 영향)

이 그룹은 M1/M2 구현이 실제로 spawn해보면서 닫힌다. 닫히지 않아도 M1 착수에는 지장 없음.

- IR refine을 단발 spawn으로 처리할 때 응답 시간(콜드 스타트 포함)이 사용자 체감에 어떻게 작용하는지 — 실측 후 utilityProcess 격리 또는 별도 작은 모델 호출 옵션 검토 ([02_model_integration.md §10](../research/02_model_integration.md)).
- 모델 전환 준비가 10초([02_nfr.md §3](../spec/02_nfr.md))를 자주 넘는지 — 넘으면 refine 프롬프트 축소, 진행 상태 세분화, 작은 모델 옵션(Phase 2)을 검토.
- `claude --append-system-prompt-file`이 사용자 기존 `CLAUDE.md`와 어떻게 상호작용하는지 — 인터랙티브 PTY 모드에서도 hidden flag로 동작하는지 실측 ([01_ir.md §7-8](../research/01_ir.md)).
- Codex thread_id 캡처 방법 — PTY 인터랙티브에서는 stream-json이 안 나오므로 `~/.codex/sessions/` 디렉토리 watch + 파일명 매핑이 가장 유력하나 안정성 실측 필요.
- Gemini `--list-sessions` 출력 파싱 안정성 — UUID와 인덱스 매핑이 thread 전환·앱 재시작 후에도 일관 동작하는지 실측.
- replay.log → 모델 응답 텍스트 추출 휴리스틱 정확도 — refine 입력 trajectory 품질에 영향.
- replay.log 회전(rotation) 정책 — 장기 thread 시 디스크 사용량.
- IR refine prompt를 PTY stdin write로 주입할 때(Codex/Gemini 새 세션) 모델별 응답 품질 차이 — 인터랙티브 모드에서 user prompt 채널이라 시스템 prompt 채널과 격이 다름 ([§8.4.1](#841-sentinel-헤더)).
- Codex `OPENAI_API_KEY` 환경변수 잔존 시 ChatGPT 구독이 무시되는 이슈 — §7.4 env keep-out 정책의 효과 실측 ([02_model_integration.md §4, §10](../research/02_model_integration.md)).
- xterm.js의 한국어 IME / 멀티바이트 입력 처리 안정성 (특히 채팅 입력창과 xterm.js 안 직접 입력의 동시 사용 시).
- PTY cols/rows 변경(window resize) 시 활성 CLI들이 화면을 안정적으로 redraw하는지.

---

## 14. Phase 4 M3 — Architecture Revision (post-M2)

> **⚠ HISTORICAL**: 본 §14는 M3 진입 시점의 설계 스냅샷이다. M3 N+O 정리 이후 **현행 정책은 §15**이며 §14의 일부 항목은 supersedes 됨 — 매핑은 §14.13 표 참조. 특히 *AGENTS.override.md*와 *cwd 4 파일* 언급은 폐기됨(§15.1 / §15.2). 본 섹션은 설계 변천사 보존을 위해 남겨두며, 현행 구현 기준으로 읽지 말 것.
>
> **Driver**: probe 05~08 ([probe_results.md §7~10](./probe_results.md)) + [Subspace 분석](../research/04_subspace_injection_analysis.md) + 사용자 directive 누적. M2 종료 후 single-active handoff에서 *workspace + multi-tab + hook + gemini refine* 패러다임으로 진화.

### 14.1 Revision 동기 요약

| 발견 | 결과 |
|---|---|
| 모델 A pivot 불가 (probe 05) | model B 유지 — PTY + xterm.js |
| 3 CLI 모두 hook 시스템 보유 (claude/codex/gemini) — probe 07 + Subspace 분석 + gemini docs | hook 채택 — alive 탭 mid-session freshness 가능 |
| 3 CLI 모두 *project-local hook 격리* 가능 (claude `--settings <path>` / codex `<cwd>/.codex/hooks.json` / gemini `<cwd>/.gemini/settings.json`) | 사용자 글로벌 설정 무침범 |
| Subspace `AGENTS.override.md` codex 자동 로드 검증 (probe 07) | codex inject 채널 = `<cwd>/AGENTS.override.md` (사용자 `AGENTS.md` 보존) |
| 매 턴 ambient refine은 사용자 subscription 빠른 소진 + 토큰 비용 (probe 08 + 비용 분석) | **refine 모델 = gemini 2.5 flash 헤드리스 강제** (무료 티어 1000 req/일 활용, claude/codex 토큰 0 소비) |
| 단일 active 모델 전환 시 이전 PTY kill → 사용자가 이전 대화 잃음 | **multi-tab UI** — 모델별 PTY 동시 활성 (Subspace UX 패턴) |
| 사용자 cwd에 우리 전용 디렉토리(`.agentbridge/`) 생성 X (사용자 directive) | **AgentBridge 메타데이터 = `~/Library/Application Support/AgentBridge/workspaces/<id>/`**. 사용자 cwd엔 *CLI native config 4종만* (hook 작동 위해 cwd 의무) |

### 14.2 새 데이터 위치 정책

```
~/Library/Application Support/AgentBridge/
├── gemini_quota.json                ← 일별 gemini API 카운터 (글로벌)
└── workspaces/<workspaceId>/
    ├── workspace.json                ← 메타 + compaction lock
    ├── ir.json                       ← 압축된 IR (max 3K 토큰)
    ├── turns.jsonl                   ← raw 턴 로그 (workspace 단위 단일 파일)
    ├── archive/
    │   ├── turns_<TS>.jsonl.archive  ← rotate된 raw
    │   └── compressed_<TS>.jsonl     ← compaction 이력
    ├── sessions/<sessionId>/
    │   ├── meta.json                 ← session(=탭) 메타: 모델/시작/종료
    │   └── replay.log                ← PTY raw bytes (M1 위치 그대로)
    └── settings/
        └── claude-settings.json      ← claude --settings flag로 가리킴 (hook 격리)


<사용자 워크스페이스 cwd>/             ← 사용자 지정 디렉토리 (사용자 프로젝트 또는 AgentBridge 새 디렉토리)
├── .codex/
│   └── hooks.json                    ← codex project-local hook (마커 블록 merge)
├── .gemini/
│   └── settings.json                 ← gemini project-local hook (마커 블록 merge)
├── AGENTS.override.md                ← codex inject 채널 (마커 블록 merge)
└── (사용자 파일들 — AgentBridge 무관)
```

**Cwd 침범 정책**:
- AgentBridge가 사용자 cwd에 *생성*하는 파일 = 위 4 파일 *한정*. 다른 어떤 파일도 cwd에 만들지 않음
- 4 파일 모두 *마커 블록 merge* 패턴 — 사용자 기존 콘텐츠 보존:
  ```
  <기존 사용자 콘텐츠 그대로>
  <!-- AgentBridge:start -->
  ...우리 블록...
  <!-- AgentBridge:end -->
  ```
- 워크스페이스 삭제 시 AgentBridge metadata는 자동 정리. cwd 4 파일은 *수동 정리 안내*만 (사용자가 자기 영역으로 다룰 수 있게)
- claude는 `.claude/` 생성 안 함 — `--settings <Application Support 안 경로>` flag로 우회

### 14.3 새 모듈 추가 / 변경

기존 §3 모듈 위에 추가:

| 모듈 | 위치 | 역할 |
|---|---|---|
| `WorkspaceStore` | Main | thread → *workspace + sessions[]*. workspace 단위 영속화 + multi-session lifecycle |
| `HookInstaller` | Main | 워크스페이스 cwd에 `.codex/hooks.json`, `.gemini/settings.json`, `AGENTS.override.md` 마커 블록 merge. 사용자 conflict 시 confirm |
| `AgentBridgeMemoryHelper` | Main 또는 별 binary | hook command로 호출되는 헬퍼. `<workspaceId>` 인자로 ir.json + turns.jsonl 읽어 stdout JSON 출력 (hookSpecificOutput.additionalContext) |
| `CompactionScheduler` | Main | workspace 단위 trigger 모니터링 (N=3턴 OR M=6K 토큰). background spawn refine |
| `RefineDispatcher` | Main | refine 모델 선택 (auto/gemini-flash/active/off) + 폴백 정책 (B+C). gemini flash 헤드리스 spawn → 응답 받아 *AgentBridge가 직접* ir.json atomic write |
| `TurnRecorder` | Main | chat:send + replay.log slice → turns.jsonl record append. 1줄 요약 휴리스틱 생성 |
| `GeminiQuotaTracker` | Main | 글로벌 일별 카운터. 800/950 임계 경고 + 자동 폴백 |

기존 모듈 변경:
- `ConversationStore` → `WorkspaceStore`로 진화 (thread 개념 deprecated, workspace + sessions[] 도입)
- `IRModule` → refine 입력이 *전체 trajectory*에서 *N턴 슬라이스 + 이전 IR*로 변경. inject payload 형식도 옵션 C(IR + 1줄 buffer)
- `CLIAdapter` → `spawnInteractive` 호출 시 hook config path 전달 추가 (claude `--settings`, codex `--cd <cwd>` 의존, gemini `--cwd` 의존)

### 14.4 새 데이터 흐름 — *매 사용자 메시지*

```
사용자 입력 → ChatInputBox → chat:send IPC → Main이 PTY stdin write
                                                       ↓
        CLI(claude/codex/gemini)가 prompt 처리 시작
                                                       ↓
        UserPromptSubmit hook fire (claude/codex)
        BeforeAgent hook fire (gemini)
                                                       ↓
        hook command = "agentbridge-memory inject --agent <kind> --workspace <id>"
                                                       ↓
        Helper가 Application Support 안 ir.json + turns.jsonl 마지막 N개 읽기
                                                       ↓
        stdout JSON 출력:
          { hookSpecificOutput: { additionalContext: "<IR + 1줄 buffer>" } }
                                                       ↓
        CLI host(claude/codex/gemini)가 additionalContext 읽어 모델 prompt에 prepend
                                                       ↓
        모델이 응답 생성 (사용자 첫 메시지가 *우리 컨텍스트 prepend된 형태*로 보임)
                                                       ↓
        응답 PTY로 출력 → xterm.js 렌더 → idle 1.5s 후 *turn 종료* 판정
                                                       ↓
        TurnRecorder가 chat:send에 저장된 user msg + replay.log slice의 assistant text 추출
        → turns.jsonl에 1 record append
        → 1줄 요약 휴리스틱 생성 → turns.jsonl record에 포함
                                                       ↓
        CompactionScheduler가 trigger 체크 (N≥3 OR M≥6K)
                                                       ↓
        trigger 도달 시:
          workspace.json에 compaction lock 시도 (atomic)
          background spawn: gemini-2.5-flash 헤드리스
            input: oldest N turns raw + current ir.json
            output: updated IR (JSON)
          AgentBridge가 응답 파싱 → ir.json atomic write
          archive/compressed_<TS>.jsonl로 압축된 N turns 이동
          turns.jsonl에서 그 N turns 제거 (rotate)
          lock 해제
```

### 14.5 새 데이터 흐름 — *모델 전환 (multi-tab open)*

```
사용자가 "+ Codex" 탭 추가 클릭
                                                       ↓
        WorkspaceStore.openSession({ workspaceId, model: 'codex' })
                                                       ↓
        HookInstaller가 workspace cwd 점검:
          - .codex/hooks.json 없음 또는 우리 블록 없음 → 마커 블록 merge
          - AGENTS.override.md 동일
          - .gemini/settings.json — codex 탭 추가에는 gemini 영향 없음 (skip)
                                                       ↓
        CLIAdapter.spawnInteractive({ model: 'codex', cwd: <workspace cwd> })
          → codex가 spawn하면서 .codex/hooks.json 자동 로드
          → 사용자에게 /hooks trust 게이트 표시 (수동 승인 필요)
                                                       ↓
        codex 사용자 trust 후 SessionStart hook fire
          → agentbridge-memory inject 호출
          → AgentBridge cwd의 AGENTS.override.md를 통해 *invisible* IR 주입 (codex native auto-load)
          → 추가로 hook의 additionalContext에도 IR + buffer 포함
                                                       ↓
        새 codex PTY가 IR 수신한 채로 시작
        기존 claude 탭 PTY는 *그대로 살아있음* — 사용자가 탭 클릭으로 전환 가능
```

### 14.6 IR 생성·갱신 트리거 정책

[probe_results.md §10.7](./probe_results.md) 결정 + 사용자 directive 결합:

| Trigger | 시점 | 동작 |
|---|---|---|
| **T-1** 탭 close | 사용자가 탭 닫음 | 닫히는 탭의 trajectory refine → IR 갱신 (background) |
| **T-2** 새 탭 open (다른 모델) | 새 탭 추가 직전 | 직전 active 탭의 trajectory refine → IR 갱신 → 새 탭 spawn 시 그 IR 받음 |
| **T-3** "메모리 갱신" 버튼 (UI) | 사용자 명시 액션 | 모든 active 탭 trajectory 통합 refine → IR 갱신 → IR 검토 모달 표시 (M3 J 청크 재배치) |
| **T-5** 워크스페이스 close (앱 종료) | 앱 quit | 모든 active 탭 일괄 close → 각자 refine → IR 갱신 |
| **(per-turn auto)** 매 턴 후 | turn 종료 | turns.jsonl append만. trigger 도달 시 background compaction (N=3 OR M=6K) |

### 14.7 Refine 모델 정책 (gemini-flash 강제 + 폴백)

```
설정 (사용자 명시):
  refineModel: "auto" | "gemini-flash" | "active" | "off"

기본 동작 (refineModel="auto"):
  EnvProbe에서 gemini 검출 + auth 통과
    YES → gemini-flash 헤드리스 사용 (무료 티어, AgentBridge가 응답 받아 ir.json 직접 작성)
    NO  → active model 헤드리스 폴백 + UI에 "토큰 비용 부담 중" 노란 배지
        둘 다 없음 → off (IR 비어있음, raw turns만 inject)

gemini quota 관리:
  gemini_quota.json 일별 카운터
  800회 도달 → UI 노란 경고
  950회 도달 → UI 빨간 경고 + 자동 폴백 활성
  1000회 한도 도달 → 다음 일까지 폴백
```

### 14.8 Hook 설정 디테일 — CLI별

```
=== claude ===
  spawn: claude --settings <Application Support>/workspaces/<id>/settings/claude-settings.json [기존 인자들]
  settings 파일 내용:
    {
      "hooks": {
        "SessionStart": [{ "matcher": "*", "hooks": [{
          "type": "command",
          "command": "<AgentBridge.app>/Contents/Resources/bin/agentbridge-memory inject --agent claude --workspace <id>"
        }]}],
        "UserPromptSubmit": [{ "hooks": [{
          "type": "command",
          "command": "<AgentBridge.app>/Contents/Resources/bin/agentbridge-memory inject --agent claude --workspace <id>"
        }]}]
      }
    }
  cwd 무침범

=== codex ===
  spawn: codex (cwd = workspace cwd)
  cwd/.codex/hooks.json (마커 블록 merge):
    {
      "hooks": {
        "SessionStart": [{ "matcher": "^(start|startup|clear|resume)$", "hooks": [{
          "type": "command",
          "command": "<AgentBridge.app>/Contents/Resources/bin/agentbridge-memory inject --agent codex --workspace <id>"
        }]}],
        "UserPromptSubmit": [{ "hooks": [{
          "type": "command",
          "command": "<AgentBridge.app>/Contents/Resources/bin/agentbridge-memory inject --agent codex --workspace <id>"
        }]}]
      }
    }
  cwd/.codex/config.toml (별도 또는 hooks.json와 병행) — `[features].codex_hooks = true` 활성
  cwd/AGENTS.override.md (마커 블록 merge) — codex 자체 auto-load 메커니즘 활용 (백업 inject 채널)
  사용자 trust 게이트: 첫 spawn 시 codex 안에서 `/hooks` 슬래시 명령으로 *수동 승인*. UI에 안내 표시

=== gemini ===
  spawn: gemini (cwd = workspace cwd)
  cwd/.gemini/settings.json (마커 블록 merge):
    {
      "hooks": {
        "SessionStart": [{ "matcher": "*", "hooks": [{
          "type": "command",
          "command": "<AgentBridge.app>/Contents/Resources/bin/agentbridge-memory inject --agent gemini --workspace <id>"
        }]}],
        "BeforeAgent": [{ "hooks": [{
          "type": "command",
          "command": "<AgentBridge.app>/Contents/Resources/bin/agentbridge-memory inject --agent gemini --workspace <id>"
        }]}]
      }
    }
  invisibility 한계: 인터랙티브 모드에서 additionalContext가 *first turn in history*로 들어감 — 사용자에게 별개 entry로 보일 수 있음 (현재 argv 방식보다 깔끔)
```

### 14.9 Inject payload 형식 (옵션 C)

helper binary stdout JSON:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart" | "UserPromptSubmit" | "BeforeAgent",
    "additionalContext": "<아래 markdown 본문>"
  },
  "suppressOutput": true
}
```

본문 (markdown, 약 5K 토큰 max):
```markdown
<agentbridge-context>
## 작업 요약 (IR — refined memory)
{intent.goal}

### 의도
- role: {intent.role}
- 제약: {intent.constraints[]}

### 결정 (recent 10개)
- {decision[].topic}: {decision[].choice} ({decision[].rationale})

### 파일 (recent 15개)
- [{status}] {path} — {summary}

### 명령 (recent 10개)
- `{cmd}` (exit={exitCode}) — {summary}

### 테스트 (recent 5개)
- [{status}] {name}: {failureSummary}

### 미해결 (active 5개)
- {task} (blockers: {blockers}) — next: {nextStep}

## 최근 활동 (요약 전, 1줄 buffer 3개)
- T+12s: 사용자 "X를 구현해" → claude가 src/foo.ts 수정
- T+34s: 사용자 "테스트 추가" → claude가 src/foo.test.ts 생성
- T+58s: 사용자 "버그 있어" → claude가 src/foo.ts:42 수정
</agentbridge-context>
```

### 14.10 새 IPC 채널

기존 §6 IPC 위에 추가:

| 채널 | 방향 | 용도 |
|---|---|---|
| `workspaces:list` | invoke | 모든 workspace 목록 |
| `workspaces:create` | invoke | 새 workspace 생성 (cwd 지정 + hook install) |
| `workspaces:delete` | invoke | workspace 삭제 (cwd 4 파일 cleanup 안내 모달 포함) |
| `sessions:open` | invoke | 워크스페이스 안 새 탭 (모델 선택). 직전 active 탭 trigger T-2 |
| `sessions:close` | invoke | 탭 닫기 + trigger T-1 |
| `sessions:list` | invoke | workspace 안 sessions[] 목록 |
| `memory:refresh` | invoke | T-3 — "메모리 갱신" 버튼. IR 검토 모달 띄움 |
| `memory:status` | invoke | gemini quota / 마지막 compaction 시각 / pending refine 등 |
| `hooks:trustStatus` | invoke | codex `/hooks` trust 게이트 상태 (UI에 안내용) |

기존 채널 deprecate / 변경:
- `threads:*` → `workspaces:*` + `sessions:*` 분리 (M2 H의 handoff:* 흐름은 multi-tab으로 흡수)
- `handoff:prepare/cancel/commit` → 사실상 *T-2 (새 탭 open) 흐름*으로 재배치. M2 H 청크의 코드는 재사용

### 14.11 사용자 cwd 마커 블록 merge — 정확 동작

```python
# pseudocode (실제는 TS)
def merge_marker_block(file_path, our_block, marker_start, marker_end):
    existing = read_file(file_path) if file exists else ""
    pattern = f"{marker_start}.*?{marker_end}" (DOTALL)

    if pattern matches in existing:
        # 우리 블록만 교체. 사용자 외부 콘텐츠 그대로
        new_content = re.sub(pattern, our_block, existing)
    elif existing.strip():
        # 사용자 콘텐츠 있음 — 우리 블록 append
        new_content = existing + "\n\n" + our_block
    else:
        new_content = our_block

    atomic_write(file_path, new_content)  # tmp + rename
```

JSON 파일 (`.codex/hooks.json`, `.gemini/settings.json`)도 동일 패턴이지만 *JSON 구조 인지*:
- 기존 `hooks` 객체 안 우리 entry를 `_agentbridge_managed: true` 플래그로 마킹
- 우리 entry만 식별·갱신·제거 가능
- 사용자 다른 entry 보존

### 14.12 차별점 표현 갱신

| # | 축 | 갱신된 표현 |
|---|---|---|
| 1 | 라이선스/비용 | 변경 없음 — 오픈소스 / 무료 |
| 2 | UX 패턴 | **Multi-tab 워크스페이스 + 명시적 IR handoff** — Subspace UI 패턴 차용, 차별점은 사용자 통제 |
| 3 | 사용자 통제 IR | 변경 없음 — IR 검토·편집 모달 (M3 J 청크). T-3 시점 사용 |
| 4 | Privacy / 요약 AI 출처 | **사용자 인증 CLI 안에 머무름**: 메인 작업은 claude/codex/gemini, 요약은 사용자 인증 gemini-flash 헤드리스 — 자체 백엔드/제3자 0. *별도 AgentBridge 클라우드 백엔드 없음* |
| 5 | 사용자 자산 격리 | **사용자 글로벌 설정 무침범** (`~/.codex/hooks.json`, `~/.claude/settings.json`, `~/.gemini/settings.json` 무수정). **사용자 cwd엔 CLI native config 4종만, 마커 블록 merge로 사용자 콘텐츠 보존**. AgentBridge 메타데이터는 OS 표준 위치(`~/Library/Application Support/AgentBridge/`) |

### 14.13 Superseded sections (M0~M2 → M3+ 매핑)

| §M0~M2 | §M3 → §M3 N+O 갱신 |
|---|---|
| §1 한눈에 보는 그림 | §14.4 → §15.5 hook 본문 |
| §3 모듈 경계 | §14.3 → §15.9 모듈 추가/제거 |
| §4 데이터 흐름 (handoff) | §14.4~14.6 → §15.5 (chat:send 폐기, hook 시스템 + 향후 turns.jsonl) |
| §5 영속화 | §14.2 → §15.2 (cwd 3파일, turns.jsonl 추가) |
| §6 IPC 패턴 | §14.10 → §15.8 (Threads/Handoff/ChatSend/CliSpawnInteractive 폐기) |
| §7 CLIAdapter | §14.8 → §15.2 (AGENTS.override.md 제거) |
| §8.1 IR 스키마 | §15.6 (trajectory/artifacts 제거, cap 축소) |
| §8.4 + §8.4.1 주입 페이로드 + Sentinel | **완전 폐기** (Layer 2). §15.5 hook 본문이 대체 |
| §9 IR 검토·편집 UI | T-3 시점으로 재배치 (변경 없음) |
| §11 보안/데이터 위치 | §14.2 + §14.11 → §15.2 (3파일) |
| §14.7 Refine 모델 정책 | §15.7 (quota 추적 footer 기반 재설계) |

### 14.14 미해결 — M3 구현 시 닫음

- gemini hook 실측 — `.gemini/settings.json` cwd 자동 로드 + `additionalContext` 첫 turn 표시 거동
- codex `/hooks` trust 승인 자동 안내 UI 디자인
- gemini-flash 헤드리스 spawn 응답 시간 실측 (compaction 1회 latency 추정 ~5초)
- compaction 동시성 lock 안정성 (다중 탭 동시 close 시)
- 사용자 cwd 4 파일 conflict 디테일 — 사용자가 마커 블록을 수동 제거한 경우 처리
- 워크스페이스 사용자 cwd가 git repo일 때 `.gitignore` 자동 추가? 사용자 권유 메시지만? (현재: 권유만, 자동 X)

---

## 15. M3 N+O 진입 결정 (2026-05-11 갱신)

§14에 정의된 흐름 위에 *N 청크 구현 + O 청크 진입 결정*으로 정책을 추가/교체한다. 본 섹션이 *현재 활성 정책*이며 §14의 일부 항목은 superseded 됨 (§14.13 매핑 표 참조).

### 15.1 변경 요약

| 영역 | 이전 (§14) | 현재 (§15) |
|---|---|---|
| GUI 채팅 입력창 | ChatInputBox + chat:send IPC + user.jsonl append | **폐기**. PTY xterm.js 자체 입력창 사용. chat:send IPC 제거 |
| 중지 버튼 + generating 상태 | UI 버튼 + 휴리스틱 | **폐기**. 사용자가 xterm에서 Ctrl-C 직접 입력 |
| AGENTS.override.md | codex 백업 inject 채널 (cwd) | **폐기**. hook 정상 시 잉여, 미정상 시도 첫 turn만 작용 |
| 사용자 cwd 파일 | 4개 (`.codex/hooks.json` + `.codex/config.toml` + `.gemini/settings.json` + `AGENTS.override.md`) | **3개** (AGENTS.override.md 제거) |
| Layer 2 IR sentinel + argv inject (claude `--append-system-prompt-file` / codex bracketed paste / gemini `-i`) | M2 H 흐름 | **폐기**. hook 시스템이 매 turn IR inject |
| user.jsonl 채널 | chat:send append-only | **폐기**. O 청크 turns.jsonl이 user/assistant 명시 분리 |
| Gemini quota 추적 | incrementQuota 카운터 (spawn당 ±1) | **폐기**. PTY 인터랙티브 footer `X% used` 파싱 (geminiQuotaTracker.recordQuotaPercent) |
| Background quota 캡처 | (없음) | OS tmpdir에서 gemini PTY 격리 spawn → footer 캡처 → SIGTERM. workspaces:open(10분 stale) / ir:refine 후(5분 stale) / 사용자 명시 버튼(throttle 우회) trigger |
| IR `trajectory[]` / `artifacts[]` 필드 | 스키마 포함 | **제거**. O 청크에서 turns.jsonl이 user/assistant raw 보관 |
| IR cap | decisions 10/files 15/commands 10/tests 5/pending 5 | **축소**: 5/5/3/3/3 |
| Refine 출력 토큰 cap | 미명시 | **`~800 토큰 이내` prompt에 명시** |
| Hook inject 본문 처리 규칙 | Layer 2 IR_SENTINEL_INSTRUCTIONS (legacy argv 채널 전용) | **HOOK_INSTRUCTIONS** prepend (~25 토큰 단순화) — `<agentbridge-context>` 본문 상단 |
| Refine 입력 채널 | user.jsonl + replay.log + 직전 IR | **(현재)** replay.log + 직전 IR. **(O 청크 후)** turns.jsonl 끝 3 record + 직전 IR |

### 15.2 데이터 위치 갱신 (§14.2 supersedes)

```
~/Library/Application Support/AgentBridge/
├── gemini_quota.json                ← schema 변경 (usedPercent 기반)
├── settings.json                    ← M3 N 신규 (refineModel 정책)
└── workspaces/<workspaceId>/
    ├── workspace.json                ← codexHookTrust 필드 추가
    ├── ir.json                       ← 슬림화 (trajectory/artifacts 제거)
    ├── turns.jsonl                   ← O 청크 본 구현 (TurnRecord 스키마)
    ├── archive/
    │   ├── turns_<TS>.jsonl.archive  ← rotate (5MB 또는 1000 record)
    │   └── compressed_<TS>.jsonl     ← compaction 시 처리된 turns + IR snapshot
    ├── sessions/<sessionId>/
    │   ├── meta.json
    │   └── replay.log                ← PTY raw bytes (M1 그대로)
    └── settings/
        └── claude-settings.json      ← claude --settings flag로 가리킴

<사용자 워크스페이스 cwd>/             ← 3 파일만 (AGENTS.override.md 제거)
├── .codex/
│   ├── hooks.json                    ← 마커 블록 merge (_agentbridge_managed 플래그)
│   └── config.toml                   ← [features].hooks=true (마커 블록)
└── .gemini/
    └── settings.json                 ← 마커 블록 merge
```

### 15.3 turns.jsonl 스키마 (O 청크 본 구현)

append-only NDJSON. 1 record = 1 turn.

```typescript
type TurnRecord = {
  id: string                          // uuid v4
  workspaceId: string
  sessionId: string                   // multi-tab 구분
  model: 'claude' | 'codex' | 'gemini'
  startedAt: string                   // ISO — 사용자 Enter 시점 (pty:write '\r' 감지)
  completedAt: string                 // ISO — PTY idle 1.5초 후

  user: string                        // pty:write buffer flush 정제 (paste/backspace)
  userBytes: number                   // 원본 (8K cap)

  // 모델 본문 — sliceAssistant 휴리스틱:
  //   1. ANSI strip + alt-screen 제거
  //   2. 시스템 indicator(✻/▲ + 시간 패턴) 제거
  //   3. ⏺ <ToolName>(<arg>) 박스 추출 → toolCalls[]
  //   4. 남은 본문 = assistantBody (500 chars cap, 긴 응답은 첫 400 + 마지막 100)
  assistantBody: string
  assistantBodyBytes: number

  // 도구 호출 별도 추출 — compaction 시 IR.commands/files 자연 흡수
  toolCalls: Array<{
    tool: string                      // 'Read' | 'Bash' | 'Edit' | 'Write' | 'Grep' | ...
    arg: string                       // 파일 경로 또는 명령
    summary?: string
  }>
}
```

### 15.4 Compaction 정책

```
trigger 체크 시점: 매 turn record append 직후

trigger 조건:
  uncompacted count > 3                        (≥ 4)
  OR  sum(userBytes + assistantBodyBytes) > 6_000

처리 단위:
  oldest (uncompacted_count - 3) 개
  * 최근 3개는 *항상* turns.jsonl에 raw 보존 (별도 보관소 없음)

처리 흐름:
  1. workspace.json.compactionInProgress atomic CAS lock (5분 stale 강제 해제)
  2. oldest N turns + current ir.json 로드
  3. RefineDispatcher.runRefine(buildCompactionPrompt({ turns, currentIR }))
  4. 결과 IR → ir.json atomic write (trajectory/artifacts 없는 슬림 스키마)
  5. archive/compressed_<ISO>.jsonl 에 처리된 turns + 결과 IR snapshot 기록
  6. turns.jsonl rewrite — oldest N개 제거
  7. compactionInProgress = null

실패:
  - lock 획득 실패 → skip
  - RefineDispatcher 실패 → 재시도 1회 + 5분 후 1회 + 누적
  - ir.json write 실패 → lock 해제 + 다음 trigger 재시도. turns.jsonl 그대로
  - 5분 stale lock → 강제 해제
```

### 15.5 Hook inject 본문 구조 (§14.9 supersedes)

매 사용자 메시지(claude/codex UserPromptSubmit, gemini BeforeAgent)마다 helper binary가 emit하는 `additionalContext`:

```markdown
<agentbridge-context>
AgentBridge 메모리. 자연스러운 대화 연속성으로 활용하라. 별개 산출물처럼 지칭하지 말라.

## 메모리 (압축)
{ir.json body — intent + decisions(5) + files(5) + commands(3) + tests(3) + pending(3)}

## 최근 대화 (raw, 최근 3개)         ← O 청크 진입 후 추가
[Turn N-2] user: ...
           assistant: ...
[Turn N-1] ...
[Turn N]   ...
</agentbridge-context>
```

helper binary는 `ir.json` + `turns.jsonl 마지막 3 record` 둘 다 읽음. **HOOK_INSTRUCTIONS = ~25 토큰**으로 단순화 (legacy IR_SENTINEL_INSTRUCTIONS의 처리 규칙 핵심만).

### 15.6 IR 스키마 슬림화 (§8.1 supersedes)

```typescript
type IR = {
  contextId: string                   // workspaceId
  meta: IrMeta                        // (변경 없음)
  intent: IrIntent                    // (변경 없음)
  decisions: IrDecision[]             // cap 5
  files: IrFile[]                     // cap 5
  commands: IrCommand[]               // cap 3
  tests: IrTest[]                     // cap 3
  pending: IrPending[]                // cap 3
  // trajectory[] 제거 — turns.jsonl 끝 3개 raw가 대체
  // artifacts[] 제거 — Phase 2에서 필요 시 복원
}
```

Refine prompt에 *"IR JSON은 800 토큰 이내로 작성하라. 정보 누적 시 가장 오래된 항목을 잘라내라"* 명시.

### 15.7 Gemini quota 추적 (§14.7 supersedes)

```
영속 위치: gemini_quota.json
schema: { usedPercent: number|null, lastSeenAt: ISO|null, forcedFallback: bool, forcedFallbackDate: YYYY-MM-DD|null }

severity 임계:
  unknown   : usedPercent == null (gemini 탭 미사용)
  ok        : <80%
  warn      : 80~94%
  critical  : 95~99%
  exceeded  : ≥100% 또는 forcedFallback

캡처 source:
  (A) gemini 인터랙티브 PTY data hook — footer "N% used" 정규식 자동 매칭 (geminiAdapter)
  (B) Background probe — OS tmpdir cwd로 gemini --skip-trust spawn → footer 캡처 → SIGTERM
      trigger: workspaces:open(10분 stale) / ir:refine 후(5분 stale) / 사용자 명시 버튼(throttle 우회)

폴백:
  사전: severity ≥ critical 또는 forcedFallback → active 모델로 폴백
  사후: gemini 응답에 quota 키워드(429/rate limit/quota/resource exhausted) → markForcedFallback + active 폴백
        UTC 자정 자동 해제
```

### 15.8 IPC 채널 갱신 (§14.10 supersedes)

**폐기** (M3 N/O + M3.7 dead code 정리 이후): `chat:send` / `cli:spawn-interactive` / `threads:*` / `handoff:*` / `threads:modelSessionCaptured` / `refine:test`

**현재 활성** (M3.5/M3.6/M3.7 누적, [src/shared/ipc.ts](../../src/shared/ipc.ts) 기준):
```
app:health / app:openPath / app:openExternal
env:probe
pty:start / pty:write / pty:resize / pty:kill / pty:data / pty:exit
dialog:pickWorkspace
ir:load / ir:refine / ir:updated
archive:list / archive:load / archive:delete                       ← M3.5 UI-E
turns:summary / turns:updated                                       ← M3.5 UI-E
instructions:list / instructions:create                             ← M3.5 UI-E
workspaces:list/create/open/delete/get/rename
workspaces:changed                                                  ← M3.6 멀티 윈도우 fan-out
home:submit                                                         ← M3.5 UI-home
sessions:create/open/close/list/rename
sessions:modelSessionCaptured                                       ← event
hooks:trustGet/Set                                                  ← M 청크
settings:get/set                                                    ← N 청크
quota:get/probe/updated                                             ← N 청크
attach:files                                                        ← M3.6 UI-DnD
memory:reset / memory:promoteLatestArchive                          ← M3.6 UI-Clear + M3.7 IR 휴지통
window:openWorkspace / window:getBootstrap / window:claimWorkspace / window:releaseWorkspace  ← M3.6 멀티 윈도우
```

`app:openPath` / `app:openExternal` / `archive:load` / `archive:delete` / `attach:files` / `pty:*`는 §15.16 보안 가드(IPC sender 소유권 / URL allowlist / openPath prefix / archive basename+lstat+realpath) 적용.

### 15.9 모듈 추가/변경 요약

| 모듈 | 상태 |
|---|---|
| `hookInstaller` | A1 — `installCodexAgentsOverride` 함수 + 호출 제거. cwd 3 파일만 (`.codex/hooks.json`, `.codex/config.toml`, `.gemini/settings.json`). codex `[features].hooks=true` 신키 emit, deprecated `codex_hooks`는 emit 안 함 |
| `geminiQuotaTracker` | Fix 3+4 — footer 파싱 / background probe / throttle gate |
| `RefineDispatcher` | N 청크 본 구현 — 모델 선택 + 폴백 (가용성/quota 사전/응답 사후) |
| `settings` | N 청크 — refineModel/theme/language/defaultBasePath 영속화 |
| **`TurnRecorder`** | O 청크 본 구현 — pty:write/data hook으로 turn 캡처 → turns.jsonl append |
| **`CompactionScheduler`** | O 청크 본 구현 — trigger 체크 + lock + RefineDispatcher 호출 |
| **`sliceAssistant`** (turnRecorder/sliceAssistant.ts) | O 청크 본 구현 — 모델별 본문 추출 + toolCalls 분리 휴리스틱 (v7) |
| **`buildCompactionPrompt`** (irModule/prompt.ts) | O 청크 본 구현 — turns 기반 user/assistant 명시 분리 prompt + EVIDENCE_RULES |
| **`ptyDisplayFilter`** | O 후속 fix 4 — `<agentbridge-context>` 블록 strip (codex/gemini visible 회피) |
| **`workspaceLock`** | M3.7 신규 — workspaceId 단위 비동기 mutex. workspace.json 5개 RMW 함수 직렬화 |
| **`windowManager`** | M3.6 UI-MultiWin 신규 — `windowsByWorkspace` Map + claim/release + broadcast scope |
| **`memoryHandlers`** (ipc) | M3.5 UI-E + M3.6 UI-Clear — archive list/load/delete + turns:summary + instructions list/create + memory:reset/promoteLatestArchive |
| **`attachHandlers`** (ipc) | M3.6 UI-DnD — 드래그 앤 드롭 파일 → PTY inject (bracketed paste + NFC 정규화) |
| **`windowHandlers`** (ipc) | M3.6 UI-MultiWin — window:openWorkspace / getBootstrap / claimWorkspace / releaseWorkspace |
| `conversationStore` | M3.7 정적 분석 — `ensureConversationDirs`만 보존 (legacy threads/ 디렉토리 ensure용). 새 CRUD 흐름은 모두 workspaceStore |
| (제거) `chatHandlers` / `threadsHandlers` / `handoffHandlers` / `handoffSession` / `threadActive` / `ModelSwitcher.tsx` / `ChatInputBox.tsx` / `IRReviewPanel.tsx` / `tmpIrFile` / `irModule/inject.ts` (Layer 2) / `refine:test` IPC + `RefineTestPanel.tsx` / Versions / killAll / sessionActive 일부 helpers | M3 N 후속 정리 + M3.7 정적 분석에서 dead code 9건 제거 |

### 15.10 §14 매핑 — 어디가 superseded됐나

| §14 항목 | §15 대응 |
|---|---|
| §14.2 데이터 위치 (cwd 4파일) | §15.2 (cwd 3파일, AGENTS.override.md 제거) |
| §14.4 매 사용자 메시지 흐름 (chat:send 기반) | §15.5 hook 본문 + (O 진입 후) turns.jsonl flush |
| §14.5 모델 전환 흐름 (AGENTS.override.md 언급) | AGENTS.override.md 단계 삭제. 나머지는 그대로 |
| §14.6 IR 갱신 트리거 정책 | T-1~T-5는 *후속 청크*에서 본 구현. 현재 ir:refine은 사용자 명시 trigger만 |
| §14.7 Refine 모델 정책 | §15.7 quota 추적 재설계 반영 |
| §14.8 Hook 설정 디테일 | AGENTS.override.md 항목 제거. claude-settings.json + .codex/hooks.json + .codex/config.toml + .gemini/settings.json |
| §14.9 Inject payload 형식 | §15.5 (HOOK_INSTRUCTIONS prepend + turns 본문 추가) |
| §14.10 IPC 채널 | §15.8 (Threads*/Handoff*/ChatSend/CliSpawnInteractive 폐기) |
| §8.1 IR 스키마 | §15.6 (trajectory/artifacts 제거, cap 축소) |
| §8.4 + §8.4.1 주입 페이로드 + Sentinel | **완전 폐기** (Layer 2). hook 시스템이 대체 |
| §11 보안/데이터 위치 | §15.2 cwd 3파일로 강화 + §15.16 IPC sender / URL allowlist / openPath / archive 가드 |

---

### 15.11 내장 터미널 세션 (M3.6 A)

**도입 배경**: 사용자가 CLI 환경 점검(`which claude` / `node -v` / `.codex/hooks.json` 확인 등)이나 잡일을 위해 별도 터미널 앱으로 가는 번거로움 제거. AgentBridge 안에 일반 zsh PTY 탭을 둠.

**키 결정**:
- `SessionMeta.kind: 'cli' | 'shell'` 필드 신설 (optional, 누락 시 cli 폴백). cli는 어댑터 dispatch + hook 흐름, shell은 zsh 직접 spawn
- shell은 다음을 모두 **bypass**: hookInstaller / TurnRecorder / DisplayFilter / Quota tracker / 어댑터 인터페이스. sessionActive 등록은 함 (workspace activeSessionCount + before-quit killAllForce 대상)
- spawn: `process.env.SHELL || /bin/zsh -l` (login shell — 사용자 `.zprofile`/`.zshrc` 로드)
- 좌 사이드바 + SessionTabs add 메뉴에 "터미널" 옵션, dot 자리 TerminalIcon
- 우 사이드바: shell 활성 시 IrPanel 자리에 "메모리 없음 — 일반 터미널 세션" 안내(IR 무관)
- 세션 close 분기 — shell은 cli의 "빈 세션 자동 정리" 규칙 미적용. native 흔적 없음 → permanent=true(사용자 명시 휴지통)만 hard delete
- compactionScheduler.pickActiveModel — cli 우선 (shell은 어댑터 없음)

### 15.12 드래그 앤 드롭 첨부 (M3.6 B)

**키 결정**:
- `AttachFilesRequest/Result` IPC + `attachHandlers.ts` 신설. renderer는 `webUtils.getPathForFile(Electron 32+)`로 절대 경로 추출
- cli inject = **bracketed paste** (`\x1b[200~ ... \x1b[201~`) + `"@<절대경로>"` 공백 분리. bracketed paste 모드 = TUI가 "paste 중"으로 인식 → codex/gemini의 자동 submit 차단. 양쪽 큰따옴표 = 공백 포함 경로 단일 토큰 보장
- shell inject = zsh quote-if-needed 공백 분리. `\n` 없음(shell에선 명령 실행)
- 디렉토리 거부(첫 cut), 한 번에 최대 20개
- **NFC 정규화** — macOS 파일시스템이 한글 등 결합 자모를 NFD로 저장. `webUtils.getPathForFile`가 NFD 그대로 반환 → Gemini Ink readline이 결합 못 해 초성만 표시. PTY 송신 직전 `.normalize('NFC')` 적용. `fs.stat` 검증은 NFD 원본으로 통과 후 송신만 NFC. APFS는 unicode-normalization-insensitive라 모델이 NFC 경로로 다시 fs.open 해도 inode 매칭 OK
- **Shift+Enter → `\x1b\r` 매핑** (Option+Enter 동등) — preventDefault + stopPropagation 필수로 textarea 기본 `\r` 누출 차단
- XtermView dragenter counter 패턴 + drop zone overlay + `dropping` race 가드 + 에러 토스트

**경로 정책 (M3.7 D-5에서 옵션 C 확정)**: cwd 안/밖 무차별 허용. 근거 — 드롭 의도 명시 + 자동 submit 차단 이중 가드 + 정상 UX 보존(데스크탑 스크린샷 첨부 등) + 모달 비용 효용. allowlist 가드는 두지 않음.

### 15.13 멀티 윈도우 + claim/release + broadcast scope (M3.6 C)

**키 결정**:
- `windowManager.ts` 신설 — `windowsByWorkspace: Map<wid, BrowserWindow>` + `homeWindows: Set<BrowserWindow>` + `closingWindows: WeakSet`
- **한 워크스페이스 = 한 윈도우 정책 엄격** — 모든 ws 진입 경로(좌 사이드바 클릭 / 새 워크스페이스 생성 / 세션 추가 / 홈 제출 / 부팅 bootstrap)가 `window:claimWorkspace` IPC 통과. 결과 `'claimed' | 'already-mine' | 'focused-other'`. `focused-other`면 main이 그 윈도우 focus + sender는 attach skip
- `handleGoHome`은 `window:releaseWorkspace`로 자기 윈도우를 home 상태로 되돌림
- IPC 4종 신설 — `window:openWorkspace` / `window:getBootstrap` / `window:claimWorkspace` / `window:releaseWorkspace`
- ⌘N = 새 빈 홈 윈도우 (macOS 메뉴바 accelerator). macOS dock 우클릭 메뉴 = 활성 윈도우 list

**Broadcast scope 매트릭스**:

| 채널 | scope | 근거 |
|---|---|---|
| `ir:updated` / `turns:updated` | `sendToWorkspaceWindow(wid, ...)` | workspaceId 매칭 윈도우만. 다른 ws 윈도우에 노이즈 X |
| `quota:updated` | `broadcastToAll(...)` | quota는 앱 단위 글로벌 — 모든 윈도우 footer/refine 정책 영향 |
| `workspaces:changed` | `broadcastToAll(...)` | 모든 윈도우 좌 사이드바 list 동기. `removedWorkspaceId` 채워지면 hard delete cascade |
| `sessions:modelSessionCaptured` / `pty:data` / `pty:exit` | sender 한정 | 중복 열림 불허로 sender == 그 ws 유일 윈도우 |

**Cascade**:
- 워크스페이스 hard delete → `closeWindowByWorkspaceId(wid)` + `workspaces:changed(removedWorkspaceId)` 전역 broadcast
- 단일 윈도우에서 ws 삭제 시 → close 대신 home reassign(앱이 사라진 듯한 경험 회피, 마지막 윈도우 가드)
- 다중 윈도우에서 ws 삭제 시 → 즉시 close + `closingWindows: WeakSet` 마커로 그 윈도우엔 후속 broadcast skip(home 전환 한 프레임 깜빡임 회피)
- 윈도우 closed → 그 ws 활성 PTY graceful `killPtyAsync` + `clearActiveSession`

**좌 사이드바 우클릭 컨텍스트 메뉴** (4 항목): 열기 / 새 창으로 열기 / 이름 수정 / 삭제. 워크스페이스 row 액션은 `+` / `🗑`만 노출(펜·새 창 버튼은 컨텍스트 메뉴로 이동).

### 15.14 메모리 초기화 정책 (M3.6 D)

**키 결정**:
- `memory:reset { workspaceId, alsoTurns }` IPC + `handleMemoryReset` handler
- `ir.json`을 `'{}'` atomic write (`loadWorkspaceIR`이 빈 IR로 인식)
- `alsoTurns=true` 옵션 시 `turns.jsonl`도 빈 파일로 rewrite
- **archive 디렉토리는 보존** — 스냅샷 정리는 별개 액션(§15.19)
- `broadcastIrUpdated({source:'manual'})` + 옵션 `broadcastTurnsUpdated` → IrPanel 즉시 갱신
- IrPanel 메모리 그룹 헤더에 ⓘ 안내 툴팁 + 수동 정제 + 메모리 초기화 3 버튼. 메모리 초기화는 `MemoryResetConfirm` 모달(alsoTurns 체크박스 + Esc close)

### 15.15 앱 종료 force kill 정책 (M3.6 hang fix)

**문제**: login shell(`zsh -l`) 일부 자식이 SIGTERM 무시 → stdio pipe 미해제 → main process hang → 사용자 시점에서 "앱 종료 무한 로딩 spinner".

**해결**:
- `killAllForce()` 신설 — 모든 PTY에 즉시 SIGKILL + replayStream destroy. grace 생략
- `before-quit` 핸들러에 `isQuitting` 가드 + `killAllForce()` 호출 + **1.5초 hard exit timeout** (`process.exit(0)`). 자식이 살아도 OS가 부모 종료 시 정리
- lifecycle 단계 종료(`killPty` / `killPtyAsync`)는 기존 SIGTERM grace 1초 → SIGKILL 정책 유지. before-quit만 즉시 force

### 15.16 보안 가드 — IPC sender / 외부 URL / openPath / archive (M3.7 D-1~D-5)

3 LLM 위임 검증(claude/codex/gemini) 보고서를 통합해 IPC 표면적 강화. attach:files cwd 정책은 옵션 C 확정.

**IPC sender 소유권 가드** (D-2):
- `pty:write/resize/kill` + `attach:files` 핸들러는 sender 윈도우의 claim 워크스페이스와 세션 owner 워크스페이스가 일치할 때만 실행
- 헬퍼: `findActiveSessionByPty(ptySessionId)` (sessionActive 역인덱스) + `getWorkspaceIdByWindow(BrowserWindow)` (windowManager)
- 한 워크스페이스 = 한 윈도우 정책상 sender 윈도우 → workspaceId 매핑 unique. 불일치 시 silent drop + warn log
- renderer 변조 시에도 다른 워크스페이스 PTY에 write/kill 또는 attach 불가

**외부 URL allowlist** (D-3):
- `isAllowedExternalUrl(url)` 헬퍼 — `https:` + hostname `github.com` 만 허용
- `app:openExternal` IPC + `setWindowOpenHandler` 양쪽 적용. renderer 변조 시에도 임의 외부 도메인 reveal 차단

**openPath prefix 가드** (D-4):
- `app:openPath`는 `app.getPath('userData')` 하위 또는 등록된 워크스페이스 cwd 하위만 허용
- 미일치 시 silent drop. 호출처 예: `health.userDataDir` reveal, instruction 파일(`AGENTS.md`/`CLAUDE.md`/`GEMINI.md`) 열기

**archive 파일 안전 가드** (D-1):
- `archive:load` / `archive:delete`(§15.19) 양쪽에 3중 검증:
  1. basename pattern — `compressed_*.jsonl`만 허용
  2. `fs.lstat` — symlink 즉시 거부 (archiveDir 안 symlink가 외부 파일 가리키는 우회 차단)
  3. `fs.realpath` 비교 — realpath 후 `archiveDir + path.sep` prefix 일치 확인

**attach:files cwd 정책** (D-5, 옵션 C 확정):
- cwd 안/밖 무차별 절대 경로 허용. allowlist 가드 없음
- 근거: 드롭 의도 명시 + 자동 submit 차단 이중 가드 + 정상 UX 보존 + 모달 비용 효용

### 15.17 workspace.json 동시성 lock (M3.7 race 보호)

**문제**: `addSessionToWorkspace` / `updateSessionMeta` / `updateWorkspaceMeta` / `deleteSession` / `touchWorkspace` 모두 lock 없는 read-modify-write 패턴. 동시 호출 시 lost-update 발생.

**대표 race**:
```
T=10.10s  codex onModelSessionIdCaptured → updateSessionMeta(modelSessionId='abc')
          loadWorkspace 사본 v1 = [claude, codex(null)]
T=10.11s  사용자 + gemini 탭 → addSessionToWorkspace
          loadWorkspace 사본 v1 = [claude, codex(null)] (같은 스냅샷)
T=10.12s  updateSessionMeta writeAtomic([codex(id='abc')]) 완료
T=10.15s  addSessionToWorkspace writeAtomic([codex(id=null), gemini])
          → codex.modelSessionId 손실
T=다음 재시작:
          codex.modelSessionId=null → isNewSession 분기 → 새 codex spawn
          → 이전 native jsonl과 끊김 → "채팅 사라짐" 인상
```

**해결** — `src/main/modules/workspaceLock.ts`:
- `withWorkspaceLock<T>(workspaceId, fn): Promise<T>` — workspaceId 단위 비동기 mutex (Promise tail chain)
- 같은 workspaceId의 read-modify-write가 직렬화. 다른 workspaceId끼리는 병렬 OK
- in-process lock (AgentBridge가 workspace.json 유일 writer라 fcntl/flock 불필요)
- `workspaceStore` 5개 함수 `addSessionToWorkspace` / `updateSessionMeta` / `updateWorkspaceMeta` / `deleteSession` / `touchWorkspace`를 lock으로 감쌈
- `saveWorkspaceIRAtomic`은 ir.json만 만지므로 lock 미적용

### 15.18 archive 스냅샷 + IR 카드 개별 삭제 (M3.7 B-2)

**키 결정**:
- 새 IPC `archive:delete { workspaceId, archivePath }` — §15.16의 archive 안전 가드(basename + lstat + realpath) 통과 후 `fs.unlink`
- 메모리 패널 IrPanel의 두 카드에 우상단 휴지통 추가:
  - **CurrentIrCard** — `memory:reset({alsoTurns: false})` 단축 호출. 현재 IR만 1-click 비우기(archive · turns 보존). 기존 메모리 초기화 모달의 단축형
  - **ArchiveCard** — 개별 스냅샷 파일 삭제 + 목록 갱신
- 카드 본체가 `<button>`이므로 nested `<button>` 회피: `<div className="mem-card-wrap">` wrapper + 휴지통 absolute + `stopPropagation`
- 확인: `window.confirm` (워크스페이스 cwd cleanup 모달과 톤 통일)
- CSS — 휴지통은 평소 `opacity: 0`, hover 또는 focus 시 표시. hover 시 danger 톤(`mem-reset-btn`과 동일 `#ffb4b4`)

### 15.19 dev 모드 앱 이름·아이콘 patch (M3.7 B-1)

**문제**: macOS dock 라벨 / 메뉴바 첫 항목 / cmd-tab은 `Electron.app/Contents/Info.plist`의 `CFBundleName` + `CFBundleDisplayName`을 우선. main 코드의 `app.setName('AgentBridge')`는 메뉴바·About 다이얼로그·시스템 알림은 잡지만 dock 라벨은 못 잡음(macOS가 plist 캐시).

**해결** — `scripts/patch-electron-name.cjs`:
1. `node_modules/electron/dist/Electron.app` → `AgentBridge.app` **rename** (같은 경로 .app은 LaunchServices가 stale 캐시 유지할 수 있어 경로 자체를 바꾸는 게 가장 확실)
2. Info.plist `CFBundleName` + `CFBundleDisplayName` = `AgentBridge` (PlistBuddy)
3. `node_modules/electron/path.txt` → `AgentBridge.app/Contents/MacOS/Electron`
4. `build/icon.icns` → `AgentBridge.app/Contents/Resources/electron.icns` 복사 (dev 모드 dock/메뉴바 아이콘 동기화)
5. `lsregister -f` + `utimes`로 LaunchServices 명시 invalidate

**자동화**: `package.json` postinstall chain — `electron-builder install-app-deps && node scripts/patch-electron-name.cjs`. 매 `npm install` 후 자동 적용.

**경계**:
- dev 전용. production build(`npm run build:mac`)는 electron-builder가 `productName` + `build/icon.icns`로 별도 plist 생성 → 패치 불필요
- `CFBundleExecutable=Electron`은 그대로 유지 (실제 바이너리 이름. 바꾸면 실행 깨짐)
- iCloud Drive 동기 디렉토리에서 .app rename은 동기 충돌 가능성 있으나 1회성 + node_modules는 gitignore 영역이라 영향 작음

### 15.20 PTY display filter — `<agentbridge-context>` 블록 strip (M3 O 후속, 2026-05-11)

**도입 배경**: codex 0.130+ / gemini는 hook의 `additionalContext`를 TUI에 *visible developer message*로 렌더링한다(openai/codex#15497, #16933). `suppressOutput: true`는 no-op. 따라서 helper binary가 emit한 IR 본문이 사용자 시각에 그대로 노출되는 노이즈가 발생.

**해결** — `src/main/modules/ptyDisplayFilter.ts`:

- PTY → renderer / TurnRecorder 경로의 출력 stream에서 `<agentbridge-context>…</agentbridge-context>` 블록을 strip하고 `[hook context hidden]` marker로 치환
- **replay.log엔 raw 보존** — 포렌식/디버그용. 사용자 시각 노이즈만 제거하고 디스크 원본은 보존
- 모델 입력엔 무영향 — codex가 내부 채널로 `additionalContext`를 이미 받은 뒤, TUI 표시 단계에서만 우리가 가림. 모델은 정상 작동
- claude는 TUI에 hook output 표시 안 함 → 필터 적용해도 no-op (안전)

**State machine** (ptySessionId 단위):
- `'pass-through'` — open tag 검색. 발견 시 emit-before + `'in-block'` 전환
- `'in-block'` — close tag 검색. 발견 시 buffer 폐기 + `'pass-through'` 복귀
- chunk 경계: pass-through에서 끝 `(OPEN_TAG.length - 1)` bytes는 partial match 가능성으로 보류. in-block에서도 동일 정책 (CLOSE_TAG 기준)

**Lifecycle**:
- `registerDisplayFilter(ptySessionId)` — workspacesHandlers의 cli 세션 spawn 직후 등록
- `unregisterDisplayFilter(ptySessionId)` — `onExit` 콜백에서 해제
- shell 세션은 등록 안 함 (§15.11 — hook 시스템 자체 bypass)
