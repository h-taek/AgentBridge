# M6.7 수동 검증 체크리스트 (Extension Development Host)

> 정적 분석 + 30개 단위 테스트로 검증되지 않은 런타임 경로를 수동으로 확인하기 위한 체크리스트.
> Extension Development Host (F5)로 띄운 뒤 항목별로 진행.

## 사전 준비

1. VS Code (또는 Antigravity)에서 본 워크스페이스 열기
2. `npm run compile` 실행 — `out/` 갱신
3. `F5` (또는 Run → Start Debugging) → 새 Extension Development Host 창 열림
4. 새 창에서 **별도 폴더**를 워크스페이스로 열기 (`~/Desktop/test-ws` 등 임시 폴더 권장. 본 프로젝트 폴더는 hook이 자기 자신을 가리키게 되어 혼란 가능)
5. AgentBridge 액티비티 바 아이콘 클릭 → Sessions / Memory 패널 표시 확인

---

## A. PTY spawn + shell-quote (J1) — 최우선

목적: `chatPanel.ts:198`의 `quoteCommandLine` 변경이 zsh에서 명령을 정상 파싱하는지.

### A-1. 일반 경로
- [ ] Sessions 패널의 + 버튼 → claude 선택
- [ ] 새 에디터 탭에 터미널이 뜨고 claude 프롬프트(`>` 또는 환영 메시지) 표시
- [ ] 짧은 메시지 입력 후 Enter → 응답 받음
- [ ] **실패 신호**: PTY가 즉시 종료, "command not found", 빈 화면, 작업 디렉토리 오류

### A-2. 경로에 `'`가 포함된 케이스 (J1의 핵심 회귀 가드)
- [ ] 임시 워크스페이스를 `~/Desktop/test ws/O'Brien-folder` 같은 이름으로 만들고 열기 (또는 사용자명이나 경로에 이미 `'` 있으면 그대로 사용)
- [ ] claude 세션 생성 → 정상 spawn 확인
- [ ] **실패 신호**: zsh syntax error, 명령 잘림. **이전 버전(b2ef7b5)에서는 여기서 깨졌음**

### A-3. codex / agy 세션도 동일
- [ ] codex 세션 생성 → 정상 spawn
- [ ] agy 세션 생성 → 정상 spawn

---

## B. Hook 설치 (M16 sync→async) — 두 번째 위험

목적: hookInstaller가 async로 바뀐 뒤에도 spawn 직전에 settings.json / hooks.json / config.toml이 디스크에 존재하는지 (await 누락 시 race 발생).

### B-1. claude
- [ ] claude 세션 생성 직후 다음 파일 존재 확인:
  - [ ] `<globalStorage>/workspaces/<wid>/settings/claude-settings.json` (workspaceId UUID는 Memory 패널 또는 OutputChannel "AgentBridge" 로그에서 확인)
- [ ] `cat` 해서 hooks.SessionStart 및 UserPromptSubmit 두 entry 모두 있는지

### B-2. codex
- [ ] codex 세션 생성 후 워크스페이스 폴더 안에:
  - [ ] `.codex/hooks.json` 존재, agentbridge-managed entry 있음
  - [ ] `.codex/config.toml` 존재, `# AgentBridge BEGIN ... [features] hooks = true ... # AgentBridge END` 블록 있음

### B-3. agy
- [ ] agy 세션 생성 후:
  - [ ] `.agents/hooks.json` 존재, `agentbridge-memory` entry 있음

### B-4. 손상 hooks.json 백업 (M16 async 경로 검증)
- [ ] codex 세션 종료 → `.codex/hooks.json`을 `{invalid json` 으로 강제 손상
- [ ] codex 새 세션 생성
- [ ] `.codex/hooks.json.broken.<ts>.bak` 파일 생성됐는지
- [ ] 새 hooks.json은 정상 JSON

---

## C. 수동 Refine + 디스크 락 (C1)

목적: `handleRefine`이 `acquireDiskLock`을 거치고, 스케줄러와 충돌 시 안전하게 거부하는지.

### C-1. 정상 Refine
- [ ] 임의 모델 세션에서 메시지 3~5개 주고받기 (turns.jsonl에 기록되도록)
- [ ] Memory 패널의 "Refine Now" 버튼 클릭
- [ ] 진행 중 상태(refining...) 표시
- [ ] 완료 후 "Refined with X (Yms)" 메시지
- [ ] `<globalStorage>/workspaces/<wid>/ir.json` 갱신됨, `turns.jsonl`이 최근 3개만 남음
- [ ] **실패 신호**: 완료 메시지 없이 종료, ir.json 미생성, ENOTSUP 등 fs 에러

### C-2. 동시 트리거 가드
- [ ] 메시지를 임계치(50턴 또는 5MB) 이상 누적하여 백그라운드 컴팩션을 트리거할 상황 만들기 — 실제로 50턴 만들기 어려우면 `~/Desktop/test-ws-2/`에 같은 워크스페이스를 두 번째 EDH로 열어 동시에 Refine 클릭
- [ ] 두 번째 클릭에서 "Compaction already in progress" 또는 "Another process holds the compaction lock" 경고
- [ ] 두 프로세스가 동시에 ir.json을 덮어쓰지 않음 (락 동작 확인)
- [ ] **실패 신호**: 두 번째 클릭도 그대로 진행되어 race

