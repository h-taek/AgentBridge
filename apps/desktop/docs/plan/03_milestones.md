# 마일스톤

> Phase 3 — Plan / 문서 3: 1차 릴리즈까지의 단계별 마일스톤

[01_mvp_scope.md](./01_mvp_scope.md)에서 정의한 1차 릴리즈를 [02_architecture.md](./02_architecture.md)의 모듈 경계에 맞춰 5개 마일스톤(M0~M4)으로 쪼갠다. 각 마일스톤은 **데모 가능한 단일 사용자 플로우**가 끝나는 지점에서 끊는다.

> **Phase 4 M0 capability probe([probe_results.md](./probe_results.md)) 결과로 I/O 모델은 *모델 B (PTY + xterm.js 임베드)* 확정.** M1~M3 산출물은 PTY 인터랙티브 + xterm.js 임베드 가정으로 작성됨.

## 1. 일정 가정 / 단위

- 1인 개발, 부업 페이스(주 10~15시간 가용 가정).
- 일정값은 **추정 범위**. 첫 마일스톤(M0/M1) 실측 후 M2~M4 조정.
- 주(週) 단위 표기. 예: "2~3주"는 부업 페이스 기준 ~20~45시간 작업량.
- 일정에 노타리 첫 회 8~12시간 대기, Apple Developer 가입 처리 시간(영업일 기준 1~2일) 포함.

## 2. 마일스톤 요약

| 마일스톤 | 한 줄 정의 | 추정 기간 | 데모 시나리오 |
|---|---|---|---|
| M0. 셋업 | Electron + electron-vite + React + TS 셋업 + IPC 골격 + capability probe 4종 완료 | 2~3주 | "앱 실행 → 빈 창 → 헬스체크 결과 표시 + probe 결과 보고서" |
| M1. 단일 모델 PTY 채팅 (Claude only) | Claude 한 모델로 PTY+xterm.js 인터랙티브 채팅 + thread 영속화(replay.log) | 3~4주 | "Claude PTY로 메시지 → xterm.js에 응답·다이얼로그 표시 → 사용자가 다이얼로그 응답 → thread 재진입 시 replay" |
| M2. 3 모델 + 자동 IR 핸드오프 | Codex/Gemini PTY 어댑터 추가, 모델 전환 시 IR refine(별도 헤드리스 spawn) + 새 PTY spawn(IR 주입). 검토 UI 없이 자동 | 3~4주 | "Claude로 5턴 → Codex 전환 → 새 PTY가 맥락 인지 응답" |
| M3. **Workspace + Multi-tab + Hook + Gemini Refine** (재정의 2026-05-11 — §6) | 한 workspace 안 multi-tab + per-message hook inject + gemini-flash refine + Turn/Compaction (O 청크) | 4~6주 | "claude/codex 탭 동시 활성 → 매 메시지마다 hook이 IR 주입 → background compaction이 IR 자동 갱신" |
| M3.5. UI 재설계 | Liquid Glass shell + Subspace 톤 + floating 사이드바 + 홈 화면 + 설정/rename UX + 메모리 관리 패널 | 1~2주 | "TitleBar + LeftSidebar(워크스페이스 트리) + xterm-host-stack + 메모리 패널 + 홈 화면 동작" |
| M3.6. 잔여 기능 | 내장 터미널 세션 / 드래그 앤 드롭 첨부 / 멀티 윈도우 / `/clear` + 메모리 초기화 / 앱 종료 hang fix | 2~3주 | "shell 탭 / 파일 드롭 / ⌘N으로 새 윈도우 / 메모리 초기화 모달" |
| M3.7. 코드 검증 | tsc strict / eslint 0 / 의존성 audit / 보안 가드(D-1~D-5) / workspace.json race lock / IR 휴지통 / 앱 라벨 patch | 1~2주 | "정적 분석 통과 + 보안 가드 적용 + workspace.json 동시성 race 해소" |
| M4. 문서 고도화·베타·정식 노타리 | LICENSE/README/CHANGELOG + 베타 빌드(ad-hoc 서명) + GitHub Releases v0.0.1 + Apple Developer 인증서 → 정식 노타리 → v0.0.2(또는 v0.1.0) | 2~3주 | "v0.0.1 베타 다운 → 우클릭 열기 → 회귀 검증 → 정식 노타리 후 v0.0.2 자동 업데이트" |

총 추정 **14~20주** (부업 페이스, M3 재정의 후). 1인 풀타임이면 절반 수준(추정).

이전 추정(12~17주) 대비 **+2~3주**는 M3 재정의 영향 (Phase 4 진입 후 probe 05~08 + Subspace 분석 결과로 workspace + multi-tab + hook system + gemini refine까지 흡수). 차별점 3 본 기능(IR 검토 모달)은 *T-3 trigger 위치*로 재배치되며, 추가로 alive 탭 mid-session freshness 확보.

## 3. M0 — 셋업

### 3.1 목표

Electron + Node 기반의 빈 앱이 실행되고, [02_architecture.md §3](./02_architecture.md)에서 정의한 모듈 경계와 IPC 골격이 자리 잡는다. **capability probe 4종은 이미 완료**([probe_results.md](./probe_results.md)) — M0 본 셋업은 그 결과 기반으로 진행.

### 3.2 산출물

#### 완료 ✅ (capability probe)

