// 서브에이전트의 격리 worktree를 만들고 지우는 git 표면 전부 (0.5.0 B-7).
//
// 격리는 선택이다. 서브 상당수는 조사나 리뷰라 파일을 안 고치고 원본 폴더에서 돈다. 여기 있는
// 것은 격리를 고른 서브에만 쓰이며, worktree는 만들기보다 지우기가 어려우므로 삭제 경로를
// 처음부터 이 한 파일에 모아 둔다.
//
// 삭제가 강제인 이유는 우리 머지가 이력을 옮기지 않고 워킹트리에 얹기만 하기 때문이다(B-9).
// 내용을 이미 가져간 뒤에도 git 눈에는 미머지 브랜치라 평범한 삭제(`-d`)는 거절당한다. 그래서
// `-D`와 `--force`를 쓴다. 강제로 지워도 커밋 객체 자체는 남으므로 식별자만 알면 되살아나고,
// 그래서 summarizeWorktree의 head를 지우기 '전에' 받아 두는 것이 이 모듈의 안전장치다.
//
// 위험 경로 검사(홈 디렉토리 거부 등)를 두지 않는다. treePath는 밖에서 들어오는 문자열이 아니라
// 우리가 발급한 교량 이름으로 조립한 값이다(B-7 이름 절). 검사를 붙이면 없는 위험을 막느라
// 정상 경로가 걸리는 쪽만 남는다.

import { execFile } from 'node:child_process';

// 브랜치에만 붙이고 폴더 이름에는 안 붙인다. `trees/` 아래라는 사실이 이미 그 말을 한다.
// 접두사가 소유권 표시를 겸하므로, 사용자가 접두사를 벗겨 정식 브랜치로 쓰기로 하면
// 그 순간 우리 목록에서 빠진다.
export const AGENT_BRANCH_PREFIX = 'agentbridge/';

// 조회는 짧게, 실제 파일을 푸는 조작은 길게 잡는다. 저장소가 크면 체크아웃과 마감 커밋이
// 초 단위로 걸리는데 그걸 타임아웃으로 끊으면 반쯤 만들어진 worktree가 남는다.
const GIT_TIMEOUT_MS = 10_000;
const GIT_WRITE_TIMEOUT_MS = 120_000;

// numstat과 status 출력이 기본 1MB를 넘길 수 있다. 서브가 만든 diff는 대개 작지만,
// 잘린 출력으로 변경 요약을 틀리게 세는 것보다 넉넉히 받는 편이 낫다.
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

// gitRemote와 같은 방식이다 — 셸을 거치지 않는 execFile에 타임아웃을 걸고 인자를 배열로 넘긴다.
// 경로에 공백이 있어도(`Mobile Documents`) 따옴표 처리가 필요 없다.
// 다만 여기서는 실패를 삼키지 않는다. 조회 실패는 프로필 키처럼 대체값을 쓸 수 있는 일이지만
// 삭제 실패는 남은 것을 영수증에 적어야 하는 일이라, 무엇 때문인지가 위로 올라가야 한다.
function runGit(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout, windowsHide: true, maxBuffer: GIT_MAX_BUFFER },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr ?? '').trim() || err.message;
          reject(new Error(`git ${args.join(' ')} 실패 — ${detail}`));
          return;
        }
        resolve(String(stdout ?? ''));
      },
    );
  });
}

