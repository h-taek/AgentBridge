# 통합 코드 품질 검증 보고서 (M6.7) — 2026-05-23

> 검증 일자: 2026-05-23
> 대상 브랜치: `main` (HEAD `b2ef7b5`)
> 입력: Claude / Codex / Gemini 3개 AI가 각각 독립적으로 수행한 정적 분석 보고서를 교차 검증·통합
> 코드 수정: **없음 (read-only)**
> 검증 범위: [HANDOFF.md](../HANDOFF.md) §3 — 정적 분석 · 데드코드 · 보안 정적 · 우선순위 파일 line-by-line · 패키징 산출물 점검
>
> 본 보고서는 M6.7 본격 진입 직전의 "현재 상태 스냅샷"이다. 세 보고서에서 등급이 엇갈린 항목은 원본 소스를 재확인해 최종 등급을 단일화했다.

---

## 0. 통합 요약

| 항목 | 결과 | 출처 일치도 |
|---|---|---|
| `tsc --noEmit` (현 설정) | ✅ exit 0 | 3/3 |
| `tsc --noEmit` + 추가 strict flag | ⚠️ 2건 (미사용 식별자) | 3/3 |
| `npm audit` | ✅ 0 vulnerabilities | 2/3 (Claude는 네트워크 차단으로 미수행) |
| ESLint / knip / ts-prune / madge / depcheck | ⏭️ 전부 미도입 | 3/3 |
| 단위 테스트 (`src/**/*.test.ts`) | ⏭️ 0건, `scripts.test` 부재 | 3/3 |
| 보안 정적 (shell injection / path traversal / JSON.parse) | ⚠️ shell-quote 누락 1건 (Major) 외 즉시 위험 없음 | 부분 일치 |
| `console.*` / `debugger` / `TODO`·`FIXME` 잔존 | ✅ 사실상 0건 (`console.warn` 1건은 WebGL 폴백) | 3/3 |
| 패키징 산출물 (`.vsix`) | ⚠️ node-pty 누락 + 워크스페이스 로컬 파일 포함 (Critical) | Codex 단독 (검증 결과 유효) |
| 수동 컴팩션 디스크 락 우회 | ⚠️ `memoryPanel.handleRefine`가 `acquireDiskLock` 미경유 (Critical) | Gemini 단독 (검증 결과 유효) |

종합 판정: **Critical 2 / Major 5 / Minor 12 + Tooling gap 4**.

- 정적 컴파일과 외부 취약점 관점에서는 깨끗하다.
- 그러나 (a) `.vsix` 산출물 자체가 런타임 불능 가능성, (b) 수동 refine 경로가 백그라운드 스케줄러와 동일 자원에 무락 접근, (c) PTY spawn shell-quote 미흡 — 3건은 M7 진입 전 반드시 해결해야 한다.
- 보조 항목인 ESLint·knip·테스트 도입은 별도 작업 트랙으로 진행.

---

## 1. AI별 보고서 특성 비교

| 보고서 | 특징 | 강점 | 약점 |
|---|---|---|---|
| Claude | line-by-line 정밀, 출처 라인 인용 풍부, 보안 항목 분류 체계적 | false-positive가 적음, "현재 위험 없음/잠재 회귀 위험" 구분 | `.vsix`·shell-quote·handleRefine 누락 |
| Gemini | 운영 리스크 시나리오를 강한 등급으로 표시 | `memoryPanel.handleRefine` Critical을 단독 발견 (실측 유효) | `ptyDisplayFilter watchdog` 누수를 Major로 과대 평가 — 실측은 5초 후 소멸·무해 |
| Codex | 패키징·배포 산출물 중심 점검 | `.vsix` 내용물 검사·`chatPanel.ts:198` shell-quote 누락 단독 발견 (둘 다 실측 유효) | 비즈니스 로직 line-by-line 깊이는 얕음 |

---

## 2. Critical (M7 진입 차단 항목)

