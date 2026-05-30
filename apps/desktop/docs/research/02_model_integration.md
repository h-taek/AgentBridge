# 모델 연동 리서치

> Phase 2 — Research / 주제 2: Claude Code, Codex CLI, Gemini CLI를 데스크톱 앱에서 어떻게 연결하는가

> ⚠️ **Phase 4 M0 capability probe 결과로 §9.3의 "headless+자체 채팅 UI MVP" 권고는 *철회됨*** ([probe_results.md §4](../plan/probe_results.md)). 세 CLI 모두 인터랙티브 모드 = 풀스크린 TUI 전용이고 stream-json 동시 출력 불가 → MVP는 **모델 B (PTY + node-pty + xterm.js raw forward)** 채택. headless 흐름은 *IR refine spawn에만* 한정 사용. 자세한 결정 흐름은 [01_mvp_scope.md §5](../plan/01_mvp_scope.md) / [02_architecture.md](../plan/02_architecture.md) 참조.

## 1. 요약

- 세 CLI(Claude Code / Codex CLI / Gemini CLI) 모두 **headless 비대화형 모드**와 **JSON/JSONL 스트리밍 출력**을 공식 지원하므로 subprocess 통합에 기술적 장애물이 거의 없다.
- Claude Agent SDK는 내부적으로 Claude Code CLI를 spawn해 stdin/stdout JSONL로 통신하고, OpenAI Codex SDK도 `codex exec --json`을 wrapping한 얇은 layer다. Gemini는 별도 agent SDK가 없고 CLI 자체의 headless 모드를 쓴다 — 즉 SDK를 쓰든 안 쓰든 결국 CLI subprocess가 본체다.
- **인증/과금 모델 차이가 가장 큰 설계 제약**이다. Claude Code OAuth(Pro/Max 구독) 토큰은 Anthropic 약관상 SDK/3rd-party에서 사용 금지 — AgentBridge가 SDK/API 직접 호출 방식을 쓰면 사용자 구독을 활용할 수 없다.
- **권장 통합 전략**: 세 모델 모두 "CLI subprocess + headless JSON stream" 단일 패턴. (1) 사용자가 가진 OAuth/구독 인증을 그대로 위임, (2) 각 CLI의 도구·권한·sandbox를 그대로 활용, (3) AgentBridge는 IR 주입과 출력 파싱만 담당.
- 동일 패턴 선례 다수 — claude-squad, claude_code_bridge, wmux, agent-of-empires, tuicommander, JetBrains Air. 모두 tmux/PTY 또는 child process로 세 CLI를 묶는다.

## 2. 통합 옵션 비교

### 2.1 Claude Code

| 옵션 | 설명 | 장점 | 단점 |
|---|---|---|---|
| (a) Claude Code CLI subprocess | `claude -p "<prompt>" --output-format stream-json` | UX 그대로 재현, 사용자 OAuth 구독 사용 가능, 도구·권한·sandbox 위임 | Node/Bun 의존, PTY 필요할 때 처리 복잡, 버전 업데이트 추적 |
| (b) Anthropic Messages API 직접 호출 | `anthropic` SDK로 `messages.create` | 가장 작은 의존성 | 도구 루프(파일 읽기/쓰기/bash) 직접 구현 필요 → "Claude Code 경험" 사라짐. **구독 OAuth 사용 불가** |
| (c) Claude Agent SDK (Python/TS) | `@anthropic-ai/claude-agent-sdk`, `claude-agent-sdk` | Claude Code의 agent 루프·tool use·MCP 노출, query()/ClaudeSDKClient API | **OAuth 구독 사용 금지(Anthropic 약관)**, API 키 종량제만. SDK도 내부에서 CLI를 spawn |

