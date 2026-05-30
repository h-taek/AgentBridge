# MVP 정의

> ⚠️ **Phase 4 M3 architecture revision 반영 (2026-05-11)** — 단일 스레드 sequential → multi-tab workspace 모델로 진화. F-03c(메모리 요약 = gemini-flash) 추가. 자세한 설계는 [02_architecture.md §14](../plan/02_architecture.md) 참조.

## MVP 범위 선정 기준

AgentBridge의 핵심 가치는 **하나의 앱에서 여러 모델을 동시에 활용하며 매 메시지마다 맥락이 자동 공유되는 것**이다.
맥락 유지는 워크스페이스 단위 IR + per-message hook 주입 위에서 동작하므로, 워크스페이스·세션·히스토리 관리는 핵심 가치의 일부다.
MVP는 이 핵심 가치를 완전히 검증할 수 있는 최소 기능으로 구성한다.

## MVP 환경 / 배포

- **OS:** macOS 전용. Windows/Linux는 향후 단계
- **배포:** 오픈소스, GitHub 릴리즈
- **모델 통합:** Claude Code / Codex CLI / Gemini CLI를 subprocess로 호출. 사용자는 각 CLI에 사전 로그인되어 있어야 한다 (AgentBridge는 별도 인증을 받지 않는다)
- **Gemini 권장:** 메모리 요약(F-03c)에 gemini-2.5-flash 헤드리스 사용. 무료 티어 1000 req/일 활용 시 사용자 메인 모델 토큰 0 소비. 미설치 시 활성 모델 폴백

---

## MVP 포함 기능

| 기능 | 이유 |
|------|------|
| F-01. 채팅 인터페이스 (multi-tab) | 앱의 기본 동작 |
| F-02. 모델 전환 (탭 추가/전환) | 핵심 기능 |
| F-03. 맥락 유지 (per-message hook inject) | 핵심 가치 — alive 탭 mid-session freshness |
| F-03b. 맥락 유지 (사용자 검토) | 차별점 3 — 메모리 패널의 현재 IR / archive 스냅샷 / refine · 초기화 액션 |
| F-03c. 메모리 요약 (gemini-flash 헤드리스) | 핵심 가치 — 사용자 메인 토큰 0 소비, 무료 티어 활용 |
| F-04. 대화 히스토리 (워크스페이스 단위) | 맥락 유지의 기반이며 멀티탭 관리의 핵심 |

MVP 단계에서 지원 모델은 **Claude, Codex, Gemini** 고정 목록으로 제공한다.

---

## MVP 제외 기능

| 기능 | 제외 이유 |
|------|-----------|
| F-05. 모델 관리 (추가/편집) | 고정 모델 목록으로 MVP 검증 가능 |

---

## MVP 완료 기준

- AgentBridge 앱을 실행할 수 있다
- 워크스페이스를 만들고, 그 안에 세 가지 모델(Claude, Codex, Gemini) 중 하나를 선택해 첫 탭으로 시작할 수 있다
- 같은 워크스페이스 안에 다른 모델 탭을 추가해 동시에 활성화할 수 있다 (이전 탭 유지)
- 매 사용자 메시지마다 IR이 hook 메커니즘으로 자동 주입된다 (모델 컨텍스트에 invisible 합성)
- 메모리 패널에서 현재 IR · 과거 스냅샷을 검토할 수 있고, refine · 메모리 초기화 액션으로 메모리를 갱신/리셋할 수 있다
- gemini 설치된 환경에서 IR refine 비용이 사용자 메인 모델 토큰을 소비하지 않는다 (gemini 무료 티어 활용)
- gemini 미설치 환경에서도 폴백으로 동작한다 (활성 모델 헤드리스 + UI 토큰 비용 경고)
- 사용자 글로벌 설정 파일은 무수정, 워크스페이스 cwd엔 CLI native 설정 3종(`.codex/hooks.json`, `.codex/config.toml`, `.gemini/settings.json`)만 마커 블록 merge로 추가
- 워크스페이스를 닫고 다시 열면 마지막 상태가 복원된다