function lines(out: string): string[] {
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

// `agentbridge/` 접두사를 벗긴 이름들.
//
// 장부를 두지 않고 그때그때 git에게 묻는 이유는 우리 삭제 경로 밖에서 남은 브랜치도 잡아야 하기
// 때문이다. 사용자가 손으로 만들었거나, 옛 버전이 남겼거나, 정리가 중간에서 멈췄을 수 있다.
// 이름 발급이 이 목록을 '살아 있는 자리' 셋 중 하나로 본다(W1).
export async function listAgentBranches(repoPath: string): Promise<string[]> {
  const out = await runGit(repoPath, [
    'for-each-ref',
    '--format=%(refname:short)',
    `refs/heads/${AGENT_BRANCH_PREFIX}`,
  ]);
  return lines(out).map((ref) => ref.slice(AGENT_BRANCH_PREFIX.length));
}

// worktree를 만든다. 브랜치는 AGENT_BRANCH_PREFIX + name이고, 현재 HEAD에서 갈라진다.
// 브랜치 없이는 worktree를 만들 수 없어서 그 브랜치가 사용자 저장소 목록에 남는다 — 접두사가
// 있는 이유가 그것이다.
export async function addWorktree(repoPath: string, treePath: string, name: string): Promise<void> {
  await runGit(
    repoPath,
    ['worktree', 'add', '-b', AGENT_BRANCH_PREFIX + name, treePath],
    GIT_WRITE_TIMEOUT_MS,
  );
}

export type WorktreeSummary = {
  head: string; // 현재 HEAD SHA — 강제 삭제 뒤에도 이 값으로 커밋을 되살린다
  dirty: boolean; // 커밋 안 된 변경이 있는가 (미추적 포함)
  changedFiles: number; // HEAD 대비 바뀐 '추적 중인' 파일 수. 미추적은 untracked가 따로 센다
  insertions: number;
  deletions: number;
  untracked: number;
};

// 지우기 전에 한 번 모으는 영수증 재료. 확인 창과 명령 출력이 같은 값을 쓴다(W7).
//
// 커밋 유무·머지 여부·워킹트리 상태는 삭제 여부에 영향을 주지 않는다. 그 셋은 영수증의 내용을
// 채우는 데만 쓴다(B-7).
export async function summarizeWorktree(treePath: string): Promise<WorktreeSummary> {
  const head = (await runGit(treePath, ['rev-parse', 'HEAD'])).trim();

  // HEAD 대비 diff라 스테이징 여부와 무관하게 같은 값이 나온다. 파일 모드만 바뀐 것도
  // 0/0으로 한 줄이 나오므로 changedFiles에는 잡힌다.
  const numstat = await runGit(treePath, ['diff', '--numstat', 'HEAD']);
  let changedFiles = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of lines(numstat)) {
    const [ins, del] = line.split('\t');
    changedFiles += 1;
    // 바이너리는 숫자 대신 '-'가 온다. 파일 수에는 넣고 줄 수에는 안 넣는다.
    if (ins !== '-') insertions += Number(ins) || 0;
    if (del !== '-') deletions += Number(del) || 0;
  }

  // diff는 미추적 파일을 못 본다. 마감 커밋이 담을 것이므로 따로 센다.
  const others = await runGit(treePath, ['ls-files', '--others', '--exclude-standard']);
  const untracked = lines(others).length;

  return {
    head,
    dirty: changedFiles > 0 || untracked > 0,
    changedFiles,
    insertions,
    deletions,
    untracked,
  };
}

// 마감 커밋. 워킹트리가 깨끗하면 아무것도 안 하고 null.
//
// 이것이 있어야 복구 식별자가 전부를 가리킨다. 에이전트는 시키지 않으면 커밋하지 않으므로(B-9)
// 대부분의 서브는 워킹트리만 더러운 채 끝나는데, 그 상태로 강제 삭제하면 SHA가 살리는 것은
// 커밋뿐이라 실제 작업물이 사라진다. 사본을 뜨는 것이 아니라 git이 이미 가진 것을 가리키게
// 만드는 일이다.
//
// `add -A`는 미추적 파일과 삭제와 파일 모드 변경까지 한 번에 담는다.
// 훅은 건너뛴다(`--no-verify`). 이것은 사용자가 부탁한 커밋이 아니라 지우기 전에 내용을
// 붙잡아 두는 안전망이라, 사용자의 pre-commit 훅이 린트로 실패한다고 작업물이 사라지면 안 된다.
// 작성자·서명 같은 나머지 git 설정은 그대로 쓴다.
export async function commitAll(treePath: string, message: string): Promise<string | null> {
  const status = await runGit(treePath, ['status', '--porcelain']);
  if (lines(status).length === 0) return null;

  await runGit(treePath, ['add', '-A'], GIT_WRITE_TIMEOUT_MS);
  await runGit(treePath, ['commit', '--no-verify', '-m', message], GIT_WRITE_TIMEOUT_MS);
  return (await runGit(treePath, ['rev-parse', 'HEAD'])).trim();
}

// worktree 폴더를 지운다. 강제인 이유는 마감 커밋 뒤에도 무시 파일 등이 남아 git이 '더럽다'고
// 거절할 수 있기 때문이고, 지울지 말지를 정하는 것은 정리 호출이 왔느냐 하나이기 때문이다(B-7).
export async function removeWorktree(repoPath: string, treePath: string): Promise<void> {
  await runGit(repoPath, ['worktree', 'remove', '--force', treePath], GIT_WRITE_TIMEOUT_MS);
}

// 브랜치를 지운다. `-D`인 이유는 머지 여부가 삭제 여부를 정하지 않기 때문이다.
//
// 거절하는 경우는 하나다 — 그 브랜치가 다른 worktree에 체크아웃돼 있을 때. 우회하려면 남의
// 작업 자리를 건드려야 하므로 우회하지 않고 무엇 때문인지 알 수 있는 에러를 올린다.
// 삭제 순서가 폴더 → 브랜치로 고정인 것도 이 때문이다(B-7: 3과 4 사이에서 멈추면 안 된다).
export async function deleteBranch(repoPath: string, name: string): Promise<void> {
  const branch = AGENT_BRANCH_PREFIX + name;
  try {
    await runGit(repoPath, ['branch', '-D', branch]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // git 버전에 따라 문구가 갈린다 — 예전은 "checked out at", 지금은 "used by worktree at".
    const at = /(?:checked out at|used by worktree at) '([^']+)'/.exec(msg);
    if (at) {
      throw new Error(`브랜치 ${branch}를 지울 수 없다 — 다른 worktree(${at[1]})에 체크아웃돼 있다`);
    }
    throw err;
  }
}