핵심 사실:
- Claude Agent SDK는 내부적으로 Claude Code CLI를 subprocess로 spawn하고 stdin/stdout JSON으로 통신한다 — (c)는 (a)의 wrapper. [SDK 내부 구조 분석](https://buildwithaws.substack.com/p/inside-the-claude-agent-sdk-from), [GitHub anthropics/claude-agent-sdk-python](https://github.com/anthropics/claude-agent-sdk-python)
- OAuth 토큰의 SDK 사용 금지: "OAuth tokens obtained through Claude Free, Pro, or Max accounts cannot be used in any product, tool, or service — including the Agent SDK." [공식 인증 문서](https://code.claude.com/docs/en/authentication), [OAuth vs API Key 정리](https://lalatenduswain.medium.com/claude-code-on-claude-max-plan-understanding-oauth-token-vs-api-key-authentication-in-2026-96a6213d2cde)

### 2.2 Codex CLI

| 옵션 | 설명 | 장점 | 단점 |
|---|---|---|---|
| (a) Codex CLI subprocess | `codex exec --json "<prompt>"` (newline-delimited events) | 사용자 ChatGPT 로그인/구독 그대로 사용, sandbox/approval 모드 활용 | Rust 바이너리 의존 |
| (b) OpenAI Responses/Chat Completions API 직접 호출 | `openai` SDK | 가장 단순 | Codex agent 루프(workspace-write, sandbox, approval) 재현 필요, ChatGPT 구독 적용 불가 |
| (c) Codex SDK (TS) | `@openai/codex-sdk` | `codex.startThread().run()`, `runStreamed()`, `resumeThread()` | (a)의 얇은 wrapper. Node 18+ 필요 |

확인 사실: TypeScript SDK는 `codex exec`를 child process로 spawn하고 JSONL 이벤트(thread.started, turn.started, item.*, turn.completed, error 등)를 ThreadEvent로 파싱. [Codex SDK 문서](https://developers.openai.com/codex/sdk), [SDK README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md)

### 2.3 Gemini CLI

| 옵션 | 설명 | 장점 | 단점 |
|---|---|---|---|
| (a) Gemini CLI subprocess | `gemini -p "<prompt>" --output-format stream-json` | 사용자 OAuth 구독, sandbox/YOLO/approval 모드 활용 | Node 의존 |
| (b) Google Generative AI / Vertex AI API 직접 호출 | `@google/generative-ai`, `@google-cloud/vertexai` | 단순한 chat 호출 | Gemini CLI agent 루프(파일/bash/MCP/checkpoint) 재현 필요 |
| (c) 공식 Gemini "Agent" SDK | **존재하지 않음**(확인 필요) — Generative AI SDK는 모델 호출용 | — | — |

확인 사실: Gemini CLI는 `--output-format json` / `--output-format stream-json` 모두 지원, `--yolo` 또는 `--approval-mode=yolo`로 자동 승인. [Headless 문서](https://geminicli.com/docs/cli/headless/), [stream-json PR #10883](https://github.com/google-gemini/gemini-cli/pull/10883)

## 3. I/O 채널 / 스트리밍

| 항목 | Claude Code | Codex CLI | Gemini CLI |
|---|---|---|---|
| 비대화형 진입점 | `claude -p` (또는 `--print`) | `codex exec` | `gemini -p` 또는 non-TTY 자동 진입 |
| stdin 프롬프트 입력 | 가능, 10MB 캡 (v2.1.128+) | 가능 | 가능 |
| 출력 포맷 | `text` / `json` / `stream-json` | `--json`(JSONL) | `--output-format text\|json\|stream-json` |
| 토큰 단위 streaming | stream-json 한 줄당 한 이벤트 | JSONL 이벤트(item.updated, agent message delta) | stream-json JSONL |
| stderr 사용 | 진단/에러 | exec 모드는 events to stdout/stderr | 진단/에러 |
| exit code | non-zero on failure (예: stdin 10MB 초과) | 작업 완료 시 0, 실패 시 non-zero | 표준 |
| 도구 호출 관찰 | stream-json에 tool_use/tool_result | item.* 이벤트(command, file change, MCP tool, web search, plan update) | stream-json에 tool 호출 이벤트 |

출처: [Claude Code Headless](https://code.claude.com/docs/en/headless), [stream-json 분석](https://backgroundclaude.com/blog/stream-json), [Codex Non-interactive](https://developers.openai.com/codex/noninteractive), [Codex exec.md](https://github.com/openai/codex/blob/main/docs/exec.md), [Gemini Headless](https://geminicli.com/docs/cli/headless/)

## 4. 인증

| CLI | 인증 방식 | 자격증명 저장 | AgentBridge 위임 전략 |
|---|---|---|---|
| Claude Code | (1) `claude /login` OAuth → Pro/Max/Team/Enterprise. (2) `ANTHROPIC_API_KEY` 환경변수(OAuth보다 우선, 종량제). (3) `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`(1년 장수명, 헤드리스용) | OS 키체인 또는 `~/.claude/` | 사용자가 OS 터미널에서 `claude login`을 미리 끝내두면 spawn 시 동일 자격증명 자동 사용 |
| Codex CLI | (1) `codex login`(브라우저 OAuth → ChatGPT Plus/Pro). (2) `codex login --device-auth`(원격). (3) `OPENAI_API_KEY` 또는 `codex login --with-api-key` | `auth.json`(`CODEX_HOME`, 기본 `~/.codex`) 또는 OS keyring | 사전 로그인 위임. 단 `OPENAI_API_KEY`가 잡히면 ChatGPT 구독 로그인이 무시되는 알려진 이슈 — spawn 시 환경변수 격리 주의 |
| Gemini CLI | (1) Google 계정 OAuth(브라우저). (2) `GEMINI_API_KEY`(AI Studio). (3) Vertex AI: ADC/`gcloud`/Service Account JSON+`GOOGLE_CLOUD_PROJECT`+`GOOGLE_CLOUD_LOCATION` | `~/.gemini/` | 사전 로그인 위임. Vertex 사용자에게는 환경변수 셋이 필수 |

핵심 규칙:
- AgentBridge는 직접 API 키를 받지 않는다. 사용자가 각 CLI에 미리 로그인되어 있다는 전제로 spawn — OAuth 구독 사용을 가능하게 만드는 유일한 방법(특히 Claude).
- spawn 시 환경변수가 사용자가 의도한 인증을 덮어쓰지 않도록 transparently pass-through 하되, 충돌 가능성을 UI에서 경고.

출처: [Claude Code Authentication](https://code.claude.com/docs/en/authentication), [Pro/Max plan 사용](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan), [Codex Auth](https://developers.openai.com/codex/auth), [Gemini Auth](https://geminicli.com/docs/get-started/authentication/), [Codex API key vs ChatGPT login 충돌](https://github.com/openai/codex/issues/3286)

## 5. 도구 사용 / 권한 / cwd

각 CLI는 자체 권한 모델과 sandbox를 가진다. **API 직접 호출이 아닌 한 도구 사용은 CLI에 위임**하는 것이 합리적.

### 5.1 권한 모드 비교

| CLI | 권한 모드 | 자동화/우회 |
|---|---|---|
| Claude Code | `default` / `acceptEdits` / `plan` / `dontAsk` / `bypassPermissions`(=`--dangerously-skip-permissions`). `--allowedTools`/`--disallowedTools`. OS 레벨 sandbox는 Bash 도구에 한정 | bypass 모드는 공식 권장 X. 컨테이너/원격 sandbox 권장 |
| Codex CLI | sandbox: `read-only` / `workspace-write` / `danger-full-access`. approval: `untrusted` / `on-request` / `never`. `--full-auto` ≡ `-a on-request -s workspace-write` | `~/.codex/config.toml`로 영구 설정, `/approvals`로 런타임 토글 |
| Gemini CLI | `default` / `auto_edit` / `yolo`. `--yolo`(=`--approval-mode=yolo`)는 모든 도구 자동 승인. yolo 시 sandbox 자동 활성화(컨테이너) | `--allowed-tools`로 화이트리스트 |

출처: [Claude Permission modes](https://code.claude.com/docs/en/permission-modes), [Codex Approvals & Security](https://developers.openai.com/codex/agent-approvals-security), [Codex Sandboxing](https://developers.openai.com/codex/concepts/sandboxing), [Gemini Policy engine](https://geminicli.com/docs/reference/policy-engine/)

### 5.2 cwd 격리

세 CLI 모두 spawn 시 `cwd` 지정 가능(표준 child process API). 대화 스레드별로 git worktree를 할당하는 패턴이 사실상 표준 — `claude-squad`, `agent-of-empires`, `parallel-code` 모두 동일. [claude-squad](https://github.com/smtg-ai/claude-squad), [agent-of-empires](https://github.com/njbrake/agent-of-empires)

### 5.3 GUI에서 도구 사용 표시

- stream-json/JSONL 이벤트를 파싱하면 tool_use(파일 읽기/쓰기/bash/web fetch)와 tool_result를 그대로 시각화 가능
- 사용자 승인 패턴 두 갈래:
  1. **CLI에 위임(권장)** — `bypassPermissions`/`--full-auto`/`--yolo`. AgentBridge는 이벤트만 표시.
  2. **AgentBridge가 중재** — CLI를 `default` 모드로 두고 stdin으로 승인/거부 송수신. 단 세 CLI의 stdin 기반 승인 프로토콜이 다르므로 통일 추상화는 직접 구현 필요(확인 필요: 양방향 stream-json 모드에 한정될 가능성).

### 5.4 "외부 터미널 경험" 재현

선례 두 갈래:
- **PTY 임베드**(xterm.js + node-pty): 실제 터미널 재현. 예: [claude-console](https://github.com/Tschonsen/claude-console), wmux, tuicommander
- **headless+커스텀 UI**: stream-json 이벤트만 받아 자체 채팅 UI 렌더링. tool 호출은 카드/diff 뷰어로. 예: claude_code_bridge, JetBrains Air

AgentBridge는 채팅 UI가 핵심이므로 후자가 자연스러움. 단 일부 CLI 기능(`/`-슬래시 명령, TUI 인터랙션)은 PTY 모드가 아니면 제한.

## 6. 동시 실행 / 세션 lifecycle

| 항목 | Claude Code | Codex CLI | Gemini CLI |
|---|---|---|---|
| 다중 인스턴스 동시 실행 | 안전. 세션은 독립 프로세스/컨텍스트. 동일 머신 다중 터미널 띄우는 패턴이 공식 | 안전. exec 모드는 단발(one-shot to completion). 세션은 `~/.codex/sessions`에 영속 | 안전. 세션마다 UUID, `~/.gemini/tmp/<project_hash>/checkpoints` 영속 |
| 세션 resume | `claude --resume` 또는 `claude --resume <id>`, `--name` 식별 | `codex resume <id>` 또는 `--last`, SDK `resumeThread()` | `gemini --resume <UUID>` (또는 `-r`) |
| 영속화 위치 | 사용자별 디렉토리 | `~/.codex/sessions` JSONL | `~/.gemini/tmp/<project_hash>/checkpoints` |
| 파일 락 / 충돌 | 동일 cwd에서 다중 인스턴스 수정은 사용자 책임. git worktree 격리 표준 | 동일 | 동일 |
| 권장 lifecycle | 메시지마다 재시작(stateless) vs 장기 PTY 모두 가능. headless `-p`는 단발이 자연스러움 | exec는 본질적으로 단발. 멀티턴은 `resume` 또는 SDK thread | -p는 단발, 인터랙티브는 장기 |

출처: [Claude Agent teams](https://code.claude.com/docs/en/agent-teams), [Codex exec.md](https://github.com/openai/codex/blob/main/docs/exec.md), [Gemini Sessions](https://geminicli.com/docs/cli/session-management/)

AgentBridge 영향:
- 여러 대화 스레드 동시 오픈은 OS/CLI 레벨에서 안전. 단 같은 cwd 공유 시 파일 race는 사용자 영역.
- "메시지마다 새 프로세스 + `--resume <id>`로 멀티턴" 패턴이 가장 단순. 단 Node 기반 CLI의 cold-start 비용은 실측 필요(확인 필요).
- **Ctrl-C 인터럽트와 세션 컨텍스트 (claude — M1 실측)**: 응답 생성 중 PTY stdin에 `\x03`(SIGINT)을 보내면 claude는 *생성을 중단*하지만, 이미 출력한 부분 응답을 **assistant 턴으로 그대로 누적해 session에 보관**한다. 다음 사용자 메시지는 "부분 응답 + 새 user 턴"으로 이어지는 흐름으로 처리됨 — claude session API에 부분 턴을 잘라낼 수단이 없어 PTY 어댑터에서 우회 불가능. AgentBridge는 native 거동 그대로 노출하며, 사용자가 의도적으로 컨텍스트를 정리하려면 (a) 새 thread로 분기, (b) M3 IR 검토·편집 모달에서 부분 응답을 사용자가 손으로 정리. Codex/Gemini 동등 거동은 M2 진입 시 실측 필요.

## 7. 비용 / 한도

| 모델 | 청구 모델 | 컨텍스트 윈도우 | 한도 |
|---|---|---|---|
| Claude (Pro/Max) | Pro $20, Max $100(5x), Max $200(20x). 5h 윈도우 + 주간 cap. Opus 별도 주간 cap | 200K (Pro/Max), 500K (Enterprise 일부) | Pro: 5h당 ~10–40 prompt, Max200: 5h당 ~50–800 prompt(추정 범위) |
| Claude API | 종량제(`sk-ant-api03-*`). Anthropic Console 청구 | 200K (1M 베타 일부 모델) | RPM/TPM 티어별 |
| Codex (ChatGPT Plus/Pro/Business) | ChatGPT 구독 포함, 5h 윈도우 + 주간. 2026-04부 토큰 기반 크레딧으로 전환 | 모델별(GPT-5 계열) | 메시지 quota |
| Codex (OpenAI API) | 토큰 종량제 | 모델별 | RPM/TPM |
| Gemini CLI(개인 Google) | 무료 티어. 60 req/min, 1,000 req/day | 1M (2.5 Pro) | RPM/RPD |
| Gemini API / Vertex | 종량제 | 1M | 프로젝트별 quota |

출처: [Claude API rate limits](https://platform.claude.com/docs/en/api/rate-limits), [Codex Pricing](https://developers.openai.com/codex/pricing), [Codex rate card](https://help.openai.com/en/articles/20001106-codex-rate-card), [Gemini CLI](https://github.com/google-gemini/gemini-cli)

UX 권고: stream-json 이벤트의 usage 필드(`input_tokens`/`output_tokens`/`cache_read`)를 파싱해 메시지별 토큰 표시. 어떤 인증을 쓰는지(구독 vs API)를 명확히 라벨링.

## 8. 선례 / 패턴

### 8.1 외부 CLI를 desktop에 임베드한 사례

핵심 검증: 대부분의 선례는 **parallel sessions** 패턴(에이전트별 별도 창/세션 병렬 실행)이며, AgentBridge가 지향하는 **단일 채팅 스레드 + 모델 전환 + IR 자동 핸드오프** 패턴과 본질적으로 다르다. 단 [Subspace](https://www.subspace.build/)는 직접 경쟁자다(§8.4 별도 분석).

| 도구 | 통합 방식 | UX 패턴 | 자동 맥락 전달 | AgentBridge와의 본질 차이 |
|---|---|---|---|---|
| [claude-squad](https://github.com/smtg-ai/claude-squad) | tmux + git worktree, 다중 CLI | parallel TUI sessions | ❌ 세션 독립 | 멀티플렉서 — 다른 패턴 |
| [claude_code_bridge](https://github.com/bfly123/claude_code_bridge) | tmux pane, 명시적 `/ask` 위임. 세션을 `.ccb/history/` 마크다운 자동 export | parallel TUI + 명시 메시지 패스 | ❌ 자동 아님 — 사용자가 `/ask`로 명시 위임 | 에이전트 팀 허브 — 다른 패턴. "context handoff" 표현은 쓰지만 자동 IR 전달이 아님 |
| [wmux](https://github.com/openwong2kim/wmux) | Electron split pane, A2A MCP 메시징 | Windows split pane | ❌ A2A 명시 메시징만 | Windows tmux 대체재 |
| [tuicommander](https://github.com/sstraus/tuicommander) | Tauri + SolidJS, 10개 CLI 자동 감지, 최대 50 세션 병렬 | parallel desktop GUI sessions | ❌ 세션 독립 | "AI agent IDE" — parallel branches 관찰 |
| [agent-of-empires](https://github.com/njbrake/agent-of-empires) | tmux + git worktree, TUI/web | parallel sessions + 모니터링 | ❌ 세션 독립 | parallel branches 글랜스 |
| [JetBrains Air](https://www.jetbrains.com/help/air/quick-start-with-air.html) | macOS 데스크톱 ADE, Codex/Claude/Gemini/Junie 오케스트레이션 | "isolated parallel environments" | ❌ independent task loops | 상용 ADE — parallel orchestration |
| [Nimbalyst](https://nimbalyst.com/) | macOS/Win/Linux 데스크톱, visual mockup → agent → diff → kanban | visual workspace + kanban | ❌ 세션 독립 | visual editor + 세션 관리 |
| [claude-console](https://github.com/Tschonsen/claude-console) | Electron + node-pty + xterm.js | 단일 모델 GUI 래퍼 | N/A | Claude 전용 — 다중 모델 아님 |
| [CC Switch](https://github.com/farion1231/cc-switch) | Tauri, provider 설정 매니저 | 설정 UI | ❌ 대화가 아님 | provider/MCP/프록시 매니저 — 영역 다름 |
| **[Subspace](https://www.subspace.build/)** | macOS 데스크톱, 다중 CLI + Shared Memory | **multi-panel workspace** | ✅ "Shared Agent Memory" 자동 | **직접 경쟁자 — §8.4** |

### 8.2 IDE/Extension 사례

- **Continue.dev**: 모든 모델 provider 직접 API 호출(OpenAI, Anthropic, Mistral, 로컬). CLI spawn 안 함. `config.json/yaml`로 provider 정의 → AgentBridge가 (b) API 직접 호출을 택할 때의 모델
- **Cline**: 동일하게 provider 직접 호출(Anthropic native protocol 우선). 도구 루프 자체 구현 → CLI 위임 안 할 경우 만들어야 하는 분량의 reference
- **Cursor**: 자체 proxy → 모델 provider. Custom model은 사용자 API 키로 직접 hit

### 8.3 Electron/Tauri로 child process 다룰 때 모범 사례

- **node-pty + xterm.js**가 PTY 임베드 사실상 표준. Electron 패키징 시 `node-pty` 헬퍼 바이너리를 `asar` 외부로 복사 필요(알려진 이슈)
- **Tauri sidecar 패턴**: 백엔드를 별도 sidecar로 분리, HTTP/IPC 통신. 한쪽이 죽어도 다른 쪽 생존. [Evil Martians 글](https://evilmartians.com/chronicles/making-desktop-apps-with-revved-up-potential-rust-tauri-sidecar)
- **zombie/signal**: child가 SIGTERM 무시 시 부모 무한 대기 → SIGKILL 폴백. node-pty는 spawn 시 부모 `process.on('exit')` 핸들러 덮어쓸 수 있음 — 핸들러를 spawn 후 등록. [Electron child process 정리](https://www.matthewslipper.com/2019/09/22/everything-you-wanted-electron-child-process.html)
- **환경변수 누수**: `OPENAI_API_KEY` 등이 사용자 shell rc에서 잡히면 의도와 다르게 인증 변경 → spawn 시 환경 화이트리스트 또는 사용자 명시

### 8.4 직접 경쟁자 — Subspace 정밀 비교

[Subspace](https://www.subspace.build/)는 AgentBridge와 **같은 문제(다중 코딩 에이전트 간 맥락 단절)를 같은 기술적 접근(turn 단위 token-efficient observation + structured tags)**으로 해결하려는 상용 macOS 데스크톱 앱이다.

#### 핵심 인용 (출처: subspace.build 공식)

- "Run Claude Code, Codex, OpenCode, Gemini, and more side-by-side in a single app"
- "Shared Agent Memory — Claude Code context flows to Codex and OpenCode, and the memory belongs to the workspace, not any single tool"
- "every conversation turn is compressed into a token-efficient observation with structured tags — **decisions, blockers, progress**"
- "tag in a fresh agent mid-task without a handoff prompt"
- "Everything Subspace remembers is visible in the app — no black box"

→ Subspace의 메모리 모델은 [01_ir.md](./01_ir.md)의 IR 권고(intent/decisions/files/commands/tests/pending) 와 본질적으로 동일한 접근.

#### 검증된 사실

- **출시·과금**: $12/월 또는 $99/년. 14일 무료 트라이얼. 상용 제품
- **플랫폼**: macOS Apple Silicon만. Windows/Linux는 로드맵
- **데이터 위치**: 100% 로컬-퍼스트가 아닐 가능성이 높음. Privacy 정책에 "메모리 통합은 **로컬 또는 AI 서비스 제공자를 통해 처리**"라고 명시 — 즉 클라우드 LLM에 위임하는 경로 존재. 자체 백엔드/계정 시스템도 추정(구독 모델, 트라이얼 인증). 다만 사용자 데이터의 Subspace 서버 저장 여부는 공개 문서로 100% 확인 불가
- **UX**: multi-panel workspace — "에이전트 + 터미널 + 문서 + 파일 + 브라우저 + git을 워크스페이스로 묶음". 단일 채팅 스레드 중심이 아님

출처: [Subspace 공식](https://www.subspace.build/), [Privacy](https://www.subspace.build/privacy), [Product Hunt](https://www.producthunt.com/products/subspace-4)

#### AgentBridge vs Subspace 매트릭스

| 차원 | AgentBridge (현 spec) | Subspace |
|---|---|---|
| 라이선스/배포 | 오픈소스, GitHub | 상용, 클로즈드 |
| 가격 | 무료 | $12/월 또는 $99/년 |
| 자체 백엔드 | 없음 (계정·구독 시스템 운영하지 않음) | 추정 있음 (구독·트라이얼 인증) |
| 사용자 데이터 위치 | 사용자 머신 | 미공개 — 클라우드 가능성 |
| 플랫폼 | macOS MVP | macOS Apple Silicon |
| UX 패러다임 | **단일 채팅 스레드 + 모델 전환** (ChatGPT 스타일) | **multi-panel workspace** (control center) |
| 통합 모델 | Claude Code / Codex CLI / Gemini CLI | Claude Code / Codex / OpenCode / Gemini "등" |
| 맥락 전달 | IR 자동 정제 + **사용자 검토·편집 가능** | "Shared Agent Memory" 자동 백그라운드, **가시화만** (편집 가능 여부 미명시) |
| CLI 통합 방식 | subprocess + headless JSON stream | 명시 미공개(추정 동일) |

#### AgentBridge의 차별점 (검증 결과)

다음 세 가지가 동시에 충족되어야 차별성이 성립한다.

1. **오픈소스 / 무료** — Subspace의 구독·클로즈드 모델과 정면 대비. 1인 개발자, 학생, 취미 사용자, 한국 개발자 커뮤니티에서 명확한 진입 장벽 차이
2. **단일 채팅 스레드 UX** — Subspace는 통합 워크스페이스 페르소나, AgentBridge는 "이미 IDE/터미널은 따로 쓰고 AI 채팅만 한 곳에 모으고 싶은" 페르소나. 페르소나가 다른 시장
3. **사용자 검토·편집 가능 IR (Amp 패턴)** — Subspace의 "memory visible — no black box" (가시성)와 명확히 다른 **통제권**(controllability) 강조. handoff 시점에 사용자가 IR을 보고 수정한 뒤 전달

#### 차별점이 될 수 없는 항목 (위험 신호)

- "로컬 실행" — Subspace도 로컬 데스크톱 앱이고, AgentBridge도 결국 모델 응답은 외부 LLM에 의존하므로 "100% 로컬"은 양쪽 다 사실이 아님. 차별점으로 마케팅하면 정직하지 않음
- "여러 코딩 에이전트 통합" — 이미 Subspace를 비롯한 여러 도구가 제공
- "맥락 자동 전달" — Subspace의 핵심 기능과 동일. 메커니즘 자체는 차별점 아님

#### 위험 평가 — 중·상

- 기술적 핵심(turn 단위 압축 + structured tags)이 **이미 검증된 패턴**. 우리가 "혁신"이 아니라 "오픈소스 대안"으로 포지셔닝해야 함
- Subspace는 시장 진입을 먼저 했고 이미 사용자/언론 노출 확보
- AgentBridge가 차별점 3개 중 어느 하나라도 흐려지면 "Subspace의 부분집합 무료 클론"으로 인식될 위험

## 9. 권고 방향

### 9.1 MVP 통합 옵션 — 세 모델 모두 "CLI subprocess + headless JSON stream"

근거:
1. **인증/과금**: 사용자가 가진 Claude Pro/Max OAuth, ChatGPT Plus 로그인, Google OAuth를 그대로 활용. API 직접 호출은 (a) Claude의 경우 약관상 구독 사용 불가, (b) 사용자가 별도 API 키 관리 부담
2. **도구 루프 구현 회피**: 파일 읽기/쓰기, bash, MCP, sandbox, 권한 다이얼로그 등 코딩 에이전트 메커니즘을 직접 구현하면 Cline/Continue 수준의 코드량. CLI 위임 시 0 라인
3. **공통 추상화 가능**: 세 CLI 모두 stream-json/JSONL을 지원해 이벤트 모델이 거의 동일(message delta, tool_use, tool_result, usage, error). AgentBridge IR과 1:1 매핑 자연스러움
4. **선례 입증**: claude-squad, claude_code_bridge, wmux 등이 동일 패턴으로 multi-agent 환경 구현

### 9.2 단일 통합 vs 모델별 다른 방식

**단일 패턴(CLI subprocess) 권고**. 모델별로 다르게 가면 코드 분기, 인증 분기, 이벤트 파싱 분기가 곱해진다. Claude Agent SDK도 내부에서 CLI를 spawn하므로 SDK를 쓰는 이점이 작다.

미래 옵션:
- Codex SDK(`@openai/codex-sdk`)는 TS 친화 layer가 매력 — Electron+TS 스택이면 코드 단순화 가능. OAuth/구독 동작은 동일(SDK가 CLI spawn)
- API 직접 호출은 "API 키 사용자만"을 위한 fallback으로 phase 2 이후 고려

### 9.3 MVP에서 우회/타협 가능한 부분

| 영역 | MVP 처리 |
|---|---|
| 도구 사용(파일/bash) | **CLI 완전 위임**. AgentBridge는 stream-json 이벤트로 표시만. 사용자 승인은 1차로 `bypassPermissions`/`--full-auto`/`--yolo` 옵션 선택(워크스페이스가 git worktree 격리 전제) |
| 권한 다이얼로그 | MVP에서는 stdin 양방향 승인 프로토콜 미구현. CLI 자체 자동 승인 모드 사용 |
| PTY vs headless | MVP는 **headless+자체 채팅 UI**. PTY/xterm 임베드는 phase 2. `/`-슬래시 같은 인터랙티브 명령은 별도 표시 |
| cwd 격리 | 대화 스레드별 git worktree 권장. MVP는 사용자가 폴더만 지정하면 worktree 자동 생성 옵션 |
| 세션 영속화 | (정정 — Plan에서 결정 변경) 각 CLI native `--resume <id>`를 1차 릴리즈에 채택. 동일 모델 내 세션 연속성은 CLI에 위임하고, AgentBridge IR은 모델 전환 시 새 모델의 첫 메시지에서만 1회 주입한다. 사용자 원칙(CLI 기본 기능 제한 금지)을 우선 적용 — [01_mvp_scope.md §5](../plan/01_mvp_scope.md), [02_architecture.md §4.1](../plan/02_architecture.md) 참조. 본 권고("resume API는 phase 2")는 단순화 차원의 1차 권고였으며 Plan 단계에서 철회됨 |
| 인증 | AgentBridge가 직접 API 키를 받지 않고, 사용자가 각 CLI를 미리 로그인했는지 헬스체크만 |

### 9.4 구현 체크리스트

1. CLI 실행 가능 + 버전 감지 (`claude --version`, `codex --version`, `gemini --version`)
2. 인증 상태 헬스체크 (각 CLI의 `/status`나 첫 호출 dry-run)
3. spawn 어댑터: 모델별 args 매핑(Claude `-p --output-format stream-json --resume <id>`, Codex `exec --json`, Gemini `-p --output-format stream-json`)
4. stream-json 파서 → AgentBridge 내부 이벤트 모델 정규화
5. lifecycle 매니저: 메시지마다 spawn(단발) + 타임아웃 + cleanup(SIGTERM→SIGKILL)
6. 환경변수 정책: 사용자 shell env 상속하되, AgentBridge가 의도적으로 설정하는 키만 명시 추가

## 10. 미해결 질문

1. **Claude Code stdin 양방향 stream-json 프로토콜**: SDK 내부 형식이 외부에 안정적으로 노출되는지(공식 문서가 SDK 내부 구현으로 분류). 헤드리스 단발 대신 장기 실행 + 양방향 stream을 시도하려면 추가 확인 필요
2. **Codex CLI: ChatGPT 구독 + `OPENAI_API_KEY` 동시 존재 시 우선순위**: 알려진 이슈가 다수 있고 버전마다 동작 다름. spawn 시 환경 격리 강도 결정 전 실측 필요
3. **Gemini CLI stream-json 안정성**: PR #10883로 들어간 비교적 최신 기능. 이벤트 스키마 안정성(2026-05 시점) 실측 필요
4. **각 CLI cold-start 시간**: 매 메시지마다 spawn 시 사용자 체감 지연. Node 기반 두 CLI(Claude, Gemini)는 수백 ms~수 초 가능. 장기 실행 PTY가 필요할 수 있음
5. **다중 인스턴스가 같은 사용자 디렉토리에 동시 글쓰기 시 락 동작**: 공식 명시 없음. git worktree 격리 표준 회피책이나 사용자가 단일 폴더 고집 시 정책 필요
6. **공식 Gemini Agent SDK 존재 여부**: `@google/generative-ai`는 모델 호출용. agent 루프 wrapper 미발견. Anthropic Agent SDK / OpenAI Codex SDK 동급 layer 추가 확인
7. **Claude Code OAuth 토큰 약관 정확한 표현**: "Anthropic 공식 앱 외 사용 금지"가 여러 출처에 등장하나 공식 약관 원문 확인 필요. AgentBridge가 "단순 CLI 실행기"로서 사용자 OAuth를 그대로 위임하는 것이 약관 위반인지 명확화 필요(법적 리스크)

## 참고

- Claude Code — [Headless](https://code.claude.com/docs/en/headless), [Permission modes](https://code.claude.com/docs/en/permission-modes), [Authentication](https://code.claude.com/docs/en/authentication), [Agent teams](https://code.claude.com/docs/en/agent-teams), [Pro/Max plan 사용](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)
- Claude Agent SDK — [Overview](https://platform.claude.com/docs/en/agent-sdk/overview), [Python](https://platform.claude.com/docs/en/agent-sdk/python), [TypeScript](https://platform.claude.com/docs/en/agent-sdk/typescript), [SDK 내부 분석](https://buildwithaws.substack.com/p/inside-the-claude-agent-sdk-from)
- Codex — [Non-interactive](https://developers.openai.com/codex/noninteractive), [CLI Reference](https://developers.openai.com/codex/cli/reference), [Auth](https://developers.openai.com/codex/auth), [SDK](https://developers.openai.com/codex/sdk), [Approvals & Security](https://developers.openai.com/codex/agent-approvals-security), [Sandboxing](https://developers.openai.com/codex/concepts/sandboxing), [Pricing](https://developers.openai.com/codex/pricing), [exec.md](https://github.com/openai/codex/blob/main/docs/exec.md), [SDK README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md), [API key 충돌 이슈](https://github.com/openai/codex/issues/3286), [ChatGPT plan 사용](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan), [rate card](https://help.openai.com/en/articles/20001106-codex-rate-card)
- Gemini CLI — [Headless](https://geminicli.com/docs/cli/headless/), [Authentication](https://geminicli.com/docs/get-started/authentication/), [Sessions](https://geminicli.com/docs/cli/session-management/), [Checkpointing](https://geminicli.com/docs/cli/checkpointing/), [Policy engine](https://geminicli.com/docs/reference/policy-engine/), [Quotas/pricing](https://geminicli.com/docs/resources/quota-and-pricing/), [GitHub](https://github.com/google-gemini/gemini-cli), [stream-json PR #10883](https://github.com/google-gemini/gemini-cli/pull/10883), [API rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)
- 선례 — [claude-squad](https://github.com/smtg-ai/claude-squad), [claude_code_bridge](https://github.com/bfly123/claude_code_bridge), [wmux](https://github.com/openwong2kim/wmux), [tuicommander](https://github.com/sstraus/tuicommander), [agent-of-empires](https://github.com/njbrake/agent-of-empires), [claude-console](https://github.com/Tschonsen/claude-console), [Continue.dev](https://docs.continue.dev/), [Cline](https://github.com/cline/cline)
- 통합 패턴 — [Tauri sidecar (Evil Martians)](https://evilmartians.com/chronicles/making-desktop-apps-with-revved-up-potential-rust-tauri-sidecar), [Electron child process](https://www.matthewslipper.com/2019/09/22/everything-you-wanted-electron-child-process.html), [node-pty](https://www.npmjs.com/package/node-pty)
- 기타 — [stream-json 분석](https://backgroundclaude.com/blog/stream-json), [OAuth vs API Key 정리 (2026)](https://lalatenduswain.medium.com/claude-code-on-claude-max-plan-understanding-oauth-token-vs-api-key-authentication-in-2026-96a6213d2cde)
