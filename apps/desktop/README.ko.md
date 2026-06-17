# AgentBridge — 데스크탑 (macOS)

> Electron 기반 standalone 앱. 컨셉·동작 원리·CLI 요구사항은 [모노레포 README](../../README.ko.md) 참고.

<p align="center">
  <a href="../../LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-green.svg"></a>
  <img alt="Desktop" src="https://img.shields.io/badge/desktop-Apple Silicon-lightgrey.svg">
</p>

---

## 데스크탑 전용 기능

익스텐션 대비 데스크탑이 추가로 제공하는 항목.

1. **사용량 사전 측정** — 데스크탑은 시작 시·정제 직후 백그라운드 probe로 quota를 측정해 사용량 카드를 최신으로 유지하고 각 CLI의 한도 근접도를 보여준다. 익스텐션은 quota를 저장만 하고 백그라운드 probe는 하지 않는다. (quota *폴백* 자체는 양쪽 앱 모두 reactive — 정제가 quota 에러에 막히면 정제 정책의 다음 모델로 넘어가고, 그 CLI는 UTC 자정까지 건너뛴다.)
2. **IR 카드 개별 삭제** — 데스크탑은 각 IR 섹션(decisions/files/commands/tests/pending) 카드 단위 삭제 가능. 익스텐션은 전체 reset만 지원
3. **네이티브 파일 드래그 앤 드롭** — 데스크탑은 OS 레벨 드롭으로 절대 경로가 자동 paste. 익스텐션은 프로젝트 폴더 내에 사본을 생성하고 해당 사본의 경로를 전달 (사본은 일정 시간 후 자동 삭제)
4. **멀티 윈도우 / 내장 zsh 터미널 탭** — 데스크탑 전용. 익스텐션은 IDE 한 인스턴스 안에서 동작하고 터미널은 IDE 자체 기능 사용

양쪽 앱 공통 기능(메모리 패널·refine 정책·hook 자동 주입 등)은 [모노레포 README](../../README.ko.md) 참고.

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
4. 우측 메모리 패널에서 현재 IR·이전 스냅샷(단기·IR 탭)과 **장기 메모리 탭**(자동제안 승인/버림)을 확인. 수동 정제 / 메모리 초기화 버튼 제공
5. 좌 사이드바에서 다른 워크스페이스로 진입하거나, 우클릭으로 "새 창으로 열기 / 이름 수정 / 삭제"

## 라이선스

[MIT](../../LICENSE) © h-taek
