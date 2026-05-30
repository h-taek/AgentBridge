# MVP 범위

> Phase 3 — Plan / 문서 1: 1차 릴리즈에 들어가는 것 / 빠지는 것을 기능 단위로 명시

[06_mvp.md](../spec/06_mvp.md)에서 정의한 MVP를 Phase 2 리서치 결정([01_ir.md](../research/01_ir.md), [02_model_integration.md](../research/02_model_integration.md), [03_desktop_framework.md](../research/03_desktop_framework.md)) + Phase 4 M0 capability probe 결과([probe_results.md](./probe_results.md))로 더 좁힌다.

## 1. 환경 / 배포

| 항목 | MVP 결정 | 근거 |
|---|---|---|
| OS | macOS 전용 | [06_mvp.md](../spec/06_mvp.md) |
| 아키텍처 | **Apple Silicon 우선, Intel은 Phase 4 종반에 universal binary로 포함 검토** | 1인 OSS의 첫 빌드/노타리 부담 최소화. universal 자체는 electron-builder가 자동이라 Phase 4 막판 전환 부담 작음 ([03_desktop_framework.md §10](../research/03_desktop_framework.md)) |
| 프레임워크 | **Electron + Node.js** | [03_desktop_framework.md §11.1](../research/03_desktop_framework.md) |
| 배포 | 오픈소스, GitHub Releases | [05_app_concept.md](../spec/05_app_concept.md) |
| 사이닝/노타리 | Apple Developer ID + notarytool. 첫 공식 릴리즈 시점부터 적용 | [03_desktop_framework.md §8](../research/03_desktop_framework.md) |
| Auto-update | electron-updater (Squirrel.Mac 백엔드) | [03_desktop_framework.md §3.4](../research/03_desktop_framework.md) |
| 인증 | AgentBridge가 직접 API 키를 받지 않음. 사용자가 각 CLI에 사전 로그인 | [02_model_integration.md §4](../research/02_model_integration.md) |

## 2. 포함되는 기능 (1차 릴리즈)

### 2.1 [04_feature_spec.md](../spec/04_feature_spec.md) 기준

> **Phase 4 M3 진입 후 재정의** ([03_milestones.md §6](./03_milestones.md), [02_architecture.md §14](./02_architecture.md)). M2까지 단일 active 모델 + handoff 흐름이었으나 M3에서 *workspace + multi-tab + per-message hook inject + gemini-flash refine*으로 진화.

| 기능 | 1차 릴리즈 동작 |
|---|---|
| F-01. 채팅 인터페이스 | **워크스페이스 안 multi-tab** — 각 탭이 한 모델의 PTY. 활성 탭의 인터랙티브 TUI를 xterm.js로 임베드. 사용자는 GUI 입력창 또는 xterm.js 안에서 직접 메시지 입력. 도구 호출 시 CLI native 다이얼로그 그대로 표시. 응답 중지는 PTY SIGTERM |
| F-02. 모델 전환 | Claude / Codex / Gemini 3개 고정. **드롭다운 전환이 아닌 *새 탭 추가*** (M3 재정의). 기존 탭은 살아있음. 탭 추가 시점에 IR refresh (T-2 trigger) → 새 탭이 최신 IR 받음 |
| F-03. 맥락 유지 (per-message hook inject) | **모든 사용자 메시지마다 hook이 IR을 invisible inject** (claude `--settings` / codex `<cwd>/.codex/hooks.json` / gemini `<cwd>/.gemini/settings.json`). alive 탭들이 mid-session에 항상 최신 IR 보유 |
| F-03b. 맥락 유지 (사용자 검토) | 우 사이드바 메모리 패널 — 현재 IR 카드 + archive 스냅샷 + Turn 흐름 + Refine/Quota + AI 지시 파일. IR 카드 클릭 시 6 섹션 상세 모달. ✨ 수동 refine / 🗑 메모리 초기화(alsoTurns 옵션) / archive promote 복원. **차별점 3 — 핵심** |
| F-03c. 메모리 요약 (gemini-flash) | refine = gemini-flash 헤드리스 강제(default). 무료 티어 1000/일 활용. 폴백 정책: gemini 미설치 시 활성 모델 헤드리스. 응답을 AgentBridge가 직접 파싱해 ir.json atomic write |
| F-04. 대화 히스토리 | **워크스페이스 단위 영속화**. PTY raw 출력은 session별 `replay.log`. user msg + assistant 1줄 요약은 workspace 단위 `turns.jsonl`. 모델별 sessionId는 session.json에 저장되어 CLI native `--resume`으로 컨텍스트 이어가기 |

