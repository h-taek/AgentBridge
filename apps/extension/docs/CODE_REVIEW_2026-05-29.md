# Code Review — 전체 코드 검사 (2026-05-29)

- 대상: `main` (v0.1.6, HEAD `1c81871`), working tree clean
- 방식: diff 없음 → 소스 트리 전체 정적 검토. 전문 리뷰어 3종(보안 / 동시성·정합성 / 유지보수성) 병렬 + 발견 항목 실제 코드 직접 검증
- 베이스라인: `tsc --noEmit` 통과 · `eslint` 무경고 · `knip` 미사용 export 없음 · `madge` 순환의존 없음
- 상태: **수정 미진행. 보고만.**

---

## P1 — 데이터 유실

### 1. turn 유실 — `appendTurn` vs compaction `rewriteTurns` 경합
- 위치: `src/core/turnsStore.ts:36`, `src/core/compactionScheduler.ts:117,208`
- 내용: `appendTurn`은 락이 없음. compaction은 `:117` `readAllTurns`로 스냅샷을 뜬 뒤 최대 60초 refine을 돌리고 `:208` `rewriteTurns(remaining)`로 파일을 통째로 덮어씀. 그 60초 사이 새 turn이 append되면 stale 스냅샷 기준 `remaining`이 그 turn을 누락한 채 덮어써 유실됨.
- 가드 한계: `inFlight` Set / 디스크락은 *동시 compaction*만 막고 append 경로는 못 막음. compaction은 백그라운드, idle flush는 별개 경로라 단일 프로세스에서도 발생 가능.
- 제안: rewrite 직전 파일을 재독해해 스냅샷 이후 추가분을 `remaining`에 보존, 또는 append/rewrite를 워크스페이스 단위 mutex로 직렬화.

---

## P2

### 2. 첫 compaction이 원본 turn을 아카이브 없이 폐기
- 위치: `src/core/compactionScheduler.ts:199,208` (수동 경로 `src/views/memoryPanel.ts:194` 동일)
- 내용: `:199` `if (currentIR)`라서 최초 compaction(`currentIR === null`)엔 아카이브를 스테이징하지 않는데, `:208` `rewriteTurns(remaining)`은 `oldest`를 무조건 버림. 새 `ir.json` 요약만 남고 raw turns는 백업 없이 소실.
- 제안: `currentIR`이 없으면 방금 만든 `ir`로 아카이브 스테이징.

### 3. dispose 시 awaiting turn 유실 + flush 미대기
- 위치: `src/core/turnRecorder/index.ts:168-172`
- 내용: dispose는 `state === 'assistant_active'`일 때만 flush. 사용자가 메시지를 보낸 직후(첫 assistant 바이트 도착 전, `state === 'awaiting'`) 탭/창을 닫으면 메시지 유실. 같은 파일 `:95` 주석은 "awaiting도 flush해야 손실 방지"라 명시하나 dispose만 누락. 또한 `flushTurn()`이 await 없는 fire-and-forget(`:169`)이라 deactivate 시 `appendFile` 완료 전 호스트 종료 가능.
- 제안: dispose도 awaiting 상태 flush 포함; 종료 경로에서 flush promise를 await.

### 4. `loadIR`가 검증 없이 IR로 캐스팅
- 위치: `src/core/compactionScheduler.ts:96`
- 내용: `JSON.parse(raw) as IR`. ir.json이 손상/부분기록돼 `{}` 형태면 `assembleIR`의 `previousIR.meta` 접근에서 throw → outer catch(`:225`)에 잡혀 매 사이클 조용히 compaction 중단.
- 제안: `meta` 존재 검증 또는 optional chaining 방어.

---

## P3

### 5. 디스크락이 진짜 CAS 아님
- 위치: `src/core/compactionScheduler.ts:55-72`
- 내용: read → write(rename) → re-read 방식. rename이 last-write-wins라 같은 워크스페이스를 연 두 VS Code 창에서 양쪽 다 통과 가능(드묾). 같은 프로세스는 `inFlight` Set(`:114`)이 실질 가드.
- 제안: `fs.open(lockPath, 'wx')` 배타 생성으로 진짜 락, 또는 디스크락을 best-effort로 명시.

### 6. agy tool prefix 정규식 미앵커
- 위치: `src/core/turnRecorder/sliceAssistant.ts:23,110`
- 내용: `^(Read|Write|…)`에 끝 앵커 없음. `✓ Reading 완료` 같은 prose 줄이 tool=`Reading` → `^Read` 매칭돼 tool call로 오분류, 본문에서 제거됨.
- 제안: `'^(' + … + ')$'`로 정확 매칭.

### 7. fallback 알림 CLI/사유 불일치 (3개 이상 CLI 체인)
- 위치: `src/core/compactionScheduler.ts:162-163`
- 내용: `triedCli[0]`(첫 CLI)에 `lastReason`(마지막 실패 CLI의 사유)을 짝지어 알림. 2개 체인(일반 케이스)은 맞지만 3개 이상이면 첫 CLI 이름에 두번째 CLI의 사유가 붙음. 알림 문구 한정. (직전 커밋 `1c81871`이 이 영역을 손봤으나 3+ 케이스는 미해결.)
- 제안: 전체 체인 표기 또는 첫 CLI의 사유 추적.

### 8. dead arithmetic
- 위치: `resources/bin/agentbridge-memory.js:229`
- 내용: `const idx = turns.length - turns.length + i + 1` 은 항상 `i + 1`.
- 제안: `const idx = i + 1;`.

### 9. `keepRecent` 매직넘버 비DRY
- 위치: `src/views/memoryPanel.ts:191`
- 내용: 하드코딩 `3`. 현재 `COMPACTION_TRIGGER.keepRecent`(=3, `src/shared/types.ts:64`)와 일치하나 상수 변경 시 어긋남.
- 제안: 상수 import 사용.

### 10. `esc()`가 따옴표 미이스케이프
- 위치: `src/views/memoryPanel.ts:738`
- 내용: `<>&`만 처리. status가 class 속성에 들어가나 `src/core/irModule/parse.ts`의 `asEnum`으로 enum 강제라 현재 안전(ir.json 직접 변조 시에만 문제). defense-in-depth.
- 제안: `esc`에 `"` / `'` 추가.

### 11. chatPanel drop-handler `quoteShellArg` 깨진 이스케이프
- 위치: `src/views/chatPanel.ts:832`
- 내용: POSIX single-quote 이스케이프가 잘못됐고 메타문자 포함 경로를 bare 반환. 단 결과는 셸이 아닌 **PTY 입력**(CLI 프롬프트 타이핑)으로 전달 → RCE 아님, 경로 깨짐 수준.
- 제안: `src/shared/shellQuote.ts`의 올바른 로직 재사용.

---

## 안전 확인됨 (커버리지)
- `src/shared/shellQuote.ts` `quoteArg` 정확
- 모든 child process가 인자 배열 사용(셸 미경유)
- 두 webview 모두 CSP + nonce + scoped localResourceRoots
- `src/core/hookInstaller.ts` atomicWrite · `assertWorkspaceCwd`($HOME 거부)
- attachment / workspaceId는 `basename` / UUID 검증으로 path traversal 차단
- LLM 출력은 전부 `esc()` / `coerce*` / `asEnum` 경유, 파일쓰기·명령구성·eval 구동에 사용 안 됨

---

## 우선순위 요약
- 조용한 데이터 손실: **#1**(turn 유실 경합), **#2 / #3**(아카이브·dispose 유실), **#4**(compaction 무한 조용한 중단)
- 견고성 / 문구: #5–#11
