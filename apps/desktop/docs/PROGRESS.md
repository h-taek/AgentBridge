# PROGRESS

## 현재 상태

**v0.0.5 배포 완료** (2026-05-26, ad-hoc 베타). v0.0.5까지 GitHub Releases 발행 (macOS only). 정식 Apple Developer 인증서 + 노타리는 누적 fix 확보 후 진행.

배포 전 단계(M0~M3.7) — 3-CLI PTY + IR/turns + workspace + 멀티 윈도우 + DnD + 내장 터미널 + Liquid Glass UI 모두 본 구현 완료. 정적 분석(tsc strict / eslint 0 error / prettier) + 의존성 audit + 보안 5종 + Sequoia ad-hoc 서명 + electron-updater 통합 완료. 세부 이력은 git log + `docs/plan/` + `docs/research/`.

## 릴리즈 이력 (배포 이후)

### v0.0.1 — 2026-05-13 (첫 ad-hoc 베타)

`agentbridge-0.0.1.dmg` 108MB / `.zip` 104MB / `latest-mac.yml`. M0~M3.7 전체 산출물 + 빌드 환경(`scripts/build-mac-external.sh`).

### v0.0.2 — 2026-05-13 (bug-fix 패치 + electron-updater 도입)

v0.0.1 사용자 환경에서 보고된 prod 빌드 회귀 2건 + 자동 업데이트 인프라 도입.

- **hookInstaller helper binary 경로 prod fix** — `hookInstaller.getHelperBinaryPath()`가 dev 경로 그대로라 `Contents/Resources/bin/...`에 없어 helper not found. `process.resourcesPath/app.asar.unpacked/resources/bin/agentbridge-memory.js`로 정정. 결과 main.log `HookInstaller 실패` 해소
- **gemini quota background probe `env: node: No such file or directory` (exit 127)** — probe spawn에 `buildAdapterEnv` 미적용으로 PATH sparse. `geminiQuotaTracker.ProbeDeps`에 `buildEnv` getter 추가 + spawn에 inject
- **electron-updater 통합** — `src/main/modules/appUpdater.ts` 신설. 부팅 + 6h polling으로 `latest-mac.yml` 확인. dev 모드 skip. ad-hoc 빌드는 다운로드까지만 동작 (정식 노타리 후 자동 설치 완전 동작)
- (별건) claude PTY exit 1 보고는 사용자 환경의 Claude Code v2.1.140 자체 자동 업데이트로 `/opt/homebrew/bin/claude` 심볼릭 링크가 transient 사라진 케이스. 15:07 자동 복구

### v0.0.3 — 2026-05-13 (IR archive 시각 fix + 진단 로그 강화)

다음 incident 발원처 추적을 위한 진단 인프라 구축.

- **IR archive 시각 표시 fix** — `memoryHandlers.readArchiveSnapshotMeta`가 `archivedAt`(스냅샷이 archive에 push된 시각)만 노출 → 가장 최근 archive와 현재 메모리가 동일 시각으로 표시됨. 새 필드 `ArchiveSnapshotMeta.updatedAt`로 `ir.meta.updatedAt` 노출, IrPanel이 시각 라벨/모달 부제로 참조
- **CJK 사이 공백 보존** — `compactBody` trailing whitespace 정리를 `\s+$`에서 `\r?\n+$`로 좁힘
- **renderer log → main.log 통합** — preload에서 `electron-log/preload` 등록, renderer에서 `import log from 'electron-log/renderer'`로 사용. App.tsx 핵심 핸들러 + closeAllAttachments + workspaces.onChanged removed에 breadcrumb
- **sessions:close source 필드** — `SessionCloseSource` 타입 9종(sidebar-trash / tab-x / workspace-switch / workspace-create / workspace-add / home-go / home-submit / workspace-removed / unknown). 모든 호출 지점 source 명시 + main 로그에 동시 기록. **B-002 (codex 세션 간헐적 사라짐) 발원처 추적 인프라**
- **XtermView 진단 로그** — mount/unmount/onExit/isActive 전환/active-rAF에 breadcrumb + dispose race 시 warn

### v0.0.4 — 2026-05-22 (Antigravity 리브랜드 + Per-CLI quota probe + 보안 + IME race)

