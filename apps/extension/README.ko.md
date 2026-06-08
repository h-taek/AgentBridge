# AgentBridge — IDE 익스텐션

> VS Code · Cursor · Antigravity IDE 등 VS Code 계열 IDE 익스텐션. 컨셉·동작 원리·CLI 요구사항은 [모노레포 README](https://github.com/h-taek/AgentBridge/blob/main/README.ko.md) 참고.

<p align="center">
  <a href="https://github.com/h-taek/AgentBridge/blob/main/LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-green.svg"></a>
  <img alt="Extension" src="https://img.shields.io/badge/extension-IDE-007ACC.svg">
</p>

---

## 데스크탑 대비 차이

데스크탑 앱과 코어 로직을 공유하지만, IDE 환경 제약상 다음 항목이 빠지거나 간소화돼 있다.

1. **사용량 사전 측정 + 자동 폴백 (proactive)** — 데스크탑은 정제 직후 백그라운드 probe로 quota를 측정해 한도 근접 *전*에 다음 모델로 전환. 익스텐션은 refine 호출이 실패한 *후*에야 priority 순서대로 폴백한다 (한 번의 실패가 항상 발생)
2. **IR 카드 개별 삭제** — 데스크탑은 각 IR 섹션(decisions/files/commands/tests/pending) 카드 단위 삭제 가능. 익스텐션은 전체 reset만 지원
3. **네이티브 파일 드래그 앤 드롭** — 데스크탑은 OS 레벨 드롭으로 절대 경로가 자동 paste. 익스텐션은 프로젝트 폴더 내에 사본을 생성하고 해당 사본의 경로를 전달 (사본은 일정 시간 후 자동 삭제)
4. **멀티 윈도우 / 내장 zsh 터미널 탭** — 데스크탑 전용. 익스텐션은 IDE 한 인스턴스 안에서 동작하고 터미널은 IDE 자체 기능 사용

양쪽 앱 공통 기능(메모리 패널·refine 정책·hook 자동 주입 등)은 [모노레포 README](https://github.com/h-taek/AgentBridge/blob/main/README.ko.md) 참고.

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

## 라이선스

[MIT](https://github.com/h-taek/AgentBridge/blob/main/LICENSE) © h-taek
