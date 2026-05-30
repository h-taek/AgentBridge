# 앱 컨셉 정의

> ⚠️ **Phase 4 M3 architecture revision 반영 (2026-05-11)** — 단일 스레드 sequential 전환 → *workspace + multi-tab parallel* 모델로 진화. 자세한 설계는 [02_architecture.md §14](../plan/02_architecture.md) 참조.

## 앱의 정체

AgentBridge는 Claude Code, Codex CLI, Gemini CLI를 하나의 데스크탑 앱 창에서 사용할 수 있게 감싸는 도구다. 각 CLI의 인터랙티브 화면을 앱 안에 임베드해 표시하고, 사용자는 GUI 입력창과 임베드된 CLI 화면을 통해 대화한다 — 자체 채팅 UI를 새로 만들지 않고 *각 CLI의 기본 UX를 그대로 살린다*.

여러 CLI 에이전트를 한 워크스페이스 안에 *멀티 탭으로 동시에* 띄울 수 있다. 사용자는 매 메시지마다 IR이 자동 주입된 상태로 작업하며, 우 사이드바 메모리 패널에서 현재 IR · archive 스냅샷을 확인하고 수동 refine 또는 메모리 초기화로 갱신할 수 있다.

---

## 핵심 특징

- **하나의 창 + 멀티 탭:** 에이전트마다 별도 터미널을 열 필요 없이 AgentBridge 하나로 사용. 한 워크스페이스 안에 여러 CLI 탭을 동시에 두고 자유롭게 전환
- **CLI 기본 기능 보존:** AgentBridge는 CLI의 권한 흐름·도구 승인 다이얼로그·세션 관리에 개입하지 않는다. CLI가 원래 제공하는 UX를 그대로 노출
- **Per-message 맥락 자동 주입:** 매 사용자 메시지마다 IR이 hook 메커니즘으로 모델에 invisible 주입됨 — alive 탭이 항상 최신 컨텍스트 보유
- **사용자 검토·통제 가능한 메모리:** 우 사이드바 메모리 패널에서 현재 IR / archive 스냅샷 확인, 수동 refine, IR(+옵션 turns) 초기화. 차별점 3
- **자체 백엔드 없음:** AgentBridge 앱은 자체 클라우드 서버·계정 시스템을 운영하지 않는다. 데이터는 사용자 머신(`~/Library/Application Support/AgentBridge/`)에 저장되며, 모델 응답은 사용자 인증 CLI를 통해 각 모델 백엔드(Anthropic/OpenAI/Google)로 흐른다
- **사용자 자산 격리:** 사용자 글로벌 설정(`~/.codex/hooks.json` / `~/.claude/settings.json` / `~/.gemini/settings.json`) 무수정. 워크스페이스 cwd엔 CLI native 설정 3종(`.codex/hooks.json`, `.codex/config.toml`, `.gemini/settings.json`)만 마커 블록 merge로 추가
- **오픈소스:** GitHub로 배포

---

## 지원 모델

- Claude (Claude Code)
- Codex (Codex CLI)
- Gemini (Gemini CLI) — *권장* (refine LLM으로 무료 티어 활용 시)

---

## 대화 구조

워크스페이스 안에 모델별 탭을 동시에 두고, 각 탭이 자기 PTY를 유지한다. 어느 탭에서든 대화하면 매 메시지마다 *모든 탭이 공유하는 최신 IR*이 그 모델 컨텍스트에 자동 주입된다.

- 각 탭이 자기 모델의 PTY를 살려둔다 (탭 클릭으로 전환, kill 없음)
- 한 탭에서 작업한 내용은 다음 N턴 후 background compaction을 거쳐 IR에 반영됨
- 다른 탭이 다음 사용자 메시지를 받을 때 hook으로 갱신된 IR을 자동 주입받아 *최신 작업 인지*

---

## 기본 사용 흐름

```
AgentBridge 실행
       ↓
홈 화면(가운데 입력창 + 3 모델 카드) 또는 좌측 사이드바에서 워크스페이스 선택/생성
       ↓
첫 모델 탭 spawn (예: claude)
       ↓
메시지 주고받기 → 매 메시지에 IR 자동 주입
       ↓
필요 시 다른 모델 탭 추가 (예: codex)
       ↓
새 탭이 *현재 IR*을 받고 시작 → 두 탭 동시 활성
       ↓
우 사이드바 메모리 패널에서 IR 확인 → 필요 시 수동 refine 또는 초기화
       ↓
워크스페이스 재진입 시 마지막 상태 복원
```

---

## 핵심 화면

### 홈 화면
- 가운데 큰 textarea + 3 모델 카드(claude/codex/gemini)
- Enter 전송 → 자동 워크스페이스 생성(기본 베이스 경로 하위 `Chat-YYMMDD-HHMM`) + 첫 세션 spawn + 첫 메시지 PTY 발사

### 워크스페이스 화면
- **TitleBar (상단)** — frameless + traffic light + 윈도우 제목
- **좌 사이드바** — 홈 / 워크스페이스 목록(펼침 시 세션 트리) / 새 워크스페이스 / 우클릭 컨텍스트 메뉴(열기·새 창·이름 수정·삭제)
- **중앙 xterm-host-stack** — 워크스페이스 안 모든 활성 PTY를 N개 마운트(탭 전환 = attach 변경)
- **세션 탭바 (xterm 상단)** — 활성 세션 목록 + `+ 모델` 드롭다운 + 닫기(x)
- **우 사이드바 메모리 패널** — IR 카드(클릭 → 6 섹션 상세 모달) + archive 스냅샷 카드들 + Turn 흐름 카드 + Refine/Quota 카드 + AI 지시 파일 카드. 그룹 헤더에 ⓘ 안내 / ✨ refine / 🗑 초기화 버튼

### 멀티 윈도우
- 한 워크스페이스 = 한 윈도우 (claim/release IPC로 중복 열림 차단)
- ⌘N으로 새 홈 윈도우, macOS dock 메뉴에서 활성 윈도우 list
