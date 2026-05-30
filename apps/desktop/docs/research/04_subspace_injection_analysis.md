# Subspace 주입 메커니즘 분석 — Claude / Codex / Gemini 별

> **목적**: Subspace.app(v0.8.4 추정) 패키지 내부 코드를 분석해 각 CLI 에이전트가 어떻게 주입(injection)을 받는지 정확히 파악. AgentBridge 차별점 정의 및 architecture 설계의 근거 확보.
>
> **분석 대상**: `subspace/Contents/Resources/resources/` (프로젝트 루트에 user가 첨부)
> + `~/.subspace/` (사용자 머신의 런타임 산출물)
>
> **핵심 코드**: [`subspace-memory.cjs`](../../subspace/Contents/Resources/resources/agents/bin/subspace-memory.cjs) (10675 lines), [`subspace-capture.js`](../../subspace/Contents/Resources/resources/agents/plugins/subspace-capture.js) (OpenCode 플러그인), wrapper scripts in `~/.subspace/bin/`.

---

## 0. 한눈에 보기

| 에이전트 | Subspace 통합 | 주입 채널 (invisible) | hook 격리 | wrapper |
|---|---|---|---|---|
| **claude_code** | ✅ 풀 통합 | `--append-system-prompt-file` + `hookSpecificOutput.additionalContext` | ✅ `--settings <isolated>` | ✅ |
| **codex** | ✅ 풀 통합 | **`cwd/AGENTS.override.md`** atomic write | ❌ `~/.codex/hooks.json` 글로벌 수정 | ✅ (`-c notify=[...]` 주입) |
| **opencode** | ✅ 풀 통합 | SDK `experimental.chat.system.transform` + `messages.transform` | ✅ 플러그인 자체 격리 | ✅ |
| **gemini** | ❌ **미통합** | (없음 — wrapper/adapter 부재) | n/a | ❌ |

→ **Subspace는 Gemini를 native 통합하지 않는다.** 사용자가 본 "Gemini self-report"는 모델의 추측 또는 Subspace 외 환경에서의 동작.

---

## 1. Claude Code 주입 — `--settings` + `--append-system-prompt-file` + hooks

### 1.1 Wrapper: `~/.subspace/bin/claude`

bash 스크립트가 `claude` PATH를 가로채어 실제 binary 실행 전 격리 flag 두 개 주입:

```bash
SETTINGS_FILE='/Users/imhyeongtaeg/.subspace/claude-code-subspace-settings.json'
SESSION_CONTEXT_FILE="$SUBSPACE_HOME/<project>/<workspace>/memory/session-context.md"

# spawn 직전 session-context.md 미존재 시 prime-session-context로 생성
if [[ -n "$SESSION_CONTEXT_FILE" && ! -f "$SESSION_CONTEXT_FILE" ]]; then
    "$SUBSPACE_HOME/bin/subspace-memory" prime-session-context --agent claude_code
fi

# 두 flag 동시 주입 — settings는 hook 격리, --append-system-prompt-file은 system prompt 합성
if [[ -f "$SETTINGS_FILE" && -n "$GROVE_PANE_ID" ]]; then
    exec "$REAL_EXECUTABLE" --settings "$SETTINGS_FILE" \
                            --append-system-prompt-file "$SESSION_CONTEXT_FILE" "$@"
fi
```

핵심:
- `--settings <path>`: claude CLI에 *우리 settings.json*만 사용하도록 지시. **사용자 `~/.claude/settings.json` 무침범**
- `--append-system-prompt-file <path>`: 매 spawn 시 *invisible* system prompt 합성. PTY echo 없음
- `prime-session-context`: 미존재 시 사전 계산하여 spawn 직전 보장

### 1.2 격리된 settings: `~/.subspace/claude-code-subspace-settings.json`

Subspace 전용 hooks 등록. 사용자 글로벌 settings.json엔 영향 X:

