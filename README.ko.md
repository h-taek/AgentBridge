<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="packages/assets/brand/agentbridge-dark.svg" />
    <img src="packages/assets/brand/agentbridge-light.svg" width="220" alt="AgentBridge 로고" />
  </picture>
</p>

# AgentBridge

> 여러 AI 코딩 에이전트(Claude · Codex · Antigravity) 사이로 작업 맥락을 옮기고, 그중 하나가 나머지에게 일을 시키게 하는 도구. macOS(Apple Silicon)에서 IDE 익스텐션으로 쓴다.

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-green.svg"></a>
  <img alt="Version" src="https://img.shields.io/badge/version-0.6.x-orange.svg">
  <img alt="Extension" src="https://img.shields.io/badge/extension-Apple%20Silicon-007ACC.svg">
</p>

<p align="center"><a href="README.md">English</a></p>

---

## 무엇을 해결하는가

Claude Code CLI · Codex CLI · Antigravity CLI를 번갈아 쓸 때 생기는 **맥락 인계** 문제를 푼다. 모델을 바꿀 때마다 어디까지 했는지가 사라지는 그 문제다.

AgentBridge는 한 작업 공간에 모델 탭을 여럿 띄우고 작업 기록을 공유한다 — 지금까지의 요약, 그 근거인 원문 턴, 사용자와 저장소에 대한 오래 가는 지식이다. 맥락은 **에이전트가 가져간다.** 훅이 매 턴에 짧은 지시문을 얹고, 에이전트가 요약이나 최근 대화나 장기 기억이 필요할 때 AgentBridge의 명령줄 도구를 부른다. 모델을 바꿔도 처음부터 다시 설명하지 않는다.

0.6부터는 같은 배관이 반대 방향으로도 돈다. 대화 중인 에이전트가 **보조 에이전트를 띄우고**, 일을 맡기고, 실제로 무엇을 했는지 읽고, 그 결과를 원본에 얹는다. 사람이 탭 사이에서 말을 옮길 필요가 없다.

각 CLI의 원래 동작(권한 확인, 도구 승인 흐름, 세션 관리)은 그대로 둔다. AgentBridge가 CLI의 기능을 뺏지 않는다.

## 누구를 위한 것인가

- Claude · Codex · Antigravity를 번갈아 쓰면서 매번 상황을 다시 설명하는 데 지친 사람
- AI CLI 여럿을 한 화면에 놓고 같은 일을 시키고 싶은 사람
- 별도 백엔드나 계정 없이, 쓰던 CLI와 쓰던 구독으로 인계 문제만 풀고 싶은 사람

## 기능

- **여러 에이전트를 한 작업 공간에** — Claude · Codex · Antigravity 탭이 동시에 열리고, 세션 트리가 각각 지금 무엇을 하는지 보여준다.
- **가져가는 맥락** — 훅은 짧은 지시문만 얹고, 요약·원문 턴·장기 기억은 에이전트가 필요할 때 가져간다. 주입되는 양이 1KB 안팎이라 최근 대화가 밀려나지 않는다.
- **서브에이전트** — 세션 안에서 보조 에이전트를 띄운다. 각각 자기 탭으로 열려 띄운 세션 아래에 붙고, 메인이 지침을 더 보내고 기록을 읽는다.
- **선택적 격리** — 보조를 자기 git worktree에서 돌릴 수 있다. 둘이 같은 파일을 고쳐도 부딪히지 않는다. 도는 동안 그 worktree가 내장 소스 제어 뷰에 붙고, 다 되면 변경을 한 번에 원본으로 옮긴다 — 하나라도 충돌하면 아무것도 얹지 않는다.
- **장기 기억** — 사용자에 대한 사실(역할·규칙·작업 방식)과 저장소에 대한 사실. 에이전트가 일하면서 제안하고, 승인하기 전에는 아무것도 기억이 되지 않는다.
- **Context 패널** — 지금의 요약, 그 근거인 원문 턴, 이전 스냅샷을 한자리에서 본다.
- **배경 작업은 싸게** — 요약과 세션 이름 짓기는 고른 CLI로 헤드리스로 돈다. 기본은 지금 대화 중인 모델이다.
- **세션 보존** — IDE를 껐다 켜도 각 CLI의 `--resume`으로 이어진다.
- **프로젝트 폴더에 아무것도 안 쓴다** — 훅은 사용자 자신의 에이전트 설정에 깔린다. 작업 트리에는 우리 파일이 없다.

## 동작 방식 — 원칙 셋

1. **쓰던 CLI를 그대로 쓴다.** 이미 로그인해 둔 CLI를 우리가 띄운 터미널에서 돌린다. AgentBridge 백엔드도 계정도 없고, 모델 비용은 사용자 자신의 구독 안에서만 발생한다.
2. **맥락은 밀지 않고 가져간다.** 훅이 나르는 것은 기억 사본이 아니라 지시문이다. 무엇이 필요한지는 에이전트가 정해서 가져가고, 그래서 프롬프트는 작고 기록은 온전하다. 요약은 고른 CLI로 헤드리스로 돌아 주 모델 토큰을 쓰지 않는다. 정책은 넷(`priority` / `fixed` / `active` / `off`)이고 한도가 차면 다음 CLI로 넘어간다.
3. **저장소는 깨끗하게 둔다.** 훅과 에이전트 스킬은 사용자 전역 설정 — `~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.gemini/config/hooks.json` — 에 표식 블록으로 들어가 사용자 설정을 건드리지 않는다. AgentBridge가 쌓는 것은 전부 `~/agentbridge/` 아래에 있다. `agentbridge uninstall`로 훅을 다시 걷어낼 수 있다.

