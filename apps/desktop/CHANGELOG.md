# Changelog

이 프로젝트는 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/) 1.1.0 형식을 따르며 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)을 사용합니다.

## [0.0.5] — 2026-05-26

메모리 주입 hook의 출력 필터 안정화 + 글로벌 hook 덮어쓰기 방지.

### Security

- **CLI 글로벌 설정 디렉토리는 워크스페이스로 지정 불가** — 홈 디렉토리 자체와 `~/.codex`, `~/.agents` 같은 CLI 설정 디렉토리 하위는 워크스페이스로 등록할 수 없습니다. 등록하려 하면 명확한 에러로 차단됩니다.

### Changed

- **메모리 주입 hook 출력 필터 강화** — codex CLI가 화면을 다시 그리는 과정에서 hook 컨텍스트 블록 안에 제어문자를 끼워 넣을 때 필터가 블록 경계를 놓치고 내부 텍스트가 그대로 노출될 수 있었습니다. 매칭 로직을 재설계해 화면 재그리기와 무관하게 항상 안정적으로 가려집니다.
- **출력 멈춤 자동 복구 안전망** — hook 컨텍스트 블록의 종료 신호가 끝내 도착하지 않는 극단 상황에서 채팅 화면이 무기한 멈출 수 있던 문제 해결. 이제 1초 안에 자동 복구되어 사용자 입력·출력 흐름이 끊기지 않습니다.

## [0.0.4] — 2026-05-22

ad-hoc 서명 베타. Gemini → Antigravity 리브랜드 + 보안 강화 + 사용성 개선.

### Security

- **`window.electron` 범용 IPC 노출 제거** — 이전엔 preload가 범용 `ipcRenderer.invoke/send/on`을 함께 노출해 curated `window.agentbridge` API를 우회할 수 있었습니다. renderer는 이제 명시 메서드만 사용합니다.
- **`pty:start` 임의 명령 실행 IPC 제거** — UI에서 사용하지 않으나 노출돼 있던 PTY spawn 채널 제거. 세션 생성은 `sessions:create/open` 경유로 일원화.
- **workspaceId / sessionId 경로 검증** — UUID 정규식 + workspaces root prefix 가드 추가. 잘못된 식별자로 인한 userData 상위 디렉토리 접근을 차단합니다.

### Changed

- **Gemini CLI → Antigravity 리브랜드** — Google이 Gemini CLI 후속작으로 Antigravity CLI(`agy`)를 발표하면서 AgentBridge가 사용하는 명령·표기·로고를 전부 갱신했습니다. 기존 Gemini 세션·설정은 자동 마이그레이션되어 호환됩니다.
- **요약 정책 4단계 재설계** — `우선순위`(설정한 순서대로 시도, 실패 시 다음 CLI) / `고정`(단일 CLI만) / `활성 모델`(가장 최근 채팅한 CLI) / `끔`(요약 안 함). 우선순위/고정에서는 비용이 가장 낮은 모델이 자동 선택됩니다. 기존 `auto`/`gemini-flash` 정책은 `priority`로 자동 마이그레이션됩니다.
- **메모리 패널 Refine/Quota 카드 재디자인** — 세 CLI 사용량을 한 줄로 나열, 다음 정제에 사용될 활성 CLI만 이름·상태 배지로 강조 표시.
- **설정 → 업데이트 확인** — 이전엔 GitHub Releases 페이지를 외부 브라우저로 여는 단순 링크였습니다. 이제 클릭하면 실제 업데이트 체크가 호출되고, 진행 상태(확인 중 → 새 버전 발견 → 다운로드 중 N% → 완료 / 최신입니다 / 에러)가 row에 실시간 표시됩니다. 별도 "릴리즈 노트 보기" row가 GitHub 페이지 외부 링크 역할을 이어받습니다. (ad-hoc 서명 단계에선 다운로드까지만 동작 — 정식 노타리 후 완전 자동 설치 가능.)
- **상단 탭 ⋯ overflow 메뉴** — 탭이 많아도 한 줄을 유지하고, 화면에 안 들어가는 탭은 ⋯ 버튼의 dropdown에서 선택할 수 있습니다.
- **최소 윈도우 504×327 + 좁은 화면 사이드바 자동 접힘** — 이전 최소 820×520에서 축소. 좁아진 화면에선 양 사이드바가 자동으로 접혀 본문 영역을 확보합니다 (사용자가 명시 토글한 상태는 우선).
- **Memory 패널 "초기화"가 archive까지 같이 비움** — 이전엔 archive 스냅샷이 보존됐습니다. 사용자가 "초기화"를 누르는 의도가 보통 전부 정리인 것이 확인되어 통합.
- **Hook 폴백 경로 정리** — agy 세션의 hook 설정이 `.agents/hooks.json` 위치로 이동했습니다. 기존 Gemini 세션의 `.gemini/settings.json` 마커 entry는 agy 설치 시 자동 정리됩니다.