```json
{
  "_subspace_hash": "2c8d93c282fc6d7a",
  "hooks": {
    "SessionStart": [{ "matcher": "*", "hooks": [
      { "type": "command", "command": "$SUBSPACE_HOME/bin/subspace-memory inject" }
    ]}],
    "Stop": [{ "matcher": "*", "hooks": [
      { "type": "command", "command": "$SUBSPACE_HOME/bin/subspace-memory capture-session" },
      { "type": "command", "command": "$SUBSPACE_HOME/bin/subspace-memory on-stop", "async": true }
    ]}],
    "UserPromptSubmit": [
      { "hooks": [{ "command": "$SUBSPACE_HOME/bin/subspace-memory rag-retrieve --hook docs" }]},
      { "hooks": [{ "command": "$SUBSPACE_HOME/bin/subspace-memory rag-retrieve --hook cross-workspace" }]}
    ]
  }
}
```

### 1.3 SessionStart hook stdout 형식 — `outputHookResponse()`

[subspace-memory.cjs:3757](../../subspace/Contents/Resources/resources/agents/bin/subspace-memory.cjs):

```js
function outputHookResponse(context) {
  const output = {
    systemMessage: context.systemMessage,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: ""  // ← claude가 읽어 system prompt에 합침
    }
  };
  process.stdout.write(JSON.stringify(output));
}
```

→ Claude가 hook stdout JSON을 native parse해 `additionalContext`를 system prompt에 자동 prepend. **별도 파일 불필요** (단, wrapper가 이미 `--append-system-prompt-file`로 session-context.md를 system prompt에 합쳐둔 상태).

즉 claude는 *2중 주입*:
1. wrapper의 `--append-system-prompt-file` (매 spawn에서 무조건)
2. SessionStart hook의 `additionalContext` (hook fire 시점에)

### 1.4 UserPromptSubmit hook — RAG wrapping

[subspace-memory.cjs:9928](../../subspace/Contents/Resources/resources/agents/bin/subspace-memory.cjs):

```js
function buildUserPromptSubmitOutput(additionalContext, systemMessage, options) {
  const payload = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext  // ← 사용자 prompt 직전에 RAG 컨텍스트 주입
    }
  };
  if (systemMessage) payload.systemMessage = systemMessage;
  return payload;
}
```

→ 매 user prompt 제출 시 FTS5 검색 결과를 RAG로 prepend. 모델이 받는 layer 3(user message wrapper)에 사전 컨텍스트가 들어옴.

---

## 2. Codex 주입 — `AGENTS.override.md` + 글로벌 `~/.codex/hooks.json`

### 2.1 Wrapper: `~/.subspace/bin/codex`

```bash
DISPATCHER='/Users/imhyeongtaeg/.subspace/hooks/codex-notify-dispatcher.py'
# Subspace wrapper v7 (notify)
# SessionStart hooks registered via ~/.codex/hooks.json (native discovery)

if [[ -f "$DISPATCHER" && -n "$GROVE_PANE_ID" ]]; then
    exec "$REAL_EXECUTABLE" -c "notify=[\"python3\", \"$DISPATCHER\"]" "$@"
fi
```

핵심:
- claude처럼 `--settings <path>` flag 주입 *불가* — 주석에 명시: "SessionStart hooks registered via `~/.codex/hooks.json` (native discovery)"
- → **codex는 글로벌 hooks 파일 외 격리 채널 없음**. Subspace는 사용자 글로벌 `~/.codex/hooks.json`을 직접 수정해 hook 등록.
- `-c notify=[...]` config flag로 notify dispatcher만 주입 (codex가 응답 종료 시 호출하는 외부 스크립트 — pane↔thread 매핑 + capture 트리거)

### 2.2 글로벌 hooks: `~/.codex/hooks.json`

사용자 머신에서 캡처한 실 데이터:

```json
{
  "hooks": {
    "SessionStart": [{ "matcher": "^(start|startup|clear|resume)$", "hooks": [
      { "command": "...subspace-memory inject --agent codex", "type": "command" }
    ]}],
    "UserPromptSubmit": [
      { "hooks": [{ "command": "...subspace-memory rag-retrieve --agent codex --hook docs", "type": "command" }] },
      { "hooks": [{ "command": "...subspace-memory rag-retrieve --agent codex --hook cross-workspace", "type": "command" }] }
    ]
  }
}
```

→ Subspace가 사용자 *글로벌* codex hooks에 자기 명령어를 등록한 상태. **AgentBridge 외에서 codex 사용 시에도 작동**.

### 2.3 SessionStart 출력: `buildCodexHookOutput()` — *AGENTS.override.md*에 atomic write