가장 큰 누적 fix 릴리즈. 14개 영역.

- **Gemini → Antigravity(`agy`) 리브랜드** — CliKind `'gemini'` → `'agy'` (workspace/settings 로드 시 자동 마이그레이션). Hook 시스템 `.agents/hooks.json` + `injectSteps: [{ephemeralMessage}]` 프로토콜(3 iteration으로 schema 확정). conversation 위치 `~/.gemini/antigravity-cli/conversations/<UUID>.pb` + cwd→UUID 매핑 `cache/last_conversations.json`. resume args `--conversation <UUID>`. 파일 rename: `geminiAdapter.ts` → `agyAdapter.ts`, `geminiResume.ts` → `agyResume.ts`, `geminiQuotaTracker.ts` → `cliQuotaTracker.ts`로 통합
- **Refine 정책 4단계 재설계** — `priority`(우선순위 list로 시도, 실패/quota 에러 시 fallback) / `fixed`(단일 CLI 고정) / `active`(args.activeModel 단일) / `off`. legacy `auto`/`agy-flash`는 `priority`로 자동 마이그레이션. 각 CLI 모델 자동: codex `-c model="gpt-5.4-mini"`, claude `--model claude-haiku-4-5`, agy는 CLI flag 미지원
- **Per-CLI quota probe** — `cliQuotaTracker.ts`로 일반화. 격리 tmpdir에 PTY spawn → 순차 InputStep(`{delayBeforeMs, write, label}[]`) 실행 → 응답 정규식 파싱 → cleanup. agy `/usage`(`(\d+)%\s*\n\s*Quota\s+(?:available|exhausted)`), codex `/status`(`5h\s*limit:[\s\S]{0,200}?(\d+)\s*%\s+left`, MCP 부팅 8s 대기), claude `/usage`(`Current\s+session[\s\S]{0,200}?(\d+)\s*%\s*used`). severity 80/95/100. `cli_quota.json`에 `Record<CliKind, QuotaFile>` 영속, legacy `agy_quota.json`/`gemini_quota.json`은 첫 read 시 agy 슬롯으로 자동 흡수
- **Probe 세션 hard cleanup** — `beforeSpawn`(디렉토리 snapshot) + `cleanupExtras`(delta unlink) hook. agy: `implicit/<UUID>.pb` + logs 스냅샷 diff unlink. codex: `snapshotCodexSessions` + capture된 thread_id로 rollout jsonl unlink. claude: 사전 발급 `--session-id <UUID>` → 모든 project 디렉토리 순회 unlink. tmp cwd는 `fs.rm(force,recursive)` 항상
- **Memory 패널 Refine/Quota 카드 재디자인** — 세 CLI 단일 카드 안에 가로 나열(vertical divider만). 활성 CLI(다음 refine에 사용)만 이름+severity 배지. activeCli 추정: `fixed`→refineFixedCli / `priority`→refinePriorityOrder[0] / `active`→sessions 중 lastChattedAt 최신 / `off`→null
- **`settings:updated` broadcast** — `settings:set` 직후 `broadcastToAll(SettingsUpdated, next)`. RefineSettingsPanel + IrPanel 구독으로 정책 변경 즉시 갱신
- **Shift+Enter 한글 IME race fix** — macOS IME가 keydown 중복 발사로 `\x1b\r` 2회 전송되던 문제. `compositionstart/end` 핸들러로 `isComposingState` 추적 + `SHIFT_ENTER_LOCK_MS=50ms` 동안 후속 keydown 흡수 + `pendingShiftEnter` flag로 PTY data 도착 시점 1회만 trigger
- **세션 reorder 모션** — 좌사이드바 세션 row(`ses-sb-<wid>-<sid>`) + 상단 탭(`ses-tab-<sid>`)에 `viewTransitionName` 부여. App.tsx onTurnsUpdated가 `setOpenWorkspace`를 `document.startViewTransition`으로 wrap → lastChattedAt 변경 시 자동 슬라이드(220ms cubic-bezier). `prefers-reduced-motion` 즉시 적용
- **세션 ⋯ overflow 메뉴** — 탭 1줄 유지, 초과분 dropdown. `createPortal`로 `.app-center overflow:hidden` 회피
- **Min window 504×327 + 좁은 화면 사이드바 자동 접힘** — 이전 820×520에서 축소. 사용자 명시 override 우선
- **Memory reset이 archive 디렉토리까지 비움** — 이전엔 archive 보존
- **turns.jsonl assistant detail 설정** — `TurnsAssistantDetail` 타입(`full` ~50KB / `compact` ~500자 / `minimal` ~200자). `sliceAssistant.applyBodyCap`이 `TURNS_ASSISTANT_DETAIL_CAP[detail]` 기준 cap
- **보안 강화 3건** — (1) preload `window.electron` 노출 제거 (`@electron-toolkit/preload`의 범용 ipcRenderer 우회 폐쇄). (2) `pty:start` IPC handler + preload API 제거 (임의 명령 실행 표면 차단, 내부 `startPty`는 유지). (3) workspaceId/sessionId UUID 정규식(`^[0-9a-f]{8}-...$`) + workspaces root prefix 가드 (path.join `..` collapse 차단)
- **Hook 비활성 ⚠ 배지** — `SessionActivateResult`/`HomeSubmitResult`에 `hookDisabledReason` 필드 추가. App.tsx `hookDisabledMap` state. SessionTabs renderTab이 reason 있는 탭에 ⚠ + title 툴팁
- **workspace 경로 정규화 연결** — v0.0.3까지 `normalizeWorkspacePath`/`validateWorkspacePath`는 정의됐으나 `createWorkspace`에서 호출 안 함 → `~/Documents`/`"My Project"`/`Mobile\ Documents` 직접 타이핑 시 spawn ENOENT. 입력 정규화 + 디스크 존재 검증 연결
- **데드코드 3건 제거** — `RefineSettingsPanel.tsx` 261 LOC(SettingsModal 통합으로 미사용) / `workspaceStore.cleanupEmptyWorkspaces`(호출 0) / `workspaceStore.readWorkspacePrimaryReplay`(호출 0)
- **정적 분석 / lint 정리** — cliQuotaTracker `capturePromise`에 `Promise.race(2s)` 가드 / killPtyAsync onExit IDisposable 양쪽 분기 dispose + timer 선언 순서 / archive 경로 가드 공유 헬퍼 `resolveArchivePathSafe` 추출 / ESLint config `scripts/**/*.cjs` ignore / SessionTabs ref-during-render 5건 onClick 시점 capture로 정정

