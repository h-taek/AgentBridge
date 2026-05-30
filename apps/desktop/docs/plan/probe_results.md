# M0 Capability Probe 결과

> Phase 4 — M0 / capability probe 산출물.
> [03_milestones.md M0 §3.2](./03_milestones.md)에서 정의한 probe 4종을 실측해 [02_architecture.md §13.1](./02_architecture.md) deferred 결정 3건을 닫는다.

## 0. 실측 환경

- 일자: 2026-05-09
- macOS arm64, Node v25.8.0, npm 11.11.0
- CLI 버전: Claude Code 2.1.138 / codex-cli 0.130.0 / gemini 0.41.2
- 인증: 세 CLI 모두 OAuth 구독 (Claude Pro/Max, ChatGPT Plus/Pro, Google 무료 티어)
- 스크립트: [`probe/scripts/`](../../probe/scripts/), raw 로그: [`probe/results/`](../../probe/results/)

## 1. Probe 01 — `--resume + headless`

### 1.1 결과 요약

세 CLI 모두 headless 모드에서 두 턴 연속 동작 확인. Turn 2(resume)에서 "42" 정답 응답 → 컨텍스트 보존 확인.

| CLI | 첫 spawn (새 세션) | session 키 노출 | resume 명령 |
|---|---|---|---|
| Claude | `claude -p '<msg>' --output-format stream-json --verbose --session-id <UUID> --permission-mode bypassPermissions` | **`session_id`** (모든 이벤트에 매번 포함) | `claude -p '<msg>' --output-format stream-json --verbose --resume <UUID> --permission-mode bypassPermissions` |
| Codex | `codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox '<msg>'` | **`thread_id`** (`thread.started` 이벤트) | `codex exec resume <UUID> --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox '<msg>'` (**subcommand**, `--resume` 플래그 아님) |
| Gemini | `gemini -p '<msg>' -o stream-json --yolo --skip-trust --session-id <UUID>` | **`session_id`** (`init` 이벤트) | `gemini -p '<msg>' -o stream-json --yolo --skip-trust --resume latest\|<index>` (UUID 직접 안 됨) |

