# AgentBridge (Extension)

여러 AI 코딩 에이전트(Claude · Codex · Antigravity) 사이에서 작업 맥락이 자동으로 따라가는 IDE 익스텐션.

원본 macOS 데스크탑 앱 — **[h-taek/AgentBridge_App](https://github.com/h-taek/AgentBridge_App)** — 의 IDE 익스텐션 포팅판이다. 컨셉·동작 원리·IR 메커니즘·hook 설계 등 **자세한 설명은 원본 README** 를 참고하면 된다.

## 무엇을 해결하나 (요약)

Claude Code, OpenAI Codex CLI, Antigravity CLI를 병행 사용할 때 모델을 갈아탈 때마다 작업 맥락이 끊기는 **context handoff** 문제를 해결한다. 한 워크스페이스 안에서 각 CLI의 native 기능을 그대로 유지한 채, 매 사용자 메시지에 **IR(Intermediate Representation)** 을 hook으로 자동 주입한다.

## 원본 대비 축약된 기능

익스텐션은 원본 데스크탑 앱의 핵심 흐름을 그대로 유지하지만, IDE 환경 제약 때문에 다음 항목은 빠지거나 간소화되어 있다.

1. **자동 quota 폴백 (proactive)** — 원본은 각 모델량의 샤용량을 실시간 감지해 95% 도달 전 다른 모델로 미리 전환한다. 익스텐션은 refine 호출이 실패한 *후에야* priority 순서대로 폴백한다 (한 번의 실패 발생)
2. **Probe(사전 호출)로 quota 잔량 조회 불가** — Gemini/Claude/Codex 모두 사용량을 별도 명령으로 조회할 수단을 제공하지 않는다. 실패 시점에서야 인지 가능
3. **IR 상세 모달 / IR 카드 개별 삭제** — 원본은 각 IR 섹션(decisions/files/commands/tests/pending) 카드 단위 삭제가 가능하지만, 익스텐션은 전체 reset만 지원
4. **네이티브 파일 드래그 앤 드롭** — 원본은 OS 레벨 드롭으로 절대 경로가 모델 입력에 자동 paste 되지만, 익스텐션은 프로젝트 폴더 내에 사본을 생성하고 해당 사본의 경로를 전달한다(사본 일정 시간 후 자동으로 삭제).

## 사전 요구사항

최소 한 개 이상의 CLI가 설치되어 있어야 한다.

| 모델 | 설치 안내 |
|---|---|
| Claude Code (`claude`) | [docs.anthropic.com/en/docs/claude-code](https://docs.anthropic.com/en/docs/claude-code) |
| OpenAI Codex CLI (`codex`) | [github.com/openai/codex](https://github.com/openai/codex) |
| Antigravity CLI (`agy`) | [antigravity.google](https://antigravity.google/product/antigravity-cli) |

## 시작하기

1. 익스텐션 설치
2. Command Palette (`Cmd+Shift+P`) → **AgentBridge: New Model Session**
3. 모델 선택 후 대화 시작


## 설정

| 키 | 기본값 | 설명 |
|---|---|---|
| `agentbridge.refine.policy` | `priority` | Refine 모델 선택: priority / fixed / active / off |
| `agentbridge.refine.priorityOrder` | `[agy, codex, claude]` | priority 정책의 시도 순서 |
| `agentbridge.refine.fixedCli` | `agy` | fixed 정책일 때 사용할 CLI |
| `agentbridge.turns.assistantDetail` | `compact` | turns.jsonl 응답 디테일: full / compact / minimal |
| `agentbridge.memory.maxArchiveSnapshots` | `15` | IR 스냅샷 보관 최대 개수. 초과분은 가장 오래된 것부터 자동 삭제 |

## 라이선스

MIT — 자세한 내용은 [LICENSE](LICENSE) 참고.

원본 프로젝트: https://github.com/h-taek/AgentBridge_App
