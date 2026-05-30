# Changelog

All notable changes to the AgentBridge extension. 본 익스텐션은 원본 [AgentBridge_App](https://github.com/h-taek/AgentBridge_App)의 IDE 포팅판이다.

[Keep a Changelog](https://keepachangelog.com/) 형식을 따른다 — 항목은 `Added` / `Changed` / `Fixed` / `Removed` / `Security`로 구분한다.

## [0.1.6] — 2026-05-24

### Changed
- 패키지 잠금 파일의 메타데이터를 현재 릴리스 정보와 동기화했다. 의존성 변경 없음.

### Fixed
- codex 세션에서 hook 컨텍스트 주입 직후 화면이 멈추던 현상 해결 (PTY 출력 필터 매칭 안정화)
- 컨텍스트 차단 안전망(watchdog) 타임아웃 단축 (5초 → 1초) — 매칭 실패 극한 케이스에서도 멈춤 시간 단축
- 채팅 출력이 누적된 뒤 일부 글자가 다른 글리프로 잘못 표시되던 현상 해결 (터미널 렌더러 업스트림 패치 반영)
- Memory refinement fallback 알림 문구가 실제 사유(미설치 / 쿼터 / 응답 파싱 실패)와 무관하게 "CLI not installed"로 단정되던 문제 — 사유별로 정확히 안내하도록 변경

### Removed
- 사용되지 않는 내부 코드와 정적 분석 설정을 제거했다. 런타임 동작 변경 없음.

## [0.1.5] — 2026-05-24

### Changed
- README 재작성 (런타임 동작 변경 없음)

## [0.1.4] — 2026-05-24

### Added
- Shift+Enter 멀티라인 입력 (한글 IME 조합 중에도 안전)
- IDE 재시작 시 직전 챗 탭 자동 복구 (`--resume`으로 대화 연속)
- 챗 터미널 ANSI 색상이 IDE 컬러 테마를 따르고, 테마 전환 시 라이브로 갱신
- 설정 `agentbridge.memory.maxArchiveSnapshots` — IR 스냅샷 보관 개수 사용자 지정 (기본 15)

### Changed
- 챗 패널은 활성 에디터 우측에 배치 — 이미 split이 있으면 가장 오른쪽 컬럼에 탭으로 누적
- Refine 우선순위 설정에 항목 수 고정(3개) 및 중복 방지 — 설정 UI에서 "Add Item" 비활성, 같은 모델 두 번 시도 방지
- 누적된 IR 스냅샷은 한도(`maxArchiveSnapshots`) 초과 시 가장 오래된 것부터 자동 정리
- Memory 패널 레이아웃 정비

### Fixed
- 다른 사이드바(Explorer 등) 사용 중에 챗 탭을 클릭하면 사이드바가 강제로 AgentBridge로 전환되던 문제

## [0.1.3] — 2026-05-23

### Changed
- README 재작성 및 배포 메타데이터 정비 (런타임 동작 변경 없음)

## [0.1.2] — 2026-05-23

### Fixed
- 일부 CLI의 TUI 렌더링 환경에서 hook context 처리가 멈추던 PTY 안정성 문제

## [0.1.1] — 2026-05-23

### Changed
- README 재작성, marketplace 메타데이터 보강, 패키징 산출물 정리 (런타임 동작 변경 없음)

## [0.1.0] — 2026-05-23

첫 공개 릴리스 (Open VSX). 원본 [AgentBridge_App](https://github.com/h-taek/AgentBridge_App)의 핵심 동작을 IDE 익스텐션 환경에 맞게 이식 — [원본 대비 축약된 기능](README.md#원본-대비-축약된-기능) 참고.