### 2.2 차별점의 박힌 위치 — *Phase 4 M3 진입 후 5축으로 확장*

> Subspace 직접 검증(2026-05-10) + probe 05~08 결과로 차별점이 *5개로 확장*. 본 단락은 갱신본. [02_model_integration.md §8.4](../research/02_model_integration.md)의 원래 3축은 #1~#3에 그대로 보존.

| 차별점 | 1차 릴리즈에서의 구현 |
|---|---|
| 1. 오픈소스 / 무료 | GitHub 공개 저장소(MIT). README에 "no AgentBridge account, no AgentBridge subscription"을 강하게 명시하고, 바로 아래에 "uses your existing Claude/Codex/Gemini CLI logins"를 붙여 오해를 줄임. AgentBridge 자체 백엔드/계정 시스템 0줄 |
| 2. Multi-tab 워크스페이스 (M3 재정의) | 한 workspace 안에 claude/codex/gemini 탭을 *동시에* 띄움. 탭 추가 시 새 모델 spawn, 닫을 때까지 *살아있음*. M2의 single-active handoff는 *T-2 (새 탭 open) 흐름*으로 흡수. UI는 Subspace 패턴 차용 |
| 3. 사용자 검토·통제 가능 메모리 | F-03b. **우 사이드바 메모리 패널 + IR 상세 모달 + 수동 refine / 메모리 초기화 / archive promote 복원**이 1차 릴리즈의 hero 기능. archive 스냅샷 보존으로 reset 후에도 직전 상태로 promote 가능. (초기 M3 J 청크 IRReviewPanel 편집 모달은 M3.5에서 read-only IR 카드 + archive 카드 카탈로그로 재정의 — 자유 편집은 Phase 2 옵션) |
| 4. **Privacy / 자체 백엔드 0** (확장) | AgentBridge 자체 클라우드 백엔드/계정 시스템 0. 메인 작업은 사용자 인증 CLI(claude/codex/gemini), 요약은 사용자 인증 gemini-flash 헤드리스(무료 티어 1000/일). 데이터가 *AgentBridge 서버로 가지 않음*. 단 메인 모델·요약 모델 둘 다 각자 백엔드(Anthropic/Google) 경유는 사용자 본인 subscription 안 — 명시적으로 표기 |
| 5. **사용자 자산 격리** (확장) | 사용자 글로벌 설정 파일(`~/.codex/hooks.json`/`~/.claude/settings.json`/`~/.gemini/settings.json`) **무수정**. 사용자 cwd엔 CLI native config 3종(`<cwd>/.codex/hooks.json`/`<cwd>/.codex/config.toml`/`<cwd>/.gemini/settings.json`)만 *마커 블록 merge*로 추가, 사용자 콘텐츠 보존. claude는 cwd 무침범(`--settings` flag로 Application Support 안 격리 settings.json 지정). AgentBridge 메타데이터는 OS 표준 위치 `~/Library/Application Support/AgentBridge/workspaces/<id>/`에 격리. (AGENTS.override.md는 M3 N 후속 정리 2026-05-11에 폐기) |

## 3. 제외되는 기능 (Phase 2 이후)

### 3.1 [04_feature_spec.md](../spec/04_feature_spec.md) 기준