[subspace-memory.cjs:2741](../../subspace/Contents/Resources/resources/agents/bin/subspace-memory.cjs):

```js
function buildCodexHookOutput(context, cwd, memoryDir) {
  const overridePath = resolveOverridePath(cwd);  // → cwd/AGENTS.override.md
  let blockContent = readSessionContextFile(memoryDir);  // session-context.md
  writeManagedOverride(overridePath, blockContent);
  // codex stdout에는 systemMessage만, additionalContext는 *파일* 경유
  process.stdout.write(JSON.stringify({ systemMessage: context.systemMessage }));
}
```

핵심: claude와 결정적으로 다른 점 — **codex는 stdout `additionalContext`로 inject 안 함**. 대신 cwd `AGENTS.override.md` 파일을 atomic 갱신하면 codex가 *자체 native auto-load*로 읽어 layer 3(user message wrapper)에 prepend.

### 2.4 `writeManagedOverride()` — 마커 블록 격리 갱신

[subspace-memory.cjs:2741](../../subspace/Contents/Resources/resources/agents/bin/subspace-memory.cjs):

```js
function writeManagedOverride(overridePath, blockContent) {
  const current = fs.existsSync(overridePath) ? fs.readFileSync(overridePath, "utf8") : "";
  const pattern = managedOverridePattern();  // /<!-- SUBSPACE_MEMORY:start -->...<!-- SUBSPACE_MEMORY:end -->/s
  const block = `${BLOCK_START}\n${blockContent}\n${BLOCK_END}`;
  let updated;
  if (pattern.test(current)) {
    updated = current.replace(pattern, `${block}\n`);  // 기존 우리 블록만 교체
  } else if (current.trim()) {
    updated = `${current.trimEnd()}\n\n${block}\n`;     // 사용자 콘텐츠 보존하고 우리 블록 append
  } else {
    updated = `${block}\n`;
  }
  fs.writeFileSync(overridePath, normalized);  // atomic 가정 — temp+rename은 별도 호출자
}
```

→ **사용자가 `AGENTS.override.md`를 직접 작성한 적이 있다면 그 콘텐츠는 보존**. Subspace는 자기 마커 사이 블록만 갱신.

### 2.5 codex의 `.override.md > .md` 우선순위 (AgentBridge probe 07로 실측)

probe 07 결과: codex는 cwd `AGENTS.md`와 `AGENTS.override.md` 둘 다 있을 때 **`.override.md`만 로드**. 즉 Subspace는 사용자 `AGENTS.md`는 *건드리지도 않으면서* override 우선순위 메커니즘으로 자기 영역만 차지.

### 2.6 codex notify dispatcher (`~/.subspace/hooks/codex-notify-dispatcher.py`)

```python
# Codex notify dispatcher v8
# This script is injected via `-c notify=[...]` when running Codex in Subspace.
# It captures pane↔conversation mappings, triggers memory capture, and chains
# to user's original notify.

def capture_mapping(pane_id, thread_id, preview):
    mappings[pane_id] = thread_id
    mappings["_lastResponse"] = {"paneId": pane_id, "ts": time.time(), "agentType": "codex", "preview": preview}
    # atomic write to ~/.subspace/conversation_mappings.json
```

→ codex `notify` config는 응답 완료 시점에 외부 스크립트 호출. Subspace는 이걸 활용해:
1. pane↔thread 매핑 갱신 (UI 상 알림 라우팅)
2. (chained) 사용자 원래 notify 호출 (있다면)
3. capture 파이프라인 트리거

### 2.7 codex 주입 layer (모델 시점)

probe 결과 + Codex self-report 교차 검증으로 확정한 model이 받는 prompt 5층:

```
1. System instructions       — OpenAI/모델 기본
2. Developer instructions    — Codex CLI 자체 (sandbox/cwd/권한)
3. User message wrapper      ← AGENTS.override.md 콘텐츠 (Subspace 영역)
   "# AGENTS.md instructions for <cwd>"
   <INSTRUCTIONS>... session-context 마커 블록 ...</INSTRUCTIONS>
4. Environment context       — cwd/shell/date/tz
5. Actual user prompt        — 사용자 입력
```

---

## 3. OpenCode 주입 — SDK 플러그인 transform

### 3.1 Wrapper: `~/.subspace/bin/opencode`

