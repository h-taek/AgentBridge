# AgentBridge — IDE 익스텐션

> VS Code · Cursor · Antigravity IDE 등 VS Code 계열 IDE 익스텐션. 컨셉·동작 원리·CLI 요구사항은 [모노레포 README](https://github.com/h-taek/AgentBridge/blob/main/README.ko.md) 참고.

<p align="center">
  <a href="https://github.com/h-taek/AgentBridge/blob/main/LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-green.svg"></a>
  <img alt="Extension" src="https://img.shields.io/badge/extension-Apple%20Silicon-007ACC.svg">
</p>

---

기능 전반(메모리 패널·refine 정책·hook 자동 주입 등)은 [모노레포 README](https://github.com/h-taek/AgentBridge/blob/main/README.ko.md) 참고.

## 설치

VS Marketplace에서 *AgentBridge* 검색 후 설치. (Cursor · Antigravity IDE 등 VS Code 계열 IDE도 사이드 메뉴에서 동일하게 설치 가능.)

## 사용법

1. Command Palette (`Cmd+Shift+P`) → **AgentBridge: New Model Session**
2. 모델 선택 → chat 패널 띄움
3. Activity Bar의 AgentBridge 아이콘 → 좌 사이드바에 세션 트리, 메모리 패널 표시

## 설정

VS Code 설정(`settings.json` 또는 Settings UI):

| 키 | 기본값 | 설명 |
|---|---|---|
| `agentbridge.refine.policy` | `priority` | Refine 모델 선택: priority / fixed / active / off |
| `agentbridge.refine.priorityOrder` | `[agy, codex, claude]` | priority 정책의 시도 순서 |
| `agentbridge.refine.fixedCli` | `agy` | fixed 정책일 때 사용할 CLI |
| `agentbridge.turns.assistantDetail` | `compact` | turns.jsonl 응답 디테일: full / compact / minimal |
| `agentbridge.memory.maxArchiveSnapshots` | `15` | IR 스냅샷 보관 최대 개수. 초과분은 가장 오래된 것부터 자동 삭제 |
| `agentbridge.memory.proposalEnabled` | `true` | 대화에서 장기 기억 후보를 자동 제안. 끄면 자동 제안 비활성화 |

## 라이선스

[MIT](https://github.com/h-taek/AgentBridge/blob/main/LICENSE) © h-taek
