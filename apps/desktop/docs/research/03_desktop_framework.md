# 데스크톱 앱 프레임워크 리서치

> Phase 2 — Research / 주제 3: macOS MVP 기준에서 AgentBridge를 어떤 프레임워크로 만드는가

> ⚠️ **Phase 4 M0 capability probe 결과로 §10의 "PTY 임베드 = phase 2" 가정은 *철회됨*** ([probe_results.md §4](../plan/probe_results.md)). I/O 모델 = **모델 B (PTY + node-pty + xterm.js)** MVP 채택. node-pty는 `@homebridge/node-pty-prebuilt-multiarch`로 ASAR unpack 정책 적용([electron-builder.yml](../../electron-builder.yml)). §3의 Electron 권고와 §11의 결론(Electron 채택)은 그대로 유효.

## 1. 요약

- AgentBridge의 핵심 워크로드는 [02_model_integration.md](./02_model_integration.md)에서 확정한 대로 **CLI subprocess + headless JSON stream**이다. 즉 프레임워크 선정의 1차 기준은 (1) child process 관리, (2) JSONL 라인 단위 stream 파싱, (3) 환경변수 화이트리스트 전달, (4) macOS 패키징·서명·자동 업데이트의 4가지로 좁혀진다.
- 후보는 사실상 셋: **Electron**(Node) / **Tauri v2**(Rust) / **SwiftUI 네이티브**. Wails(Go), Flutter desktop, Neutralino는 동일 도메인의 검증된 OSS 선례가 빈약해 1인 OSS에는 위험.
- 동일 도메인(Claude / Codex / Gemini CLI 래퍼) OSS 선례는 두 갈래로 갈린다. **Electron + node-pty + xterm.js** 그룹(claude-console, coide, terminal-manager, wmux 변종, claude-code-web, op7418/CodePilot)과 **Tauri v2 + Rust** 그룹(cc-switch, Claudia, tuicommander, terraphim/liquid-glass-terminal). SwiftUI는 Clarc, Claudius 둘이 두드러진다.
- **권고**: MVP는 **Electron**. 근거 — (1) AgentBridge에 가장 가까운 OSS 5개 이상이 동일 스택, (2) JSONL 파싱·child process 관리가 Node 표준 라이브러리 1줄 수준, (3) phase 2의 PTY 임베드(node-pty + xterm.js)가 가장 매끄럽다. 트레이드오프 — 번들 100–150 MB, 유휴 메모리 200–300 MB. 1인 OSS의 우선순위에서 받아들일 만함.
- **재평가 조건**: (a) 번들/메모리가 차별점이 되어야 한다면 Tauri v2(Rust 학습 비용 2–3개월), (b) macOS 단일 타깃이 확정되고 native UX가 결정적이라면 SwiftUI(phase 2 PTY 비용이 가장 큼).

## 2. 후보 비교 매트릭스