빌드 산출물: `agentbridge-0.0.4.dmg` 108MB + `.zip` 104MB + `latest-mac.yml`. release commit `0b8d4c6`.

### v0.0.5 — 2026-05-26 (release commit `34fe620`, tag `v0.0.5`)

빌드 산출물: `agentbridge-0.0.5.dmg` 108MB + `AgentBridge-0.0.5-arm64-mac.zip` 104MB + `latest-mac.yml`. GitHub Release: `https://github.com/h-taek/AgentBridge_App/releases/tag/v0.0.5`.

**ptyDisplayFilter 매칭 알고리즘 재설계 + in-block watchdog.** extension v0.1.6 알고리즘 본 앱 포팅.

- **문제** — 기존 `filterDisplayData`는 raw input에 `indexOf(OPEN_TAG)` / `indexOf(CLOSE_TAG)`로 매칭. codex TUI가 hook context 출력 도중 화면 재그리기로 태그 사이에 `\r`/ANSI escape/C0 제어문자를 끼우면 매칭이 깨져 raw `<agentbridge-context>` 태그가 사용자 화면에 노출될 수 있었음
- **알고리즘** — `buildPlainProjection(input)`으로 ANSI sequence(CSI/OSC/2-byte ESC) + C0(0x00-0x1f) + DEL(0x7f)를 걷어낸 plain 문자열 + `plainToOrig[]` 인덱스 매핑 생성. plain 위에서 `indexOf` 매칭 후 `plainToOrig`로 원본 emit/drop 경계 역산. chunk 경계 처리: (a) plain tag-prefix 부분 매치 → `plainToOrig`로 원본 carry 시작점 역산 (b) 미완성 ANSI tail은 `trailingTail`로 분리해 다음 chunk와 합쳐 재처리
- **in-block watchdog** — close 태그가 stream에서 영구 누락되는 catastrophic case 대비. `BLOCK_TIMEOUT_MS=1s` setTimeout으로 force-unblock + `STUCK_WARN_MS=500ms` 시점 stuck 경고 로깅. `filterDisplayData` 진입부에 setTimeout 지연 환경 대비 이중 체크(`Date.now()` 비교)
- **호환** — 기존 함수형 export(`registerDisplayFilter`/`unregisterDisplayFilter`/`filterDisplayData`/`getFilterState`) 시그니처 유지 → 호출처(`ptySession.ts`, `workspacesHandlers.ts`) 무수정. extension의 `onForceUnblock` 콜백은 소비자 없어 의도적 미포팅
- **검증** — (1) 합성 worst-case 12종: `\r` 끼움, ANSI CSI 끼움, BS/\t/DEL 끼움, OSC escape 끼움, 청크 경계 OPEN 중간/incomplete ANSI 중간/CLOSE prefix 중간, 다중 블록, byte-by-byte streaming, close 영구 누락 watchdog, fake close 접두사. (2) 실제 4세션 replay.log(총 8.6MB, OPEN 32개) × 청크 크기 6단계(전체/4096/1024/197/13/1B) — 모든 청크 크기에서 byte-identical 출력. (3) A/B 비교(옛 raw indexOf vs 새 plain projection) — 운영 데이터에선 byte-identical(아직 dirty tag 미발생), 합성 dirty tag에서만 옛 알고리즘이 raw OPEN/CLOSE leak. (4) 실제 운영 main.log에 watchdog 1회 발동 기록(`19:12:39.527 watchdog timer fired (1006ms)` ptySessionId `071a60c8...`) — 약 1초 freeze 자동 복구 사례 포착
- **CHANGELOG 추상화** — 별도 커밋 `0c81dde`에서 구현 디테일 제거하고 사용자 관점으로 재작성
- **글로벌 CLI 디렉토리 워크스페이스 차단** — `validateWorkspacePath`에 가드 추가. 홈 디렉토리 자체 + `~/.codex` / `~/.agents` / `~/.gemini` / `~/.claude` / `~/.antigravity` / `~/.antigravity-ide` / `~/.antigravitycli` 하위 경로 거부. 이전엔 hookInstaller가 `<cwd>/.codex/hooks.json`, `<cwd>/.agents/hooks.json` 등을 쓰면서 CLI 글로벌 hook 파일을 덮어쓸 위험. (claude는 `Application Support` 격리 경로 하드코딩이라 구조적 차단 기존 보유, codex/agy는 cwd 기반이라 가드 필요.) 회귀 테스트 11/11 통과 (홈/글로벌 8케이스 throw + `~/Documents`·`/tmp` pass + 비존재 경로 throw)