### C-3. ir:updated 이벤트
- [ ] Refine 완료 후 Memory 패널의 IR 표시 영역이 새 내용으로 갱신되는지

---

## D. Codex thread_id 캡처 (J2)

목적: `walkRolloutFiles`를 오늘+어제로 좁힌 변경이 실제 spawn 후 신규 jsonl을 정상 캡처하는지.

### D-1. 기본 캡처
- [ ] codex 세션 생성 → 메시지 1개 보내기
- [ ] OutputChannel "AgentBridge" 로그에서 `codexSessionWatcher: thread_id captured <UUID>` 메시지 확인
- [ ] Sessions 패널에서 해당 세션 항목에 모델 세션 ID 노출 확인 (디버그 정보 표시되는 위치에 따라 다름)
- [ ] **실패 신호**: 60s 후 `codex thread_id capture timeout` 경고

### D-2. (선택) 장기 사용자 시뮬레이션
- [ ] `~/.codex/sessions/2024/01/01/rollout-...jsonl` 처럼 1년 전 가짜 파일 다수 생성 → spawn 시 폴더 walk가 빠른지 (이전: 다 스캔, 현재: 오늘+어제만 스캔하므로 영향 없어야 함)
- [ ] activity monitor / iostat 등으로 watcher 동작 중 디스크 I/O 확인

---

## E. Archive 2-phase commit (M17)

목적: rewriteTurns 실패 시 archive .tmp가 폐기되는지. 정상 경로는 C-1에서 이미 검증되므로 여기는 실패 경로만.

### E-1. 정상 흐름 (이미 C-1에서 확인)
- [ ] Refine 후 `<wid>/archive/compressed_<ts>.jsonl` 생성, `.tmp` 잔존 없음

### E-2. 실패 시 폐기 (재현 어려움 — 선택)
- [ ] `<wid>/turns.jsonl` 위치에 일부러 같은 경로의 디렉토리를 미리 만들어 rewriteTurns가 실패하게 유도
- [ ] Refine 클릭 → 에러 발생
- [ ] `<wid>/archive/` 에 `.tmp`만 남고 `.jsonl`은 없거나, 둘 다 없는 상태 (`.tmp`는 abortArchive로 unlink됨)

---

## F. ptyDisplayFilter watchdog cleanup (M7)

목적: 강제 unblock 후 watchdog 타이머가 즉시 정리되는지. 직접 관찰 어렵고 단위 테스트로도 일부만 검증.

### F-1. hook context가 정상 닫히는 경우
- [ ] claude 세션에서 hook이 실행되는 메시지 (예: `/init` 또는 hook이 발동되는 명령) — 화면에 `[hook context hidden]` 마커가 보이고 그 이후 정상 진행
- [ ] 잘 보일 거예요

### F-2. hook context 닫힘 누락 시뮬레이션 (어려움)
- [ ] resources/bin/agentbridge-memory.js 호출 도중 강제 종료시켜서 `</agentbridge-context>` 안 오게 만들기
- [ ] 5초 후 OutputChannel에 `ptyDisplayFilter: watchdog timer fired` 또는 `block timeout — force unblock` 메시지
- [ ] 화면에는 hook 영역이 [hook context hidden]으로 표시되거나 sanitize된 상태로 진행

---

## G. attachment store (M5)

목적: `path.basename` 방어층이 정상 첨부 파일 흐름을 깨지 않는지.

### G-1. 파일 드롭
- [ ] claude 세션 탭에 작은 이미지/텍스트 파일 드래그 → 정상 attach
- [ ] 워크스페이스 폴더에 `.agentbridge/attachments/<sessionId>/<filename>` 생성
- [ ] 메시지 안에 첨부 경로가 정상 표시됨

### G-2. 경로 traversal 방어
- [ ] (어려움) 일부러 sessionId나 filename에 `..` 포함된 케이스는 caller 단에서 이미 차단되므로 정상 발생 안 함. 안전이 목적

---

## H. Hook 동작 (전체 플로우)

- [ ] claude / codex / agy 각각 세션에서 메시지 한 번씩 보내고 응답 받음
- [ ] OutputChannel "AgentBridge" 에 `helper: injected <agentbridge-context>` 같은 로그가 메시지마다 보임 (helper가 실행되어 IR을 주입했다는 신호)
- [ ] turns.jsonl에 user/assistant 페어가 정상 누적

---

## I. 종료 / dispose

- [ ] 세션 탭 닫기 → PTY 정상 종료, output channel에 disposal 메시지
- [ ] EDH 창 자체 닫기 → 잔여 timer / process 없는지 (다음 F5 띄울 때 zombie process 없음)

---

## 실패 시 보고할 정보

문제 발생 시 함께 알려주세요:

- 어떤 항목(A-1, B-3 등)에서 실패했는지
- OutputChannel "AgentBridge" 로그 (Debug Console에 `agentbridge.log` 또는 OutputChannel UI에서 복사)
- 실패한 모델 (claude / codex / agy)
- 실패 시점의 파일 상태 (`ls -la <wid>` 등)
- 가능하면 EDH의 Help → Toggle Developer Tools → Console 로그