| 항목 | Electron | Tauri v2 | SwiftUI 네이티브 |
|---|---|---|---|
| 백엔드 언어 | Node.js / TypeScript | Rust (+ JS API) | Swift |
| 렌더 엔진(macOS) | 번들 Chromium | 시스템 WKWebView | 네이티브 뷰 |
| Hello world 번들 | 80–150 MB | 8–12 MB | 수 MB (추정) |
| 유휴 메모리 (참고) | 200–300 MB | 30–80 MB | 가장 낮음 (추정) |
| 콜드 스타트 | 1–2초 | <0.5초 | 매우 빠름 (추정) |
| child process API | `child_process.spawn` / `utilityProcess` | `tauri-plugin-shell`의 `Command::spawn` | Foundation `Process` 또는 Swift 6.2 `Subprocess` |
| 라인 단위 stdout 스트리밍 | `child.stdout.on('data')` + 줄 분할 | `CommandEvent::Stdout(line)` (Tauri가 라인 분할 제공) | `FileHandle.readabilityHandler` 직접 드레인 또는 Swift 6.2 `AsyncSequence` |
| stdin 양방향 | 표준 (`child.stdin.write`) | 가능, 단 알려진 함정 (#5736, #4440) | 표준 (`Pipe`) |
| PTY 라이브러리 | **node-pty** (사실상 표준) | portable-pty / tauri-plugin-pty / alacritty_terminal | `forkpty(2)` C interop 직접 (검증 라이브러리 부재 — 추정) |
| 환경변수 pass-through | `env` 옵션 trivial. macOS GUI PATH 미상속은 모든 프레임워크 공통 | `Command::env(...)` trivial | `Process.environment` trivial |
| 패키징 도구 | electron-builder / electron-forge | tauri-bundler (`tauri build`) | Xcode + `notarytool` |
| Auto-update | electron-updater (Squirrel.Mac) | Tauri updater 또는 tauri-plugin-sparkle-updater | Sparkle |
| 학습 곡선(1인) | Node 한 가지면 충분 | Rust 2–3개월 (단순 케이스는 JS API만으로도 가능) | Apple 생태계 익숙도에 의존 |
| 동일 도메인 OSS 선례 | 5+개 (Anthropic Claude Desktop 포함) | 3+개 | 2개 |

수치는 동일 앱 마이그레이션 사례와 마케팅 자료가 섞여 있어 **자릿수 차이의 방향성**만 신뢰. Tauri 메모리도 페이지가 무거우면 200 MB 넘는다는 반례 있음([Tauri #5889](https://github.com/tauri-apps/tauri/issues/5889)). 출처: [Hopp 마이그레이션 사례](https://www.gethopp.app/blog/tauri-vs-electron), [codeology 2025](https://codeology.co.nz/articles/tauri-vs-electron-2025-desktop-development.html), [tech-insider 2026](https://tech-insider.org/tauri-vs-electron-2026/), [johal.in 비교](https://johal.in/you-use-tauri-20-electron-300-desktop-apps/), [RaftLabs 비교](https://www.raftlabs.com/blog/tauri-vs-electron-pros-cons/).

## 3. Electron

### 3.1 child process / JSONL 스트리밍

- `child_process.spawn`이 표준 진입점. stdout이 `Readable` 스트림이라 `on('data')` 후 `\n` 기준으로 split해 JSONL 라인 단위 파싱. [Electron Adventures Episode 16](https://dev.to/taw/electron-adventures-episode-16-streaming-terminal-output-431g), [Node.js child_process 문서](https://nodejs.org/api/child_process.html).
- Claude Code의 `claude -p '...' --output-format stream-json --verbose` 출력에 대해 커뮤니티 파서 다수 존재 — [Khan/format-claude-stream](https://github.com/Khan/format-claude-stream), [shibuido/claude-stream-json-parser](https://github.com/shibuido/claude-stream-json-parser), [awesome-claude-code 정리](https://github.com/hesreallyhim/awesome-claude-code/issues/1046). AgentBridge가 자체 파서를 만들 때 reference가 풍부하다.
- `utilityProcess`는 자체 작성한 Node 워커를 격리할 때 유용하나 외부 바이너리 spawn에는 일반 `spawn`을 그대로 쓰는 게 맞다. [utilityProcess 문서](https://www.electronjs.org/docs/latest/api/utility-process), [Slipper 가이드](https://www.matthewslipper.com/2019/09/22/everything-you-wanted-electron-child-process.html).

### 3.2 환경변수 pass-through 와 macOS PATH 함정

- `child_process.spawn(cmd, args, { env: { ...whitelisted } })` 로 화이트리스트 trivial.
- macOS GUI 앱은 `~/.zshrc` / `~/.zprofile` 미상속 → `/opt/homebrew/bin`, `~/.npm-global/bin` 등에 설치된 `claude`/`codex`/`gemini` 미발견. 알려진 고질 함정. [Electron #5626](https://github.com/electron/electron/issues/5626), [#550](https://github.com/electron/electron/issues/550), [haroldadmin 정리](https://blog.haroldadmin.com/posts/finding-right-path), [Auto-Claude #978](https://github.com/AndyMik90/Auto-Claude/issues/978).
- 표준 해법: [`sindresorhus/fix-path`](https://github.com/sindresorhus/fix-path) + 첫 실행 시 `which claude` 또는 사용자 명시 경로 입력. 캡처한 PATH/CLI 절대경로는 앱 설정에 영속화.

### 3.3 node-pty 통합과 ASAR 함정 (phase 2 영향)

- [Microsoft node-pty Electron 예제](https://github.com/microsoft/node-pty/blob/main/examples/electron/README.md)가 공식적으로 제공된다. 사실상 표준.
- `.node` 네이티브 모듈은 [`@electron-forge/plugin-auto-unpack-natives`](https://www.electronforge.io/config/plugins/auto-unpack-natives) 또는 electron-builder의 `asar.unpack: '**/*.node'` 로 자동 외부화.
- 단 `spawn-helper` 같은 비-`.node` 보조 실행 파일은 unpack에서 누락되어 macOS에서 크래시 → 별도 glob 추가 필요. [Forge #3934](https://github.com/electron/forge/issues/3934), [electron-builder #1285](https://github.com/electron-userland/electron-builder/issues/1285).
- Electron 메이저 버전과 ABI 호환 필요 — `electron-rebuild` 또는 prebuilt 사용.

### 3.4 패키징 / 서명 / 노타리 / Auto-update

- `electron-builder`가 DMG/zip/blockmap을 GitHub Releases에 자동 업로드. `afterSign` hook에 `notarytool` 호출이 표준. [electron.build/code-signing-mac](https://www.electron.build/code-signing-mac.html), [BigBinary 가이드](https://www.bigbinary.com/blog/code-sign-notorize-mac-desktop-app), [simonw til](https://github.com/simonw/til/blob/main/electron/sign-notarize-electron-macos.md).
- Apple Developer Program **$99/년** 사실상 필수. Developer ID Application 인증서 + Hardened runtime + 필요 시 entitlement(`com.apple.security.cs.allow-jit` 등 — 케이스별 확인 필요).
- Auto-update: `electron-updater`(Squirrel.Mac 백엔드), GitHub Releases publish provider 빌트인. 차분 업데이트(blockmap) 지원.

### 3.5 보안

- Electron 20+ renderer 기본 sandbox 활성. `contextIsolation` 끄지 말 것. [Sandbox 문서](https://www.electronjs.org/docs/latest/tutorial/sandbox/), [Process Model](https://www.electronjs.org/docs/latest/tutorial/process-model).

### 3.6 1인 OSS 사례

- [Tschonsen/claude-console](https://github.com/Tschonsen/claude-console), [vicmaster/coide](https://github.com/vicmaster/coide), [coneilen/terminal-manager](https://github.com/coneilen/terminal-manager), [vultuk/claude-code-web](https://github.com/vultuk/claude-code-web), [openwong2kim/wmux](https://github.com/openwong2kim/wmux), [op7418/CodePilot](https://github.com/op7418/CodePilot). 모두 `Electron main + node-pty + IPC + xterm.js` 패턴.
- Anthropic 자체 Claude Desktop도 Electron. [Drew Breunig 분석](https://www.dbreunig.com/2026/02/21/why-is-claude-an-electron-app.html), [tonsky.me — Fall of native](https://tonsky.me/blog/fall-of-native/).

## 4. Tauri v2

### 4.1 child process / 라인 단위 스트리밍

- 두 갈래의 통합 패턴.
  - **Shell plugin (사용자 환경의 외부 CLI 호출)**: `tauri-plugin-shell`의 `Command::new("claude").args(...).spawn()` → `CommandEvent::Stdout(line)`이 라인 단위로 들어온다. AgentBridge의 사전 로그인된 CLI 위임 모델과 부합. [Shell plugin 문서](https://v2.tauri.app/plugin/shell/), [CommandChild docs.rs](https://docs.rs/tauri-plugin-shell/latest/tauri_plugin_shell/process/struct.CommandChild.html).
  - **Sidecar (앱이 번들한 외부 바이너리)**: `externalBin: ["binaries/agent-bridge-helper"]` + `aarch64-apple-darwin`/`x86_64-apple-darwin` 두 벌. AgentBridge는 외부 CLI를 번들하지 않으므로 sidecar 경로는 해당 없음. [Sidecar 문서](https://v2.tauri.app/develop/sidecar/), [Samuel Magny 가이드](https://medium.com/@samuelint/tauri-how-to-start-stop-a-sidecar-and-pipe-sidecar-stdout-stderr-to-app-logs-from-rust-8f81a92111ad).
- Tauri가 라인 분할까지 해주므로 JSONL 친화적이다.

### 4.2 stdin 양방향의 알려진 함정

- AgentBridge가 IR을 stdin으로 주입하는 [02_model_integration.md §9.3](./02_model_integration.md) 결정과 직결되는 영역.
- 알려진 이슈: shell 스크립트에 stdin 못 보냄([Issue #5736](https://github.com/tauri-apps/tauri/issues/5736)), stdin이 자동으로 닫히지 않아 child가 EOF 대기 중 block([Discussion #4440](https://github.com/tauri-apps/tauri/discussions/4440)), sidecar에 시크릿(env) 표준 전달이 진행 중([Issue #12693](https://github.com/tauri-apps/tauri/issues/12693)).
- Rust 측에서 `CommandChild::write(bytes)`로 명시적으로 다뤄야 하며, MVP 채택 시 stdin 양방향 스트레스 테스트가 필수다.

### 4.3 환경변수 / PATH

- Rust `Command::env(K, V)` / `envs(map)` trivial. [Environment Variables 문서](https://v2.tauri.app/reference/environment-variables/).
- macOS GUI PATH 미상속 문제는 동일하게 발생. Rust 생태계엔 `fix-path` 동등품이 명시 라이브러리로 보이지 않음 — login shell 일회 spawn으로 PATH 캡처(`/bin/zsh -ilc 'echo -n $PATH'`)하거나 사용자 명시 입력 패턴을 직접 구현(추정).

### 4.4 PTY (phase 2 영향)

- [`portable-pty`](https://lib.rs/crates/portable-pty) — Wezterm 저자가 만든 cross-platform PTY. Wezterm 자체가 production 사용자라 안정성 신뢰도 높음(추정).
- [`tauri-plugin-pty`](https://crates.io/crates/tauri-plugin-pty) — 0.1.1 신생, production 적합성 확인 필요.
- `alacritty_terminal` 직접 임베드 — tuicommander가 실증.
- node-pty만큼의 사용 빈도는 아니지만 작동하는 패턴이 있다.

### 4.5 WebView 일관성

- macOS는 WKWebView 사용. macOS 단일 타깃이면 WKWebView만 검증하면 되어 오히려 단순(추정). 단 phase 3에서 Windows(WebView2/Chromium) / Linux(WebKitGTK) 확장 시 CSS/JS 호환성 매트릭스 추가됨. [Webview Versions](https://v2.tauri.app/reference/webview-versions/), [WKWebView 함정 사례](https://takazudomodular.com/pj/zudo-tauri/docs/frontend/playwright-engine-pitfall/), [macOS WebKit crash #11501](https://github.com/tauri-apps/tauri/issues/11501).

### 4.6 패키징 / 서명 / 노타리 / Auto-update

- [`tauri-action`](https://github.com/tauri-apps/tauri-action) GitHub Action이 universal binary 빌드, DMG 생성, Releases publish, `latest.json`(updater 매니페스트) 자동. 노타리도 `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` 환경변수 주면 자동. [Tauri GitHub guide](https://v2.tauri.app/distribute/pipelines/github/), [Massi production 가이드](https://dev.to/massi_24/shipping-a-production-macos-app-with-tauri-20-code-signing-notarization-and-homebrewpublished-o10), [tomtomdu73 Part 2](https://dev.to/tomtomdu73/ship-your-tauri-v2-app-like-a-pro-github-actions-and-release-automation-part-22-2ef7).
- Auto-update: 빌트인 [Tauri Updater](https://v2.tauri.app/plugin/updater/)는 동작은 하지만 macOS native dialog/background check 약하다는 평가. [yuexun.me](https://yuexun.me/native-macos-updates-in-tauri/).
- macOS 사용자 경험을 native급으로 끌어올리려면 [`tauri-plugin-sparkle-updater`](https://github.com/ahonn/tauri-plugin-sparkle-updater)로 Sparkle 통합 — EdDSA 검증, native dialog, 백그라운드 체크.

### 4.7 1인 OSS 사례

- [farion1231/cc-switch](https://github.com/farion1231/cc-switch) — 50+ provider 프리셋, 트레이 quick switch, MCP/Skills 양방향 동기화. Tauri 2 + React 18 + TS + Rust.
- [gaiin-platform/claudia](https://github.com/gaiin-platform/claudia) — Custom agents, 세션 매니지, 백그라운드 에이전트.
- [sstraus/tuicommander](https://github.com/sstraus/tuicommander) — 멀티 에이전트 병렬 오케스트레이션, git worktree 자동, alacritty_terminal 임베드.
- [terraphim/liquid-glass-terminal](https://github.com/terraphim/terraphim-liquid-glass-terminal) — Electron 기반 Liquid Terminal에서 Tauri로 명시적 포트.

## 5. SwiftUI 네이티브 macOS

### 5.1 child process / JSONL 스트리밍

- Foundation `Process`(NSTask 후신)는 작은 입출력엔 동작하나, OS 파이프 버퍼 한계 초과 시 hang 함정이 잘 알려져 있다. [Apple Developer forums](https://developer.apple.com/forums/thread/690310), [Swift Forums Process 글](https://forums.swift.org/t/basic-process-streaming-stdout-stderr-through-closure/15288).
- `FileHandle.readabilityHandler`로 계속 드레인하는 패턴이 정석. 또는 Swift 6.2의 새 [`Subprocess`](https://github.com/swiftlang/swift-subprocess)를 쓰면 `for try await line in process.standardOutput.lines` 같은 AsyncSequence가 가능해 JSONL 친화적. [TrozWare 2025 글](https://troz.net/post/2025/process-subprocess/), [Michael Tsai 정리](https://mjtsai.com/blog/2025/10/30/swift-6-2-subprocess/).
- 서드파티: [jamf/Subprocess](https://github.com/jamf/Subprocess).

### 5.2 stdin / 환경변수

- `Pipe.fileHandleForWriting.write(data)` 또는 Swift 6.2 `Subprocess`의 Async API.
- `Process.environment = ["PATH": ...]` trivial. macOS GUI PATH 미상속은 동일.

### 5.3 PTY (phase 2 비용 가장 큼)

- 표준 라이브러리에 PTY 추상화 없음. `forkpty(2)`/`openpty(3)`을 C interop으로 직접 호출하거나 자체 구현 필요.
- 검증된 Swift PTY 표준 라이브러리는 본 리서치 시점에 두드러지게 발견되지 않음 — 확인 필요.

### 5.4 패키징 / 서명 / Auto-update

- Xcode `xcodebuild archive` + `productbuild` 또는 `create-dmg`. fastlane / GitHub Actions(macOS runner)로 자동화.
- App Store는 sandboxing 제약이 강해 임의 child process spawn이 사실상 불가. AgentBridge는 **App Store가 아닌 Developer ID + 직접 배포** 경로(추정).
- Auto-update는 [Sparkle](https://sparkle-project.org/)이 사실상 표준. 사용자 경험은 가장 좋다.

### 5.5 단점

- Cross-platform 확장 시 코드 재사용 거의 0.
- 모던 채팅 UI(스트리밍 토큰, 마크다운, 코드 syntax highlight) 라이브러리 풀이 웹 기반보다 얇음(추정).

### 5.6 1인 OSS 사례

- [ttnear/Clarc](https://github.com/ttnear/Clarc) — claude CLI를 그대로 spawn, approval modal, per-project window. 비개발자 대상 표방.
- [Claudius (josh.ing)](https://www.josh.ing/claudius) — macOS 14+, multi-window, private alpha.
- [Indragie 블로그 — "Claude Code로 100% 작성한 macOS 앱"](https://www.indragie.com/blog/i-shipped-a-macos-app-built-entirely-by-claude-code) — 본문에 SwiftUI 명시는 못 찾음(확인 필요).

## 6. 기타 후보 (얕게)

- **Wails (Go)**: macOS는 WKWebView. Go의 `os/exec` + `bufio.Scanner` 깔끔. Go 친숙하면 매우 낮은 학습 비용. 단 동일 도메인 OSS 선례가 두드러지게 없어 1인 OSS가 자력으로 함정을 발견해야 함. [wails.io](https://wails.io/), [Wails 2026 회고](https://johal.in/wails-python-go-web-tech-desktop-applications-2026/).
- **Flutter desktop**: 채팅 UI 라이브러리가 모바일 중심. macOS native UX 적합도 낮음(추정). Flutter 엔진 때문에 번들 30 MB+ 정도. AgentBridge에 부적합.
- **Neutralino**: 매우 가볍지만 child process / PTY 생태계가 얇음. 부적합.

## 7. 직접 경쟁자 / 동일 도메인 선례 정리

| 프로젝트 | 프레임워크 | 패턴 | 비고 |
|---|---|---|---|
| [Tschonsen/claude-console](https://github.com/Tschonsen/claude-console) | Electron + React + xterm.js + node-pty | main에서 node-pty spawn → IPC → renderer xterm 렌더 | "Phase 1 prototype" |
| [vicmaster/coide](https://github.com/vicmaster/coide) | Electron + React 19 + xterm.js + node-pty | 멀티 탭 터미널 | TTY 그대로 |
| [coneilen/terminal-manager](https://github.com/coneilen/terminal-manager) | Electron + xterm.js + node-pty | `~/.claude/history.jsonl` 임포트, 세션 영속화 | Claude+Copilot |
| [openwong2kim/wmux](https://github.com/openwong2kim/wmux) | Electron + ConPTY (Windows) | tmux 스타일 분할 + MCP server | Windows 전용 변종 |
| [op7418/CodePilot](https://github.com/op7418/CodePilot) | Electron + Next.js | MCP & skills 확장, 폰에서 제어 | Cross-provider 클라이언트 |
| Anthropic Claude Desktop | Electron | 코드 공유(웹↔데스크톱) | 공식 사례 |
| [farion1231/cc-switch](https://github.com/farion1231/cc-switch) | Tauri 2 + React 18 + TS + Rust | 50+ provider 프리셋, 트레이 quick switch, MCP/Skills 동기화 | Claude+Codex+Gemini+OpenCode 통합 매니저 — AgentBridge와 가장 유사 |
| [gaiin-platform/claudia](https://github.com/gaiin-platform/claudia) | Tauri 2 + React 18 + TS + Rust | Custom agents, 세션 매니지 | macOS/Linux/Windows |
| [sstraus/tuicommander](https://github.com/sstraus/tuicommander) | Tauri + SolidJS + Rust + alacritty_terminal | 멀티 에이전트 병렬, git worktree 자동, RAM ~80 MB | 10개 에이전트 자동 감지 |
| [terraphim/liquid-glass-terminal](https://github.com/terraphim/terraphim-liquid-glass-terminal) | Tauri + Rust + TS | Electron→Tauri 명시적 포트 | 메모리 ↓ |
| [ttnear/Clarc](https://github.com/ttnear/Clarc) | SwiftUI native | claude CLI spawn, approval modal, per-project window | 비개발자 대상 |
| [Claudius](https://www.josh.ing/claudius) | SwiftUI native | macOS 14+, multi-window | private alpha |
| [Subspace](https://www.subspace.build/) | 미공개(추정 macOS native — 확인 필요) | multi-panel workspace, "Shared Agent Memory" | 직접 경쟁자 — [02_model_integration.md §8.4](./02_model_integration.md) |
| [JetBrains Air](https://www.jetbrains.com/help/air/quick-start-with-air.html) | 자체 ADE | parallel orchestration | 상용 |

핵심 관찰: **AgentBridge에 가장 가까운 OSS 다수가 Electron + node-pty + xterm.js** 라는 점은 객관적으로 확인된다. Tauri 그룹은 도메인 적합도가 비등하지만 stdin 양방향 함정이 있어 핵심 설계와 정면으로 부딪힐 수 있다. SwiftUI 그룹은 macOS native UX가 가장 좋지만 phase 2 PTY 비용이 가장 크다.

## 8. macOS 패키징 · 서명 · 자동 업데이트 비교

### 8.1 공통 — Apple Developer Program $99/년 사실상 필수

Developer ID Application 인증서가 있어야 GateKeeper가 quarantine을 자동 해제하고 노타리 결과를 신뢰한다. 사이닝 없는 앱은 macOS Sequoia에서 우클릭→열기조차 점점 까다로워지는 추세(추정). Hardened runtime + 필요 시 entitlement(케이스별). 첫 노타리는 8–12시간 걸릴 수 있고 이후 ~10분. [BigBinary 가이드](https://www.bigbinary.com/blog/code-sign-notorize-mac-desktop-app), [Electron Code Signing](https://www.electronjs.org/docs/latest/tutorial/code-signing).

### 8.2 도구별 흐름

| 항목 | electron-builder / Forge | tauri-bundler (`tauri build`) | Xcode + notarytool |
|---|---|---|---|
| DMG/zip 생성 | yes | yes | yes |
| Universal binary (arm64+x86_64) | yes | `--target universal-apple-darwin` | xcodebuild 자동 |
| GitHub Releases publish | `publish: github` | `tauri-action`으로 자동 | 수동 또는 GitHub Actions |
| 노타리 hook | `afterSign` 커스텀 스크립트 | tauri-action에 `APPLE_*` 주면 자동 | `xcrun notarytool submit` |
| Sparkle 통합 | 비공식, 직접 | `tauri-plugin-sparkle-updater` | 사실상 표준 |
| ASAR/native unpack 함정 | 있음 (§3.3) | 해당 없음 | 해당 없음 |

### 8.3 Auto-update 비교

- **Squirrel.Mac (electron-updater)**: 검증, 차분 업데이트(blockmap) 지원. 자체 UI(non-native dialog).
- **Sparkle**: macOS 사용자에게 익숙한 native dialog, EdDSA 검증, 백그라운드 체크, phased rollout, 다국어. SwiftUI 앱 사실상 표준. Tauri는 plugin으로 통합 가능.
- **Tauri 빌트인 updater**: 동작은 함, native UX는 약함이라는 평가.

### 8.4 외부 CLI 호출 시 macOS 정책

- AgentBridge가 사용자 환경에 사전 설치된 `claude`/`codex`/`gemini`를 spawn하는 모델이므로, 외부 CLI 자체에 대한 Gatekeeper 적용 여부는 별개 이슈가 아님(추정). 다만 macOS 14+에서 child가 부모와 다른 entitlement를 가질 때 정책이 까다로워지는 사례 보고가 있어 케이스별 확인 필요.
- macOS GUI 앱의 PATH 미상속은 모든 프레임워크 공통 함정. §3.2 / §4.3 / §5.2 참조.

## 9. PTY 라이브러리 (phase 2)

| 프레임워크 | 권장 옵션 | 성숙도 |
|---|---|---|
| Electron | [node-pty](https://github.com/microsoft/node-pty) | 사실상 표준. Microsoft 유지보수. ASAR unpack 함정 있음(§3.3) |
| Tauri | [portable-pty](https://lib.rs/crates/portable-pty) (Wezterm 저자), [tauri-plugin-pty](https://crates.io/crates/tauri-plugin-pty), `alacritty_terminal` 직접 임베드 | portable-pty는 Wezterm 자체가 production 사용자. plugin은 0.1.1 신생 |
| SwiftUI | `forkpty(2)`/`openpty(3)` C interop 직접 | 표준 라이브러리 부재 — 가장 비싼 경로 |

추가 참고: [marc2332/tauri-terminal](https://github.com/marc2332/tauri-terminal), [yofabr/tauri-pty](https://github.com/yofabr/tauri-pty), [Wezterm portable_pty 이슈 #6946](https://github.com/wezterm/wezterm/issues/6946).

## 10. AgentBridge MVP에서 우회 / 타협 가능한 부분

| 영역 | MVP 처리 |
|---|---|
| PTY 임베드 | **헤드리스 + 자체 채팅 UI** ([02_model_integration.md §9.3](./02_model_integration.md)). PTY는 phase 2 — 프레임워크 선정 시 미래 비용으로 평가 |
| Universal binary | MVP에서는 Apple Silicon 단독부터 시작해도 됨. electron-builder/tauri-bundler 모두 phase 후반에 universal로 전환 부담 작음 |
| Sparkle vs 빌트인 updater | MVP는 빌트인 updater(electron-updater 또는 Tauri updater)로 시작. 사용자 피드백에서 native UX 요구가 강해지면 Sparkle로 전환 |
| 사이닝/노타리 | Apple Developer Program 가입은 첫 릴리즈 직전에 진행 (개발 단계는 미사이닝 빌드 + `xattr -d com.apple.quarantine` 안내) |
| PATH 캡처 UX | 첫 실행 시 자동 감지 + 실패 시 사용자 입력 화면. fix-path는 MVP에서, 정교한 PATH 캡처는 phase 1.5 |
| 환경변수 격리 | 사용자 shell env 상속하되, AgentBridge가 의도적으로 설정하는 키만 명시 추가 ([02_model_integration.md §9.4](./02_model_integration.md)와 일관) |

## 11. 권고

### 11.1 결론 — Electron

AgentBridge MVP는 **Electron**을 채택한다.

근거:
1. **선례 풍부**. Claude/Codex/Gemini CLI 래퍼 OSS의 사실상 디폴트 스택이 `Electron + node-pty + xterm.js`다. 1인 OSS에 reference 5개 이상 = 큰 자산. Anthropic 자체 Claude Desktop도 Electron이라는 사실은 메시지로도 강하다.
2. **핵심 워크로드 적합**. AgentBridge의 핵심은 stream-json/JSONL 파싱·중계 + child process lifecycle. Node 표준 라이브러리 1줄 수준이고, 커뮤니티 파서(Khan/format-claude-stream 등) 즉시 차용 가능.
3. **Phase 2 PTY 진입 매끄러움**. node-pty + xterm.js 조합은 OSS 사례 5개를 그대로 reference로 쓸 수 있다. ASAR unpack 함정은 잘 알려져 있어 1일 내 해결(추정).
4. **Tauri의 stdin 양방향 함정**이 AgentBridge 핵심 설계와 정면으로 부딪힌다. IR 주입은 stdin write 패턴이 핵심이고, 알려진 이슈(#5736, #4440)와 진행 중 작업(#12693)을 우회·검증할 시간 비용이 1인 개발에 부담.

비용/트레이드오프:
- 번들 100–150 MB, 유휴 메모리 200–300 MB. 사용자가 "또 Electron이야?"라고 반응할 수 있음. 1인 OSS 우선순위에서 받아들임.
- macOS GUI PATH 미상속 → `fix-path` + 첫 실행 PATH 캡처 패턴 필수.
- Apple Developer Program $99/년은 첫 공식 릴리즈 시점부터 필수.

### 11.2 재평가 조건

- **Z-1 (Tauri v2 전환)**: cross-platform 출시가 phase 1.5로 앞당겨지거나, 번들/메모리가 차별점으로 부각되면 재평가. 단 Rust 학습 비용 2–3개월. cc-switch / Claudia / tuicommander가 reference. stdin 양방향은 shell plugin Command 경로 + `CommandChild::write` 명시 사용 + 스트레스 테스트로 우회.
- **Z-2 (SwiftUI 전환)**: macOS 단일 타깃이 확정되고 native UX·번들·전력 소비가 핵심 KPI가 되면 재평가. phase 2 PTY 비용이 가장 크다는 점을 감수해야 함. Clarc / Claudius가 reference.
- **Z-3 (Wails)**: Go 친숙도가 매우 높고 Rust/Swift 모두 회피하고 싶은 경우. 동일 도메인 OSS 선례 빈약 — 권장도 비권장도 아님.

### 11.3 MVP 셋업 시 동시 처리 항목

- electron-builder 또는 electron-forge 셋업 + macOS DMG 타깃
- `fix-path` 또는 첫 실행 PATH 캡처 패턴 + 사용자 명시 입력 fallback
- ASAR unpack 정책 ( phase 2 node-pty 진입 시점에 `**/*.node` + `spawn-helper` 추가 )
- Apple Developer Program 가입 일정 (첫 공식 릴리즈 ~2개월 전)
- electron-updater + GitHub Releases publish provider
- Renderer sandbox/contextIsolation 켠 상태 유지

### 11.4 단일 통합 vs 모델별 다른 처리

[02_model_integration.md §9.2](./02_model_integration.md)의 "단일 패턴(CLI subprocess)" 결정은 그대로 유지된다. 프레임워크 선택과 무관하게 세 CLI 모두 동일한 spawn → JSONL 파싱 어댑터를 거친다. Electron의 Node child_process / Tauri의 shell plugin Command / SwiftUI의 Process 어떤 경로든 추상화 단일성은 유지 가능.

## 12. 미해결 질문

1. **Sparkle 도입 시점**. MVP는 electron-updater로 시작하지만, 사용자 피드백에서 native dialog 요구가 강하면 Sparkle로 전환. 비용·기대 효과·도입 시점 별도 판단 필요.
2. **Apple Silicon 단독 vs Universal binary**. MVP는 어느 쪽으로 시작할지. 한국 개발자 커뮤니티의 Intel Mac 사용자 비중 데이터 부재 — 확인 필요.
3. **Subspace의 실제 프레임워크**. 공식 문서에 기술 스택 언급이 두드러지지 않음. SwiftUI native 추정이지만 미확인. 차별점 분석에 직접 영향은 없으나 마케팅 비교 시 참고.
4. **node-pty의 Electron 메이저 버전 호환성**. AgentBridge가 채택할 Electron 버전(36+ 가정)에서 node-pty 최신 stable의 ABI 호환성 — 첫 빌드 시 검증 필요.
5. **macOS 14+ child entitlement 정책**. 부모 앱이 hardened runtime + 특정 entitlement를 가진 상태에서 외부 CLI(`claude` 등)를 spawn할 때 정책 변화 — 첫 노타리 시도 후 확인 필요.
6. **macOS GUI PATH 캡처의 정합성**. login shell 일회 spawn(`/bin/zsh -ilc 'echo -n $PATH'`)이 사용자가 의도한 PATH와 항상 일치하는지 — 사용자 환경(직접 export, dotfiles 미사용 등)에서 예외 처리 패턴 필요.

## 13. 참고

- 프레임워크 비교 — [Hopp 마이그레이션](https://www.gethopp.app/blog/tauri-vs-electron), [codeology 2025](https://codeology.co.nz/articles/tauri-vs-electron-2025-desktop-development.html), [tech-insider 2026](https://tech-insider.org/tauri-vs-electron-2026/), [johal.in 비교](https://johal.in/you-use-tauri-20-electron-300-desktop-apps/), [RaftLabs](https://www.raftlabs.com/blog/tauri-vs-electron-pros-cons/), [Tauri v2 vs Electron 6개월 회고](https://dev.to/hiyoyok/tauri-v2-vs-electron-after-6-months-of-real-development-my-honest-take-2ic0), [supportdevs.com](https://supportdevs.com/en/rust-tauri-apps/), [Tauri #5889 메모리 반례](https://github.com/tauri-apps/tauri/issues/5889)
- Tauri shell / sidecar / stdin — [Sidecar 문서](https://v2.tauri.app/develop/sidecar/), [Shell plugin](https://v2.tauri.app/plugin/shell/), [Shell JS reference](https://v2.tauri.app/reference/javascript/shell/), [tauri-plugin-shell crates.io](https://crates.io/crates/tauri-plugin-shell), [CommandChild docs.rs](https://docs.rs/tauri-plugin-shell/latest/tauri_plugin_shell/process/struct.CommandChild.html), [Pipe stdout 가이드](https://medium.com/@samuelint/tauri-how-to-start-stop-a-sidecar-and-pipe-sidecar-stdout-stderr-to-app-logs-from-rust-8f81a92111ad), [Discussion #8641](https://github.com/tauri-apps/tauri/discussions/8641), [Discussion #4440](https://github.com/tauri-apps/tauri/discussions/4440), [Issue #5736](https://github.com/tauri-apps/tauri/issues/5736), [Issue #12693](https://github.com/tauri-apps/tauri/issues/12693), [Environment Variables](https://v2.tauri.app/reference/environment-variables/)
- Tauri PTY / WebView — [portable-pty](https://lib.rs/crates/portable-pty), [tauri-plugin-pty](https://crates.io/crates/tauri-plugin-pty), [tauri-plugin-pty docs.rs](https://docs.rs/crate/tauri-plugin-pty/latest), [marc2332/tauri-terminal](https://github.com/marc2332/tauri-terminal), [yofabr/tauri-pty](https://github.com/yofabr/tauri-pty), [Wezterm #6946](https://github.com/wezterm/wezterm/issues/6946), [Webview Versions](https://v2.tauri.app/reference/webview-versions/), [WRY](https://github.com/tauri-apps/wry), [WKWebView 함정](https://takazudomodular.com/pj/zudo-tauri/docs/frontend/playwright-engine-pitfall/), [Tauri #11501](https://github.com/tauri-apps/tauri/issues/11501)
- Electron child_process / utilityProcess / PATH — [child_process 문서](https://nodejs.org/api/child_process.html), [utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process), [Process Model](https://www.electronjs.org/docs/latest/tutorial/process-model), [Streaming Terminal Output](https://dev.to/taw/electron-adventures-episode-16-streaming-terminal-output-431g), [Slipper 가이드](https://www.matthewslipper.com/2019/09/22/everything-you-wanted-electron-child-process.html), [Electron #5626](https://github.com/electron/electron/issues/5626), [Electron #550](https://github.com/electron/electron/issues/550), [haroldadmin PATH 글](https://blog.haroldadmin.com/posts/finding-right-path), [fix-path](https://github.com/sindresorhus/fix-path), [Auto-Claude #978](https://github.com/AndyMik90/Auto-Claude/issues/978)
- Electron 보안 / sandbox — [Sandbox](https://www.electronjs.org/docs/latest/tutorial/sandbox/), [Breach to Barrier](https://www.electronjs.org/blog/breach-to-barrier), [crashReporter](https://www.electronjs.org/docs/latest/api/crash-reporter)
- Electron node-pty / asar — [node-pty Electron 예제](https://github.com/microsoft/node-pty/blob/main/examples/electron/README.md), [Auto Unpack Natives plugin](https://www.electronforge.io/config/plugins/auto-unpack-natives), [npm](https://www.npmjs.com/package/@electron-forge/plugin-auto-unpack-natives), [packager #1841](https://github.com/electron/packager/pull/1841), [electron-builder #1285](https://github.com/electron-userland/electron-builder/issues/1285), [Forge #3934](https://github.com/electron/forge/issues/3934), [ASAR Archives 문서](https://www.electronjs.org/docs/latest/tutorial/asar-archives), [Thomas Deegan 가이드](https://thomasdeegan.medium.com/electron-forge-node-pty-9dd18d948956)
- macOS 사이닝 / 노타리 / 패키징 — [BigBinary 가이드](https://www.bigbinary.com/blog/code-sign-notorize-mac-desktop-app), [omkarcloud 예제](https://github.com/omkarcloud/macos-code-signing-example), [Electron Code Signing](https://www.electronjs.org/docs/latest/tutorial/code-signing), [electron-builder MacOS](https://www.electron.build/code-signing-mac.html), [Forge macOS 사이닝](https://www.electronforge.io/guides/code-signing/code-signing-macos), [simonw til](https://github.com/simonw/til/blob/main/electron/sign-notarize-electron-macos.md), [Tauri GitHub guide](https://v2.tauri.app/distribute/pipelines/github/), [Massi production 가이드](https://dev.to/massi_24/shipping-a-production-macos-app-with-tauri-20-code-signing-notarization-and-homebrewpublished-o10), [tauri-action](https://github.com/tauri-apps/tauri-action), [tomtomdu73 Part 2](https://dev.to/tomtomdu73/ship-your-tauri-v2-app-like-a-pro-github-actions-and-release-automation-part-22-2ef7)
- Auto-update — [Tauri Updater](https://v2.tauri.app/plugin/updater/), [tauri-plugin-sparkle-updater](https://github.com/ahonn/tauri-plugin-sparkle-updater), [crates.io](https://crates.io/crates/tauri-plugin-sparkle-updater), [Native macOS Updates in Tauri](https://yuexun.me/native-macos-updates-in-tauri/), [Tauri auto-updater til](https://thatgurjot.com/til/tauri-auto-updater/), [Sparkle](https://sparkle-project.org/)
- SwiftUI / Foundation Process / Subprocess — [Process 문서](https://developer.apple.com/documentation/foundation/process), [Swift Forums Process 글](https://forums.swift.org/t/basic-process-streaming-stdout-stderr-through-closure/15288), [Apple Developer forums](https://developer.apple.com/forums/thread/690310), [jamf/Subprocess](https://github.com/jamf/Subprocess), [Hacking with Swift Process](https://www.hackingwithswift.com/example-code/system/how-to-run-an-external-program-using-process), [Swift 6.2 Subprocess (Tsai)](https://mjtsai.com/blog/2025/10/30/swift-6-2-subprocess/), [Pitch — Swift Subprocess](https://forums.swift.org/t/pitch-swift-subprocess/69805), [swiftlang/swift-subprocess](https://github.com/swiftlang/swift-subprocess), [TrozWare 2025](https://troz.net/post/2025/process-subprocess/)
- 1인 OSS Electron — [claude-console](https://github.com/Tschonsen/claude-console), [coide](https://github.com/vicmaster/coide), [terminal-manager](https://github.com/coneilen/terminal-manager), [claude-code-web](https://github.com/vultuk/claude-code-web), [wmux openwong2kim](https://github.com/openwong2kim/wmux), [wmux amirlehmam](https://github.com/amirlehmam/wmux), [CodePilot](https://github.com/op7418/CodePilot), [Drew Breunig — Why Claude is Electron](https://www.dbreunig.com/2026/02/21/why-is-claude-an-electron-app.html), [tonsky.me — Fall of native](https://tonsky.me/blog/fall-of-native/)
- 1인 OSS Tauri — [cc-switch](https://github.com/farion1231/cc-switch), [Claudia](https://github.com/gaiin-platform/claudia), [claudia.so](https://claudia.so/), [tuicommander](https://github.com/sstraus/tuicommander), [liquid-glass-terminal](https://github.com/terraphim/terraphim-liquid-glass-terminal), [Apidog Claudia 소개](https://apidog.com/blog/claudia-the-gui-for-claude-code/)
- 1인 OSS SwiftUI — [Clarc](https://github.com/ttnear/Clarc), [Claudius](https://www.josh.ing/claudius), [Indragie 사례](https://www.indragie.com/blog/i-shipped-a-macos-app-built-entirely-by-claude-code)
- 기타 — [Wails](https://wails.io/), [Wails 2026](https://johal.in/wails-python-go-web-tech-desktop-applications-2026/), [Khan/format-claude-stream](https://github.com/Khan/format-claude-stream), [shibuido/claude-stream-json-parser](https://github.com/shibuido/claude-stream-json-parser), [awesome-claude-code parser issue](https://github.com/hesreallyhim/awesome-claude-code/issues/1046), [stream-json duplicate session bug](https://github.com/anthropics/claude-code/issues/5034), [avasdream — Wrapping Claude CLI](https://avasdream.com/blog/claude-cli-agentic-wrapper)
