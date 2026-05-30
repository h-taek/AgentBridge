# IR refine 첫 평가 결과

> Phase 4 — M2 G 청크 검증 산출물 / 2026-05-10
>
> 같은 사용자 메시지에 세 모델(claude/codex/gemini)이 정제한 IR을 비교해 prompt/스키마 약점을 식별한다. **prompt 보강은 별도 청크에서** — 본 문서는 그 근거 기록.

## 검증 케이스

- 사용자 메시지: "현재 진행하는 프로젝트에 대해 어떻게 생각해. 간단하게만 대답해" (단발 의견 요청)
- 워크스페이스: AgentBridge 프로젝트 루트
- 검증 흐름: thread 생성 → 위 메시지 전송 → 모델 응답 → IrPanel "IR 정제 실행" → 영속화된 IR JSON 비교
- 한계: trivial 의견 요청이라 files/commands/tests/decisions가 풍부한 코딩 task 시나리오는 미검증. 본 평가가 식별한 약점은 *코딩 task 검증 후 보강 폭이 더 커질 수 있음*.

## 모델별 결과 비교

| 항목 | Claude | Codex | Gemini |
|---|---|---|---|
| `intent.goal` | 정확 | 정확 | 정확 |
| `intent.constraints` | "간단하게만 답변" ✅ | "간단하게 대답" ✅ | **누락** ❌ |
| `intent.role` | "user" — 메시지 role과 혼동 | 미기재(보수적) | "AI Assistant (Gemini)" — 모델 이름 오용 |
| `decisions` | 빈 배열 ✅ | 2개 — 본인 검토 절차/평가 | 1개 — 평가 자체 |
| `files` | 비어있음 ✅ | 3개 (README/PROGRESS/05_app_concept) ✅ | 비어있음 ✅ |
| `commands` | 비어있음 ✅ | 2개 (pwd / rg) ✅ | 비어있음 ✅ |
| `tests` | 빈 배열 ✅ | 빈 배열 ✅ | 빈 배열 ✅ |
| `pending` | "사용자 응답 대기" — over-fill | 빈 배열 ✅ | "사용자 응답 대기" — over-fill |
| `trajectory` | 2턴, 응답 본문 거의 원문 보존 ✅ | 7턴, tool 호출까지 분해 ✅ | 2턴, 짧지만 정확 |
| `originalRef` | 미사용 | "input1[1]" / "input2" 등 임의 라벨 | 미사용 |

### 종합 판단

- **Codex** — handoff 입력으로 가장 informative. 도구 호출(pwd / rg / 파일 read)을 `commands` + `files` + `trajectory.tool` 세 영역에 잘 분배. 다른 모델로 넘길 때 "이미 무엇을 봤는가"가 살아있음.
- **Claude** — trajectory 응답 본문을 거의 원문에 가깝게 보존. 짧은 대화에서는 손실 거의 없음. constraints/intent도 정확.
- **Gemini** — 가장 빈약. constraints 누락 + intent.role 오용 + trajectory 짧음.

세 모델 모두 G 청크의 인프라(prompt 빌드 → spawnRefineIR → assistantText 누적 → fence/balanced JSON 추출 → 스키마 coerce → 영속화)는 정상 동작. **G 완료 정의는 충족**.

## 식별된 약점 (Prompt/스키마)

다음 청크(prompt 보강 또는 스키마 다듬기)에서 처리 후보:

### 1. `intent.role` 의미가 prompt에 모호 — *공통*

세 모델이 모두 다른 해석으로 채움(메시지 role / 모델 이름 / 미기재). [01_ir.md §6-2](../research/01_ir.md)는 `role: design|implement|review|...` 같은 enum 의도였으나 [prompt.ts](../../src/main/modules/irModule/prompt.ts)의 `IR_SCHEMA_GUIDE`에는 `"role"?: string`으로만 적혀있음.

**보강 방향**: enum을 명시(`design|implement|review|debug|discussion|other`) + "사용자가 수행하는 *작업의 성격*을 가리키며, 메시지 role이나 모델 이름이 아니다"라는 설명 추가.

### 2. `pending` over-fill — claude / gemini

trivial 응답에도 의례적으로 "사용자 응답 대기" 항목을 채움. 현재 prompt의 "정보를 모르면 해당 항목을 생략하거나 빈 배열로 두어라. 추측하지 말라" 조항이 약함.

**보강 방향**: pending 항목에 "*실제로 차단된 작업이나 다음 사용자 메시지를 기다리는 것 이상의 구체적 다음 단계*가 있을 때만 채워라. 일반적인 '응답 대기'는 빈 배열" 같은 강도 보강.

### 3. `originalRef` 형식 미정의 — codex 임의 라벨

[01_ir.md §6-2](../research/01_ir.md) trajectory 항목의 `originalRef?`는 "원문 참조"로만 정의되고 형식 미정. codex가 `input1[1]` / `input2` 같은 자체 라벨을 만들어 넣음.

**보강 방향 옵션**:
- (a) 명확한 형식(예: `user.jsonl#L<n>` 또는 `replay.log#offset=<n>`) 강제 — IR이 실제 저장 파일 라인과 매핑돼 검증/되감기 가능. 단 정밀 매핑 헤드리스 모델에 어렵움.
- (b) `originalRef` 자체를 1차 릴리즈에서 제거 — IR 본문에 압축본만 두고 원문 복구는 user.jsonl + replay.log에서 직접. 단순.

