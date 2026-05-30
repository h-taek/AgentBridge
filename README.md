# AgentBridge

> 여러 AI 코딩 에이전트(Claude · Codex · Antigravity) 사이에서 작업 맥락이 자동으로 따라가는 도구. macOS 데스크탑 앱과 VS Code 익스텐션 두 형태로 제공.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## 무엇을 해결하나

Claude Code, OpenAI Codex CLI, Google Antigravity CLI를 병행 사용할 때 발생하는 **context handoff** 문제 — 모델을 갈아탈 때마다 작업 맥락이 끊기는 문제 — 를 해결한다.

AgentBridge는 한 워크스페이스 안에 여러 모델 탭을 *동시에* 띄우고, 매 사용자 메시지마다 **IR(Intermediate Representation, "공유 메모리")** 을 hook 메커니즘으로 자동 주입한다. 모델을 갈아타도 *어디까지 작업했고 무엇을 결정했는지* 가 끊기지 않는다.

각 CLI의 기본 동작(권한 다이얼로그, 도구 승인 흐름, 세션 관리)은 그대로 유지된다. AgentBridge는 CLI의 native 기능을 제한하지 않는다.

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

- MacOS용 데스크탑 앱
- VS Code extension

## 프라이버시 / 데이터 위치

AgentBridge는 자체 서버나 백엔드 없이 사용자 본인 환경의 CLI만 매개한다. 데이터 흐름은 다음 두 경로로만 한정된다.

- **메인 모델 메시지** — 사용자가 인증한 각 CLI(claude / codex / agy)를 통해, 그 CLI가 원래 통신하는 모델 백엔드(Anthropic / OpenAI / Google)로만 전송된다. AgentBridge가 중간에 별도 서비스로 우회하지 않는다.
- **IR 정제** — 정제 정책에 따라 선택된 사용자 인증 CLI(기본은 Antigravity)를 헤드리스로 호출해 수행한다. 정제 요청은 그 CLI가 원래 통신하는 백엔드로만 전송되며, 결과 IR JSON은 사용자 머신에 저장된다.

위 두 경로 외 어떤 외부 서비스(자체 백엔드, 분석·텔레메트리, 제3자 요약 등)로도 전송되지 않는다. 워크스페이스 메타데이터·대화 기록·메모리(IR)·turns 로그·replay 버퍼는 모두 사용자 머신에만 저장된다. 정확한 저장 위치는 각 앱 README 참고 — 데스크탑은 `~/Library/Application Support/AgentBridge/`, 익스텐션은 VS Code globalStorage 격리 경로.

---

## 모노레포 구조 (기여자용)

```
packages/core/    # @agentbridge/core — 양쪽 앱이 공유하는 코어 로직
apps/desktop/     # Electron 데스크탑 앱
apps/extension/   # VS Code 익스텐션
```

코어는 `vscode` / `electron` 모듈을 직접 import하지 않는다. 사이드이펙트(로깅, 파일 IO, 이벤트)는 인터페이스로 받고 각 앱이 구현체를 주입한다.

```sh
pnpm install
pnpm typecheck
pnpm build
```

각 패키지는 `changesets`로 독립 버전업·릴리스된다.

## 라이선스

[MIT](LICENSE) © h-taek