## 요구 사항

AgentBridge는 사용자 환경의 CLI를 그대로 돌린다. 쓰려는 모델의 CLI를 따로 설치해야 하고, 최소 하나는 있어야 한다.

| 모델 | 설치 안내 | 인증 |
|---|---|---|
| Claude (`claude`) | [claude.ai/code](https://www.claude.com/product/claude-code) | `claude` 실행 후 안내를 따른다 |
| Codex (`codex`) | [openai.com/codex](https://openai.com/codex) | `codex` 실행 후 안내를 따른다 |
| Antigravity (`agy`) | [antigravity.google](https://antigravity.google/product/antigravity-cli) | `agy /auth` 또는 환경 변수 |

셋 다 PATH에 있어야 한다. 일부만 깔려 있어도 동작하지만, 배경 작업을 무료 한도로 돌리려면 **Antigravity(`agy`) 설치와 인증**을 권한다. 없으면 대화 중인 모델로 떨어지고 토큰 소모 안내가 뜬다.

## 설치

VS Marketplace에서 *AgentBridge*를 검색해 설치한다. Cursor·Antigravity IDE 같은 VS Code 계열 IDE도 각자의 확장 화면에서 같은 방법으로 설치한다.

## 사용법

1. 명령 팔레트(`Cmd+Shift+P`) → **AgentBridge: New Model Session**
2. 모델을 고르면 채팅 탭이 열린다
3. 액티비티 바의 AgentBridge 아이콘에서 세션 트리, Context 패널, 승인 대기 중인 기억 제안을 본다

보조 에이전트에게 일을 시키려면 탭의 에이전트에게 말하면 된다 — 띄우고, 상태를 보고, 무엇을 했는지 읽고, 원본에 얹는 방법이 그 에이전트에게 이미 실려 있다.

## 설정

VS Code 설정(`settings.json` 또는 설정 화면):

| 키 | 기본값 | 설명 |
|---|---|---|
| `agentbridge.refine.policy` | `active` | 배경 작업을 어느 CLI로 돌릴지: `priority` / `fixed` / `active` / `off` |
| `agentbridge.refine.priorityOrder` | `[agy, codex, claude]` | `priority` 정책에서의 시도 순서 |
| `agentbridge.refine.fixedCli` | `agy` | `fixed` 정책에서 쓸 CLI |
| `agentbridge.refine.useClaude` | `true` | 배경 작업에 Claude를 쓸지. 헤드리스 `claude -p`는 구독이 아니라 API 크레딧을 쓰므로, 빼려면 끈다 |
| `agentbridge.turns.assistantDetail` | `compact` | 턴 기록에 답변을 얼마나 남길지: `full` / `compact` / `minimal` |
| `agentbridge.memory.maxArchiveSnapshots` | `15` | 이전 스냅샷을 몇 개까지 둘지. 넘으면 오래된 것부터 지운다 |

## 프라이버시

AgentBridge에는 자체 서버가 없다. 사용자 환경에 이미 있는 CLI를 중개할 뿐이고, 데이터가 흐르는 길은 아래 둘뿐이다.

- **사용자의 메시지** — 인증해 둔 CLI(claude / codex / agy)를 통해 그 CLI가 원래 통신하는 백엔드(Anthropic / OpenAI / Google)로만 간다. 중간에 우리 쪽을 경유하지 않는다.
- **배경 작업** — 요약과 세션 이름 짓기 등은 같은 CLI를 헤드리스로 불러 처리한다. 요청은 그 CLI의 원래 백엔드로만 가고, 결과는 사용자 기기에 저장된다.

그 밖으로 나가는 것은 없다. 분석도 원격 측정도 제3의 서비스도 없다. 세션 기록·턴 로그·기억·터미널 재생 버퍼는 전부 로컬 파일이다.

## 데이터 위치

전부 `~/agentbridge/` 아래에 프로젝트 폴더 기준으로 쌓인다.

```
~/agentbridge/
├── workspaces/<폴더 이름>-<해시>/
│   ├── workspace.json                  ← 세션 목록과 상태
│   ├── ir.json                         ← 작업 요약
│   ├── turns.jsonl                     ← 원문 턴
│   ├── archive/                        ← 이전 스냅샷
│   ├── sessions/<세션 id>/             ← 탭별 재생 버퍼와 훅 신호
│   └── trees/<이름>/                   ← 격리한 서브에이전트의 worktree
├── attachments/                        ← 채팅에 붙여넣은 이미지
└── global/
    ├── profiles/default/               ← 사용자에 대해 아는 것
    │   ├── proposals/                  ← 승인 대기 중인 제안
    │   └── docs/<카테고리>/<slug>.md   ← 승인된 것
    └── projects/<저장소>-<해시>/       ← 이 저장소에 대해 아는 것
```

사용자 자신의 에이전트 설정에는 훅과 스킬을 위한 표식 블록만 생긴다.

```
~/.claude/settings.json          ~/.claude/skills/agentbridge/
~/.codex/hooks.json              ~/.agents/skills/agentbridge/
~/.gemini/config/hooks.json      ~/.gemini/config/skills/agentbridge/
```

## 라이선스

[MIT](LICENSE) © h-taek
