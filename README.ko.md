<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="packages/assets/brand/agentbridge-dark.svg" />
    <img src="packages/assets/brand/agentbridge-light.svg" width="220" alt="AgentBridge logo" />
  </picture>
</p>

# AgentBridge

> 여러 AI 코딩 에이전트(Claude · Codex · Antigravity) 사이에서 작업 맥락이 자동으로 따라가는 도구. macOS(Apple Silicon)에서 IDE 익스텐션으로 제공.

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-green.svg"></a>
  <img alt="Version" src="https://img.shields.io/badge/version-0.5.x-orange.svg">
  <img alt="Extension" src="https://img.shields.io/badge/extension-Apple%20Silicon-007ACC.svg">
</p>

---

## 무엇을 해결하나

Claude Code CLI, Codex CLI, Antigravity CLI를 병행 사용할 때 발생하는 **context handoff** 문제 — 모델을 갈아탈 때마다 작업 맥락이 끊기는 문제 — 를 해결한다.

AgentBridge는 한 워크스페이스 안에 여러 모델 탭을 *동시에* 띄우고, 매 사용자 메시지마다 **IR(Intermediate Representation, "공유 메모리")** 을 hook 메커니즘으로 자동 주입한다. 모델을 갈아타도 *어디까지 작업했고 무엇을 결정했는지* 가 끊기지 않는다.

이 단기 기억 위에, AgentBridge는 **장기 기억(global context)** 도 쌓는다: 당신과 당신의 작업 방식에 관한 오래 가는 사실(역할·컨벤션·워크플로…)을 대화에서 자동 제안하고, 승인하면 *모든* 워크스페이스·세션에 걸쳐 유지된다 — ChatGPT/Claude 메모리처럼, 단 로컬에 저장되고 여러 CLI가 공유한다.

각 CLI의 기본 동작(권한 다이얼로그, 도구 승인 흐름, 세션 관리)은 그대로 유지된다. AgentBridge는 CLI의 native 기능을 제한하지 않는다.

## 이런 분께

- Claude · Codex · Antigravity를 번갈아 쓰며, 모델을 갈아탈 때마다 작업 맥락을 다시 설명하는 게 답답한 사람
- 여러 AI CLI를 한 화면에 띄워 두고 비교하며 일하고 싶은 사람
- 별도 백엔드·계정 없이, 이미 쓰던 자기 CLI·구독 그대로 context handoff만 해결하고 싶은 사람

## 주요 기능

- **멀티 에이전트 워크스페이스** — Claude · Codex · Antigravity CLI 탭을 한 워크스페이스에서 동시에 띄운다.
- **IR 자동 핸드오프** — 매 메시지마다 공유 메모리(IR)가 hook으로 주입돼, 모델을 갈아타도 작업 맥락이 끊기지 않는다.
- **무료/저비용 정제** — 기본 정책이 메모리 갱신을 Antigravity 무료 티어 CLI로 헤드리스 수행해 메인 모델 토큰을 소비하지 않는다.
- **메모리 패널** — 현재 메모리 · 이전 스냅샷 · 턴 흐름을 한눈에 보고, 수동 정제·초기화를 할 수 있다.
- **장기 기억(global context)** — 오래 가는 지식(역할 · 컨벤션 · 워크플로 · …)을 대화에서 자동 제안하고, 승인/버림으로 큐레이션한다. 승인된 기억은 모든 워크스페이스가 공유한다. 자동 제안은 설정에서 끌 수 있다.
- **세션 영속화 + resume** — 앱을 껐다 켜도 native `--resume`으로 이전 대화를 그대로 이어간다.
- **자동 세션 이름** — 새 채팅 세션이 첫 메시지로 자동 명명돼, 탭과 사이드바에 모델명 대신 짧은 제목이 표시된다. 이름은 언제든 직접 바꿀 수 있다.
- **사용자 자산 격리** — 글로벌 설정을 수정하지 않고, 사용자가 이미 인증한 본인 CLI만 임베드한다.

## 동작 원리 — 세 가지 원칙