- ✅ probe 01 (`--resume + headless`) — sessionId 키 위치 + 명령 형태 확정
- ✅ probe 02 (권한 모드 — 헤드리스) — 모델 B 채택으로 메인 흐름엔 토글 없음. refine spawn에만 적용
- ✅ probe 03 (PTY 헤드리스 호환성) — 세 CLI PTY 환경에서 stream-json 일관 출력 확인
- ✅ probe 04 (인터랙티브 PTY + 승인 다이얼로그) — 세 CLI 모두 풀스크린 TUI 전용. 모델 A 불가, 모델 B 채택

#### 진행할 항목 (M0 본 셋업)

- [ ] 프로젝트 초기화 ([electron-vite](https://electron-vite.org/) 템플릿 + React + TypeScript)
- [ ] electron-builder 셋업 + 기본 빌드 동작 ([01_mvp_scope.md §1](./01_mvp_scope.md), [03_desktop_framework.md §8.2](../research/03_desktop_framework.md))
- [ ] Main / preload / Renderer 분리. contextIsolation/sandbox/nodeIntegration 정책 적용 ([02_architecture.md §11](./02_architecture.md))
- [ ] IPC 채널 타입 정의 단일 소스 위치 결정 + 첫 핸들러 1개 동작 (`app:health`)
- [ ] `EnvProbe` 모듈 — `/bin/zsh -ilc 'echo -n $PATH'`로 PATH 캡처 + `claude/codex/gemini --version` 감지
- [ ] `AppLifecycle` — 단일 BrowserWindow 생성, 메뉴 기본
- [ ] `ConversationStore` 디렉토리 스캐폴드 (`~/Library/Application Support/AgentBridge/`) ([02_architecture.md §5](./02_architecture.md))
- [ ] React 부트스트랩 — 라우터/상태관리 결정 (zustand vs jotai 등 — 본 마일스톤에서 결정)
- [ ] **node-pty 패키지 선택** — `node-pty` vs `@homebridge/node-pty-prebuilt-multiarch` vs `@lydell/node-pty`. 현재 Electron Node 버전의 prebuilt 가용성 기준. probe 04에서는 prebuilt-multiarch 사용 — 그대로 채택 가능
- [ ] **xterm.js 의존 설치** — `@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-web-links` (선택)
- [ ] PTY 스모크 테스트 — Main에서 `bash --login -c 'echo hello'` 같은 단순 명령을 PTY로 spawn해 Renderer XtermView에 출력. IPC `pty:data` / `pty:write` / `pty:resize` 골격 동작
- [ ] 기본 로깅 라이브러리 (electron-log 권고)

### 3.3 완료 정의

- 앱을 빌드하고 실행하면 단일 빈 창이 뜬다.
- 첫 화면에 EnvProbe 결과(세 CLI 감지 결과)가 표시된다.
- IPC `app:health` 호출이 Renderer→Main→Renderer 왕복으로 동작한다.
- 미사이닝 빌드라도 macOS에서 우클릭→열기로 실행 가능하다.
- xterm.js 컴포넌트가 dummy PTY(예: `bash`) 출력을 정상 표시하고 키 입력을 PTY로 forward한다.

### 3.4 위험 / 결정 항목

- ✅ **셋업 5종 결정** (Phase 4 진입 시점):
  - 패키저: **electron-builder** (GitHub Releases publish + auto-update 빌트인)
  - UI 프레임워크: **React** (마크다운/코드 highlight 라이브러리 풀)
  - 빌드 도구: **Vite** (`electron-vite` 템플릿 사용)
  - 언어: **TypeScript** (IPC 타입 단일 소스)
  - LICENSE: **MIT**
- ✅ **capability probe 4종 완료** — [probe_results.md](./probe_results.md). I/O 모델 = **모델 B (PTY + xterm.js)** 확정. 일정 영향 +1~2주
- **node-pty prebuilt 가용성** — 사용 중인 Electron 메이저 버전과 ABI 호환되는 prebuilt가 있는지 확인. 없으면 다른 fork(`@homebridge/...`, `@lydell/...`) 시도 또는 native rebuild 환경 셋업
- **PATH 캡처 명령 형태** — 환경별 케이스 검증 필요 ([02_architecture.md §12](./02_architecture.md))
- **ASAR unpack 정책** — node-pty native binary는 ASAR 안에서 동작 안 함. `electron-builder` 설정에 `asarUnpack` 패턴 추가 ([03_desktop_framework.md §9](../research/03_desktop_framework.md))

## 4. M1 — 단일 모델 PTY 채팅 (Claude only)

### 4.1 목표

Claude 단일 모델로 PTY 인터랙티브 채팅 end-to-end를 검증한다. 이 단계에서 PTY lifecycle / xterm.js 임베드 / replay.log 영속화 / GUI 입력창 ↔ PTY stdin 통합의 핵심 기술을 모두 다룬다. Codex/Gemini는 어댑터 인터페이스가 같으므로 M1이 통과하면 M2는 모델별 매핑 + IR refine 추가로 줄어든다.

### 4.2 산출물

- [ ] `CLIAdapter` 추상 인터페이스 정의 + Claude 어댑터 구현 — `spawnInteractive` / `write` / `resize` / `killInteractive` ([02_architecture.md §7.1](./02_architecture.md))
- [ ] Claude PTY spawn — 두 분기
  - 새 세션: `claude --session-id <UUID> --append-system-prompt-file <tmpIR>` (모델 전환 직후. M1에서는 IR 없이 단순 `claude --session-id <UUID>`로 시작 가능)
  - 이어가기: `claude --resume <UUID>` (thread 재진입 시)
- [ ] 환경변수 화이트리스트 + 사용자 shell env 상속 + CLI 절대경로 + PTY 환경(TERM=xterm-256color, COLORTERM=truecolor)
- [ ] `ConversationStore` — 스레드 메타(activeModel + `sessions: { claude }`) + `<contextId>.user.jsonl` (사용자 메시지) + `<contextId>.replay.log` (PTY raw bytes) + `<contextId>.ir.json` (M1에서는 빈 IR placeholder) ([02_architecture.md §5](./02_architecture.md))
- [ ] **PTY lifecycle** — thread 활성화 시 spawn, thread 종료/모델 전환/앱 종료 시 SIGTERM(grace 1초) → SIGKILL ([02_architecture.md §7.4](./02_architecture.md))
- [ ] **응답 중지 처리** — 사용자가 GUI "중지" 버튼 클릭 또는 xterm.js에서 직접 Ctrl-C → PTY stdin으로 `\x03` write. CLI native 인터럽트 동작 그대로 노출(별도 라벨 없음)
- [ ] **Claude 임시 IR 파일 lifecycle** — `os.tmpdir()` 하위 생성 + spawn 후 즉시 삭제 + 다음 spawn 직전 prefix 매칭 잔존 정리 ([02_architecture.md §7.4](./02_architecture.md)). M1에서는 IR이 비어있어 사실상 빈 파일이지만 lifecycle 검증
- [ ] **env keep-out** — spawn env에 `OPENAI_API_KEY` / `GEMINI_SYSTEM_MD`를 *AgentBridge가 추가하지 않음*. 사용자 shell에 이미 export된 경우에만 통과 ([02_architecture.md §7.4](./02_architecture.md))
- [ ] IPC `chat:send` (입력창 → PTY stdin) / `pty:write` (xterm 키 입력) / `pty:resize` / `pty:data` (PTY → xterm 출력) / `pty:exit` / `threads:open` / `threads:create` / `threads:close`
- [ ] **replay.log → xterm.js replay** — thread 재진입 시 replay.log를 stream으로 xterm.write에 흘려 화면 복원
- [ ] **xterm.js 통합** — `@xterm/xterm` + fit add-on. cols/rows 변경 시 PTY resize. raw bytes 단방향 forward. 입력은 onData → `pty:write`
- [ ] **채팅 입력창** — Enter 시 텍스트를 `chat:send`로 송신, 줄바꿈은 Shift+Enter. user.jsonl에 사용자 메시지 append. PTY에는 텍스트 + `\r` write
- [ ] Renderer `ThreadList` — 스레드 목록 / 새 스레드 / 이어서 진행
- [ ] Renderer `FirstRunGuide` — CLI 미설치/미인증 시 안내 + CLI 절대경로 직접 입력 fallback + **사용자 메모리 파일 자동 로드 안내**(cwd/홈의 `AGENTS.md` / `GEMINI.md` / `CLAUDE.md`가 각 CLI에 의해 자동 로드되어 IR과 함께 작동함을 명시)
- [ ] Renderer `Settings` — 워크스페이스 폴더 선택

### 4.3 완료 정의

- 사용자가 워크스페이스 폴더를 선택하고 Claude PTY를 띄울 수 있다.
- xterm.js에 Claude 인터랙티브 TUI(workspace trust 다이얼로그 → 메인 prompt input box)가 정상 표시된다.
- 사용자가 GUI 입력창에 메시지를 입력하면 PTY로 전달되고 응답이 xterm.js에 표시된다.
- 도구 호출 시 Claude native 다이얼로그가 xterm.js에 뜨고 사용자가 그 안에서 Y/N 또는 numbered menu로 응답할 수 있다.
- 응답 중 Ctrl-C 또는 GUI 중지 버튼으로 인터럽트할 수 있다.
- 앱을 재실행해도 이전 스레드를 열어 이어서 진행할 수 있다 (replay.log로 화면 복원 + `--resume`으로 컨텍스트 보존).

### 4.4 위험 / 결정 항목

- **`claude --session-id` + `--append-system-prompt-file` 인터랙티브 PTY 호환성** — probe 04는 인터랙티브 모드에서 trust dialog만 확인. `--append-system-prompt-file`이 인터랙티브 spawn에서도 hidden flag로 동작하는지 M1 초반 실측 ([02_architecture.md §13.2](./02_architecture.md))
- **xterm.js 한국어 IME 처리** — GUI 입력창과 xterm.js 직접 입력 두 경로의 IME 충돌. M1 초반 시나리오 검증
- **replay.log → xterm.js 화면 복원** — ANSI escape 시퀀스가 시간순으로 그대로 흘러도 xterm.js가 정상 화면을 그려주는지 (특히 alt-screen 진입/탈출, cursor positioning 시퀀스). 일부 시퀀스는 *상태 의존*이라 부분 replay 시 깨질 수 있음 — M1에서 단순 append-only로 시작, 깨지면 M2에서 휴리스틱 보강
- **PTY cols/rows 변경 시 redraw 안정성** — window resize 시 CLI가 화면을 안정적으로 redraw하는지
- **첫 spawn 시 trust 다이얼로그 자동 처리 여부** — 첫 thread는 사용자가 직접 trust 응답. AgentBridge가 자동 응답하지 않음(원칙: CLI 기능 제한 금지). 단 trust 응답 후 메인 prompt까지 도달했음을 감지해 IR 주입 시점을 결정 — 휴리스틱(M2 결정)
- **Node 기반 CLI 콜드 스타트** — PTY long-lived spawn이라 매 메시지 spawn 부담은 없음. thread 활성화 시 1회만 발생. 첫 스타트가 너무 느리면 EnvProbe 단계에서 미리 워밍 검토(Phase 2)
- **마크다운/코드 highlight 라이브러리** — 입력창 미리보기 + IR 검토 모달용. Phase 4에서 결정

## 5. M2 — 3 모델 + 자동 IR 핸드오프

### 5.1 목표

Codex / Gemini PTY 어댑터를 추가하고, 모델 전환 시 IR이 자동으로 정제·주입되도록 한다. **이 단계의 IR 핸드오프는 사용자 검토 UI 없이 자동 동작**한다(M3에서 검토 UI 추가). 이렇게 분리하는 이유: 자동 정제 품질을 먼저 검증하고 그 위에 검토 UI를 올린다.

### 5.2 산출물

- [ ] **Codex 어댑터** —
  - 새 세션: `codex` (workspace trust 다이얼로그 첫 화면 → 사용자 응답 후 메인 prompt input box) + spawn 직후 IR 본문을 PTY stdin write (단 trust 응답이 끝난 후 — 휴리스틱으로 메인 prompt 도달 감지)
  - 이어가기: `codex resume <thread_id>` 또는 `codex resume --last`
  - **thread_id 캡처** — `~/.codex/sessions/` 디렉토리 watch + 파일명 매핑 (M2에서 결정 — [§13.2](./02_architecture.md))
- [ ] **Gemini 어댑터** —
  - 새 세션: `gemini --session-id <UUID> --skip-trust` + spawn 직후 IR 본문을 PTY stdin write
  - 이어가기: 두 단계. (1) `gemini --list-sessions` 출력 파싱 → UUID로 인덱스 검색. (2) `gemini --resume <idx> --skip-trust`
- [ ] **CLIAdapter.spawnRefineIR** — 헤드리스 stream-json spawn (메인 PTY와 별도). Claude `claude -p '<prompt>' --output-format stream-json --verbose --permission-mode acceptEdits` / Codex `printf '%s' '<prompt>' \| codex exec --json --skip-git-repo-check -s read-only -` / Gemini `gemini -p '<prompt>' -o stream-json --approval-mode auto_edit --skip-trust`
- [ ] **stream-json 정규화 (refine 한정)** — `assistant.text` 누적, `usage`, `error` 추출 ([02_architecture.md §7.3](./02_architecture.md))
- [ ] `IRModule.refine(threadId, currentModel)` — 현재 활성 모델이 자기 trajectory를 정제 ([01_ir.md §6-3](../research/01_ir.md), [02_architecture.md §8.2](./02_architecture.md))
  - replay.log → ANSI strip → 모델 응답 텍스트 추출 휴리스틱 (M2에서 결정)
  - user.jsonl과 응답 텍스트 결합 → 시간순 trajectory
  - refine prompt 빌드 → spawnRefineIR → parseRefineOutput → IR draft
- [ ] `IRModule.buildInjectionPayload(threadId, targetModel)` — Claude/Codex/Gemini 별 페이로드 직렬화 ([02_architecture.md §8.4](./02_architecture.md))
  - Claude: 임시 파일에 sentinel + IR 본문 → `--append-system-prompt-file` 인자
  - Codex: PTY stdin write 텍스트 (trust 응답 후 메인 prompt 도달 시점에 write)
  - Gemini: PTY stdin write 텍스트 (input box 등장 시점에 write)
- [ ] **모델 전환 흐름** — IPC `handoff:prepare` (refine 헤드리스 spawn) / `handoff:cancel` (refine SIGTERM) / `handoff:commit` (IR 저장 + 기존 PTY kill + 새 PTY spawn with IR 주입). M2는 자동 commit, 검토 UI는 M3
- [ ] Renderer `ModelSwitcher` — 입력창 우측 드롭다운. **응답 스트리밍 중(휴리스틱) 비활성**
- [ ] **모델 전환 UI 상태 처리** — `Switching:Preparing`(진행 표시기 + 경과 시간 + from→to + 취소 버튼) / `Switching:Committing` / `Switched` / `Switching:Failed`(재시도/취소 액션) ([02_architecture.md §4.2.1](./02_architecture.md))
- [ ] 10초 초과 시 보조 안내("예상보다 오래 걸리고 있습니다 — 취소할 수 있습니다") 표시. 자동 abort 없음
- [ ] **PTY 재spawn 흐름** — 기존 PTY SIGTERM(grace 1초)→SIGKILL → 새 모델 PTY spawn → xterm.js 클리어 + 새 PTY 출력 표시
- [ ] 정제 LLM 호출 비용/지연 측정 + 로그
- [ ] 환경변수 격리 — Codex `OPENAI_API_KEY` 잔존 시 ChatGPT 구독 무시 이슈 정책 결정 ([02_model_integration.md §10](../research/02_model_integration.md))

### 5.3 완료 정의

- 한 스레드에서 Claude → Codex → Gemini 순으로 전환할 수 있다.
- 각 전환 시점에 IR이 자동 정제(헤드리스 spawn)되어 새 모델의 PTY가 재시작 + IR 주입 + 첫 응답이 이전 맥락을 인지한다(예: 직전에 수정한 파일·결정사항을 새 모델이 언급).
- 새 PTY가 정상 활성화되어 xterm.js에 인터랙티브 TUI 표시.
- trajectory 원천(user.jsonl + replay.log)은 보존되고, 매 handoff는 원본에서 다시 정제(재귀 압축 회피).

### 5.4 위험 / 결정 항목

- **Codex thread_id 캡처 안정성** — `~/.codex/sessions/` 디렉토리 watch가 spawn 시점에 race condition 없이 동작하는지. 다른 codex 인스턴스가 동시 실행 중이면 어떤 파일이 우리 것인지 식별 휴리스틱 필요
- **Gemini `--list-sessions` 파싱 안정성** — 출력 형식이 CLI 버전 변경 시 깨질 가능성. 정규식 + fallback 전략
- **replay.log → 응답 텍스트 추출 휴리스틱** — refine 입력 trajectory 품질에 직결. 잘못 추출하면 모델이 맥락 못 잡음. 시나리오 5~10개로 검증
- **IR을 PTY stdin write로 주입하는 모델별 응답 품질** — Codex/Gemini는 user prompt 채널이라 system prompt 채널(Claude)과 격이 다름. 모델별 sentinel 헤더([02_architecture.md §8.4.1](./02_architecture.md)) 효과 실측
- **Codex/Gemini 새 세션 spawn 직후 IR 주입 타이밍** — Codex는 trust 다이얼로그 응답 후, Gemini는 input box 등장 후 → 정확한 *준비 완료* 감지 휴리스틱 필요. 너무 빨리 write하면 dialog가 prompt로 받아 우리 IR이 trust 응답으로 처리됨(probe 04에서 관찰). 너무 늦으면 사용자 체감 지연
- **정제 품질 검증** — 자동화된 벤치마크는 1인 OSS에 과중 ([01_ir.md §7-10](../research/01_ir.md)). 수동 시나리오 5~10개로 검증
- **정제 시간** — 사용자 체감 지연. 너무 길면 utilityProcess 격리 또는 작은 모델 옵션 (Phase 2)
- **전환 진행 상태** — IR 정제 + PTY 재spawn으로 최대 10~13초 지연 가능(측정 구간 [02_nfr.md §3](../spec/02_nfr.md))을 허용하되, 진행 표시기 + 경과 시간 + 취소 버튼을 노출
- **취소·실패 동작** — `Switching:Preparing` 중 취소 시 refine spawn에 SIGTERM, 메인 PTY/활성 모델·IR 변경 없음. commit 도중 새 PTY spawn 실패 시 fromModel PTY가 이미 죽었으면 fromModel로 복구 spawn (best-effort)
- **응답 중지와 모델 전환 컨트롤 활성화 정책** — PTY 출력 idle 휴리스틱(예: 1초간 추가 data 없음)으로 "응답 종료" 추정. stream-json처럼 명시 끝 마커가 없으므로 휴리스틱 부정확성 감수

## 6. M3 — Workspace + Multi-tab + Hook + Gemini Refine (재정의 2026-05-11)

### 6.1 목표

> **Phase 4 M3 진입 직후 architecture revision 발생** ([probe_results.md §7~10](./probe_results.md), [02_architecture.md §14](./02_architecture.md), [04_subspace_injection_analysis.md](../research/04_subspace_injection_analysis.md)). 원래 M3는 *IR 검토·편집 모달*만 추가하는 작은 마일스톤이었으나, probe 05~08 결과로 *workspace + multi-tab + hook system + gemini refine*까지 흡수.

차별점 3(IR handoff 사용자 통제)은 *T-3 메모리 갱신 버튼* 시점 IR 검토 모달로 살아남으면서, 동시에 alive 탭 mid-session freshness(hook) + 무료 티어 refine(gemini-flash) + workspace UX(Subspace 패턴)까지 도입.

이미 완료: J 청크 (IR 검토 모달, [src/renderer/src/components/IRReviewPanel.tsx](../../src/renderer/src/components/IRReviewPanel.tsx)). 단 trigger 위치를 *모델 전환 시점*에서 *T-3 메모리 갱신 시점*으로 *재배치* 필요.

### 6.2 산출물 (청크 단위 분리 — 검증 통과 단위로 커밋)

#### K 청크 — Workspace 데이터 모델 + 마이그레이션

- [x] `WorkspaceStore` 새 모듈 — `~/Library/Application Support/AgentBridge/workspaces/<id>/{workspace.json, ir.json, turns.jsonl, sessions/, archive/, settings/}` 디렉토리 구조 ([§15.2](./02_architecture.md))
- [x] thread → workspace 마이그레이션 헬퍼 (기존 thread를 workspace로 변환, sessions[] 배열에 단일 element 보관. 손상 JSON best-effort 복구)
- [x] IPC: `workspaces:list/create/open/delete/get/rename`, `sessions:create/open/close/list/rename/modelSessionCaptured`, `home:submit`
- [x] sessions[] 다중 활성 — 한 workspace 안 여러 PTY 동시 spawn 지원
- [x] 마이그레이션 일회성 — 기존 사용자 thread 데이터 자동 변환 (`migration_state.json` 영구 마커로 부팅 시 zombie 재마이그레이션 차단)

#### L 청크 — Multi-tab UI (Q3-B Subspace 패턴)

- [ ] 3-panel layout — left workspace nav / center active session PTY / right activity feed (sessions list, files changed)
- [ ] 탭바 컴포넌트 — workspace 안 sessions[] 표시. 활성 탭 강조. 탭 추가(`+ <model>`) / 닫기(`x`)
- [ ] 탭 클릭 시 PTY 활성 전환 (kill 안 함, 단지 attach 변경)
- [ ] 다른 탭 살아있는 동안 메모리 freshness 정책 — alive 탭은 *spawn 시점 IR* 보유. 다음 사용자 메시지 시 hook이 최신 IR 주입 (per-message hook이 핵심)
- [ ] 기존 `ModelSwitcher`(M2 H) — *deprecated*. "+ <model>" 탭 추가 버튼으로 대체

#### M 청크 — Hook system + AgentBridge 헬퍼 binary

- [ ] `agentbridge-memory` 헬퍼 binary (Main 프로세스 내 spawn 가능한 형태 또는 별 Node 스크립트). hook command가 호출
- [x] CLI별 hook config 생성 + 마커 블록 merge ([§14.8](./02_architecture.md), [§14.11](./02_architecture.md)):
  - claude: Application Support 안 `claude-settings.json` 작성, spawn 시 `--settings <path>` 전달
  - codex: workspace cwd `.codex/hooks.json` 마커 블록 merge + `[features].hooks = true` 활성 (config.toml). probe 08 이후 deprecated `codex_hooks`는 emit 안 함 — 신키 `hooks` only
  - gemini: workspace cwd `.gemini/settings.json` 마커 블록 merge
- [x] hook 호출 시 stdout JSON 출력 — `hookSpecificOutput.additionalContext` + `hookEventName`별 별도 command emit (helper binary `--event` 인자로 이름 통일)
- [x] 코덱스 `/hooks` trust 게이트 안내 — `WorkspaceMeta.codexHookTrust: 'pending'|'trusted'` + `CodexTrustBanner` UI ([probe 08 결정사항](./probe_results.md))

#### N 청크 — Refine 모델 = gemini-flash + GeminiQuotaTracker (완료 2026-05-11)

- [x] `RefineDispatcher` — refine 모델 선택 (auto/gemini-flash/active/off) + 폴백 (가용성/quota 사전/응답 사후)
- [x] gemini-flash 헤드리스 spawn — `gemini -p '<refine prompt>' -o stream-json --approval-mode auto_edit --skip-trust`
- [x] gemini 응답 파싱 → IR JSON → AgentBridge가 *직접* `ir.json` atomic write
- [x] **`GeminiQuotaTracker` 재설계** — incrementQuota 카운터 폐기. PTY 인터랙티브 footer `X% used` 파싱이 진실의 원천. severity = unknown/ok/warn(80)/critical(95)/exceeded(100)
- [x] Background quota probe — OS tmpdir 격리 cwd로 gemini PTY spawn → footer 캡처 → SIGTERM. trigger: workspaces:open(10분 stale) / ir:refine 후(5분 stale) / 사용자 명시 버튼(throttle 우회)
- [x] gemini 미설치 / quota exceeded 시 폴백 — 활성 모델 헤드리스 + UI 노란 배지
- [x] 사용자 설정 `refineModel` 토글 (RefineSettingsPanel)

#### N 후속 — 코드 부채 정리 (완료 2026-05-11)

- [x] GUI 채팅 입력창(ChatInputBox + chat:send IPC) 폐기 — PTY xterm.js 자체 입력창 사용
- [x] 중지 버튼 + generating 휴리스틱 폐기 — Ctrl-C는 PTY 직접
- [x] AGENTS.override.md 폐기 — cwd 4파일 → 3파일
- [x] Layer 2 IR_SENTINEL/buildInjectionPayload/어댑터 irPayload 분기 폐기 — Hook 시스템이 대체
- [x] Hook inject 본문에 HOOK_INSTRUCTIONS prepend (~25 토큰 단순화)
- [x] user.jsonl 채널 폐기 — refine 입력은 replay.log 단일 (O 청크에서 turns.jsonl로 대체 예정)
- [x] threadsHandlers/handoffHandlers/handoffSession/threadActive/ModelSwitcher.tsx/tmpIrFile dead code 모두 제거
- [x] conversationStore legacy CRUD 모두 제거 (ensureConversationDirs만 보존)
- [x] contextId → workspaceId rename (IrRefineRequest, RunIrRefineArgs)
- [x] gemini 미설치 시 노란 배지 (E2)

#### O 청크 — Turns.jsonl + CompactionScheduler (진입 결정 완료 2026-05-11, 본 구현 ⬜)

설계 명세 [02_architecture.md §15.3~15.6](./02_architecture.md) 참조.

- [ ] **`TurnRecorder`** — pty:write IPC hook + ptySession onData hook chain. sessionId별 buffer 적재 → Enter 키(`\r`) 감지 → flushPendingUser → PTY idle 1.5초 → flushPendingTurn → turns.jsonl append
- [ ] **`sliceAssistant`** 모듈 — 모델별 본문 추출 휴리스틱 (claude `⏺`, codex `▌`, gemini markdown). 도구 호출 박스 `⏺ <Tool>(arg)` 추출 → toolCalls[] 분리. assistantBody 500 chars cap
- [ ] TurnRecord schema (§15.3) — user / userBytes / assistantBody / assistantBodyBytes / toolCalls[]
- [ ] turns.jsonl 위치: `<workspaceId>/turns.jsonl` append-only NDJSON
- [ ] cap: user 8K / assistantBody 500 chars (첫 400 + 마지막 100)
- [ ] rotate 정책 — 5MB 또는 1000 record 도달 시 archive/turns_<TS>.jsonl.archive 이동
- [ ] **`CompactionScheduler`** — trigger 조건: uncompacted count > 3 OR sum bytes > 6K. 처리: oldest (count - 3)개. **최근 3개는 항시 raw 보존**
- [ ] workspace 단위 lock — `workspace.json.compactionInProgress: { sessionId, startedAt }` atomic CAS, 5분 stale 강제 해제
- [ ] **`buildCompactionPrompt`** — user/assistant 명시 분리 입력 + 직전 IR. "IR 800 토큰 이내" cap 명시
- [ ] **IR 스키마 슬림화** — trajectory[] / artifacts[] 제거. decisions cap 5/files 5/commands 3/tests 3/pending 3
- [ ] **Hook inject 본문 확장** — helper binary가 ir.json + turns.jsonl 끝 3 record 둘 다 읽어 본문 구성 (§15.5)
- [ ] failure 처리 — 재시도 1회 + 5분 대기 + 1회 + 누적
- [ ] archive 파일 — compressed_<TS>.jsonl에 처리된 turns + 결과 IR snapshot

#### P 청크 — IR 검토 모달 재배치 (T-3 trigger)

- [ ] M3 J 청크 IRReviewPanel 그대로 재사용
- [ ] *trigger 위치 변경*: 모델 전환 → "메모리 갱신" 버튼(T-3) 클릭 시점
- [ ] 모달 내부에서 모든 active 탭의 trajectory 통합 refine 후 결과 IR 검토·편집
- [ ] T-1/T-2/T-5 trigger는 *모달 없이 background* (사용자 옵션 토글로 모달 활성 가능)
- [ ] gemini 미설치 + active model이 토큰 부담일 때 사용자 confirm 모달

#### Q 청크 — `/clear` UI + cwd cleanup 안내

- [ ] B-1 + D-3 정책 ([probe_results.md §10.7](./probe_results.md))
- [ ] UI에 "메모리 초기화" 버튼 — IR을 빈 IR로 reset
- [ ] codex `/clear` 후 stale IR 받음을 사용자 안내 (UI 툴팁)
- [ ] 워크스페이스 삭제 시 cwd **3 파일** cleanup 안내 모달 (.codex/hooks.json + .codex/config.toml + .gemini/settings.json — 마커 블록 자동 제거 옵션)

### 6.3 완료 정의

- 한 workspace 안에 claude/codex/gemini 탭을 동시에 띄울 수 있다
- 각 탭이 자기 PTY를 유지한 채 *모든 사용자 메시지*에 IR이 자동 주입된다 (hook 메커니즘으로)
- 사용자가 "메모리 갱신" 버튼 누르면 IR 검토 모달이 떠 모든 활성 탭의 trajectory를 통합 refine해 보여준다
- gemini 설치된 사용자는 refine LLM 비용 0 (무료 티어)
- gemini 미설치 사용자는 활성 모델 폴백 + UI 토큰 비용 경고 표시
- 사용자 글로벌 설정 파일은 무수정 (`~/.claude/settings.json` / `~/.codex/hooks.json` / `~/.gemini/settings.json` 그대로)
- 사용자 cwd엔 `.codex/hooks.json` / `.codex/config.toml` / `.gemini/settings.json` **3 파일만** 마커 블록 merge로 추가 (AGENTS.override.md 폐기, 2026-05-11)
- 워크스페이스 삭제 시 메타데이터 자동 정리 + cwd 3 파일 사용자 안내

### 6.4 위험 / 결정 항목

- **codex `/hooks` trust 수동 승인 UX** — 첫 spawn 시 사용자가 codex 안에서 슬래시 명령 실행해야 함. UI 안내 디자인 핵심
- **multi-tab 메모리 사용량** — 동시 PTY 다수 시 ~500MB+ RAM 점유 가능. 사용자 설정으로 max 동시 탭 수 cap 권장
- **gemini quota 한도** — 헤비 사용자 1000 req/일 도달 가능. 폴백 정책 + UI 명시 안내
- **per-turn hook latency** — 우리 헬퍼 binary가 50~100ms 안에 응답해야 사용자 체감 X. 파일 I/O 성능 측정 필요
- **마커 블록 merge race** — 사용자가 cwd 4 파일을 수동 편집하는 동안 우리가 merge 시 충돌 — atomic read-modify-write로 회피
- **gemini 의존성 표현** — README/첫 실행 가이드에 *gemini 설치 권장* 명시. 미설치도 동작은 하나 비용 발생
- **차별점 4 표현 갱신** — *Subspace 대비 privacy 강함*은 유지하되 "사용자가 메인 모델 외에 gemini도 인증해야 무료" 사실 명시
- **데이터 흐름 leak 우려** — 사용자 작업이 메인 CLI(예: claude → Anthropic) + 요약 CLI(gemini → Google) 두 백엔드로 흐름. 단일 백엔드 의존 대비 *경로 추가*. README에 명시

## 7. M4 — 패키징·서명·릴리즈

### 7.1 목표

DMG 사이닝/노타리, auto-update 채널, 공개 저장소 정비를 마치고 GitHub Releases에 첫 베타(v0.0.1, ad-hoc 서명 + Gatekeeper 우회 안내)를 게시한 뒤, Apple Developer 인증서를 받은 후 정식 노타리된 v0.0.2(또는 v0.1.0)로 정식 배포한다.

### 7.2 산출물

- [ ] Apple Developer Program 가입 ($99/년) ([03_desktop_framework.md §8.1](../research/03_desktop_framework.md))
- [ ] Developer ID Application 인증서 발급 + Hardened runtime + entitlements 결정 (필요 최소)
- [ ] electron-builder `afterSign` 훅에 `notarytool` 통합 ([03_desktop_framework.md §3.4](../research/03_desktop_framework.md))
- [ ] DMG 빌드 + 첫 노타리(8~12시간 대기 가정) + Gatekeeper 통과 검증
- [ ] electron-updater + GitHub Releases publish provider 동작 ([03_desktop_framework.md §3.4](../research/03_desktop_framework.md))
- [ ] **node-pty ASAR unpack 정책** — `electron-builder` `asarUnpack` 설정에 `node_modules/<pty-package>/**` 추가 ([03_desktop_framework.md §3.3, §9](../research/03_desktop_framework.md))
- [ ] PATH 캡처 결과만 검증
- [ ] README — 차별점 3개 상단 명시, 정직 라인("CLI subprocess wrapper", "no own backend", "no AgentBridge account/subscription", "uses your existing CLI logins") 유지. **사용자 메모리 파일(AGENTS.md / GEMINI.md / CLAUDE.md) 자동 로드 + AgentBridge가 수정하지 않음 + IR은 임시 채널 전달임을 명시** ([README.md](../../README.md))
- [ ] LICENSE = MIT ([01_mvp_scope.md §1](./01_mvp_scope.md))
- [ ] CONTRIBUTING / Code of Conduct (선택)
- [ ] 첫 실행 가이드 — CLI 설치/로그인 안내 + 워크스페이스 cwd 안내 ([02_architecture.md §11](./02_architecture.md))
- [x] CHANGELOG / Release Notes
- [x] `v0.0.1` 태그 + Releases 게시 (ad-hoc 서명 + hardenedRuntime + `valid on disk` 검증 통과. 사용자 Gatekeeper 우회 필요)
- [ ] Apple Developer 인증서 + 정식 노타리 → `v0.0.2` (또는 `v0.1.0`) Releases 게시
- [ ] universal binary 포함 검토 (Apple Silicon만으로도 첫 출시 가능 — 1차 릴리즈 결정 [01_mvp_scope.md §1](./01_mvp_scope.md))

### 7.3 완료 정의

- GitHub Releases에서 DMG를 다운로드해 설치하고 처음 실행할 수 있다 (Gatekeeper 경고 없음).
- 앱이 자동 업데이트를 체크한다.
- node-pty native binary가 ASAR unpack 위치에서 정상 로드된다 (PTY 정상 spawn).
- README 상단에서 차별점 3개를 즉시 식별할 수 있다.
- LICENSE / CONTRIBUTING이 공개되어 있다.
- 첫 실행 가이드가 동작한다.

### 7.4 위험 / 결정 항목

- **첫 노타리 대기 시간** — 8~12시간 가정. 일정에 포함 ([03_desktop_framework.md §8.1](../research/03_desktop_framework.md)).
- **macOS 14+ child entitlement 정책** — 외부 CLI spawn(특히 PTY)이 hardened runtime + entitlement 조합과 어떻게 상호작용하는지 첫 노타리 후 실측. PTY 관련 entitlement(예: `com.apple.security.cs.disable-library-validation`) 검토 필요할 수 있음
- **node-pty native binary 노타리** — sandbox/notarization과 충돌 없는지 첫 빌드에서 검증
- **마케팅 라인** — Subspace와의 비교를 README에 명시할지 말지. 명시하지 않더라도 차별점 3개를 그 자리에서 읽으면 식별되는 수준은 유지 ([02_model_integration.md §8.4](../research/02_model_integration.md)).

## 8. 마일스톤 간 의존성

```
M0 ──► M1 ──► M2 ──► M3 ──► M4
              │      │
              └──────┴── M3는 M2의 자동 정제 품질이 검증된 후 시작
```

- **M2 → M3**: M2가 끝나야 IR draft 품질을 사용자가 검토할 의미가 생긴다. 반대로 M2를 건너뛰고 M3 먼저 만들면 검토할 데이터가 모형(mock)이 되어 차별점 검증이 약해진다.
- **M0 → M1 → M2**: 어댑터 추상화가 M1에서 정해지고 M2는 모델별 매핑 + IR refine 추가. M1 통과 후 M2 일정이 단축될 가능성이 높다(추정).
- **M4는 M3 완료 후**: 차별점 3개가 박힌 상태에서 첫 릴리즈. 마케팅 라인이 일관됨.

## 9. 우선순위가 흔들릴 때의 가드레일

1인 OSS의 가장 큰 위험은 "기능 욕심으로 마일스톤이 늘어나는 것". [01_mvp_scope.md §3.2](./01_mvp_scope.md)에서 명시적으로 후순위로 미룬 항목들은 M0~M4 동안 **건드리지 않는다**. 특히:

- ~~PTY/xterm.js 임베드~~ → ✅ MVP 채택(모델 B)
- ~~stdin 양방향 승인 프로토콜~~ → ✅ 모델 B에서 자연 흡수 (xterm.js → PTY stdin)
- git worktree 자동 격리 → Phase 2
- Sparkle 전환 → Phase 2
- Universal binary는 v0.1.0 후속 릴리즈에서 검토
- Windows / Linux → Phase 4 종료 후
- 자동 redaction → Phase 2
- 토큰/비용 대시보드 → Phase 2

위 중 하나라도 M0~M4 진행 중 "지금 넣어야 할 것 같다"는 신호가 오면, **그 신호의 근거가 차별점 3개 중 어느 하나를 약화시키는지**를 먼저 점검한다. 차별점이 약해지지 않으면 Phase 2로 미룬다.

## 10. 1차 릴리즈 이후

본 문서는 v0.1.0(Phase 5 배포)까지만 다룬다. v0.1.x 패치 / Phase 5 후속 / Phase 2 일정은 v0.1.0 출시 후 사용자 피드백을 반영해 별도 plan 문서에서 갱신한다.
