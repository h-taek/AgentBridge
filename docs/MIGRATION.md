# 마이그레이션 계획 — 두 레포 → 모노레포

## 출발점 (실측 — 2026-05-30)

두 원본 레포 비교 결과:

| 항목 | 상태 |
|---|---|
| `resources/bin/agentbridge-memory.js` | **byte-identical** (383줄, 100% 일치) |
| `src/shared/{ir,turns,ipc}.ts` (app) ↔ `src/shared/types.ts` (extension) | 같은 스키마, 파일 분할 구조만 다름 |
| `turnRecorder/` | 양쪽 평행 존재, 거의 동일 |
| `irModule/` (parse, prompt) | 양쪽 평행 존재, 거의 동일 |
| `cliAdapter/` | 양쪽 평행 존재, agy/codex/claude 어댑터 |
| `hookInstaller.ts` | 양쪽 존재 |
| `compactionScheduler.ts` | 양쪽 존재 |
| `refineDispatcher.ts` | 양쪽 존재 |
| `shellQuote.ts` | 익스텐션에만 있는 전용 모듈 (app은 inline `shellQuoteIfNeeded`) |

## 단계 (점진 — 한 번에 하나씩)

### Phase 0 — 인프라 (완료 시점에 v0.0.0 태그)
- [x] pnpm workspaces + changesets 셋업
- [x] `packages/core` 스캐폴드
- [x] 100% 동일 파일(`agentbridge-memory.js`) 이관

### Phase 1 — 순수 타입과 schema
- [ ] `shared/types.ts` (extension) ↔ `shared/{ir,turns,ipc}.ts` (app) 비교, 단일 모듈로 통일
- [ ] `@agentbridge/core` export 시작

### Phase 2 — 의존성 없는 순수 함수
- [ ] `shellQuote` (extension 버전 채택 후 app의 `shellQuoteIfNeeded` 대체)
- [ ] `irModule/parse.ts`, `irModule/prompt.ts`
- [ ] `turnRecorder/sliceAssistant.ts`, `turnRecorder/constants.ts`

### Phase 3 — 사이드이펙트 경계 정리
사이드이펙트는 코어가 인터페이스로 받고 각 앱이 구현체를 주입:
```ts
interface Logger { log(s: string): void; warn(s: string): void }
interface Storage { read(path: string): Promise<string>; write(path: string, data: string): Promise<void> }
interface EventBus { emit(name: string, payload: unknown): void; on(name: string, h: (p: unknown) => void): void }
```
- [ ] `turnsStore`, `workspaceStore`, `sessionRegistry`, `attachmentStore` — Storage 인터페이스로 추상화
- [ ] `output.log`/`output.warn` 호출부 — Logger 주입
- [ ] `compactionEvents` (EventEmitter) — EventBus 주입

### Phase 4 — 상위 로직
- [ ] `turnRecorder/index.ts` (의존성 주입 적용)
- [ ] `compactionScheduler.ts`
- [ ] `refineDispatcher.ts`, `refineHeadless.ts`
- [ ] `hookInstaller.ts`
- [ ] `cliAdapter/{codex,agy,claude}Adapter.ts`

### Phase 5 — 앱 통합
- [ ] `apps/extension/`로 원본 익스텐션 진입점/뷰 이관
- [ ] `apps/desktop/`로 원본 Electron main/preload/renderer 이관
- [ ] 원본 두 레포 archive

## 원칙

1. **원본 두 레포는 마이그레이션 완료까지 그대로 둔다.** 롤백 가능 상태 유지.
2. **각 Phase는 독립적으로 mergeable.** Phase 1 끝나면 동작하는 코어가 있어야 함.
3. **코어는 `vscode` / `electron` 직접 import 금지.** 의존성 주입 또는 인터페이스 경유.
4. **차이가 드러나는 모듈은 옮길 때 통일.** "양쪽 다 받아주는 추상화" 함정 회피.

## 미해결 / 결정 필요

- [ ] 코어를 GitHub Packages로 publish할지, workspace 내부 의존만 유지할지 — 후자가 단순.
- [ ] `agentbridge-memory.js`를 코어 빌드 산출물에 포함시킬지, 원본 위치 유지할지.
- [ ] Phase 2~3 사이에 차이가 드러난 모듈 처리 정책 (예: 한쪽 버그픽스가 다른 쪽엔 없는 경우).