claude wrapper와 거의 동일 패턴. session-context.md prime + 실 binary exec.

### 3.2 SDK 플러그인 hooks (`subspace-capture.js`)

OpenCode SDK가 노출하는 4개 hook:

```js
'experimental.chat.system.transform': async (_input, output) => {
  if (cachedContext && output?.system) {
    output.system.push(cachedContext);  // ← system prompt에 직접 push
  }
},

'experimental.chat.messages.transform': async (input, output) => {
  // 첫 user prompt에 RAG 블록 주입 (한 번만, fire-once)
  // 사용자 메시지를 <subspace_rag_context>...</subspace_rag_context><user_prompt>...</user_prompt>로 재작성
},

event: async ({ event }) => {
  if (event.type !== 'session.idle') return;
  // 응답 종료 시 transcript 분석 + on-stop spawn + cachedContext re-cache
},

'experimental.session.compacting': async (input, output) => {
  // 컴팩션 시 RAG 전달 사실 보존하는 노트 추가
}
```

→ OpenCode는 plugin contract가 풍부해 SDK 레벨에서 *깔끔하게* 주입. PTY/stdout 우회 불필요.

### 3.3 OpenCode RAG 출력 형식

[subspace-memory.cjs:10033](../../subspace/Contents/Resources/resources/agents/bin/subspace-memory.cjs):

```js
function formatOpenCodeOutput(context, ragStatusLine) {
  return {
    context,
    agentType: "opencode",
    deliveryChannel: "opencode-message-transform",
    ...ragStatusLine ? { ragStatusLine, systemMessage: ragStatusLine } : {},
    suppressOutput: true
  };
}
```

→ stdout JSON이 아니라 *플러그인 내부에서* user 메시지를 SDK API로 직접 wrapping.

---

## 4. Gemini — *Subspace 미통합*

### 4.1 정량 증거

`~/.subspace/bin/` 디렉토리 내용:
```
claude       (4735 bytes)  ← 통합
codex        (2342 bytes)  ← 통합
opencode     (3111 bytes)  ← 통합
subspace-memory       (250 bytes, 진입점)
subspace-memory.cjs   (5963692 bytes, 핵심 로직)
subspace-shell        (1000 bytes)
```

→ **gemini wrapper 없음**.

### 4.2 코드 레벨 검증

```bash
$ grep -in "gemini" subspace-memory.cjs
4338:// src/cli/subspace-memory/memory-gemini.ts
4385:// src/cli/subspace-memory/memory-gemini.ts
```

Gemini 언급 2건 모두 `memory-gemini.ts` *모듈 주석*. 이 모듈은 **Subspace가 *요약 LLM으로* Gemini API를 사용**하는 backend-side 인터페이스 (Vercel API 경유). agent integration이 아님.

### 4.3 first-prompt-rag adapter 등록 목록

[subspace-memory.cjs:10075](../../subspace/Contents/Resources/resources/agents/bin/subspace-memory.cjs):

```js
var ADAPTERS = new Map([
  ["claude_code", claudeCodeFirstPromptRagAdapter],
  ["codex", codexFirstPromptRagAdapter],
  ["opencode", opencodeFirstPromptRagAdapter]
]);

function parseFirstPromptRagAgentType(raw) {
  if (raw === "claude_code" || raw === "codex" || raw === "opencode") return raw;
  return null;  // ← gemini는 unknown agent
}
```

→ Subspace는 **gemini agentType 자체를 모른다**.

### 4.4 사용자가 본 "Gemini self-report" 해석

사용자가 보고한 "AGENTS.override.md 통해 받았다"는 Gemini 자기 보고는 다음 중 하나:

1. **Gemini의 추측** — cwd에 AGENTS.override.md 파일이 보이니 자기 컨텍스트 출처를 그렇게 합리화. 모델이 자기 prompt 구조를 정확히 알 능력 없음.
2. **Subspace 외부 환경** — 사용자가 일반 gemini를 Subspace 워크스페이스 cwd에서 호출. probe 07 결과 gemini는 `AGENTS.override.md` auto-load *안 함*. 즉 실제로는 받지 않음.

→ Gemini의 self-report는 **inject가 실제로 일어났다는 증거 아님**.

### 4.5 gemini를 위한 Subspace 미해결 영역

