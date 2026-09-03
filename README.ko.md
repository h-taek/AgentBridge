<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="packages/assets/brand/agentbridge-dark.png" />
    <img src="packages/assets/brand/agentbridge-light.png" width="220" alt="AgentBridge 로고" />
  </picture>
</p>

<h1 align="center">AgentBridge</h1>

<p align="center">
  <img alt="version 0.6.0" src="https://img.shields.io/badge/version-0.6.0-orange">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-green.svg"></a>
  <img alt="macOS Apple Silicon" src="https://img.shields.io/badge/macOS-Apple%20Silicon-4493F8">
</p>

<p align="center"><a href="README.md"><b>English</b></a></p>

<p align="center">
  Claude · Codex · Antigravity를 단일 작업 공간에서 실행하고 작업 맥락을 공유한다.<br />
  모델을 바꿔도 어디까지 작업했는지 다시 설명하지 않는다.
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=h-taek.agentbridge"><b>Marketplace</b></a> ·
  <a href="https://open-vsx.org/extension/h-taek/agentbridge"><b>OpenVSX</b></a> ·
  <a href="https://github.com/h-taek/AgentBridge/releases"><b>Release</b></a>
</p>

<p align="center"><img src="packages/assets/readme/hero.png" alt="AgentBridge 작업 화면" width="960" /></p>

## 무엇을 해결하는가

Claude Code, Codex, Antigravity를 번갈아 쓰면 모델을 바꿀 때마다 작업 상황을 처음부터 다시 설명해야 한다. AgentBridge는 세 CLI를 단일 작업 공간에 탭으로 띄우고 작업 기록을 공유한다. 지금까지의 진행 요약, 대화 원문, 사용자와 저장소에 관한 장기 기억이 한곳에 남는다.

기록을 프롬프트에 밀어 넣지는 않는다. 훅은 짧은 지시문 한 줄만 붙이고, 에이전트가 필요하다고 판단했을 때 `agentbridge` 명령으로 직접 가져간다.

## 누구를 위한 것인가

- 세 CLI를 오가며 같은 설명을 되풀이하는 사람
- 여러 에이전트를 한 화면에서 같은 작업에 투입하고 싶은 사람
- 새 계정이나 별도 서버 없이 기존 CLI와 구독만 쓰고 싶은 사람

## 기능

<table>
<tr>
<td width="50%">
<h3>한 작업 공간, 세 에이전트</h3>
<p>Claude와 Codex, Antigravity 탭을 동시에 띄운다. 세션 트리에서 어느 세션이 돌고 있고 어느 세션이 끝났는지 본다.</p>
</td>
<td width="50%"><img src="packages/assets/readme/feature-workspace.gif" alt="세션 트리와 모델 탭 세 개" /></td>
</tr>
<tr>
<td width="50%">
<h3>모델을 바꿔도 이어지는 맥락</h3>
<p>요약과 대화 원문, 그리고 알려준 것이 한 벌로 남고, 새로 연 탭이 그중 필요한 만큼만 가져가므로 상황을 다시 설명하지 않아도 된다. 주입되는 블록은 1KB 안팎이라 최근 턴이 밀려 사라지지 않는다.</p>
</td>
<td width="50%"><img src="packages/assets/readme/feature-context.gif" alt="모델을 바꿔 작업을 잇는 장면" /></td>
</tr>
<tr>
<td width="50%">
<h3>에이전트가 띄우는 에이전트</h3>
<p>지금 대화 중인 에이전트에게 서브에이전트를 띄우라고 하면 된다. 서브는 자기 탭으로 열려 부모 세션 아래에 묶이고, 부모는 후속 지시를 보내고 서브가 남긴 기록을 읽는다.</p>
</td>
<td width="50%"><img src="packages/assets/readme/feature-subagents.gif" alt="서브에이전트 생성과 결과 회수" /></td>
</tr>
<tr>
<td width="50%">
<h3>격리 워크트리</h3>
<p>서브를 자기 git 워크트리에서 돌릴 수 있다. 둘이 같은 파일을 고쳐도 부딪히지 않는다. 도는 동안 내장 소스 컨트롤에 그 워크트리가 뜨고 끝나면 한꺼번에 합치는데, 충돌이 하나라도 있으면 아무것도 합치지 않고 원래 폴더를 그대로 둔다.</p>
</td>
<td width="50%"><img src="packages/assets/readme/feature-worktree.gif" alt="내장 소스 컨트롤의 격리 워크트리" /></td>
</tr>
<tr>
<td width="50%">
<h3>승인해야 남는 기억</h3>
<p>역할이나 일하는 방식, 저장소의 관례처럼 오래 가는 것만 남긴다. 에이전트가 일하다 제안하고, 승인한 것만 기억이 된다.</p>
</td>
<td width="50%"><img src="packages/assets/readme/feature-memory.gif" alt="장기 기억 패널과 승인 대기 제안" /></td>
</tr>
</table>

