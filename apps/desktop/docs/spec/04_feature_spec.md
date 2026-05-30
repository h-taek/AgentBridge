# 기능 명세

사용자 시나리오에서 도출한 기능 목록이다.

> ⚠️ **Phase 4 M3 architecture revision 반영 (2026-05-11)** — 단일 스레드 sequential 전환 모델 → *workspace + multi-tab parallel* 모델로 진화. F-02/F-03/F-04 갱신, F-03c(메모리 요약 = gemini-flash) 추가. 자세한 설계는 [02_architecture.md §14](../plan/02_architecture.md) / [03_milestones.md §6](../plan/03_milestones.md) 참조.

---

## F-01. 채팅 인터페이스

선택한 모델과 채팅 형태로 대화한다.

- 사용자가 메시지를 입력하면 선택된 모델이 응답한다
- 현재 대화 중인 모델이 표시된다 (활성 탭으로)
- 응답 스트리밍 중 사용자가 응답을 중지할 수 있고, 받은 부분까지의 응답은 보존된다
- 관련 시나리오: 전체

---

## F-02. 모델 전환 (multi-tab)

한 워크스페이스 안에 *여러 모델 탭을 동시에* 두고 자유롭게 전환한다.

- 워크스페이스 안에 claude / codex / gemini 탭을 *추가*할 수 있다 (각 탭이 한 모델의 PTY)
- 모델 전환 = 새 탭 *추가* 또는 기존 탭 *클릭*. 기존 탭의 PTY는 살아있음 (kill 안 함)
- 새 탭이 추가될 때 *해당 시점의 IR*이 새 모델에 자동 주입됨
- 지원 모델: Claude, Codex, Gemini (탭 단위로 독립 spawn)
- 관련 시나리오: 전체

---

## F-03. 맥락 유지 (per-message hook inject)

매 사용자 메시지마다 IR이 자동으로 모델 컨텍스트에 주입된다.

- 각 CLI의 native hook 메커니즘 활용 (claude/codex/gemini 모두 hook 시스템 보유)
- claude는 `--settings <격리 경로>`로 hook 등록 (글로벌 무침범), codex/gemini는 워크스페이스 cwd의 project-local 설정으로 등록
- alive 탭이 mid-session에 항상 최신 IR을 받음 — 사용자가 별도 트리거 없이도 다른 탭의 진행 상황을 자연스럽게 인지
- 사용자가 별도로 설명하지 않아도 새 모델이 이전 대화 내용을 파악한다
- 관련 시나리오: 전체

---

## F-03b. 맥락 유지 (사용자 검토)

사용자가 메모리 패널에서 IR을 직접 확인하고 필요 시 갱신/초기화한다.

- 우 사이드바 메모리 패널에 현재 IR 카드 + 과거 archive 스냅샷 카드 + Turn 흐름 카드 + Refine/Quota 카드 + AI 지시 파일 카드를 표시
- 현재 IR 카드를 클릭하면 6 섹션(intent / decisions / files / commands / tests / pending) 상세 모달이 열림
- 메모리 그룹 헤더의 ✨ refine 버튼으로 수동 IR 재정제, 🗑 메모리 초기화 버튼으로 IR(+옵션 turns) 빈 상태로 reset
- 초기화는 archive 스냅샷을 보존하므로 직전 상태로 promote 복원 가능
- 적용 후 *모든 alive 탭*이 다음 사용자 메시지부터 새 IR을 hook으로 받음
- 관련 시나리오: 전체

---

## F-03c. 메모리 요약 (gemini-flash 헤드리스)

IR refine은 사용자 인증 gemini CLI를 헤드리스로 호출해 수행한다.

- 기본: gemini-2.5-flash 헤드리스 spawn (무료 티어 1000 req/일 활용)
- 사용자 머신에 gemini가 인증되어 있으면 메인 모델 토큰 0 소비
- gemini 미설치 시 폴백: 활성 모델 헤드리스(claude/codex) — 사용자 토큰 비용 발생, UI에 노란 배지 표시
- 한도 도달 시(800/950 임계) 자동 폴백 + 사용자 경고
- 사용자 설정에서 명시 모델 선택 가능 (auto/gemini-flash/active/off)
- 관련 시나리오: 전체

---

## F-04. 대화 히스토리

워크스페이스 단위로 대화가 영속화되며, 각 모델 탭은 자기 PTY raw 출력을 별개 보관한다.

- 워크스페이스 안 각 세션(=탭)이 자기 모델의 응답을 독립 보관 (`replay.log`)
- 워크스페이스 단위 통합 turns.jsonl에 모든 탭의 user msg + assistant 1줄 요약 기록
- 워크스페이스 재진입 시 마지막으로 활성이었던 탭 또는 사용자가 마지막 본 탭으로 복원
- 이전 워크스페이스/탭을 선택해 이어서 진행할 수 있다 (각 CLI의 `--resume` 활용)
- 관련 시나리오: 전체

---

## F-05. 모델 관리

지원 모델 목록을 관리한다.

- 사용 가능한 모델 목록을 확인할 수 있다
- 새로운 모델을 추가할 수 있다
- 관련 시나리오: 전체