| 기능 | 제외 이유 |
|---|---|
| F-05. 모델 관리 (추가/편집) | 고정 3개로 핵심 가치 검증 가능 ([06_mvp.md](../spec/06_mvp.md)) |

### 3.2 리서치/probe에서 후순위로 미룬 항목

| 항목 | MVP 처리 | 출처 |
|---|---|---|
| ~~PTY 임베드 (xterm.js + node-pty)~~ | ✅ **MVP 채택**으로 결정 변경 (probe 04 결과). 모델 B 확정 | [probe_results.md §4](./probe_results.md) |
| 권한 토글 / 권한 다이얼로그 GUI 중재 | **MVP 미구현**. 모델 B 채택으로 *권한 토글 자체가 없어짐* — CLI native 인터랙티브 모드의 권한 흐름을 xterm.js에 그대로 노출하고 사용자가 매 도구 호출 시 직접 응답. AgentBridge는 권한 결정에 개입 안 함 | [probe_results.md §4-5](./probe_results.md), 사용자 원칙(CLI 위임) |
| stdin 양방향 승인 프로토콜 | **모델 B에서 자연 흡수** — xterm.js → PTY stdin로 키 입력이 양방향. 별도 프로토콜 불필요 | 동일 |
| 멀티 인스턴스 / 동시 실행 | **MVP 채택으로 변경 (M3 재정의 2026-05-11)** — 한 워크스페이스 안 multi-tab(모델별 PTY 동시 활성) 지원. *여러 워크스페이스 동시 활성*은 Phase 2 | [02_architecture.md §14](./02_architecture.md), [03_milestones.md §6](./03_milestones.md) |
| git worktree 자동 격리 | 사용자가 폴더만 지정. 자동 worktree 생성은 Phase 2 옵션 | [02_model_integration.md §9.3](../research/02_model_integration.md) |
| Sparkle 통합 | electron-updater로 시작. native dialog 요구 강하면 Phase 2 전환 | [03_desktop_framework.md §11.1](../research/03_desktop_framework.md) |
| Universal binary | Apple Silicon 단독 우선. universal은 Phase 4 종반 검토 | §1 |
| Windows / Linux | 명시적 후순위 | [06_mvp.md](../spec/06_mvp.md) |
| MCP / Skills 통합 | 각 CLI에 위임. AgentBridge는 별도 추상화 미제공 | — |
| 사용자 정의 system prompt / `CLAUDE.md` 편집 | Phase 2. MVP는 기본값 + IR 주입만 | [01_ir.md §5](../research/01_ir.md) |
| 토큰/비용 표시 | xterm.js 안에서 각 CLI native footer/status로 표시(우리가 별도 파싱 안 함). 통합 대시보드는 Phase 2 | [02_model_integration.md §7](../research/02_model_integration.md) |
| 민감 정보 redaction | IR refine 시 자동 redaction은 미구현. 사용자 검토 단계에서 수동 편집으로 우회 (1차 릴리즈) | [01_ir.md §7-9](../research/01_ir.md) |

## 4. IR 동작 — 1차 릴리즈 결정

[01_ir.md §6](../research/01_ir.md)의 권고 스켈레톤을 기준으로 1차 릴리즈에 박는다.

