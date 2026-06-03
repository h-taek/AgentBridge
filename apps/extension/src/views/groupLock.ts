// 채팅 패널 에디터 그룹 자동 잠금.
//
// 채팅 패널이 "처음 active가 되는 순간" 그 패널이 속한 에디터 그룹에
// workbench.action.lockEditorGroup 명령을 1회 실행한다. 잠긴 그룹에는 새 에디터가
// 열리지 않으므로, 탐색기에서 연 파일이 채팅 패널을 덮지 않는다.
//
// - 잠금 명령은 "현재 active인 그룹"에 작동하므로 active 시점에만 실행해야 정확하다.
// - 패널당 1회만 시도 — 사용자가 수동으로 잠금을 풀면 다시 잠그지 않는다 (사용자 의도 존중).
// - 명령 실패는 흡수하고 warn 로그만 남긴다 — 잠금은 부가 기능이라 채팅을 막으면 안 됨.
//
// vscode 모듈을 직접 import하지 않고 의존성을 주입받는다 (mocha 단위 테스트 가능).
// 설계: docs/0.1.0/plan/02_editor_group_lock.md

export interface GroupLockerDeps {
  executeCommand: (command: string) => PromiseLike<unknown>;
  warn: (msg: string) => void;
}

export interface GroupLocker {
  onViewState(active: boolean): void;
}

export function createGroupLocker(deps: GroupLockerDeps): GroupLocker {
  let attempted = false;
  return {
    onViewState(active: boolean): void {
      if (!active || attempted) return;
      attempted = true;
      void Promise.resolve(deps.executeCommand('workbench.action.lockEditorGroup')).then(
        undefined,
        (err: unknown) => {
          deps.warn(`에디터 그룹 잠금 실패 (무시하고 계속): ${String(err)}`);
        },
      );
    },
  };
}