(b)가 단순성 측면 우세. M3에서 IR 검토·편집 모달이 들어오면 그때 다시 검토.

### 4. trajectory 분해 단위 차이 — codex만 tool 호출 분리

같은 prompt 가이드인데 codex만 `role: tool` 항목을 채움(claude/gemini는 user/assistant 2턴만). 이는 모델 native 응답 형태 차이(codex는 stream-json으로 tool 호출이 명확히 별 라인) 때문이지 prompt 결함은 아님.

**판단**: 이건 *기능*이지 *결함*이 아니다. tool 호출을 한 모델은 그걸 살리고, 안 한 모델은 안 살리는 게 자연스럽다. prompt 변경 불필요.

## H 청크 진입 시 이 문서의 활용

H 청크(handoff 흐름)는 IR을 *주입*하는 단계. 다음 모델에 어떤 필드가 잘 살아남고 어떤 필드가 손상·재해석되는지가 prompt 보강의 *주입 측면 피드백*이 된다. 본 문서는 정제 측면만 본 결과이므로, H 종료 후 양쪽 피드백을 합쳐 prompt 보강 폭을 결정하는 게 합리적.

## 우선순위

| 약점 | 사용자 체감 | 보강 비용 | 우선순위 |
|---|---|---|---|
| 1. `intent.role` 모호 | 낮음 (handoff 결과에 큰 영향 없음 추정) | 낮음 (prompt 5줄) | 중 |
| 2. `pending` over-fill | 중 (다음 모델에 잘못된 "대기 중" 신호) | 낮음 (prompt 1~2줄) | **상** |
| 3. `originalRef` 형식 | 낮음 (현재 미사용) | 중 (스키마/매핑 결정) | 하 |

## 다음 액션

1. (지금) G 청크 마무리 — 본 문서 + IRModule + IPC + Renderer 패널 커밋
2. (H 청크) handoff 흐름 구현 + 사용자 검증
3. (H 청크 종료 후 결정) 본 문서 + H 단계에서 모은 주입 측면 피드백을 합쳐 prompt 보강 청크 진입 여부/범위 결정

---

## H 청크 검증에서 발견된 추가 이슈 (2026-05-10)

### 5. 코덱스/제미나이의 IR 주입 = 첫 사용자 메시지로 처리됨

PTY stdin write로 IR을 보내면 codex/gemini는 *첫 사용자 메시지*로 인식하고 즉시 응답을 생성한다. 사용자는 IR을 "참고"하길 원했지만 모델은 "응답"을 만든다. sentinel 헤더의 "재요약·재인용하지 말라" 지시가 user prompt 채널에서는 약하다.

**보강 방향 옵션 (M3 prompt 청크에서 결정)**:
- (a) sentinel 헤더에 "이 메시지에 직접 응답하지 말고 짧은 ack만 출력하라" 같은 더 강한 지시 추가
- (b) IR 본문 말미에 사용자 친화적 ack 요청 명시: "준비됐다는 짧은 한 줄로 응답하라" 등
- (c) IR을 stdin 메시지로 주입하지 말고 첫 사용자 메시지에 prepend하는 방식으로 전환 (단, 사용자 첫 메시지 입력까지 IR이 적용 안 됨)

claude는 system-prompt 채널이라 영향 적음 — sentinel 약한 지시도 유효.

### 6. 코덱스 첫 응답 이전 화면 잘림

handoff 후 codex 첫 응답 직전까지의 출력(welcome 화면, IR 주입 paste 흔적 등)이 xterm에 표시되지 않고, 첫 응답 도착 시점부터 표시 유지. codex TUI alt-screen 이동 시점과 xterm 버퍼의 동기화 문제로 추정 — codex CLI 자체 거동.

**M2 수용**: codex 자체 alt-screen 동작이라 우리 측 우회 어려움. 사용자가 첫 응답까지 빈 화면에 가까운 상태를 봐야 하는 UX 단점이나 동작 자체는 정상.

### 7. 세션 목록 모델 표시 동기화 (보강 후 재검증 필요)

활성 thread의 모델 전환이 thread list 카드의 `activeModel` 표시에 반영되지 않는다는 보고. 코드 흐름상 `handoff:commit` 완료 → `reloadThreads()` → 디스크 메타 재읽기 → 표시 갱신이지만, 실제로 화면에 갱신되지 않는 케이스 발견. ModelSwitcher의 dropdown은 `pendingModel` ↔ `meta.activeModel` 동기화 effect 추가로 보강.

### 발견된 race condition들 (코드로 즉시 수정)

| 증상 | 원인 | 수정 |
|---|---|---|
| `Append system prompt file not found` (claude IR 주입) | `cleanupTmpIrFile`이 spawn 직후 즉시 호출되어 claude PTY fork가 argv 파싱·파일 read를 끝내기 전에 unlink | 60초 지연 unlink로 변경 + `cleanupStaleTmpIrFiles` 안전망 유지 |
| `chat:send: thread 미활성` (전환 직후) | 직전 PTY의 onExit가 grace 만료로 늦게 도착해 새 PTY의 active 매핑을 잘못 clear | onExit hook info에 `ptySessionId` 포함 + `clearActiveIfMatches` 가드 |
| `ENOENT: rename ...threads/.../tmp` (handoff:commit) | `listThreads`가 모든 `.tmp`를 즉시 unlink해 동시 atomic rename과 race | mtime 30초 이상 된 .tmp만 정리하도록 변경 |