> 위 명령은 **헤드리스 spawn 한정** (probe 01 검증용 + IR refine spawn에 사용). 모델 B 채택([§4](#4-probe-04--인터랙티브-pty--승인-다이얼로그)) 후 메인 채팅 흐름은 인터랙티브 PTY 모드를 사용하므로 위 명령 형태와 다르다 — 인터랙티브 진입 명령은 [02_architecture.md §7.2](./02_architecture.md) 참조.

### 1.2 plan 가정과 차이

| 항목 | plan 문서 가정 | 실측 |
|---|---|---|
| Codex resume 인자 | `codex exec --json --resume <id>` | `codex exec resume <UUID>` (subcommand. exec 옵션 `--resume` 없음) |
| Gemini resume 입력 | UUID | `latest` 또는 인덱스 번호. UUID는 `--session-id`(첫 spawn 시 사전 설정)에서만 사용 |
| Codex stream 형식 | `--output-format stream-json` | `--json` (JSONL 출력) |

### 1.3 부수 발견

- **Claude `--system-prompt-file` / `--append-system-prompt-file`** ✅ 존재 (hidden flag, `--bare` 설명에서 확인). plan §7.2의 IR 주입 방식 그대로 유지 가능.
- **Gemini multi-thread 추적** — `--resume latest`는 가장 최근 세션 1개만 잡음. 멀티-thread 환경에서 충돌 가능. 우회: 첫 spawn 시 `--session-id <UUID>`로 우리가 UUID 통제 → 이어가기 시 `gemini --list-sessions` 출력 파싱(`인덱스. <title> (<X ago>) [<UUID>]` 형태)에서 UUID로 인덱스를 찾아 `--resume <index>`. 매번 list 호출이 필요한 점이 비용.
- **Codex stdin 대기** — prompt를 인자로 넘겨도 stdin이 열려있으면 "Reading additional input from stdin..." 메시지와 함께 hang. spawn 시 stdin을 즉시 close 필요(probe runner에 fix 적용).
- **Claude stream-json 이벤트 종류** — `rate_limit_event` / `system`(subtype:init) / `assistant` / `result`(subtype:success). 모든 이벤트에 `session_id`, `uuid`(이벤트 단위 ID) 두 키.
- **Codex stream 이벤트** — `thread.started` / `turn.started` / `item.completed` / `turn.completed`. session 키는 `thread.started.thread_id`에만 노출.
- **Gemini stream 이벤트** — `init` / `message` / `tool_use` / `tool_result` / `result`. session 키는 `init.session_id`에만.

## 2. Probe 02 — 권한 모드 (참고용)

> 모델 B 채택으로 메인 채팅 흐름은 CLI native `default` 모드 인터랙티브 — 권한 토글 자체가 사라졌다. 본 절은 **IR refine 헤드리스 spawn**에서 어떤 권한 인자를 쓸지 결정하는 참고 자료. (refine은 도구 호출 자체를 안 하므로 사실상 무관하나 spawn 시 인자는 명시해야 함.)

### 2.1 분류 기준

각 모드별로 `Write 'hello' to ./probe-test.txt; reply 'done'.` prompt를 보내 다음을 분류:
- **completed**: exit=0, 파일 작성됨
- **skip**: exit=0, "done"은 응답하나 파일 미작성 (모델이 권한 부족 인지하고 작업 포기)
- **hung**: timeout (승인 대기로 멈춤)
- **error**: exit≠0
- **refuse**: exit=0이나 작업/응답 모두 미수행

### 2.2 Claude (`--permission-mode`)

| 모드 | 결과 | dur | file | done |
|---|---|---|---|---|
| `default` | skip | 11.7s | N | Y |
| `acceptEdits` | **completed** | 6.0s | Y | Y |
| `plan` | skip | 24.6s | N | Y |
| `bypassPermissions` | **completed** | 8.2s | Y | Y |

`auto`/`dontAsk`는 미테스트. `default`/`plan`은 headless에서 silent skip — 도구 호출 없이 응답만.

### 2.3 Codex (`-s` sandbox)

`codex exec` subcommand에는 `-a/--ask-for-approval` 없음 — approval policy는 sandbox 모드에 implicit. main `codex --help`의 `-a`는 interactive 모드용.

| 모드 | 결과 | dur | file | done |
|---|---|---|---|---|
| 미지정 (default = read-only) | refuse (exit=0이나 "writing is blocked by read-only sandbox; rejected by user approval settings") | 12.5s | N | N |
| `-s read-only` | refuse | 10.0s | N | N |
| `-s workspace-write` | **completed** | 7.4s | Y | Y |
| `-s danger-full-access` | **completed** | 10.5s | Y | Y |
| `--dangerously-bypass-approvals-and-sandbox` | **completed** | 7.7s | Y | Y |

### 2.4 Gemini (`--approval-mode`)

| 모드 | 결과 | dur | file | done |
|---|---|---|---|---|
| `default` | **hung** (60s timeout) | 61.0s | N | (Y) |
| `auto_edit` | **completed** | 10.3s | Y | Y |
| `yolo` | **completed** | 11.1s | Y | Y |
| `plan` | completed (⚠️) | 44.7s | Y | Y |

⚠️ **`plan` 모드 우회 가능** — 모델이 처음에 plan 모드 정책으로 차단당하나, `exit_plan_mode` 도구를 자체 호출해 plan 모드를 종료한 후 파일 작성. read-only 보장 아님. 보안 측면 주의.

### 2.5 IR refine spawn에서 사용할 권한 인자

refine은 도구 호출이 없는 텍스트 정제 작업 — 권한 모드와 무관하게 동작해야 함. spawn 인자에 권한 모드 명시할 때 *완료*가 보장되는 가장 좁은 모드 사용:

| CLI | refine spawn 권한 인자 |
|---|---|
| Claude | `--permission-mode acceptEdits` (도구 호출 없으면 사실상 plain spawn과 동일) |
| Codex | `-s read-only` (refine은 파일 안 씀) |
| Gemini | `--approval-mode auto_edit` (`default`는 hang 위험) |

메인 채팅 흐름(인터랙티브 PTY)에는 권한 인자 명시하지 않음 — 사용자가 인터랙티브에서 직접 응답.

## 3. Probe 03 — 헤드리스 PTY 호환성

`node-pty` native binding이 Node v25.8.0 prebuilt 미제공으로 빌드 실패. macOS 시스템 도구 `script(1)` (`script -q -F <log> <cmd>...`)로 PTY 시뮬레이션 — 자식 프로세스 입장에서 isatty=true는 동일.

### 3.1 결과

| CLI | classification | exit | dur | bytes | ANSI escape | JSON 라인 ok/fail | session 노출 |
|---|---|---|---|---|---|---|---|
| Claude | ansi-mixed-but-parseable | 0 | 5.1s | 3769 | 11 | 3 / 0 | ✅ `session_id` |
| Codex | clean-json | 0 | 8.3s | 325 | 0 | 3 / 0 | ✅ `thread_id` (raw 로그 직접 확인) |
| Gemini | clean-json | 0 | 9.2s | 1146 | 0 | 4 / 0 | ✅ `session_id` |

### 3.2 raw 로그 발췌

**Claude PTY** — 시작/끝에 mouse/cursor 제어 시퀀스, JSON 라인은 깨끗:
```
^D^H^H{"type":"rate_limit_event",...,"session_id":"aff07ecf..."}^M
{"type":"system","subtype":"init",...,"session_id":"aff07ecf..."}^M
{"type":"assistant",...,"session_id":"aff07ecf..."}^M
{"type":"result","subtype":"success",...,"session_id":"aff07ecf..."}^M
^[[?1006l^[[?1003l^[[?1002l^[[?1000l^[[>4m^[[<u^[[?1004l^[[?2031l^[[?2004l^[[?25h^7^[[r^8^]0;^G^[[?25h
```

**Codex PTY** — 첫 라인에 `^D` 제어문자 1바이트 외에 깨끗:
```
^D{"type":"thread.started","thread_id":"019e0baa..."}
{"type":"turn.started"}
{"type":"item.completed","item":{...,"text":"42"}}
{"type":"turn.completed","usage":{...}}
```

**Gemini PTY** — 깨끗한 JSON 라인:
```
{"type":"init",...,"session_id":"..."}
{"type":"message","role":"user",...}
{"type":"message","role":"assistant","content":"42",...}
{"type":"result","status":"success",...}
```

### 3.3 의의 — IR refine spawn의 PTY 호환성 검증

세 CLI 모두 **헤드리스 모드를 PTY 안에서 spawn**해도 stream-json/JSONL 라인이 손상 없이 출력됨. Claude만 시작/끝부분에 ANSI escape sequence 노출되나 라인 사이에는 섞이지 않아 strip만 추가하면 파싱 가능.

이 결과는 모델 B 채택 후에도 **IR refine spawn**(백그라운드, 헤드리스, stream-json) 단계에서 PTY 환경 의존성이 없음을 확인하는 의미. refine은 PTY 없이 일반 child_process spawn으로 동작 — 본 probe는 일관성 검증으로만 의미.

## 4. Probe 04 — 인터랙티브 PTY + 승인 다이얼로그

`@homebridge/node-pty-prebuilt-multiarch`로 PTY 양방향 spawn (Node v25 prebuilt 제공). 각 CLI를 인터랙티브 모드(no `-p`/`exec`)로 띄우고 도구 호출을 유발하는 prompt를 stdin으로 전송.

### 4.1 결과

| CLI | rawBytes | ANSI escape | JSON 라인 | classification |
|---|---|---|---|---|
| Claude | 3,459 | 361 | 0 | model-B-ansi-only |
| Codex | 1,312 | 182 | 0 | indeterminate (trust dialog에 막힘) |
| Gemini | 19,609 | 832 | 0 | model-B-ansi-only |

### 4.2 주요 발견

세 CLI 모두 **인터랙티브 모드 = 화면 좌표 기반 풀스크린 TUI** (`[<row>;<col>H` 같은 cursor positioning escape 다수). **JSON 라인은 한 건도 출력되지 않음**. 즉 인터랙티브 모드와 stream-json은 상호 배타적.

- **Claude 인터랙티브** — `Quick safety check: Is this a project you trust?` workspace trust 다이얼로그가 첫 화면. `❯ 1. Yes, I trust this folder / 2. No, exit` numbered menu, Enter 키로 확인. trust 응답 후 box-drawing 환영 화면(`╭─ Claude Code v2.1.138 ─...`) + prompt input box(`❯ Try "fix lint errors"`). probe에서는 우리 prompt가 trust 단계에서 보내져서 적용 안 됨.
- **Codex 인터랙티브** — 풀스크린 alt-screen TUI(`[?2026l` 같은 sync mode). `Do you trust the contents of this directory?` trust 다이얼로그. `> 1. Yes, continue / 2. No, quit` numbered menu. Codex 자체가 alternate screen 진입.
- **Gemini 인터랙티브** — `--skip-trust`로 trust 우회 후 box-drawing input box(`╭...│ ⠙ Waiting for authentication... │...╯`) → 인증 후 input box(`> Type your message or @path/to/file`) + footer(workspace, sandbox, model, quota). probe에서 응답 키 `y`가 prompt input으로 들어가는 것 관찰됨.

### 4.3 결론 — 모델 A 불가, 모델 B 채택

이번 probe의 핵심 발견 두 가지:

1. **인터랙티브 모드 = stream-json 미출력**. 세 CLI 모두 인터랙티브에서는 ANSI 풀스크린 TUI만 내보내며 stream-json 라인을 동시에 출력하지 않는다.
2. **승인 다이얼로그는 풀스크린 TUI 일부**. trust/도구 승인 다이얼로그가 텍스트 파싱 가능한 형태가 아니라 `[<row>;<col>H` 좌표 + 박스 그리기 escape 시퀀스 묶음.

→ **모델 A (PTY + stream-json + 다이얼로그 *텍스트* GUI 모달 중재)** 불가. 다이얼로그 텍스트만 추출해 우리 GUI 모달로 변환하는 휴리스틱은 깨지기 쉽다.

남은 선택지:
- **모델 B (PTY + xterm.js 그대로 임베드)**: 풀스크린 TUI를 자체 앱 내 xterm.js 박스에 raw bytes 그대로 forward. 다이얼로그 텍스트 추출 *불필요* — xterm.js가 화면을 그리고 사용자가 그 안에서 직접 키 응답. CLI native 권한 흐름 그대로 유지.
- **모델 C (헤드리스 + 자동 권한 토글)**: 사용자 모르게 도구 자동 진행. *"AgentBridge는 CLI 기본 기능을 제한하지 않는다"* 원칙 위배 ([02_model_integration.md §6](../research/02_model_integration.md)). "묻기" 모드를 봉쇄하므로 보안 부담을 AgentBridge가 떠안음.

→ **모델 B 채택**. 사용자와 합의:

1. **보안**: CLI native 권한 흐름 그대로 — 사용자가 매 도구 호출마다 인터랙티브 다이얼로그에서 직접 응답
2. **원칙 부합**: CLI 기본 기능 제한 없음. 모든 native 권한 모드 그대로 사용 가능
3. **차별점 보존**: 차별점 1(멀티 모델), 차별점 3(IR 검토) 그대로. 차별점 2의 정의를 *"모든 모델을 한 창에서, 핸드오프는 자동"* 으로 reword
4. **표준 패턴 + 일정 영향 축소**: Electron + node-pty + xterm.js 사례 풍부 (Warp/Hyper/VS Code 통합 터미널/Tabby 등). 모델 B의 핵심 부담이었던 "다이얼로그 파싱"이 *불필요*함이 probe 04로 밝혀져 일정 영향 +1~2주 정도

다이얼로그 텍스트 추출의 어려움(§4.2)은 모델 A 한정 문제였다. 모델 B는 다이얼로그를 *파싱하지 않고* xterm.js에 raw bytes만 전달하므로 휴리스틱이 끼어들 여지가 없다.

### 4.4 모델 B의 UI 구상

사용자가 그린 1차 UI 레이아웃 (2026-05-09):

```
┌─────────────────────────────────────────┐
│ ┌──────┐ ┌────────────────────────────┐ │
│ │검색창│ │  CLI 화면 표시             │ │
│ ├──────┤ │  (xterm.js, 활성 모델의    │ │
│ │채팅  │ │   인터랙티브 TUI)          │ │
│ │히스토│ │                            │ │
│ │리/   │ │                            │ │
│ │세션  │ │                            │ │
│ │선택창│ │                            │ │
│ │      │ ├────────────────────────────┤ │
│ │      │ │ 채팅 입력창                │ │
│ │      │ │              [모델 선택 ▼] │ │
│ └──────┘ └────────────────────────────┘ │
└─────────────────────────────────────────┘
```

흐름:
- **좌측 사이드바**: AgentBridge 자체 영역. 검색 + thread 리스트
- **중앙 xterm.js**: 활성 모델 PTY 출력. 키 입력은 PTY stdin으로 forward. 도구 호출 다이얼로그가 뜨면 사용자가 그 안에서 직접 응답
- **하단 입력창**: 사용자 메시지 작성. Enter → PTY stdin으로 forward (개행 포함). IME, 멀티라인, 마크다운 미리보기 같은 GUI 입력 강점 살림
- **모델 선택 드롭다운**: 모델 전환 트리거 → IR refine spawn (백그라운드, 헤드리스, stream-json) → IR 검토 모달 overlay (차별점 3) → confirm 시 새 모델 PTY spawn + IR 주입 + xterm.js 재초기화

## 5. Deferred 결정 닫음 ✅

[02_architecture.md §13.1](./02_architecture.md) 3건 모두 닫힘.

| 결정 | 닫힘 결과 |
|---|---|
| I/O 모델 (헤드리스 vs PTY 모델 A/B) | ✅ **모델 B (PTY + xterm.js 임베드)** 확정. 근거: 모델 A는 probe 04로 stream-json 동시 출력 불가 확인 → 기술적 불가. 모델 C는 보안/원칙 위배 → 비합리. 모델 B는 다이얼로그 파싱 *없이* xterm.js raw forward만 하므로 일정 영향 +1~2주로 축소 |
| 각 CLI `--resume` 명령 형태 + sessionId stream 키 위치 | ✅ §1.1 표대로 (헤드리스 한정). 인터랙티브 진입 명령은 [02_architecture.md §7.2](./02_architecture.md)에서 모델 B 가정으로 재작성 |
| 토글에 노출할 native 권한 모드 범위 | ✅ **권한 토글 자체 삭제** (모델 B 채택). 메인 흐름은 CLI native 인터랙티브 — 사용자가 직접 응답. probe 02 헤드리스 매트릭스는 IR refine spawn에만 의미 있음(§2.5) |

## 6. 후속 정정 사항

probe 결과로 정정된 plan 문서 (이번 세션):

- [01_mvp_scope.md §3.2](./01_mvp_scope.md) — ✅ "PTY 임베드 미사용" → "PTY+xterm.js 임베드 채택"으로 정정. 차별점 2 정의 reword
- [02_architecture.md §1, §3, §4, §5, §6.2, §7, §8.4, §10, §11, §13.1](./02_architecture.md) — ✅ 메인 흐름 모델 B 가정으로 재작성. 권한 토글 매트릭스 삭제. node-pty/xterm.js MVP 채택
- [03_milestones.md M0~M4](./03_milestones.md) — ✅ M1~M3 산출물 PTY/xterm.js 반영. 일정 +1~2주
- [README.md](../../README.md) — ✅ 차별점 2 표현 정정
- [docs/spec/05_app_concept.md](../spec/05_app_concept.md) — ✅ 채팅 UI 정의의 "단일 채팅" 표현 보완

## 7. Probe 05 — Model A 재검증 (post-M2, 2026-05-10)

### 7.1 동기

M2 종료 후 사용자가 PTY 안 numbered menu("1. Yes / 2. No")가 텍스트 프로토콜처럼 보임을 관찰 → 헤드리스 + 자체 GUI 채팅(model A) pivot 가능성 제기. probe 04가 model A를 기각한 근거는 "헤드리스 = 묻지 않는 모드 한정"이었으나, probe 02가 *명시적으로 테스트하지 않은 빈틈* 두 가지가 남아 있어 좁힌 재 probe 실행:

- **B**: Claude `--input-format stream-json` 멀티턴 + SDK side channel 권한 요청
- **C**: Codex `exec --ask-for-approval` long form (probe 02는 `-a` short만 시도해 reject)

### 7.2 결과

| 케이스 | 명령 | 결과 |
|---|---|---|
| 5A (claude --help) | flag 카탈로그 | `--input-format stream-json` 존재(only with `--print`), `--permission-mode` choices = `acceptEdits/auto/bypassPermissions/default/dontAsk/plan`. 어느 것도 *runtime ask user* 채널 아님 |
| 5A (codex exec --help) | flag 카탈로그 | `exec` 서브커맨드는 `--sandbox`만. `--ask-for-approval`은 *top-level CLI*에만 존재(인터랙티브용). headless `exec`엔 없음 |
| 5A (gemini --help) | flag 카탈로그 | `--approval-mode` choices = `default(prompt for approval)/auto_edit/yolo/plan`. **`default` = Plan Mode 변형** (`auto_edit`/`yolo`는 정상 도구 실행, §7.2-bis 참조) |
| 5B (claude stream-json input) | `--input-format stream-json --output-format stream-json --permission-mode default` + stdin JSON user turn | 이벤트 type: `system/assistant/user/result/rate_limit_event`. `tool_use` 발생 → tool_result에 즉시 deny 메시지 + result.permission_denials 누적. **별도 `permission_request`/`approval_request` 이벤트 type 없음.** `-p` 모드와 권한 거동 동일 |
| 5C (codex --ask-for-approval long form) | `codex exec --json --sandbox workspace-write --ask-for-approval on-request` | exit=2, stderr: `error: unexpected argument '--ask-for-approval' found`. short form `-a`도 동일 |

### 7.2-bis Gemini headless 모드별 도구 가용성 (probe 02 재집계)

§7.2 5A 행과 §7.3 결론 정확도 보강. probe 02 `02_gemini_*` 결과 재집계로, *gemini headless에서 도구 실행 자체는 가능*하며 차단은 `default`(Plan Mode 변형) 한정임을 명시:

| `--approval-mode` | write_file 결과 | 결과 파일 |
|---|---|---|
| `default` | "Plan Mode" 안내 → invoke_agent 시도 → 정책 차단 → exit | ❌ 미생성 |
| `auto_edit` | tool_use:write_file → tool_result:**success** | ✅ probe-test.txt 생성 |
| `yolo` | tool_use:write_file → tool_result:**success** | ✅ probe-test.txt 생성 |
| `plan` | source 차단 (plans 디렉토리 한정 허용) | ❌ 미생성 (의도) |

→ 헤드리스 자체가 도구를 막는 게 아님. `default`가 *Plan Mode = read-only*에 해당.

claude 도 동일 구조: `default`만 silent deny. `acceptEdits`/`bypassPermissions`에서 도구 정상 실행 (probe 02 / probe 01 결과).

### 7.3 결론 — Model A pivot 불가 확정 (재차)

세 CLI 모두에서 **headless + runtime tool 승인 응답 채널**이 존재하지 않음 (이건 §7.2-bis 도구 가용성과 무관 — *권한 부여 채널의 부재* 자체가 model A 차단 사유):

- Claude: `default`/`auto`/`dontAsk`/`plan` 모드 모두 사용자에게 묻지 않음. `default`는 silent deny + metadata 누적, 나머지는 사전 자동 정책. stream-json 입력 모드도 동일 거동
- Codex `exec`: 사전 `--sandbox`만. `--ask-for-approval`은 인터랙티브 전용
- Gemini headless: 모드 사이 강도 선택만 가능 (`auto_edit`/`yolo` 자동 / `default`/`plan` 차단). 매 도구 단위 사용자 결정 채널 없음

→ **모델 B(PTY + xterm.js) 유지**. 사용자의 "PTY numbered menu가 텍스트 프로토콜처럼 보임" 관찰은 정확하나, 그 텍스트는 풀스크린 TUI가 그린 박스 그리기 escape의 일부라 헤드리스에서 분리 가능한 채널이 아님(probe 04 §4.2 결론과 일치).

### 7.4 산출물

- `probe/scripts/05_headless_interactive.ts` — 케이스 A(help)/B(claude stream-json)/C(codex ask-for-approval) 자동화
- `probe/results/05A_*_<TS>.help` / `05B_*_<TS>.jsonl` / `05C_*_<TS>.jsonl` — 각 케이스 raw 출력
- `probe/results/05_summary_<TS>.json` — 케이스별 timed_out/observed_event_types/tool_use/permission_request_event/permission_denied_in_result 매트릭스

### 7.5 Plan 문서 영향

없음. M3 본 계획(IR 검토·편집 모달 — 이미 J 청크 완료) 그대로 진행. K/L 청크는 [03_milestones.md M3 §6.2](./03_milestones.md) 잔여 항목.

## 8. Probe 06 — Headless 슬래시 / MCP / subagent 가용성 (2026-05-10)

### 8.1 동기

probe 05에서 권한 채널 부재 확정. 사용자가 그건 *수용 가능*한 사항으로 정리. 다음 결정 변수는 **headless에서 *interactive에서만 의미 있는* 기능들이 어디까지 빠지는가** — 슬래시 커맨드 / MCP / subagent.

### 8.2 결과 매트릭스

| 기능 | claude headless | codex headless `exec` | gemini headless `-p` |
|---|---|---|---|
| 슬래시 가로채기 | ✅ **부분 작동** (아래 §8.3) | ❌ 사용자 메시지 텍스트로 처리 | ❌ 사용자 메시지 텍스트로 처리 |
| Task tool / subagent | ✅ 작동 (Task tool 호출 정상, subagent에 prompt 전달) | n/a | n/a (gemini 자체 invoke_agent는 별개 — probe 02 default에서 작동 확인) |
| MCP 서버 | ❌ **연결 안 됨** — init log `mcp_servers` 배열에 `status: "pending"`로 등장하나 connect 단계 미진입. 모델 응답: "I don't have any MCP tools available in this session" | 미테스트 | 미테스트 |

### 8.3 Claude headless 슬래시 세부 거동

| 슬래시 | 응답 | 판정 |
|---|---|---|
| `/help` | "/help isn't available in this environment." (assistant text) | 가로채기 OK, *환경별 가용성 게이팅* (headless 차단) |
| `/usage` | 구독·사용량 텍스트 ("You are currently using your subscription to power your Claude Code usage…") | ✅ 작동 |
| `/context` | 마크다운 표 — Model / Tokens / Estimated usage by category | ✅ 작동 |
| `/compact` | "Error: No messages to compact" — 단일 턴이라 압축 대상 없음. 가로채기는 OK, 컨텍스트 있으면 작동 | ✅ 가로채기 OK |
| `/init` | 90초 실행 후 timeout (164KB 출력) — 코드베이스 분석 중. CLAUDE.md 생성 슬래시는 헤드리스에도 노출 | ✅ 작동 |

→ **Claude는 헤드리스에 슬래시 인프라를 보유**. 일부 슬래시는 *환경* 게이팅으로 비활성(`/help` 등) — 즉 슬래시 종류별 가용성은 *별도로* 확인해야 함. 슬래시가 헤드리스에서 *전무하지는* 않다는 게 결론.

### 8.4 Codex / Gemini headless 슬래시 부재

- **gemini `-p '/help'`**: 모델이 "/help"를 사용자 메시지로 받아 `invoke_agent(agent_name=cli_help)` 도구로 *Gemini CLI 사용법 일반 설명*을 생성. "Type these inside a `gemini` session" 안내 — 즉 슬래시 자체는 *세션 안에서만* 작동한다는 모델 응답이 곧 답
- **codex `exec '/help'`**: 모델이 "/help"를 사용자 메시지로 받아 codex 자체 capabilities 설명 텍스트 응답. 슬래시 가로채기 없음

→ codex `exec` 헤드리스, gemini `-p` 헤드리스: **슬래시 인프라 자체가 없음**. 사용자 입력 텍스트로 처리.

### 8.5 MCP 서버

probe 02 claude `-p` init 이벤트에 `mcp_servers: [{ name: "claude.ai Notion", status: "pending" }]` 등장 → probe 06F 동일 — *pending* 상태로 머무름. 모델한테 "List MCP tools" 요청 시 응답: "I don't have any MCP tools available in this session." → **claude headless 모드는 MCP 미연결**. interactive 모드 한정 기능으로 추정.

(codex/gemini의 MCP는 본 probe에서 미테스트. claude 결과만으로도 model A pivot 시점에서는 MCP 사용 일관성 깨짐 — claude 외 모델 동등 검증 필요지만 우선순위 낮음)

### 8.6 종합

기술적으로 model A pivot 시 *가용 기능*은 다음과 같이 갈림:

- ✅ **그대로 사용**: 도구 실행(파일 R/W/Bash 등) — 자동 모드 한정. claude 일부 슬래시(`/usage`, `/context`, `/compact`, `/init`). claude Task/subagent. gemini invoke_agent.
- ❌ **소실**: codex/gemini 슬래시 인프라. claude 일부 슬래시(`/help`, 환경 게이팅 슬래시들). claude MCP 서버. 사용자 per-tool 거부권 (probe 05).
- ⚠️ **확인 필요**: claude custom slash 커맨드(`.claude/commands/*.md`) 헤드리스 가용성. claude skills(`.claude/skills/*`) 헤드리스 작동. codex/gemini MCP 동등 확인.

### 8.7 산출물

- `probe/scripts/06_headless_slash_mcp.ts` — 케이스 A(claude slash)/C(gemini slash)/D(codex slash)/E(claude Task)/F(claude MCP)
- `probe/results/06_*_<TS>.jsonl` (raw) + `06_summary_<TS>.json`

## 9. Probe 07 — CLI native memory 파일 auto-load 매트릭스 + hook 시스템 inventory (2026-05-10)

### 9.1 동기

Subspace 분석(`SUBSPACE_MEMORY_ANALYSIS.md`) + Gemini self-report로 두 메커니즘 발견:

1. **CLI native hook 시스템** — `~/.codex/hooks.json`(SessionStart/UserPromptSubmit hooks 등록), `~/.claude/settings.json` hooks 섹션
2. **`.override.md` 파일 기반 inject** — Subspace가 codex에 `AGENTS.override.md` atomic 갱신해 invisible inject 달성

확정 필요:
- 각 CLI가 cwd에서 *어떤* 파일을 native auto-load 하는가
- `.override.md` 패턴이 cross-CLI인가, codex 한정인가
- hook 시스템 활용 가능성 + 격리 방법

### 9.2 결과 — auto-load 매트릭스

cwd sandbox에 6개 후보 파일을 unique sentinel과 함께 배치 후 각 CLI 헤드리스 호출. 응답에 등장하는 sentinel로 auto-load 식별.

| 후보 파일 | claude | codex | gemini |
|---|---|---|---|
| `AGENTS.md` | ❌ 무시 | ❌ 무시 (override가 있을 때) | ❌ 무시 |
| `AGENTS.override.md` | ❌ 무시 | ✅ **로드** (AGENTS.md보다 우선) | ❌ 무시 |
| `CLAUDE.md` | ✅ **로드** | ❌ 무시 | ❌ 무시 |
| `CLAUDE.override.md` | ❌ 무시 | ❌ 무시 | ❌ 무시 |
| `GEMINI.md` | ❌ 무시 | ❌ 무시 | ✅ **로드** |
| `GEMINI.override.md` | ❌ 무시 | ❌ 무시 | ❌ 무시 |

→ **각 CLI별로 native channel 1개씩**. claude는 `CLAUDE.md`, codex는 `AGENTS.override.md`(>AGENTS.md), gemini는 `GEMINI.md`. **`.override.md` 패턴은 codex 한정** (claude/gemini 미지원).

### 9.3 결과 — hook 시스템 inventory

| CLI | hook 위치 | 형식 | Subspace 등록 사례 |
|---|---|---|---|
| claude | `~/.claude/settings.json` (`hooks` 키) | JSON | 분석 자료에 따르면 사용. 사용자 환경 settings.json엔 미등록 |
| codex | `~/.codex/hooks.json` | JSON | ✅ Subspace가 *현재 사용자 환경에 이미 등록*: SessionStart matcher `^(start\|startup\|clear\|resume)$` + UserPromptSubmit matcher `*` |
| gemini | `~/.gemini/settings.json`엔 hooks 섹션 없음 | (미확인) | gemini hook 시스템 존재 여부 미확인 |

코덱스 사용자 환경의 등록된 Subspace hook (실 데이터):

```json
{
  "hooks": {
    "SessionStart": [{ "matcher": "^(start|startup|clear|resume)$", "hooks": [{
      "command": "...subspace-memory inject --agent codex",
      "type": "command"
    }]}],
    "UserPromptSubmit": [
      { "hooks": [{ "command": "...subspace-memory rag-retrieve --agent codex --hook docs", "type": "command" }] },
      { "hooks": [{ "command": "...subspace-memory rag-retrieve --agent codex --hook cross-workspace", "type": "command" }] }
    ]
  }
}
```

### 9.4 우리 architecture에 미치는 영향

**A. invisible inject cross-CLI 달성 옵션**:

| CLI | 현재 채널 | 가시성 | 대안 (probe 07 결과 기반) |
|---|---|---|---|
| claude | `--append-system-prompt-file` | ✅ invisible | 그대로 유지 (가장 깨끗 — cwd 무관) |
| codex | PTY stdin bracketed paste | ❌ visible | **`cwd/AGENTS.override.md` atomic write** → invisible. 사용자 AGENTS.md 보존됨 |
| gemini | `-i argv` | ❌ visible | `cwd/GEMINI.md` 수정 외 invisible 채널 *없음*. argv 유지 또는 사용자 파일 침범 trade-off |

**B. hook 시스템 활용 risk** — 글로벌 설정 침범:
- `~/.codex/hooks.json` / `~/.claude/settings.json` 모두 *사용자 글로벌 설정*
- 우리가 hook 등록하면 *사용자가 AgentBridge 외에서 해당 CLI 사용 시에도 우리 hook 작동* → 정직성 원칙 위배
- 격리 옵션 (probe 필요):
  - claude: spawn 시 `--settings <path>` 같은 flag로 일시 settings 지정 가능?
  - codex: 환경변수로 hooks.json 경로 override 가능? `~/.codex/config.toml`에 설정 가능?
- 격리 불가 시 **hook 시스템 미채택 권고**

**C. 차별점 5 정확 표현 확정**:
- ❌ ~~"사용자 메모리 파일 미수정"~~ — codex `AGENTS.md`는 안 건드리지만 cwd `AGENTS.override.md` 신규 생성한다면 *cwd 침범*
- ✅ **"사용자 cwd 무침범 — IR은 AgentBridge 자체 디렉토리에 격리"** — 현재 architecture 그대로 유지가 *유일한 깔끔한 표현*
- 만약 codex inject를 `AGENTS.override.md`로 옮기면 — 차별점 5 *부분 약화* (cwd에 우리 파일 1개 생성. 단 사용자 기존 AGENTS.md는 보존)

### 9.5 가능한 길 (구현 X — 분석만)

**길 1 — 현재 architecture 유지** (최대 격리, 일부 visibility 비용)
- claude `--append-system-prompt-file`(invisible) / codex stdin(visible) / gemini argv(visible) 그대로
- 차별점 5 가장 강한 형태 유지
- codex/gemini IR이 사용자 첫 메시지처럼 보이는 거동 수용 (M2 findings.md §5에 기록된 부분)

**길 2 — codex만 AGENTS.override.md 채택**
- codex에서만 invisible inject 달성
- *trade-off*: cwd에 `AGENTS.override.md` 신규 생성. 사용자 AGENTS.md 보존
- gemini는 길 1 유지 (visible)
- 차별점 5 부분 약화 (codex 한정으로 cwd 파일 1개 추가)

**길 3 — codex AGENTS.override.md + gemini GEMINI.md 수정**
- codex/gemini 모두 invisible
- gemini는 사용자 GEMINI.md *수정* 필요 (sentinel 블록 atomic merge) — Subspace가 AGENTS.md에 했던 것과 같은 방식
- 차별점 5 *결정적 약화*

**길 4 — Hook 시스템 채택 + 격리 probe 추가**
- claude/codex hook 시스템 격리 등록 가능성을 추가 probe (08)로 확인
- 가능하면: hook으로 invisible inject — *Subspace와 동일 메커니즘*. 차별 layer는 사용자 통제 IR + privacy
- 불가능하면: 길 1~3 중 선택

### 9.6 산출물

- `probe/scripts/07_memory_files_and_hooks.ts` — 케이스 A(hook config dump) + B(cwd 6 파일 auto-load 매트릭스)
- `probe/results/07A_*_<TS>.dump` — claude_settings / codex_hooks / codex_config_toml / gemini_settings 원본
- `probe/results/07B_*_<TS>.jsonl` — 각 CLI 헤드리스 응답
- `probe/results/07_summary_<TS>.json` — caseA + caseB 종합

### 9.7 결정 필요 사항

1. **inject 채널 개편 여부** — 길 1/2/3 중 선택, 또는 길 4(hook 격리 probe) 추가 진행
2. **probe 08 (hook 격리)** 진행 여부 — claude `--settings` flag / codex hooks.json 경로 override 가능성
3. **차별점 5 표현 정정 시점** — README/memory 문구 갱신은 채널 결정 후

## 10. Probe 08 — codex notify dispatcher `/clear` 감지 시도 (B-2 + D-4 검증) (2026-05-10)

### 10.1 동기

architecture 결정 B(`/clear` 후 IR 정책)에서 사용자 directive: **"B-2 + D-4 우선 probe → 안 되면 B-1 + D-3"**.
- B-2: `/clear` 시 IR 자동 초기화
- D-4: codex `-c notify=[python3, dispatcher.py]` config 채널로 lifecycle 이벤트 수신 (Subspace 동일 메커니즘)

### 10.2 시나리오

probe/scripts/08_codex_notify_clear.ts: PTY로 codex 인터랙티브 spawn 후 5단계 입력 스크립팅:

| T | 액션 | 의도 |
|---|---|---|
| +6s | `1\r` | trust 다이얼로그 응답(probe 04 패턴) |
| +10s | `what is 2+2?\r` | turn 1 |
| +24s | `/clear\r` | clear 이벤트 발생 시점 |
| +29s | `what did I just ask?\r` | turn 2 (post-clear) |
| +43s | `/quit\r` | 정상 종료 |

dispatcher(`probe/scripts/lib/probe08_notify_dispatcher.py`)는 매 호출마다 stdin payload + argv + env 일부를 JSONL로 로깅.

### 10.3 실측 결과

```
dispatcher calls: 0
payload fields observed: (none)
```

**dispatcher 한 번도 호출 안 됨.** PTY raw 로그 분석으로 원인 식별:

#### 원인 A — turn 미제출 (즉발적 차단)

codex 0.130.0의 prompt input UI는 `\r`을 *prompt buffer에 줄 추가*로만 처리. submit 안 됨. PTY 로그에서 입력 영역(line 17~) 누적 확인:
```
›
 what
   is
   2+2?
 /clear
 ...
```

→ 5개 step 모두 buffer에 누적된 채로 종료. 어떤 turn도 codex 모델에 제출되지 않음 → notify 이벤트 자체가 발생할 조건 미충족.

submit key 변경 추정: 이전 codex는 `\r` submit, 0.130.0은 다른 sequence (예: 별도 \n 추가, Ctrl+Enter, 또는 일정 idle 후 자동) 일 가능성. probe 04 시점(2026-05-09)부터 *24시간 내 codex 동작 변경*.

#### 원인 B — 결정적 부수 발견: codex 0.130.0의 새 hook 보안 게이트

PTY 로그 startup 영역에 *명시 경고*:

```
⚠ [features].codex_hooks is deprecated. Use [features].hooks instead.
Enable it with --enable hooks or [features].hooks in config.toml.
See https://developers.openai.com/codex/config-basic#feature-flags for details.

⚠ 3 hooks need review before they can run. Open /hooks to review them.
```

해석:
1. `[features].codex_hooks` (Subspace가 의존하는 옛 flag)이 *deprecated*. 새 `[features].hooks`로 전환 필요
2. **`~/.codex/hooks.json`에 등록된 모든 hook이 사용자 *명시적 `/hooks` 리뷰* 후에만 작동** — 보안 게이트
3. 현재 사용자 머신엔 Subspace 등록 hook 3개 모두 *review 대기* 상태로 비활성

→ 우리가 hook을 등록해도 사용자가 codex 안에서 `/hooks`로 *수동 승인* 해야 작동. UX 마찰 추가.

(notify는 hook과 다른 config채널이지만 turn 미제출로 동작 자체 미검증)

### 10.4 결론 — B-2 + D-4 채택 불가

세 가지 실재 장애:

1. **PTY 인터랙티브 스크립팅 fragility**: codex 0.130.0의 submit key 변경으로 자동화된 turn 발사 불안정. AgentBridge가 ambient `/clear` 감지 흐름을 자동화하려면 매 codex 버전 업데이트마다 submit 동작 추적 필요
2. **codex `/hooks` 보안 게이트**: hook 등록 → 자동 작동 *불가*. 사용자가 codex 안에서 `/hooks` 슬래시 명령으로 수동 승인 필수. AgentBridge UX의 "그냥 작동" 원칙과 충돌
3. **`[features].codex_hooks` deprecated**: 옛 flag로 등록된 hook은 작동 보장 X. 새 `[features].hooks` 형식으로 전환해야 하나 schema 미파악 (별도 probe 필요)

→ **B-1 + D-3 fallback 확정** (사용자 directive 그대로):
- B-1: `/clear` 후 IR을 그대로 둠 (stale 수용)
- D-3: AgentBridge UI에 "메모리 초기화" 버튼 — 사용자가 `/clear` 의도와 별개로 명시 액션

이 조합은:
- ✅ codex hooks 안 건드림 → 차별점 5 강 유지
- ✅ codex 버전 변경 영향 0
- ✅ 사용자 명시 액션이라 의도 명확
- ⚠️ `/clear` 후 stale IR — 단 사용자가 우리 UI 버튼으로 보완 가능

### 10.5 codex 0.130.0 변경 사항 (부산물 정보)

probe 08의 *부수* 산출물 — AgentBridge architecture 영향:

| 변경 | 영향 |
|---|---|
| trust 다이얼로그 미노출 (cwd가 `--cd`로 명시됐을 때 자동 trust) | M2 H의 codex spawn 시 trust 응답 휴리스틱 *불필요* 가능 — 별도 검증 필요 |
| prompt input submit key 변경 | M2 E의 ChatSubmitStep에서 codex bracketed paste + `\r` 흐름 재검증 필요 |
| `[features].hooks` + `/hooks` 보안 게이트 | 우리 codex 통합은 *hook 의존 0건* 선택이 더 강해짐. AGENTS.override.md 채널만으로 충분 |
| `[features].codex_hooks` deprecated 경고 | Subspace 사용자 환경에 등록된 hook은 향후 재구성 필요할 수 있음 |

### 10.6 산출물

- `probe/scripts/08_codex_notify_clear.ts` — PTY 인터랙티브 스크립트
- `probe/scripts/lib/probe08_notify_dispatcher.py` — 로깅 dispatcher
- `probe/results/08_dispatcher_<TS>.log` — dispatcher invocation log (0건)
- `probe/results/08_pty_<TS>.raw.log` — codex PTY raw bytes
- `probe/results/08_summary_<TS>.json` — 종합

### 10.7 architecture 결정 확정 (probe 05~08 통합)

| 결정 | 채택 |
|---|---|
| 모델 A pivot (헤드리스 + 자체 채팅 UI) | **불가** (probe 05 — runtime tool 승인 채널 부재) |
| 헤드리스 모델 사용 가능 영역 | refine spawn만 (M2 F 그대로). 메인 흐름은 model B (PTY) |
| codex IR inject 채널 | **`cwd/AGENTS.override.md` atomic write** (probe 07 길 2 + 9.5의 길 4-α 부분) |
| claude IR inject 채널 | `--append-system-prompt-file` 유지 (현재 M2 H 그대로) |
| gemini IR inject 채널 | `-i argv` 유지 (visible 수용 — Subspace도 미해결 영역) |
| `/clear` 후 IR 정책 | **B-1 + D-3** — stale 수용 + AgentBridge UI 명시 버튼 |
| codex hooks.json 사용 여부 | **사용 안 함** (probe 08 — `/hooks` 보안 게이트 + deprecation) |
| 메모리 트리거 정책 | **session-close 시점만** (사용자 통찰 — ambient 안 함, 토큰 절약 + 차별점 4 강화) |

→ §10.7 내용은 probe 09 + 사용자 directive 누적 후 *재revision*됨 — [§11.4](#114-architecture-결정-재확정-probe-09-반영)와 [02_architecture.md §14](./02_architecture.md) 참조.

## 11. Probe 09 — Sentinel hook fire + invisibility 실측 (2026-05-11)

### 11.1 동기

[02_architecture.md §14](./02_architecture.md) M3 architecture revision의 *핵심 가정*: 3 CLI 모두 hook 메커니즘으로 *invisible inject* 가능. probe 06A에서 hook 시스템 *존재* 확인은 됐으나, **AgentBridge가 직접 등록한 hook이 fire하고 additionalContext가 모델 컨텍스트에 합성되는지** 미검증. probe 09가 그 격차를 닫음.

### 11.2 케이스 + 실측 결과

격리된 sentinel hook(`PROBE09_<CLI>_HOOK_FIRED_PINEAPPLE_TURTLE_VOLCANO`) 등록 후 헤드리스 spawn → 모델 응답 echo 확인:

| 케이스 | 등록 위치 | 결과 | 응답 echo | stdout 등장 |
|---|---|---|---|---|
| 09A claude | `--settings <isolated path>` flag | ✅ **FIRED** | ✅ sentinel echo | ✅ 헤드리스 stream-json `hook_response` 이벤트 |
| 09B codex | `<cwd>/.codex/hooks.json` + `<cwd>/.codex/config.toml` (`[features].hooks=true`) | ❌ **NOT FIRED** | ❌ "NONE" | ❌ |
| 09C gemini | `<cwd>/.gemini/settings.json` (SessionStart + BeforeAgent) | ✅ **FIRED** | ✅ sentinel echo (응답 첫 chunk) | ✅ user message 앞에 `<hook_context>` 태그 prepend |

#### 09A claude 상세

stream-json 출력에 hook lifecycle 이벤트 명확:
```json
{"type":"system","subtype":"hook_started","hook_name":"SessionStart:startup",...}
{"type":"system","subtype":"hook_response","hook_name":"SessionStart:startup",
  "stdout":"...","exit_code":0,"outcome":"success",...}
```
모델 최종 응답: `"PROBE09_CLAUDE_HOOK_FIRED_PINEAPPLE_TURTLE_VOLCANO"`.

→ **`--settings <Application Support 안 isolated path>` 격리 패턴이 *완전 작동***. 사용자 글로벌 `~/.claude/settings.json` 무영향 + hook fire + `additionalContext` 모델 컨텍스트 합성. M3 architecture 핵심 가정 검증.

#### 09B codex 상세

stream-json 출력에 deprecation 메시지:
```
[features].codex_hooks is deprecated. Use [features].hooks instead.
(Enable it with --enable hooks or [features].hooks in config.toml.)
```

우리가 config.toml에 `hooks = true` 추가했음에도 hook fire 안 됨. 또 `--enable hooks` flag 필요할 가능성 + `/hooks` 보안 게이트 (헤드리스에선 자동 통과 안 됨).

→ **codex 헤드리스 hook은 게이트로 차단**. 다만 *PTY 인터랙티브 모드*에선 [Subspace 사용자 환경에 등록된 hooks이 실 작동](#92-결과--auto-load-매트릭스)하는 실 사례가 있어 작동 가정 유지. 단 사용자 수동 `/hooks` trust 절차 필요.

#### 09C gemini 상세

Gemini는 `additionalContext`를 *user message 앞에* `<hook_context>` XML 태그로 prepend:
```
<hook_context>Special context phrase from hook: PROBE09_GEMINI_HOOK_FIRED_...</hook_context>

[원본 user prompt]
```

→ Gemini hook **fire 성공**. invisibility 측면에선 *first turn user message 안에 별개 entry로 등장* — claude의 system prompt 합성보다는 *덜* invisible (probe 07 docs에서 추정한 거동과 일치). 다만 *현재 argv `-i` 방식보다는 깔끔* (사용자 자기 메시지처럼 안 보임, 별개 태그).

### 11.3 환경 path 이슈 (해결됨)

probe 환경(iCloud Drive 동기화 디렉토리, 공백 포함 path)에서 1차 시도 시 hook command가 `bash <path>` 형태로 등록되어 *공백으로 split*되어 실행 실패. claude stream-json 명확:
```
"output":"bash: /Users/imhyeongtaeg/Library/Mobile: No such file or directory\n"
"exit_code":127,"outcome":"error"
```

해결: hook command를 `bash '<path>'` (single quote)로 등록 → 정상 실행. 이건 우리 architecture 영향 X — production AgentBridge.app은 `/Applications/AgentBridge.app/Contents/Resources/bin/`(공백 없음)에서 spawn. 다만 *구현 시 path quoting을 default*로 두는 것이 robust.

### 11.4 architecture 결정 재확정 (probe 09 반영)

| 결정 | 채택 + 검증 상태 |
|---|---|
| Claude hook + `--settings` 격리 | ✅ **probe 09A로 *직접 검증 완료*** — 헤드리스/PTY 모두 작동 가정 |
| Codex hook + project-local | 🟡 PTY 인터랙티브 한정 작동 가정 (Subspace 사용자 환경 사례). 헤드리스 미작동. 사용자 `/hooks` trust 게이트 수동 승인 필요 |
| Gemini hook + project-local | ✅ **probe 09C로 *직접 검증 완료*** — `<hook_context>` 태그로 user message prepend. semi-invisible (claude 대비) |
| Hook command path quoting | 구현 시 single-quote 또는 escape 적용 (probe 09 1차 실패 → 2차 성공 사례 반영) |
| Refine 모델 = gemini-2.5-flash 헤드리스 | ✅ 결정 그대로. inject path는 우리 직접 ir.json 작성 (gemini는 텍스트만 반환) |
| 메모리 트리거 정책 | **per-message hook (alive 탭 freshness)** + N턴 background compaction + T-1/T-2/T-3/T-5 (10.7과 일관) |

§10.7의 "session-close 시점만" 표현은 *compaction 트리거 한정*으로 정정 — *inject 트리거는 매 사용자 메시지(hook)*. 비용 재계산은 [02_architecture.md §14](./02_architecture.md) 참조.

### 11.5 산출물

- `probe/scripts/09_hook_fire_invisible.ts` — 케이스 A/B/C 자동화
- `probe/scripts/lib/probe09_hook_command.sh` — sentinel echo dispatcher
- `probe/results/09A_claude_<TS>.jsonl` / `09B_codex_<TS>.jsonl` / `09C_gemini_<TS>.jsonl` — raw 출력
- `probe/results/09_summary_<TS>.json` — 종합

### 11.6 미해결 — M3 구현 시 닫음

- codex PTY 인터랙티브 모드에서 hook fire 검증 (Subspace 사용자 환경의 등록된 hooks가 실 작동하는 사례는 있음 — 우리 hook으로 동일 패턴 적용 시 작동 가정. M3 K/M 청크 구현 시 실측)
- gemini `<hook_context>` 태그 표시가 사용자 인터랙티브 화면에 *어떻게 보이는지* (M3 L UI 청크에서 사용자 검증)
- codex `--enable hooks` flag와 `[features].hooks = true` config.toml의 정확 활성화 절차 (M3 M 청크 구현 시 실측)
- hook command stdout JSON parse 견고성 — 우리 헬퍼 binary가 JSON 외 텍스트 출력 시 CLI host 거동