| 항목 | 1차 릴리즈 결정 | 근거 |
|---|---|---|
| 직렬화 포맷 | **JSON** (사용자 머신 파일). JSONL은 trajectory만 라인 단위 | [01_ir.md §7-1](../research/01_ir.md) — 단순성 / 가독성 |
| trajectory 보존 깊이 | 최근 10턴 원문 + 그 이전은 structured 필드 + 요약 1~2문단 | [01_ir.md §6-3](../research/01_ir.md) |
| trajectory 입력 소스 | 메인 흐름이 PTY raw bytes이므로 사용자 메시지 + CLI native session 파일을 결합해 trajectory 추출. 정확한 형태는 M2 구현 시 결정 | [probe_results.md](./probe_results.md), [01_ir.md §6-3](../research/01_ir.md) |
| 정제 LLM | **현재 활성 모델**이 자기 자신을 정제 — refine은 *별도 헤드리스 spawn*(stream-json)으로 메인 PTY 세션과 격리. 별도 LLM 호출 없음 | 1인 개발 단순성. 비용/지연 추가 없음 |
| 파일 ref 처리 | 파일 경로만 저장. 내용은 새 모델이 도구로 재취득 | [01_ir.md §6-2](../research/01_ir.md) — 일관성 / 디스크 공간 |
| A2A 어휘 차용 범위 | `contextId` / `Task` / `Message` / `Part` / `Artifact` 어휘만. AgentCard·streaming·extension은 미차용 | [01_ir.md §7-5](../research/01_ir.md) |
| 사용자 검토 단계 | **MVP에 포함**. 모델 전환 직전 모달 overlay | [01_ir.md §6-3](../research/01_ir.md) — Amp 패턴 + 차별점 3 |
| 민감 정보 처리 | 자동 redaction 미구현. 사용자 검토 단계에서 수동 제거 | §3.2 |

## 5. CLI 통합 — 1차 릴리즈 결정

probe 결과로 [02_model_integration.md](../research/02_model_integration.md)의 헤드리스 가정을 *PTY 인터랙티브* + 별도 *헤드리스 refine*으로 분리.

| 항목 | 1차 릴리즈 결정 | 근거 |
|---|---|---|
| I/O 모델 | ✅ **모델 B (PTY + xterm.js 임베드)**. 메인 채팅은 인터랙티브 TUI를 PTY로 spawn해 raw bytes를 xterm.js에 forward. IR refine만 별도 헤드리스 spawn(stream-json) | [probe_results.md §4](./probe_results.md) |
| 메인 진입 명령 (인터랙티브, 모델 B) | Claude `claude --session-id <UUID>` (새 세션) / `claude --resume <UUID>` (이어가기). Codex `codex` (새) / `codex resume <UUID>` (이어가기). Gemini `gemini --session-id <UUID> --skip-trust` (새) / `gemini --resume <index> --skip-trust` (이어가기, list-sessions 파싱). 권한 모드 인자는 *명시 안 함* — 사용자가 인터랙티브에서 직접 응답 | [probe_results.md §4](./probe_results.md), [02_architecture.md §7.2](./02_architecture.md) |
| IR refine 명령 (헤드리스, 별도 spawn) | Claude `claude -p '<refinePrompt>' --output-format stream-json --verbose --permission-mode acceptEdits`. Codex `codex exec --json --skip-git-repo-check -s read-only '<refinePrompt>'`. Gemini `gemini -p '<refinePrompt>' -o stream-json --approval-mode auto_edit --skip-trust` | [probe_results.md §1, §2.5](./probe_results.md) |
| IR 주입 시점 | **모델 전환 후 새 모델의 첫 PTY 진입 시 1회만**. 같은 모델로 이어가는 메시지에는 IR을 재주입하지 않는다 | 사용자 결정 — IR은 모델 전환 전용. 동일 모델 내 세션 연속성은 CLI에 위임 |
| IR 주입 방식 | Claude `--append-system-prompt-file <임시IR>` (인터랙티브에서도 hidden flag로 동작 — probe 01 §1.3) / Codex 새 세션은 spawn 직후 IR 본문을 PTY stdin으로 즉시 write 후 사용자 첫 메시지 / Gemini 동일 (새 세션 시 spawn 직후 IR 본문 stdin write) | [probe_results.md §1](./probe_results.md), [01_ir.md §5](../research/01_ir.md) |
| 권한 모드 | **권한 토글 없음**. CLI native 인터랙티브 모드의 권한 흐름을 그대로 사용 — 도구 호출 시 CLI가 xterm.js에 다이얼로그를 그리고 사용자가 직접 응답 (numbered menu / Y/N / 화살표 키). AgentBridge는 키 입력만 forward | [probe_results.md §4](./probe_results.md), 사용자 원칙(CLI 위임) |
| 세션 lifecycle | thread당 활성 PTY 1개 (long-lived). 모델 전환·thread 전환·앱 종료 시 SIGTERM → 1초 grace → SIGKILL. 모델별 sessionId는 thread 메타에 보관 | [02_model_integration.md §6](../research/02_model_integration.md), [02_architecture.md §7.4](./02_architecture.md) |
| CLI 헬스체크 | 첫 실행 시 `claude --version` / `codex --version` / `gemini --version` 가능 여부 + 인증 상태 안내 | [02_model_integration.md §9.4](../research/02_model_integration.md) |
| 환경변수 정책 | 사용자 shell env 상속. AgentBridge가 의도적으로 설정하는 키만 명시 추가. PATH는 첫 실행 시 캡처 또는 사용자 명시 | [02_model_integration.md §9.4](../research/02_model_integration.md), [03_desktop_framework.md §3.2](../research/03_desktop_framework.md) |