### 그 외 기능

- 기존 CLI와 구독 사용 — 자체 서버나 별도 계정이 없다. 모델 비용은 기존에 쓰던 CLI 구독 범위 안에서만 발생한다.
- 프로젝트 폴더 보존 — 훅과 스킬은 사용자 에이전트 설정에 설치한다. 저장소에는 AgentBridge 파일을 쓰지 않는다.
- 저비용 백그라운드 작업 — 작업 요약과 세션 명명은 지정한 CLI를 헤드리스로 실행해 처리한다. 할당량이 소진되면 다음 CLI로 넘어간다.
- 파일 경로 끌어다 놓기 — Shift를 누른 채 파일을 채팅 화면에 놓으면 경로가 `@경로`로 입력줄에 들어간다. 탐색기의 파일과 편집기 탭, IDE 바깥의 파일 모두 된다.
- 세션 복원 — IDE를 다시 열어도 각 CLI의 `--resume` 기능으로 이전 세션이 이어진다.
- CLI 방식 유지 — 권한 확인과 도구 승인, 세션 관리는 각 CLI의 방식을 따른다.

## 지원 에이전트

사용자 환경에 설치된 CLI를 직접 실행한다. 세 가지 가운데 하나 이상이 필요하다.

| 에이전트 | 명령 | 설치 |
|---|---|---|
| Claude Code | `claude` | [claude.com/product/claude-code](https://www.claude.com/product/claude-code) |
| Codex | `codex` | [openai.com/codex](https://openai.com/codex) |
| Antigravity | `agy` | [antigravity.google](https://antigravity.google/product/antigravity-cli) |

인증은 각 CLI를 한 번 실행해 안내를 따르면 된다. Antigravity는 `agy /auth`를 쓴다.

백그라운드 작업을 무료 할당량으로 처리하려면 Antigravity(`agy`)를 설치하고 인증해 둔다. 사용할 수 없으면 현재 대화 중인 모델로 전환하며 토큰 사용을 알린다.

## 설치

확장 탭에서 'AgentBridge'를 검색해 설치한다. Cursor, Antigravity IDE, Windsurf에서도 각 IDE의 확장 탭을 이용한다.

[Marketplace](https://marketplace.visualstudio.com/items?itemName=h-taek.agentbridge) · [OpenVSX](https://open-vsx.org/extension/h-taek/agentbridge) · [Release](https://github.com/h-taek/AgentBridge/releases)

### 시작하기

설치하면 활동 바에 AgentBridge 아이콘이 생긴다. 누르면 사이드바에 Sessions와 Context, Long-term Memory 세 패널이 열린다.

1. Sessions 패널 제목줄의 `+` 버튼을 누른다. 편집기 탭 오른쪽 위의 AgentBridge 아이콘도 같은 일을 한다.
2. 뜬 목록에서 모델을 고르면 채팅 탭이 열리고 그 CLI가 바로 뜬다.
3. 연 세션은 Sessions 패널에 쌓인다. 눌러 다시 열고, 행에 마우스를 올려 이름을 바꾸거나 지운다.
4. Context 패널에서 지금까지의 요약과 대화 원문을, Long-term Memory 패널에서 승인 대기 중인 제안을 본다.

서브에이전트가 필요하면 채팅 탭의 에이전트에게 말하면 된다. 띄우고, 상태를 보고, 결과를 읽고, 변경을 합치는 방법이 스킬로 이미 등록돼 있다.

## 동작 방식

- 로컬 CLI 직접 실행 — 로컬에 이미 인증된 CLI를 터미널 세션에서 직접 구동한다. 중간에 외부 중계 서버를 두지 않는다.
- 맥락 조회 — 훅은 기억 사본 대신 짧은 지시문을 보낸다. 에이전트가 필요한 요약이나 최근 턴을 직접 가져가므로 프롬프트 크기를 키우지 않고 기록을 보존한다.
- 프로젝트 폴더 무결성 — 훅과 스킬은 사용자 설정의 표시된 블록에 설치되어 기존 설정을 건드리지 않는다. 데이터는 모두 `~/agentbridge/` 아래에 저장하며, `agentbridge uninstall`로 훅을 제거할 수 있다.
- Shift 드래그로 경로 삽입 — 채팅 화면은 Shift가 눌린 드래그만 IDE보다 먼저 가로챈다. 탐색기와 편집기 탭에서 온 것은 경로를 그대로 읽고, IDE 바깥에서 온 파일은 `~/agentbridge/attachments/`로 복사한 뒤 그 경로를 넣는다. 표기는 세 CLI가 모두 아는 `@경로`다.

## 설정

VS Code 설정(`settings.json` 또는 설정 화면):

| 키 | 기본값 | 설명 |
|---|---|---|
| `agentbridge.refine.policy` | `active` | 백그라운드 작업 처리 CLI 선택 정책 |
| `agentbridge.refine.priorityOrder` | `[agy, codex, claude]` | `priority` 정책 CLI 시도 순서 |
| `agentbridge.refine.fixedCli` | `agy` | `fixed` 정책 고정 CLI |
| `agentbridge.turns.assistantDetail` | `compact` | 턴 기록에 저장할 답변 양 |
| `agentbridge.memory.maxArchiveSnapshots` | `15` | 보관할 이전 스냅샷 수 |

## 데이터 위치

모든 데이터는 `~/agentbridge/` 아래에 프로젝트 폴더별로 나누어 저장한다.

```
~/agentbridge/
├── workspaces/<폴더명>-<해시>/
│   ├── workspace.json      ← 세션과 상태
│   ├── ir.json             ← 지금까지의 요약
│   ├── turns.jsonl         ← 대화 원문
│   ├── archive/            ← 이전 스냅샷
│   ├── sessions/<세션id>/  ← 탭별 리플레이 버퍼, 훅 신호
│   └── trees/<이름>/       ← 격리된 서브에이전트 워크트리
├── attachments/            ← 채팅에 붙여 넣은 파일
└── global/
    ├── profiles/default/   ← 사용자에 대해 아는 것
    └── projects/<저장소>/  ← 이 저장소에 대해 아는 것
```

각 에이전트의 전역 설정 파일에는 훅과 스킬 등록을 위한 전용 블록만 추가되며, 기존 설정은 건드리지 않는다.

```
~/.claude/settings.json          ~/.claude/skills/agentbridge/
~/.codex/hooks.json              ~/.agents/skills/agentbridge/
~/.gemini/config/hooks.json      ~/.gemini/config/skills/agentbridge/
```

## 프라이버시

AgentBridge는 자체 서버를 운영하지 않는다. 사용자의 메시지는 인증된 CLI를 통해 각 CLI의 기존 백엔드(Anthropic · OpenAI · Google)로만 간다. 요약과 세션 이름 같은 백그라운드 작업도 같은 CLI가 처리하며, 결과는 사용자 기기에 저장한다.

그 밖의 데이터는 기기 밖으로 보내지 않는다. 분석과 원격 측정, 제3자 서비스를 사용하지 않는다. 세션 기록과 턴 로그, 기억, 터미널 재생 버퍼는 모두 로컬 파일로 남는다.

## 라이선스

[MIT](LICENSE) © h-taek

장기 기억 모듈은 [gc-tree](https://github.com/handsupmin/gc-tree)(MIT)의 코드를 각색했다. [NOTICE](NOTICE) 참고.