## 알려진 이슈

| ID | 증상 | 진단 | fix 후보 |
|---|---|---|---|
| B-001 | codex 답변 중 다른 탭 전환 시 codex 화면 멈춰 보임. 백그라운드 PTY는 동작 지속 (bytesEmitted 누적) | xterm.js v5.5.0 IntersectionObserver가 z-index 트릭에 안 걸려 비활성 탭 풀스피드 렌더링 → main thread 경합 | `.xterm-host-stack .xterm-wrap:not(.xterm-host-active)`에 `display: none` 추가 → IntersectionObserver `isIntersecting=false` 유도 → 자동 pause 작동 |
| B-002 | codex 세션 간헐적 사라짐. `permanent: true / reason: 'user-permanent'` 로그 잔존, 사용자는 휴지통 미클릭 진술 | v0.0.3 `SessionCloseSource` 9종 라벨로 다음 incident의 발원처 추적 인프라 확보. v0.0.4 누적 로그 분석 대기 | 휴지통 confirm 팝업은 추가 안 함 (사용자 결정 — 워크스페이스 삭제 confirm과 혼동) |
| B-003 | `[hook context hidden]` marker 뒤로 codex 박스 외곽 빈 공간 잔존 (특히 SessionStart hook에서 두드러짐) | 필터는 OPEN…CLOSE 사이만 제거. codex가 hook context 박스 렌더링하려고 미리 예약한 N줄(`\r\n`, `\e[K`, cursor 이동)은 OPEN 태그 밖이라 손대지 않음 | 정공법: helper binary(`resources/bin/agentbridge-memory.js`) 출력 형식 변경으로 codex 박스 인식 자체 회피. 기능 영향 없음, 시각적 거슬림만. 사용자 무시 가능 판단 |

