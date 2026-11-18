// 이름이 바뀐 폴더 이어받기가 끝났다는 신호 (0.8.0 spec/07).
//
// getOrCreateWorkspaceId는 새 id 자리에 워크스페이스를 만든다. 이어받기보다 먼저 불리면 빈 새
// 워크스페이스가 생겨 이어받기가 할 일 없음으로 끝나거나 폴더 옮기기가 실패한다. 그래서 활성화 직후
// 바로 도는 뷰(세션 목록·기억 패널)는 워크스페이스 id를 얻기 전에 이것을 기다린다.

let ready: Promise<void> = Promise.resolve();

export function setWorkspaceReady(p: Promise<void>): void {
  ready = p;
}

export function whenWorkspaceReady(): Promise<void> {
  return ready;
}