1. **사용자 자신의 CLI를 그대로 사용** — 사용자가 *이미 인증한 자기 CLI*를 PTY로 임베드한다. 별도 AgentBridge 백엔드·계정 시스템은 없으며, 메인 모델 비용은 사용자 본인의 subscription 안에서만 발생한다.
2. **IR 자동 핸드오프** — 모델 전환·매 메시지마다 IR이 hook으로 자동 주입된다. 사용자가 명시 정제 액션으로 IR을 갱신하거나, compaction 임계를 넘으면 자동으로 정제된다. IR 정제는 **무료/저비용 CLI를 헤드리스로 호출**해 수행하므로 메인 모델 토큰을 0 소비한다. 정제 정책은 `우선순위` / `고정` / `활성 모델` / `끔` 4단계 중 선택할 수 있고, 한도 근접/초과 시 다음 CLI로 자동 폴백한다.
3. **사용자 자산 격리** — 글로벌 설정(`~/.claude` / `~/.codex` / `~/.agents`)은 수정하지 않는다. 워크스페이스 cwd에는 CLI native config(`.codex/hooks.json` / `.codex/config.toml` / `.agents/hooks.json`)만 마커 블록 merge 방식으로 추가하며, claude는 cwd 무침범(`--settings <격리 경로>` flag 활용)으로 동작한다.

## 사전 요구사항

AgentBridge는 사용자 환경의 CLI를 임베드하므로, 사용하려는 모델의 CLI는 별도로 설치되어 있어야 한다. 최소 한 개 이상 필요.

| 모델 | 설치 안내 | 인증 |
|---|---|---|
| Claude (`claude`) | [claude.ai/code](https://www.claude.com/product/claude-code) | `claude` 실행 후 안내 |
| Codex (`codex`) | [openai.com/codex](https://openai.com/codex) | `codex` 실행 후 안내 |
| Antigravity (`agy`) | [antigravity.google](https://antigravity.google/product/antigravity-cli) | `agy /auth` 또는 환경변수 |

세 CLI 모두 PATH에 등록되어 있어야 한다. 일부만 설치되어 있어도 동작하지만, IR 정제를 무료 티어로 수행하려면 **Antigravity(`agy`) 설치 + 인증**이 권장된다 (없으면 활성 모델 폴백 + 토큰 비용 경고).

## 사용 가능 형태

- macOS(Apple Silicon) IDE 익스텐션 — VS Code · Cursor · Antigravity IDE 등 VS Code 계열 IDE에서 동작. [설치·사용법](apps/extension/README.ko.md)

## 프라이버시

AgentBridge는 자체 서버나 백엔드 없이 사용자 본인 환경의 CLI만 매개한다. 데이터 흐름은 다음 두 경로로만 한정된다.

- **메인 모델 메시지** — 사용자가 인증한 각 CLI(claude / codex / agy)를 통해, 그 CLI가 원래 통신하는 모델 백엔드(Anthropic / OpenAI / Google)로만 전송된다. AgentBridge가 중간에 별도 서비스로 우회하지 않는다.
- **IR 정제** — 정제 정책에 따라 선택된 사용자 인증 CLI(기본은 Antigravity)를 헤드리스로 호출해 수행한다. 정제 요청은 그 CLI가 원래 통신하는 백엔드로만 전송되며, 결과 IR JSON은 사용자 머신에 저장된다.

위 두 경로 외 어떤 외부 서비스(자체 백엔드, 분석·텔레메트리, 제3자 요약 등)로도 전송되지 않는다. 워크스페이스 메타데이터·대화 기록·메모리(IR)·turns 로그·replay 버퍼는 모두 사용자 머신에만 저장된다.

## 데이터 위치

모든 데이터는 프로젝트 폴더를 키로 `~/.agentbridge/` 아래에 둔다(V-12 통일 저장소).

```
~/.agentbridge/                              ← AgentBridge 메타데이터
├── workspaces/<workspaceId>/
│   ├── workspace.json
│   ├── ir.json                             ← 압축된 공유 메모리 (단기)
│   ├── turns.jsonl                         ← raw 턴 로그
│   ├── archive/                            ← compaction 스냅샷
│   ├── sessions/<sessionId>/replay.log     ← PTY raw bytes (탭별)
│   └── settings/claude-settings.json       ← claude --settings flag 대상
└── global/profiles/default/                ← 장기 기억 (글로벌 프로필, 공유)
    ├── proposals/                          ← 대기 중 자동 제안 (승인 전)
    └── docs/<category>/<slug>.md           ← 승인된 장기 기억

<사용자 워크스페이스 cwd>/           ← 사용자 프로젝트
├── .codex/hooks.json           ← codex hook (마커 블록 merge)
├── .codex/config.toml          ← codex hook enable (마커 블록 merge)
├── .agents/hooks.json          ← agy(Antigravity) hook (마커 블록 merge)
└── (사용자 파일들 — AgentBridge 무관)
```

## 라이선스

[MIT](LICENSE) © h-taek

장기 기억 모듈은 [gc-tree](https://github.com/handsupmin/gc-tree)(MIT)의 코드를 각색했습니다. [NOTICE](NOTICE) 참고.
