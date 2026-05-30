# AgentBridge — 데스크탑 (macOS)

> Electron 기반 standalone 앱. 컨셉·동작 원리·CLI 요구사항은 [모노레포 README](../../README.md) 참고.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../../LICENSE)
![Platform: macOS](https://img.shields.io/badge/Platform-macOS-lightgrey.svg)

<!-- TODO(scr-1): 메인 스크린샷 — 한 워크스페이스에 3 모델 탭 활성 + 우측 메모리 패널 -->

---

## 데스크탑 전용 기능

익스텐션 대비 데스크탑이 추가로 제공하는 항목.

- **네이티브 파일 드래그 앤 드롭** — 파일을 xterm 영역에 떨어뜨리면 OS 레벨에서 절대 경로가 모델 입력에 자동 paste (자동 submit 차단, 사용자가 직접 Enter). 익스텐션은 IDE 제약상 사본 생성 방식
- **사용량 사전 측정 + 자동 폴백 (proactive)** — 정제 직후 사용된 CLI를 백그라운드로 띄워 `/usage`·`/status`로 quota를 직접 확인. 한도 근접/초과 전에 다음 CLI로 자동 폴백하며, 측정용 임시 세션은 종료 시 conversation 파일까지 자동 정리. 익스텐션은 refine 실패 *후*에야 폴백
- **IR 카드 개별 삭제** — 각 IR 섹션(decisions/files/commands/tests/pending) 카드 단위 삭제 가능. 익스텐션은 전체 reset만 지원
- **메모리 주입 비활성 배지** — Hook 설치 실패로 IR 자동 주입이 동작하지 않는 세션은 탭에 ⚠ 배지 표시

양쪽 앱 공통 기능(메모리 패널·refine 정책·hook 자동 주입 등)은 [모노레포 README](../../README.md) 참고.

## 설치

[GitHub Releases](https://github.com/h-taek/AgentBridge/releases)에서 `.dmg` 다운로드.

ad-hoc 서명 빌드라 macOS Gatekeeper가 첫 실행을 차단한다. 다음 중 하나로 우회:

```bash
# 방법 1 — 터미널
xattr -dr com.apple.quarantine /Applications/AgentBridge.app
```

```
# 방법 2 — 시스템 설정 → 개인정보 보호 및 보안 → "그래도 열기"
```

## 사용법

1. 앱 실행 → 홈 화면에서 메시지 입력 + 모델 선택 → Enter
2. AgentBridge가 `~/AgentBridge/Chat-YYMMDD-HHMM/` 폴더에 워크스페이스를 자동 생성한 뒤 모델을 spawn
3. 한 워크스페이스 안에서 *상단 + 모델* 버튼으로 다른 모델 탭 추가 가능. 탭 전환 = 모델 전환, IR은 자동으로 따라감
4. 우측 메모리 패널에서 현재 IR과 이전 스냅샷을 확인. 수동 정제 / 메모리 초기화 버튼 제공
5. 좌 사이드바에서 다른 워크스페이스로 진입하거나, 우클릭으로 "새 창으로 열기 / 이름 수정 / 삭제"

## 데이터 저장 위치

```
~/Library/Application Support/AgentBridge/      ← AgentBridge 메타데이터 (격리)
└── workspaces/<workspaceId>/
    ├── workspace.json
    ├── ir.json                                  ← 압축된 공유 메모리
    ├── turns.jsonl                              ← raw 턴 로그
    ├── archive/                                 ← compaction 스냅샷
    ├── sessions/<sessionId>/replay.log          ← PTY raw bytes (탭별)
    └── settings/claude-settings.json            ← claude --settings flag 대상

<사용자 워크스페이스 cwd>/                       ← 사용자 프로젝트
├── .codex/hooks.json                            ← codex hook (마커 블록 merge)
├── .codex/config.toml                           ← codex hook enable (마커 블록 merge)
├── .agents/hooks.json                           ← agy(Antigravity) hook (마커 블록 merge)
└── (사용자 파일들 — AgentBridge 무관)
```

## 라이선스

[MIT](../../LICENSE) © h-taek
