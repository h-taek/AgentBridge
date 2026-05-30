# AgentBridge

> 여러 AI 코딩 에이전트(Claude · Codex · Antigravity) 사이에서 작업 맥락이 자동으로 따라가는 macOS 데스크탑 앱.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Platform: macOS](https://img.shields.io/badge/Platform-macOS-lightgrey.svg)

<!-- TODO(scr-1): 메인 스크린샷 — 한 워크스페이스에 3 모델 탭 활성 + 우측 메모리 패널 -->

---

## 무엇을 해결하나

Claude Code, OpenAI Codex CLI, Google Antigravity CLI를 병행 사용할 때 발생하는 **context handoff** 문제 — 모델을 갈아탈 때마다 작업 맥락이 끊기는 문제 — 를 해결합니다.

AgentBridge는 한 워크스페이스 안에 여러 모델 탭을 *동시에* 띄우고, 매 사용자 메시지마다 **IR(Intermediate Representation, "공유 메모리")** 을 hook 메커니즘으로 자동 주입합니다. 모델을 갈아타도 *어디까지 작업했고 무엇을 결정했는지* 가 끊기지 않습니다.

각 CLI의 기본 동작(권한 다이얼로그, 도구 승인 흐름, 세션 관리)은 그대로 유지됩니다. AgentBridge는 CLI의 native 기능을 제한하지 않습니다.

## 특이점

비슷한 도구와 다르게 다음 세 가지 원칙으로 설계되어 있습니다.

1. **사용자 자신의 CLI를 그대로 사용** — 사용자가 *이미 인증한 자기 CLI*를 PTY로 임베드합니다. 별도 AgentBridge 백엔드·계정 시스템은 없으며, 메인 모델 비용은 사용자 본인의 subscription 안에서만 발생합니다.
2. **IR 자동 핸드오프** — 모델 전환·매 메시지마다 IR이 hook으로 자동 주입됩니다. 사용자가 명시 정제 액션으로 IR을 갱신하거나, compaction 임계를 넘으면 자동으로 정제됩니다. IR 정제는 **무료/저비용 CLI를 헤드리스로 호출**해 수행하므로 메인 모델 토큰을 0 소비합니다. 정제 정책은 `우선순위` / `고정` / `활성 모델` / `끔` 4단계 중 선택할 수 있고, 한도 근접/초과 시 다음 CLI로 자동 폴백합니다.
3. **사용자 자산 격리** — 글로벌 설정(`~/.claude` / `~/.codex` / `~/.agents`)은 수정하지 않습니다. 워크스페이스 cwd에는 CLI native config(`.codex/hooks.json` / `.codex/config.toml` / `.agents/hooks.json`)만 마커 블록 merge 방식으로 추가하며, claude는 cwd 무침범(`--settings <격리 경로>` flag 활용)으로 동작합니다.

## 주요 기능

- **메모리 패널** — 현재 IR + 이전 스냅샷 + Turn 흐름 + Refine·Quota 카드. IR 카드 개별 삭제, 메모리 초기화, 수동 정제 버튼
- **드래그 앤 드롭 첨부** — 파일을 xterm 영역에 떨어뜨리면 절대 경로가 모델 입력에 자동 paste (자동 submit 차단, 사용자가 직접 Enter)
- **멀티 윈도우** — 워크스페이스별 별도 BrowserWindow. ⌘N 새 빈 윈도우, 좌 사이드바 우클릭으로 "새 창으로 열기"
- **상단 탭 ⋯ overflow 메뉴** — 탭이 많아도 한 줄 유지, 화면에 안 들어가는 탭은 ⋯ dropdown으로 선택
- **세션 정렬 + reorder 모션** — 가장 최근에 채팅한 세션이 좌사이드바 최상단 / 상단 탭 좌측 끝으로 자동 이동 (View Transitions 220ms 슬라이드)
- **내장 터미널 세션** — 일반 zsh PTY 탭. CLI 환경 점검·잡일용
- **CLI 사용량 직접 측정 + 자동 폴백** — 정제 직후 사용된 CLI를 백그라운드로 띄워 `/usage`·`/status`로 quota를 직접 확인. 한도 근접/초과 시 다음 CLI로 자동 폴백하며, 측정용 임시 세션은 종료 시 conversation 파일까지 자동 정리
- **메모리 주입 비활성 배지** — Hook 설치 실패로 IR 자동 주입이 동작하지 않는 세션은 탭에 ⚠ 배지 표시

## 설치

[GitHub Releases](https://github.com/h-taek/AgentBridge/releases)에서 `.dmg` 다운로드.

ad-hoc 서명 빌드라 macOS Gatekeeper가 첫 실행을 차단합니다. 다음 중 하나로 우회하세요:

```bash
# 방법 1 — 터미널
xattr -dr com.apple.quarantine /Applications/AgentBridge.app
```

```
# 방법 2 — 시스템 설정 → 개인정보 보호 및 보안 → "그래도 열기"
```

## 사전 요구사항

AgentBridge는 사용자 환경의 CLI를 임베드하므로, 사용하려는 모델의 CLI는 별도로 설치되어 있어야 합니다.

| 모델 | 설치 안내 | 인증 |
|---|---|---|
| Claude | [claude.ai/code](https://www.claude.com/product/claude-code) | `claude` 실행 후 안내 |
| Codex | [openai.com/codex](https://openai.com/codex) | `codex` 실행 후 안내 |
| Antigravity | [antigravity.google](https://antigravity.google/product/antigravity-cli) | `agy /auth` 또는 환경변수 |

세 CLI 모두 PATH에 등록되어 있어야 하며, AgentBridge는 부팅 시 자동 감지해 설정 → "CLI 감지" 페이지에서 결과를 표시합니다. 일부만 설치되어 있어도 동작하지만, IR 정제를 무료 티어로 수행하려면 **Antigravity(`agy`) 설치 + 인증**이 권장됩니다 (없으면 활성 모델 폴백 + 토큰 비용 경고).

## 사용법

1. 앱 실행 → 홈 화면에서 메시지 입력 + 모델 선택 → Enter
2. AgentBridge가 `~/AgentBridge/Chat-YYMMDD-HHMM/` 폴더에 워크스페이스를 자동 생성한 뒤 모델을 spawn합니다
3. 한 워크스페이스 안에서 *상단 + 모델* 버튼으로 다른 모델 탭을 추가할 수 있습니다. 탭 전환 = 모델 전환이며, IR이 자동으로 따라갑니다
4. 우측 메모리 패널에서 현재 IR과 이전 스냅샷을 확인할 수 있습니다. 수동 정제 / 메모리 초기화 버튼도 제공됩니다
5. 좌 사이드바에서 다른 워크스페이스로 진입하거나, 우클릭으로 "새 창으로 열기 / 이름 수정 / 삭제"가 가능합니다

## 프라이버시 / 데이터 위치

AgentBridge는 자체 서버나 백엔드 없이 사용자 본인 환경의 CLI만 매개합니다. 데이터 흐름은 다음 두 경로로만 한정됩니다.

- **메인 모델 메시지** — 사용자가 인증한 각 CLI(claude / codex / agy)를 통해, 그 CLI가 원래 통신하는 모델 백엔드(Anthropic / OpenAI / Google)로만 전송됩니다. AgentBridge가 중간에 별도 서비스로 우회하지 않습니다.
- **IR 정제** — 정제 정책에 따라 선택된 사용자 인증 CLI(기본은 Antigravity)를 헤드리스로 호출해 수행합니다. 정제 요청은 그 CLI가 원래 통신하는 백엔드로만 전송되며, 결과 IR JSON은 사용자 머신에 저장됩니다.

위 두 경로 외 어떤 외부 서비스(자체 백엔드, 분석·텔레메트리, 제3자 요약 등)로도 전송되지 않습니다. 워크스페이스 메타데이터·대화 기록·메모리(IR)·turns 로그·replay 버퍼는 모두 사용자 머신에만 저장됩니다.

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

[MIT](LICENSE) © h-taek
