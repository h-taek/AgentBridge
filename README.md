# AgentBridge

AgentBridge 모노레포 — VS Code 익스텐션과 데스크탑(Electron) 앱이 같은 코어 로직을 공유합니다.

## 구조

```
packages/
  core/           # @agentbridge/core — 공유 로직 (workspace 내부 의존)
apps/
  extension/      # VS Code 익스텐션 (← 03_AgentBridge_Extension)
  desktop/        # Electron 데스크탑 앱 (← 02_AgentBridge_App)
```

코어는 `vscode` / `electron` 모듈을 직접 import하지 않습니다. 사이드이펙트
(로깅, 파일 IO, 이벤트)는 인터페이스로 받고 각 앱이 구현체를 주입합니다.

## 릴리스

`changesets`로 각 패키지가 독립적으로 버전업·릴리스됩니다. 한쪽에만 패치가
필요할 때 다른 쪽 버전은 그대로 둘 수 있습니다.

```sh
pnpm changeset           # 변경 기록
pnpm version-packages    # 영향받는 패키지만 버전 bump
pnpm release             # 빌드 + 릴리스
```

## 개발

```sh
pnpm install
pnpm typecheck
pnpm build
```

## 현재 상태 — 마이그레이션 진행 중

이 레포는 두 기존 레포에서 공유 로직을 통합하는 작업의 시작점입니다.
원본 레포는 그대로 유지된 상태로, 모듈 단위로 점진적 이관 중.

- 원본 익스텐션: `../03_AgentBridge_Extension`
- 원본 데스크탑: `../02_AgentBridge_App`
- 마이그레이션 계획: `docs/MIGRATION.md`