## 6. UI 구성 — 1차 릴리즈

M3.5 UI 재설계 + M3.6 잔여 기능 반영 (Liquid Glass shell + multi-tab + 메모리 패널 + 멀티 윈도우).

| 영역 | 1차 릴리즈 동작 |
|---|---|
| TitleBar (상단) | 26px frameless + traffic light 정렬 + 워크스페이스 제목 동적 표시 |
| 좌 사이드바 | 홈 행 + 워크스페이스 목록(chevron 펼침 시 세션 트리) + 새 워크스페이스 폼. row 액션 `+`/`🗑`, 우클릭 컨텍스트 메뉴(열기 / 새 창으로 열기 / 이름 수정 / 삭제). 세션 row는 펜·휴지통 |
| 세션 탭바 (xterm 상단) | 워크스페이스 안 sessions[] 표시. 활성 탭 강조. `+ 모델` 드롭다운(claude/codex/gemini/터미널), 탭 close `x`(soft close — UI 숨김, 클릭 재오픈 시 PTY 재spawn) |
| 중앙 xterm-host-stack | 활성 PTY N개를 동시 마운트(탭 클릭 = attach 변경, kill 안 함). PTY raw bytes 그대로 표시 + 사용자 키 입력 forward. 도구 호출 다이얼로그도 그대로 노출. 로딩 오버레이(모델 PNG + pulse halo + `starting…`) |
| 홈 화면 (워크스페이스 미선택 시) | HomePane — 가운데 큰 textarea + 3 모델 카드. Enter 전송 → 자동 워크스페이스 생성(`settings.defaultBasePath` 하위 `Chat-YYMMDD-HHMM`) + 첫 세션 spawn + 첫 메시지 PTY 발사 |
| 우 사이드바 메모리 패널 | 3 collapsible 그룹(AI 지시 / Refine·Quota / 메모리). 현재 IR 카드(클릭 → 6 섹션 상세 모달) + archive 스냅샷 카드 N개 + Turn 흐름 카드(2-bar + tick) + Refine/Quota 카드 + AI 지시 카드(AGENTS/CLAUDE/GEMINI.md 핸들). 헤더에 ⓘ 안내 / ✨ refine / 🗑 초기화 (초기화 모달은 alsoTurns 옵션) |
| 설정 모달 | list-row + sub-page. About / 외관(다크 잠금) / 언어(한글 잠금) / 데이터 경로 / CLI 감지 sub-page / 단축키 sub-page / 사용 설명서 sub-page / Refine 정책 select / 라이선스 sub-page. `app:openPath` / `app:openExternal` IPC로 안전 가드 적용 |
| 멀티 윈도우 | 한 워크스페이스 = 한 윈도우 (claim/release IPC). ⌘N으로 새 홈 윈도우, macOS dock 메뉴 = 활성 윈도우 list, 좌 사이드바 워크스페이스 우클릭으로 "새 창으로 열기" |
| 드래그 앤 드롭 | xterm 영역에 OS 파일 드롭 → bracketed paste + `@<절대경로>` (cli) / quote-if-needed 공백 분리(shell) inject. NFC 정규화 + Shift+Enter `\x1b\r` 매핑 |
| 첫 실행 안내 | CLI 감지 결과 (EnvProbe — `claude` / `codex` / `gemini --version`). 미설치/미인증 시 안내 |