기술적 이유 추정:
- gemini CLI에 claude `--settings`/`--append-system-prompt-file`에 해당하는 격리 flag 없음 (probe 07A에서 `~/.gemini/settings.json` 점검 — hooks 섹션 없음)
- gemini의 `.override.md` 패턴 미지원 (probe 07에서 `GEMINI.override.md` 무시됨 실측)
- gemini SDK 플러그인 hook이 OpenCode 같은 형태로 제공되는지 미확인

→ Subspace 측에서도 *invisible inject 채널을 찾지 못해* native 통합 보류한 것으로 추정. 우리(AgentBridge)도 같은 한계 직면.

---

## 5. 패턴 추상화

### 5.1 주입 채널 종류 (Subspace 사용 사례 기준)

| 채널 | 가시성 | 격리성 | 사용 CLI |
|---|---|---|---|
| Wrapper의 `--append-system-prompt-file <path>` | invisible | 사용자 글로벌 무침범 | claude |
| Wrapper의 `--settings <isolated.json>` (hook 등록 격리) | hook 시스템 격리 | 사용자 글로벌 무침범 | claude |
| 글로벌 `~/.codex/hooks.json` 수정 | invisible | **글로벌 침범** | codex |
| `cwd/AGENTS.override.md` atomic merge | invisible | cwd 신규 파일 1개 | codex |
| 글로벌 `~/.codex/config.toml`에 `-c notify=[...]` 주입 | invisible | wrapper 한정 일시 적용 | codex |
| SDK plugin (`experimental.chat.system.transform` 등) | invisible | 플러그인 자체 격리 | opencode |
| (없음) | n/a | n/a | gemini |

### 5.2 Subspace의 capture 파이프라인 요약

매 응답 종료 시점:
1. claude `Stop` hook → `subspace-memory capture-session` + `on-stop --async`
2. codex `notify=[...]` → dispatcher → 매핑 갱신 + observation 트리거
3. opencode `event: session.idle` → transcript 분석 + on-stop spawn + cachedContext re-cache

`on-stop`은 transcript 압축 → LLM 요약(Vercel API 또는 로컬 Haiku) → observation .jsonl/.md append → Status threshold 도달 시 status_update.

→ **요약 LLM은 Vercel 백엔드 의존이 기본**. `GROVE_MEMORY_HAIKU_ENABLED=1`로 로컬 claude Haiku 폴백 가능.

---

## 6. AgentBridge 적용 시사점

### 6.1 차별점 매트릭스 재정정 (이 분석 후)

| 축 | Subspace | AgentBridge 현재 | AgentBridge 가능 (probe 07 길 4-α) |
|---|---|---|---|
| 요약 LLM | Vercel 백엔드 (기본) / 로컬 Haiku 옵션 | 사용자 인증 CLI 헤드리스 | 동일 |
| claude 주입 | wrapper + `--settings` + `--append-system-prompt-file` | `--append-system-prompt-file` (이미) | wrapper 채택 시 hook까지 가능 |
| codex 주입 | 글로벌 hooks.json 수정 + `AGENTS.override.md` | PTY stdin paste (visible) | `AGENTS.override.md` 채택 가능 (글로벌 hooks 침범 회피) |
| gemini 주입 | **미통합** | argv (visible) | (Subspace도 미해결) |
| 글로벌 설정 | `~/.codex/hooks.json` 침범 | 미침범 | 미침범 (codex hooks 회피) |
| cwd 파일 | `AGENTS.override.md` 신규 생성 | 미생성 | 채택 시 `AGENTS.override.md` 1개 생성 (codex 한정) |

### 6.2 AgentBridge가 Subspace보다 *우월할 수 있는* 영역

1. **Privacy/요약 LLM 출처**: Subspace는 Vercel 백엔드가 기본 → 사용자 대화 leak + 별도 요금제. AgentBridge는 사용자 인증 CLI 헤드리스 — 추가 비용 0, leak 0
2. **사용자 글로벌 설정 무침범**: Subspace는 codex `~/.codex/hooks.json`을 *글로벌* 수정. AgentBridge는 codex inject를 `AGENTS.override.md`로만 수행하면 글로벌 침범 회피 가능
3. **사용자 통제 IR**: Subspace는 자동 누적, 가시화만. AgentBridge는 검토·편집 모달 (M3 J 청크 완료)