### C1. `memoryPanel.handleRefine`가 `compactionScheduler` 디스크 락을 우회 — Race Condition

- **출처**: Gemini §2.10 (단독). 본 통합 보고서에서 원본 검증 — **유효**.
- **위치**: [src/views/memoryPanel.ts:106-175](../../src/views/memoryPanel.ts#L106-L175)
- **검증**: 해당 함수가 `runRefine` → `parseRefineOutput` → `assembleIR` → `writeFile(ir.json.tmp)` → `rename` → `rewriteTurns`를 직접 수행. [src/core/compactionScheduler.ts:45](../../src/core/compactionScheduler.ts#L45)의 `acquireDiskLock`(workspace.json `compactionInProgress` CAS)를 전혀 호출하지 않는다. `inFlight` Set도 우회.
- **시나리오**: 사이드바 "Refine" 버튼 클릭이 백그라운드 자동 컴팩션과 겹치면 두 프로세스가 동시에 `ir.json`/`turns.jsonl`을 덮어쓴다. atomic rename 자체는 안전하지만 **두 writer가 서로의 결과를 덮어쓰고 `archiveCompactedTurns`가 중복 덮어쓰기 영향을 받을 수 있다**.
- **개선안**: `handleRefine`도 `compactionScheduler`의 `checkAndRunCompaction` (또는 `acquireDiskLock`/`releaseDiskLock`을 export해서) 동일 경로를 통과시킨다. 수동 트리거는 `force: true` 플래그로 임계치 무시만 다르게.

### C2. `.vsix` 패키징 산출물이 런타임 불능 상태

- **출처**: Codex §3 Critical 1 (단독). 통합 보고서에서 패키지 검사 결과 — **유효**.
- **증거**:
  - `agentbridge-0.1.0.vsix`에 `extension/node_modules/node-pty/**` 미포함 → 설치 후 `require('node-pty')` 실패 가능성.
  - 동시에 `extension/.agents/hooks.json`, `extension/.codex/config.toml`, `extension/.codex/hooks.json`, `extension/.antigravitycli/*.json` 등 **개발 워크스페이스 로컬 hook 파일이 배포물에 포함**.
- **근본 원인**: [.vscodeignore](../../.vscodeignore)가 `.agents/**`, `.codex/**`, `.antigravitycli/**`, `package 2.json`, `out/**/* 2*`, `**/* 2.*` 패턴을 제외하지 않고 있음. node-pty의 darwin prebuild만 포함시키는 화이트리스트 전략도 부재.
- **개선안**: `.vscodeignore` 재정비 → `vsce package` 재실행 → `unzip -l`로 (a) `node-pty/prebuilds/darwin-arm64`, `darwin-x64` 포함, (b) `.agents/.codex/.antigravitycli/package 2.json/out/**/* 2*` 미포함 동시 확인.

---

## 3. Major

### J1. `ChatPanel` PTY spawn의 shell quote escaping 누락

- **출처**: Codex §3 Major 2 (단독). 통합 보고서에서 원본 검증 — **유효**.
- **위치**: [src/views/chatPanel.ts:198](../../src/views/chatPanel.ts#L198)
- **현재 조립**: `[command, ...args].map(a => `'${a}'`).join(' ')` → `/bin/zsh -lc 'exec …'`
- **문제**: arg에 single quote `'`가 포함되면 명령 문자열이 깨진다. workspace path / globalStorage path / attachment path가 `'`를 포함할 경우 spawn 실패 또는 shell interpretation 리스크.
- **개선안**: [src/core/hookInstaller.ts](../../src/core/hookInstaller.ts)의 `quoteArg`(POSIX `'\"'\"'` 패턴)를 동일하게 적용. 두 경로의 escape 헬퍼를 `src/shared/`로 추출 권고.

### J2. `codexSessionWatcher` DFS 폴링이 장기 사용자 환경에서 I/O 스파이크

- **출처**: Gemini §2.7 Major (단독 Major), Claude §4.7 Minor — 통합 등급 **Major**.
- **위치**: [src/core/cliAdapter/codexSessionWatcher.ts:77-98](../../src/core/cliAdapter/codexSessionWatcher.ts#L77-L98) `walkRolloutFiles`
- **문제**: 1초 간격으로 `~/.codex/sessions/<YYYY>/<MM>/<DD>` 3중 폴더를 전수 DFS. 장기 사용자가 수천~수만 세션 jsonl을 누적한 경우 매 spawn마다 IDE 응답성에 영향.
- **현재 완화**: 60s 윈도우로 제한 — Claude의 "큰 문제 없음" 판단 근거. 다만 윈도우 내내 CPU/I/O를 점유한다.
- **개선안**: (a) 당일/최근 월 폴더로 스캔 범위 제한, 또는 (b) `vscode.workspace.createFileSystemWatcher` / `fs.watch` 기반 이벤트 푸시로 전환. `agyResume.ts`도 같이 정리.

### J3. 패키징 입력 트리에 iCloud 중복 산출물(`* 2.*`) 잔존

- **출처**: Codex §3 Major 3 (단독).
- **증거**: `package 2.json` (구 `agentbridge.hello` 커맨드 정의 포함), `out/extension 2.js`, `out/extension.js 2.map`, `out/{core,shared,settings,pty,log} 2`, `media/dots/* 2.svg`.
- **영향**: `.vscodeignore`가 이 패턴을 제외하지 않으면 stale JS가 배포물에 포함되어 런타임 라우팅이 어긋날 수 있음. C2와 함께 해결.

### J4. 패키징 산출물 자동 정적 분석 도구 미도입

- **출처**: 3/3 일치.
- **누락**: ESLint + `@typescript-eslint/recommended`, knip 또는 ts-prune, madge, depcheck, mocha/vitest/`@vscode/test-electron`.
- **개선안**: M7 진입 전 ESLint + knip 최소 사양으로 도입. 단위 테스트(J5)와 함께 CI 게이트화.

### J5. 단위 테스트 체계 부재

- **출처**: 3/3 일치 (Gemini "공백 상태", Codex Critical 2, Claude Action item).
- **현황**: `src/**/*.test.ts` 0건, `package.json` `scripts.test` 부재, mocha/vitest 미설치.
- **우선 대상 (HANDOFF §3.4 + 본 통합 보고서)**: `turnRecorder` state machine, `sliceAssistant` chrome regex(특히 §M11 false-positive), `ptyDisplayFilter` partial chunk·watchdog, `compactionScheduler` CAS race, `sessionRegistry` corrupt JSON backup, `hookInstaller` TOML merge·shell quote.

---

## 4. Minor (개선 권고)

| # | 위치 | 항목 | 출처 |
|---|---|---|---|
| M1 | [tsconfig.json](../../tsconfig.json) | strict 보강 4종 추가 (`noUnusedLocals`/`noUnusedParameters`/`noImplicitReturns`/`noFallthroughCasesInSwitch`) | 3/3 |
| M2 | [turnRecorder/index.ts:38](../../src/core/turnRecorder/index.ts#L38) | `assistantStartedAt` 미사용 필드 제거 (할당만 되고 읽히지 않음) | Claude, Codex |
| M3 | [memoryPanel.ts:18](../../src/views/memoryPanel.ts#L18) | `extensionUri` 미사용 생성자 파라미터 제거 | Claude, Codex |
| M4 | [envProbe.ts:48](../../src/core/envProbe.ts#L48) | `binaryName` 시그니처를 `'agy' \| 'codex' \| 'claude'` literal union 또는 `/^[A-Za-z0-9_-]+$/` 화이트리스트로 강화 (현재 호출처는 모두 상수 — 잠재 회귀 위험) | Claude |
| M5 | [attachmentStore.ts:19](../../src/core/attachmentStore.ts#L19) | `attachmentPathFor`에 `path.basename` 적용해 path traversal 방어층 추가 (현재는 caller 의존) | Claude |
| M6 | [workspaceStore.ts:31](../../src/core/workspaceStore.ts#L31) | 손상 JSON 시 빈 객체 fallback + 백업 (sessionRegistry 패턴과 동치화) | Claude |
| M7 | [ptyDisplayFilter.ts:55-67](../../src/core/ptyDisplayFilter.ts#L55-L67) | `filter()` 내부 동기 timeout 분기에서도 `clearTimeout(this.watchdog)` 명시적 호출. 추가로 `dispose()`에서 `onForceUnblock = null` 레퍼런스 클리어 | Claude(Minor), Gemini(Major→재분류) |
| M8 | [agyResume.ts](../../src/core/cliAdapter/agyResume.ts), [codexSessionWatcher.ts](../../src/core/cliAdapter/codexSessionWatcher.ts) | polling sleep 구간 abort signal 반응성 개선 (Promise.race + signal listener) | Claude |
| M9 | [pty/pseudoterminal.ts](../../src/pty/pseudoterminal.ts) | 타입 전용 파일이므로 `shared/types.ts`로 통합 또는 `pty/types.ts`로 개명 | 3/3 |
| M10 | [turnRecorder/index.ts:133-135](../../src/core/turnRecorder/index.ts#L133-L135) | `userBuffer.length > TURN_CAP.userBytes * 2` 비교가 문자 수 vs 바이트 단위 불일치. UTF-8 한글 입력에서 보호 한계가 조기 발동 가능 | Claude |
| M11 | [sliceAssistant.ts:162](../../src/core/turnRecorder/sliceAssistant.ts#L162) | `^[A-Z][A-Za-z-]{2,19}…?\s*\d*$` 정규식이 본문 정상 단어(`Codex`, `React`, `TypeScript`) 단독 라인을 chrome으로 오인할 수 있음 — false-positive 회귀 테스트 고정 | Claude |
| M12 | [sliceAssistant.ts:102](../../src/core/turnRecorder/sliceAssistant.ts#L102) | agy tool 화이트리스트 하드코딩 — 신규 tool 추가 시 누락 위험. 상수 분리 권고 | Claude |
| M13 | [agyResume.ts:99](../../src/core/cliAdapter/agyResume.ts#L99) | `cwd: string` 파라미터를 로깅에만 사용 — `loggingTag` 등으로 개명/주석 보강 | Claude |
| M14 | [sessionRegistry.ts:199](../../src/core/sessionRegistry.ts#L199) | `import('./attachmentStore')` 동적 import 사유(순환 의존성 회피?) 주석 부재. 또한 `.catch(() => {})`로 swallowed — 최소 warn 로그 권고 | Claude, Gemini |
| M15 | [hookInstaller.ts:35](../../src/core/hookInstaller.ts#L35) | `helperPath` `__dirname` 기준 2후보 검사. webpack/bundle 후 경로 변경 시 throw — M7 패키징에서 재검증 필요 | Claude |
| M16 | [hookInstaller.ts](../../src/core/hookInstaller.ts) 전반 | 거의 모든 디스크 I/O가 `readFileSync`/`mkdirSync`/`renameSync` 동기 API. UI 스레드 블로킹 — 호출 빈도가 낮아 현재 무해하나 `fs.promises`로 통일 권고 | Gemini |
| M17 | [compactionScheduler.ts:186-190](../../src/core/compactionScheduler.ts#L186-L190) | `saveIR`/`archiveCompactedTurns` 성공 후 `rewriteTurns` 실패 시 turns.jsonl과 archive 양쪽에 동일 턴이 남을 가능성. archive 측 중복 가드 또는 3단계 단일 트랜잭션화 검토 | Gemini |
| M18 | [turnRecorder/index.ts](../../src/core/turnRecorder/index.ts) | `resetState()` 호출 시 `idleTimer` 무조건 clear 가드 추가. 현재 상위 메서드에서 선행 clear하지만 robustness 보강. Tab(0x09) skip이 자동완성 시 userBuffer 정합성에 미치는 영향 모니터 | Gemini |
| M19 | [chatPanel.ts:720](../../src/views/chatPanel.ts#L720) | `console.warn('WebGL addon failed…')` — webview devtools 진단용으로 합당하나 OutputChannel 라우팅 여부 결정 | Claude, Codex |
| M20 | [chatPanel.ts](../../src/views/chatPanel.ts) `dispose()` | PTY SIGKILL 3초 지연 setTimeout ID 미보존. 잦은 dispose 시 누적 우려 (현재 빈도 낮음) | Gemini |

---

## 5. Tooling / Process gap (Action items)

| # | 항목 | 비고 |
|---|---|---|
| T1 | ESLint + `@typescript-eslint/recommended` 도입 | M7 진입 전 |
| T2 | knip 또는 ts-prune, madge, depcheck 도입 | 네트워크/패키지 허용 확인 후 |
| T3 | mocha + `@vscode/test-electron` (또는 vitest) 도입 + `scripts.test` 등록 | J5 우선 대상 6종부터 |
| T4 | `npm audit` 정기 실행 | Claude 환경에서는 네트워크 차단으로 미수행, 다른 2건은 0 vulnerabilities 확인 |

---

## 6. 보고서 간 등급 조정 내역

세 보고서가 동일 사안을 다른 등급으로 분류한 경우, 원본 코드 재검증 결과를 따라 통합 등급을 단일화했다.

| 사안 | Claude | Gemini | Codex | 통합 등급 | 근거 |
|---|---|---|---|---|---|
| `memoryPanel.handleRefine` 디스크 락 우회 | (미발견) | Critical | (미발견) | **Critical (C1)** | 원본 확인: `acquireDiskLock` 미경유 사실. race 시나리오 실재. |
| `.vsix` 산출물 (node-pty 누락 + 워크스페이스 로컬 파일 포함) | (미발견) | (미발견) | Critical | **Critical (C2)** | `unzip -l` 결과 사실. |
| `chatPanel.ts:198` shell-quote 누락 | (미발견) | (미발견) | Major | **Major (J1)** | 원본 확인: `'${a}'` 단순 wrap, single quote arg에 취약. |
| `codexSessionWatcher` DFS 폴링 | Minor | Major | (미발견) | **Major (J2)** | 장기 사용자 누적 시 영향이 실측 가능 → Major 채택. |
| `ptyDisplayFilter` watchdog 누수 | Minor | Major | (미발견) | **Minor (M7)** | 5초 후 fire-and-noop으로 즉시 영향 없음 → Minor 유지. |
| `assistantStartedAt`/`extensionUri` 미사용 | Minor | (미발견) | Major | **Minor (M2/M3)** | 타입 안전성 영향만 있고 동작 영향 없음 → Minor 유지. |

---

## 7. 다음 단계

1. **M7 차단 항목 우선 해결**: C1(handleRefine 락 경유) → C2(`.vsix` 산출물 정리) → J1(shell-quote) 순.
2. C2 작업 시 `.vscodeignore`를 재정비하고 `vsce package` 후 `unzip -l`로 화이트리스트 검증.
3. tsconfig strict 4종 추가(M1) + M2/M3 정리 → `tsc --noEmit` 통과 유지.
4. ESLint(T1) + knip(T2) 도입 후 dead export · 미사용 의존성 일괄 정리.
5. 단위 테스트(J5/T3) — §M11 false-positive와 §C1 race를 regression guard로 먼저 고정.
6. J2(코덱스 왓처 폴링)는 별도 PR — file system watcher 전환은 영향 범위가 넓다.

---

## 8. 검증 사이클(M6.5) 회귀 영향

본 보고서에서 코드 수정은 **없음**. M6.5에서 다듬어둔 동작은 모두 그대로 보존된다.