## 7. 1차 릴리즈 완료 정의 (Definition of Done)

[06_mvp.md](../spec/06_mvp.md)의 완료 기준을 다음으로 확장한다.

- macOS (Apple Silicon 검증) 사이닝 + 노타리된 DMG가 GitHub Releases에 게시되어 있다 (1차 베타는 ad-hoc 서명 + Gatekeeper 우회 안내, 정식 노타리는 v0.0.2부터)
- AgentBridge 앱을 실행할 수 있고, 첫 실행 시 세 CLI 설치/인증 상태가 자동 감지된다
- 홈 화면 또는 좌 사이드바에서 워크스페이스를 만들고 Claude / Codex / Gemini 중 하나로 시작할 수 있다 (xterm.js에 인터랙티브 TUI가 정상 표시되고 입력이 PTY로 forward된다)
- 도구 호출 시 CLI native 다이얼로그가 xterm.js에 표시되고 사용자가 응답할 수 있다
- 같은 워크스페이스 안에 다른 모델 탭을 추가해 동시에 활성화할 수 있다 (이전 탭 유지)
- 매 사용자 메시지마다 hook이 IR을 invisible inject한다
- 우 사이드바 메모리 패널에서 현재 IR / archive 스냅샷을 확인하고, 수동 refine / 메모리 초기화 / archive promote 복원이 가능하다
- compaction 트리거(uncompacted ≥6 또는 ≥12K bytes) 도달 시 background compaction이 자동 실행되어 IR이 갱신된다
- gemini 설치된 환경에서 refine 비용이 메인 모델 토큰을 소비하지 않는다 (gemini-flash 헤드리스 + 무료 티어). 미설치 시 활성 모델 폴백 + UI 노란 배지
- 이전 워크스페이스/세션 목록을 조회하고 이어서 진행할 수 있다 (CLI native `--resume`로 컨텍스트 보존)
- 멀티 윈도우 — 한 워크스페이스 = 한 윈도우 정책, ⌘N으로 새 홈 윈도우
- electron-updater로 자동 업데이트 채널이 동작한다 (정식 노타리 후 활성)
- README / LICENSE / CHANGELOG가 GitHub에 공개되어 있고, 차별점 5축이 README 상단에 명시되어 있다

## 8. 비-목표 (명시적으로 1차 릴리즈에서 하지 않는 것)

- "Subspace보다 더 나은 multi-panel workspace를 만든다" — 페르소나가 다르다 ([02_model_integration.md §8.4](../research/02_model_integration.md))
- "100% 로컬 실행을 마케팅한다" — 외부 LLM 의존이라는 사실이 변하지 않음. 정직 라인 유지 ([README.md](../../README.md), [02_nfr.md](../spec/02_nfr.md))
- "에이전트 간 자동 협업/위임" — 단일 활성 모델 패러다임. 동시 멀티 에이전트는 Phase 2 이후
- "코딩 에이전트 자체 도구 루프 재구현" — CLI에 완전 위임. AgentBridge는 wrapper + 연속성 레이어 ([05_app_concept.md](../spec/05_app_concept.md))
- "Cross-platform 동시 출시" — macOS만. Windows/Linux는 Phase 4 이후
- "기존 GUI 터미널 앱과 경쟁한다" — Warp/Hyper/Tabby 같은 일반 터미널 대체가 아님. AgentBridge는 *코딩 에이전트 CLI 전용* 컨테이너. xterm.js 임베드는 차별점 2(다중 모델 통합)와 IR 핸드오프(차별점 3)를 위한 수단