### 6.3 Subspace에서 *우리도 차용 가능한* 패턴

1. **claude wrapper의 `--settings` 격리** — hook 등록을 사용자 글로벌 settings.json 무침범으로 가능
2. **codex `AGENTS.override.md` 채널** — invisible inject + 사용자 AGENTS.md 무침범 (`.override > .md` 우선순위 활용)
3. **마커 블록 atomic merge** — `<!-- ... :start --> ... <!-- ... :end -->` 패턴으로 사용자 콘텐츠 보존하면서 우리 영역 갱신
4. **3-tier 메모리 구조** — observation/status/summary 단위 분리 (검색·압축에 유리)

### 6.4 *차용해서는 안 되는* 패턴

1. **글로벌 `~/.codex/hooks.json` 수정** — 사용자가 AgentBridge 외에서 codex 쓸 때도 우리 hook 작동 → 정직성 원칙 위배
2. **요약 LLM을 자체 백엔드/제3자 API로 보내기** — privacy 차별점 핵심
3. **Gemini를 invisible inject 흉내내기** — Subspace도 미해결, 무리한 구현은 fragility risk

---

## 7. 결론

1. **Subspace의 주입 메커니즘은 CLI별로 비대칭**. claude는 wrapper+`--settings`+system-prompt-file로 깨끗, codex는 글로벌 hooks 수정 + `AGENTS.override.md`로 부분 우회, opencode는 SDK 플러그인으로 정공법, **gemini는 통합 자체 부재**.
2. **AgentBridge는 Subspace의 좋은 패턴(claude 격리 wrapper, codex AGENTS.override.md, 마커 블록 merge)을 차용 가능**. 글로벌 설정 침범과 자체 백엔드 의존은 회피해 차별점 강화.
3. **Gemini invisible inject는 Subspace도 못 푼 영역** — AgentBridge가 *현재 패턴(argv `-i`, visible)*을 유지하는 것은 기술적으로 정당한 선택. 향후 gemini CLI에 격리 flag/SDK plugin 등이 추가되면 재검토.

---

## 부록: 핵심 파일 좌표

### Subspace 패키지 (분석 source)
- [`agents/bin/subspace-memory.cjs`](../../subspace/Contents/Resources/resources/agents/bin/subspace-memory.cjs:3757) — `outputHookResponse`
- [`agents/bin/subspace-memory.cjs`](../../subspace/Contents/Resources/resources/agents/bin/subspace-memory.cjs:2771) — `buildCodexHookOutput`
- [`agents/bin/subspace-memory.cjs`](../../subspace/Contents/Resources/resources/agents/bin/subspace-memory.cjs:2741) — `writeManagedOverride`
- [`agents/bin/subspace-memory.cjs`](../../subspace/Contents/Resources/resources/agents/bin/subspace-memory.cjs:9988) — first-prompt-rag adapters (3종)
- [`agents/plugins/subspace-capture.js`](../../subspace/Contents/Resources/resources/agents/plugins/subspace-capture.js:735) — OpenCode `experimental.chat.system.transform`
- [`agents/plugins/subspace-capture.js`](../../subspace/Contents/Resources/resources/agents/plugins/subspace-capture.js:634) — OpenCode `experimental.chat.messages.transform`

### 사용자 머신 런타임 산출물
- `~/.subspace/bin/{claude, codex, opencode}` — wrapper scripts
- `~/.subspace/claude-code-subspace-settings.json` — claude 격리 hooks
- `~/.subspace/hooks/codex-notify-dispatcher.py` — codex notify 디스패처
- `~/.codex/hooks.json` — Subspace가 등록한 글로벌 codex hooks
- `~/.subspace/conversation_mappings.json` — pane↔session 매핑
- `~/.subspace/<project>/<workspace>/memory/{status.json, observations/, session-context.md, ...}` — 3-tier 메모리

### AgentBridge probe 산출물 (교차 검증)
- [`docs/plan/probe_results.md §7`](../plan/probe_results.md) — model A pivot 불가 (probe 05)
- [`docs/plan/probe_results.md §8`](../plan/probe_results.md) — 헤드리스 슬래시/MCP/subagent (probe 06)
- [`docs/plan/probe_results.md §9`](../plan/probe_results.md) — CLI native auto-load 매트릭스 + hook 시스템 (probe 07)