### Added

- **세 CLI 사용량 직접 측정** — 정제 직후 사용된 CLI를 백그라운드로 띄워 `/usage` · `/status` 슬래시 명령으로 현재 quota를 직접 확인합니다. 설정 패널의 "지금 확인" 버튼으로 임의 CLI를 즉시 측정할 수도 있습니다. 한도 근접/초과 시 다음 정제부터 다른 CLI로 자동 폴백.
- **측정용 세션 흔적 정리** — 측정을 위해 임시로 띄운 CLI 세션은 종료와 동시에 자체 conversation 파일까지 삭제. 다음에 같은 CLI를 외부에서 `--resume` 등으로 열어도 측정용 세션이 보이지 않습니다.
- **설정 변경 즉시 반영** — 한 패널/윈도우에서 정제 정책을 바꾸면 다른 모든 곳의 활성 CLI 표시가 즉시 갱신됩니다.
- **메모리 주입 비활성 배지** — Hook 설치 실패로 IR 자동 주입이 동작하지 않는 세션은 탭에 ⚠ 배지가 표시됩니다. 이전엔 silent로 일반 CLI처럼 동작해 핵심 기능 비활성을 알아차리기 어려웠습니다.
- **세션 정렬 + reorder 모션** — 가장 최근에 채팅한 세션이 좌사이드바 최상단 / 상단 탭 좌측 끝으로 이동합니다. 정렬이 바뀔 때 부드러운 슬라이드 모션이 적용됩니다 (View Transitions API, 220ms). `prefers-reduced-motion` 사용자엔 즉시 적용.
- **턴 기록 상세 단계 설정** — Settings → "Turn 기록 상세" 에서 `full` / `compact` / `minimal` 중 선택. assistant 본문이 잘리는 글자 수가 단계별로 달라집니다 (full ~50KB / compact ~500자 / minimal ~200자).

### Fixed

- **한글 IME Shift+Enter race** — 한글 입력 중 Shift+Enter를 누르면 마지막 글자가 다음 줄로 끌려가거나 줄바꿈이 두 번 발생하던 문제. macOS IME가 keydown을 중복 발사하는 동작에 맞춰 입력 상태를 추적하도록 수정.
- **워크스페이스 경로 입력 처리** — Finder "경로 복사" / zsh `Mobile\ Documents` 등 escape·따옴표·`~` 가 들어간 경로를 입력하면 첫 세션 spawn이 ENOENT로 실패하던 문제. 이제 정상 cwd로 자동 변환되고, 미존재 경로는 생성 시점에 명확한 에러로 거부됩니다.

### Added — 진단

- **자동 업데이트 진행 상태 broadcast** — 업데이트 확인 → 다운로드 → 설치 대기 사이 모든 상태가 단일 채널로 전파되어 어느 윈도우에서든 동일하게 표시됩니다.
- **Quota 측정 디버그 로그** — 측정 실패 시 응답 본문 일부를 main.log에 남겨 CLI TUI 변경에 따른 회귀를 빠르게 진단할 수 있습니다.

## [0.0.3] — 2026-05-13

ad-hoc 서명 베타. 메모리 스냅샷 시간 표시 정정 + 진단 로그 강화.

### Fixed