## 다음 빌드 후보

| 항목 | 내용 |
|---|---|
| B-001 fix 시도 | `main.css` 비활성 탭 wrap에 `display: none` 추가. 적용 후 사용자 검증 라운드 필요 |
| B-002 발원처 확정 | v0.0.3 `source` 필드 + v0.0.4 누적 main.log 분석 → 휴지통이 아닌 다른 경로(workspace-removed / workspace-switch 등)에서 hard delete 트리거되는지 식별 |
| 세션 hard delete modelSessionId 캡처 race | codex/agy spawn 후 modelSessionId 비동기 캡처(1~3초). 캡처 전 휴지통 누르면 native 파일 삭제 안 됨 → 외부 `--resume`에서 잔존. 빈도 낮음(2026-05-22 검증). 보완 후보: (a) hard delete 시 캡처 짧게 wait, (b) beforeSpawn snapshot diff cleanup(probe 패턴 차용). 현재는 "현행 유지" 결정 |
| envProbe 캐시 self-healing | spawn 실패 시 `forceRefresh=true`로 envProbe 재실행 후 1회 자동 재시도. v0.0.1 때 claude transient 심볼릭 링크 부재(자체 자동 업데이트 중) 케이스 회복 |
| ptyDisplayFilter `onForceUnblock` 콜백 | extension 원본 보유, 본 앱 의도적 미포팅. watchdog 발동을 UI 토스트/메트릭으로 노출하고 싶을 때 신설 — `setForceUnblockHandler(sessionId, fn)` 함수형 API로 추가 |

## 배포 인프라

| 항목 | 상태 / 메모 |
|---|---|
| 빌드 스크립트 `scripts/build-mac-external.sh` | `~/.agentbridge-build/`에서 빌드 — iCloud Drive `com.apple.provenance` xattr로 codesign 거부되는 문제 우회 |
| 서명 | ad-hoc (`identity: '-'`) + `hardenedRuntime: true` + `gatekeeperAssess: false` + entitlements에 `disable-library-validation` (Sequoia framework Team ID mismatch dyld 거부 우회) |
| 자동 업데이트 | electron-updater 통합. 부팅 + 6h polling으로 `latest-mac.yml` 확인. ad-hoc 빌드는 다운로드까지만 동작 (자동 설치는 정식 노타리 필요) |
| GitHub Releases | v0.0.2부터 linear accumulating commit history (OSS 표준). main force push 안 함. tag pointer만 force update 허용. assets: dmg + zip + latest-mac.yml + blockmap |
| Apple Developer 인증서 + 정식 노타리 | ⬜ 미정. Developer ID Application 인증서 → `electron-builder.yml` `identity` + `notarize: true` 전환 → notarytool 자동 호출(8~12시간) → Gatekeeper 통과 dmg. 이 시점부터 electron-updater 자동 설치 흐름 완전 동작 |
| Homebrew tap (옵션) | ⬜ 정식 노타리 후 검토 (자체 tap `homebrew-agentbridge` 또는 공식 cask PR) |

## 백로그 (시점 미정)

- 회귀 시나리오 12종 + 성능 5종 사용자 수동 라운드 (베타 빌드별)
- 다른 OS (Linux/Windows) 지원
- 빌드 산출물 크기 최적화 (node-pty prebuilds 정리)
- GitHub Actions CI/CD

## 참고

- 배포 전 단계(M0~M3.7) 청크별 산출물은 git log + 커밋 메시지에 기록됨
- v0.0.x 사용자 facing 변경점은 [`CHANGELOG.md`](CHANGELOG.md) (개발자 디테일은 본 문서)
- 과거 설계 결정 사유는 [`docs/plan/`](docs/plan/) / [`docs/research/`](docs/research/)
