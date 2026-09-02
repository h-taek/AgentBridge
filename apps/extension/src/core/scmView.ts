// 서브의 worktree를 VS Code 소스 제어 뷰에 저장소로 붙인다 (0.5.0 5단계, B-9 사람이 보는 경로).
//
// diff 화면을 우리가 만들지 않는다. 내장 git 확장은 작업 공간 밖의 저장소도 추가로 열 수 있고
// (`openRepository`), 그러면 평소 쓰던 diff 에디터와 gutter 표시와 파일별 변경 목록이 그대로
// 붙는다. 우리 몫은 어느 폴더를 등록하고 언제 해제할지 넘기는 것뿐이다(research/05).
//
// 탐색기 뷰에는 안 붙인다. 폴더를 더하는 API는 `workspace.updateWorkspaceFolders` 하나인데,
// 폴더가 하나인 창을 다중 루트로 바꾸는 순간 익스텐션 호스트가 재시작될 수 있다고 API 정의에
// 적혀 있다. 우리 PTY 세션이 전부 그 위에 있으므로 서브를 격리할 때마다 돌던 세션이 끊긴다.
//
// 등록 실패는 스폰을 막지 않는다. 보는 경로 하나가 없는 것이지 서브가 안 도는 것이 아니다.

import * as vscode from 'vscode';
import * as output from '../log/output';

// 내장 git 확장 API 중 우리가 쓰는 것만. 타입 패키지를 의존성에 더하지 않는다 — 셋뿐이다.
interface GitRepository {
  rootUri: vscode.Uri;
}
interface GitApi {
  state: string;
  repositories: GitRepository[];
  openRepository(uri: vscode.Uri): Promise<GitRepository | null>;
  getRepository(uri: vscode.Uri): GitRepository | null;
}
interface GitExports {
  getAPI(version: number): GitApi;
}

// 확장은 켜지는 데 시간이 걸린다. 첫 조회에서 undefined가 나오고 재시도하면 잡힌다(research/05 §6).
const POLL_MS = 300;
const WAIT_MS = 10_000;

let cached: GitApi | null = null;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function gitApi(): Promise<GitApi | null> {
  if (cached && cached.state === 'initialized') return cached;

  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const ext = vscode.extensions.getExtension<GitExports>('vscode.git');
    if (ext) {
      const exports = ext.isActive ? ext.exports : await ext.activate();
      const api = exports.getAPI(1);
      // `repositories`가 채워지는 것은 초기화가 끝난 뒤다.
      if (api.state === 'initialized') {
        cached = api;
        return api;
      }
    }
    await delay(POLL_MS);
  }
  output.warn('scmView: git 확장을 잡지 못했다 — 소스 제어 뷰 등록을 건너뛴다');
  return null;
}

// 이 경로를 소스 제어 뷰에 등록한다. 이미 있으면 아무 일도 안 일어난다.
export async function registerRepo(treePath: string): Promise<void> {
  try {
    const api = await gitApi();
    if (!api) return;
    await api.openRepository(vscode.Uri.file(treePath));
    output.log(`scmView: 소스 제어 뷰에 등록 — ${treePath}`);
  } catch (err) {
    output.warn(`scmView: 등록 실패 — ${String(err)}`);
  }
}

// 해제. API에 closeRepository가 없어서 명령으로 부른다(research/05 §2·§4).
//
// 넘길 객체를 경로로 되찾을 때 rootUri를 한 번 더 본다. 등록 안 된 경로로 물으면 확장이 그것을
// 품은 다른 저장소를 줄 수 있는데, 그대로 넘기면 사용자의 원본 저장소를 뷰에서 닫는다.
export async function unregisterRepo(treePath: string): Promise<void> {
  try {
    const api = await gitApi();
    if (!api) return;
    const target = vscode.Uri.file(treePath).fsPath;
    const repo =
      api.repositories.find((r) => r.rootUri.fsPath === target) ??
      api.getRepository(vscode.Uri.file(treePath));
    if (!repo || repo.rootUri.fsPath !== target) return;
    await vscode.commands.executeCommand('git.close', repo);
    output.log(`scmView: 소스 제어 뷰에서 해제 — ${treePath}`);
  } catch (err) {
    output.warn(`scmView: 해제 실패 — ${String(err)}`);
  }
}