- **메모리 패널 archive 카드 시각 표시** — 이전엔 "이 스냅샷이 archive에 push된 시각"(`archivedAt`)을 표시해, 가장 최근 archive와 현재 메모리가 동일 시각으로 보였습니다. 실제 IR이 정제된 시각(`ir.meta.updatedAt`)으로 정정해 현재 메모리와 archive 카드가 시계열로 구분됩니다.

### Changed

- **PTY 슬라이서 — CJK 공백 보존** — `compactBody`의 trailing whitespace 제거 로직이 CJK 사이 공백을 같이 깎던 문제 완화. 줄바꿈만 trim하는 방식으로 단순화.

### Added — 진단

- **renderer → main.log 통합** — preload에서 `electron-log/preload`를 로드해 renderer 측 로그가 main.log로 흘러들어옵니다. App.tsx 핵심 핸들러(`handleSelectTab`/`closeSession`/`closeAllAttachments`/`handleGoHome`/`handleHomeSubmit`/`handleCreateWorkspace`/`handleOpenCard`)에 breadcrumb 추가.
- **`sessions:close source` 필드** — IPC 요청에 발원처(`sidebar-trash` / `tab-x` / `workspace-switch` / `workspace-create` / `workspace-add` / `home-go` / `home-submit` / `workspace-removed` / `unknown`) 식별을 추가해 main.log에 함께 찍습니다. 세션이 사라지는 incident 발생 시 발원처를 즉시 추적할 수 있습니다.
- **XtermView 이벤트 로그** — mount / unmount / `isActive` 전환 / active-rAF의 fit·resize·refresh / PTY onExit / dispose race 시 warn. 탭 전환 프리즈 incident 진단 자료.

## [0.0.2] — 2026-05-13

ad-hoc 서명 베타. v0.0.1 패키지 빌드에서 발견된 결함 두 건 수정 + 자동 업데이트 채널 사전 도입.

### Fixed

- **Hook 시스템 자동 IR 주입이 패키지 빌드에서 항상 실패하던 문제** — `agentbridge-memory` helper binary 경로가 `process.resourcesPath/bin/...`로 잘못 참조돼 hook 없이 spawn 폴백됐습니다. `app.asar.unpacked/resources/bin/...`로 정정. 차별점 3(IR 자동 핸드오프)이 패키지 빌드에서 정상 동작합니다.
- **Gemini quota 자동 background probe가 패키지 빌드에서 즉시 종료되던 문제** — probe PTY spawn에 login shell PATH가 누락돼 `env: node: No such file or directory`로 exit 127. 어댑터 공용 env 빌더(`buildAdapterEnv`)를 probe 흐름에 inject. footer 자동 캡처 + 자동 폴백 흐름이 정상 동작합니다.

### Added

- **자동 업데이트(electron-updater)** — GitHub Releases의 `latest-mac.yml` 채널을 부팅 직후 + 6시간 주기로 polling. 새 버전 발견 시 백그라운드 다운로드 후 다음 종료 시 자동 설치. 진행/오류는 `~/Library/Logs/agentbridge/main.log`에 누적. ad-hoc 서명 단계에선 다운로드까지만 동작하며, Apple Developer ID 인증서 + notarytool 통과 후 update 흐름이 작동합니다.

## [0.0.1] — 2026-05-13

첫 공개. macOS만 지원, ad-hoc 서명 빌드.

> **외부 사용자 첫 실행 안내**: ad-hoc 서명이라 macOS Gatekeeper가 차단합니다.
> 다음 중 하나로 우회:
>
> 1. 터미널: `xattr -dr com.apple.quarantine /Applications/AgentBridge.app`
> 2. 시스템 설정 → 개인정보 보호 및 보안 → "그래도 열기"

### Added — 핵심 기능

- **멀티 에이전트 워크스페이스** — 한 워크스페이스 안에 Claude · Codex · Gemini CLI 탭을 동시에 띄울 수 있습니다. xterm.js로 각 CLI의 인터랙티브 화면을 그대로 임베드합니다.
- **IR 자동 핸드오프** — 매 사용자 메시지마다 IR(공유 메모리)이 hook 메커니즘으로 자동 주입됩니다. 모델을 갈아타도 작업 맥락이 끊기지 않습니다.
- **IR 정제** — Gemini 무료 티어를 헤드리스로 호출해 IR을 갱신합니다. 메인 모델(Claude/Codex) 토큰을 소비하지 않습니다. compaction 임계(turn 수/byte)를 넘으면 자동으로, 또는 메모리 패널 버튼으로 수동 실행할 수 있습니다.
- **메모리 패널** — 우측 사이드바에 AI 지시 / Refine·Quota / 메모리 3 그룹의 collapsible 카드. 현재 IR · 이전 스냅샷 · Turn 흐름을 한눈에 확인할 수 있고, IR 카드별 개별 삭제, 메모리 초기화, 수동 정제가 가능합니다.
- **세션 영속화 + resume** — 모든 워크스페이스/세션은 자동으로 저장되며, 앱 재실행 시 native CLI resume(`claude --resume` / `codex resume` / `gemini --resume`)으로 이전 대화를 그대로 이어갈 수 있습니다.
- **사용자 자산 격리** — 글로벌 설정(`~/.claude` / `~/.codex` / `~/.gemini`)은 수정하지 않습니다. 워크스페이스 cwd에는 CLI native config 3종(`.codex/hooks.json` / `.codex/config.toml` / `.gemini/settings.json`)만 마커 블록 merge로 추가합니다. claude는 cwd 무침범으로 동작합니다.

### Added — 부가 기능

- **드래그 앤 드롭 첨부** — 파일을 xterm 영역에 떨어뜨리면 절대 경로가 모델 입력에 자동 paste됩니다. bracketed paste로 자동 submit을 차단해 사용자가 직접 Enter를 누를 때까지 모델이 전송하지 않습니다. 한 번에 최대 20개 파일.
- **멀티 윈도우** — 워크스페이스를 별도 BrowserWindow로 띄울 수 있습니다. ⌘N으로 새 빈 윈도우, 좌 사이드바 우클릭 메뉴에서 "새 창으로 열기". 한 워크스페이스 = 한 윈도우 정책으로 중복 열림을 차단합니다.
- **내장 터미널 세션** — 일반 zsh PTY 탭. 모델 spawn 없이 CLI 환경 점검·잡일용으로 사용할 수 있습니다.
- **홈 화면 부트스트랩** — 앱 실행 시 홈 화면에서 메시지를 입력하면 `~/AgentBridge/Chat-YYMMDD-HHMM/` 폴더에 워크스페이스를 자동 생성해 모델을 시작합니다.
- **Gemini quota 자동 폴백** — Gemini CLI footer의 `X% used`를 자동 감지해 95% 이상이면 활성 모델로 자동 폴백합니다. 임계 진입 시 UI 배지로 안내하며, UTC 자정에 자동 해제됩니다.
- **워크스페이스/세션 인라인 rename** — 좌 사이드바 펜 아이콘 또는 우클릭 메뉴로 직접 이름 편집. IME composition 안전.
- **codex hook trust 안내** — codex의 `/hooks` 수동 승인 절차를 UI 배너로 안내합니다.

### Added — 단축키

- ⌘B / ⌘⌥B — 좌·우 사이드바 토글
- ⌘N — 새 빈 윈도우 (macOS Safari/Finder 표준)
- ⌘Q — 앱 종료
- Enter / ⇧Enter — 홈 화면 전송 / 줄바꿈
- Esc — 모달 닫기 · sub-page 뒤로
- ⇧Enter (터미널 안) — 줄바꿈 (Option+Enter 동등)

### Known limitations

- 다국어 UI(영어 등) 및 라이트 테마는 잠겨 있습니다(언어 `ko` / 테마 `dark` 고정).
- 사용자 정의 단축키, 로컬 LLM 어댑터, 드래그 앤 드롭 폴더 지원 없음.
- macOS 외 플랫폼(Windows/Linux) 빌드 없음.

[0.0.2]: https://github.com/h-taek/AgentBridge/releases/tag/v0.0.2
[0.0.1]: https://github.com/h-taek/AgentBridge/releases/tag/v0.0.1
