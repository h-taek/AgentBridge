// 서브가 실제로 무엇을 바꿨는지 뜨는 git 표면 (0.5.0 5단계, B-9).
//
// gitWorktree.ts와 나누는 이유는 그쪽이 수명주기(만들고 지우기) 표면이고 이쪽은 내용 표면이라서다.
// 여기서 뜬 패치를 그대로 원본에 얹는 것이 머지이므로, 검수와 머지가 같은 재료를 쓴다.
//
// 패치는 임시 인덱스로 뜬다. 미추적 파일까지 담으려면 `git add`가 필요한데, 도는 서브의 인덱스를
// 우리가 건드리면 그 서브의 스테이징이 사라진다. `GIT_INDEX_FILE`로 인덱스를 하나 따로 두면
// 서브의 인덱스도 워킹트리도 안 건드리고 같은 패치가 나온다 — 미추적·바이너리·파일 모드 변경이
// 한 번에 담긴다.
//
// 분기점은 그때그때 git에게 묻는다. 스폰 시점의 SHA를 레코드에 적어두면 원본이 앞으로 나간 뒤
// 어긋나고, 같은 사실이 두 군데 남는다(격리 여부를 디스크로만 판정하는 것과 같은 이유).

import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { worktreeExists } from './cleanup';

const GIT_TIMEOUT_MS = 10_000;
// add -A는 워킹트리 전체를 해싱한다. 큰 저장소에서 초 단위로 걸리는데 그걸 끊으면 패치가
// 반쪽으로 나온다.
const GIT_WRITE_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

// 패치 전문의 상한. 소비자가 모델이라 출력이 그대로 맥락에 들어간다. 넘으면 파일 경계에서
// 자르고 남은 파일 이름을 적는다 — 잘렸다는 사실을 안 알리면 모델은 그것이 전부라고 믿는다.
export const PATCH_LIMIT_BYTES = 50_000;

function runGit(
  cwd: string,
  args: string[],
  opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: opts.timeout ?? GIT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: GIT_MAX_BUFFER,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
      },
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

export interface Snapshot {
  // 파일별 요약. `git diff --stat` 출력 그대로다 — 사람이 읽는 형태를 우리가 다시 만들지 않는다.
  stat: string;
  // 적용 가능한 패치 전문. 변경이 없으면 빈 문자열이다.
  patch: string;
  // 바뀐 파일 경로 전부. 자를 때 무엇이 빠졌는지 말하는 데 쓴다.
  files: string[];
}

// 워킹트리의 지금 상태를 base와 견준다. dir은 저장소 안이면 어디든 되고, base는 커밋이면 된다.
//
// 인덱스를 HEAD로 씨 뿌린 뒤 add -A 하는 순서인 이유는, 빈 인덱스에서 시작하면 삭제된 파일이
// 패치에 안 잡히기 때문이다. .gitignore가 걸린 것은 add -A가 알아서 뺀다 — 무시되는 파일은
// 변경의 일부가 아니다.
export async function snapshotAgainst(dir: string, base: string): Promise<Snapshot> {
  const scratch = await fsp.mkdtemp(join(tmpdir(), 'agentbridge-index-'));
  const env = { GIT_INDEX_FILE: join(scratch, 'index') };
  try {
    await runGit(dir, ['read-tree', 'HEAD'], { env });
    await runGit(dir, ['add', '-A'], { env, timeout: GIT_WRITE_TIMEOUT_MS });

    const stat = await runGit(dir, ['diff', '--cached', '--stat', base], { env });
    const names = await runGit(dir, ['diff', '--cached', '--name-only', base], { env });
    // --binary는 바이너리 변경까지 적용 가능한 형태로 담는다. --no-ext-diff는 사용자의 외부
    // diff 도구가 끼어들어 패치를 못 쓰게 만드는 것을 막는다.
    const patch = await runGit(
      dir,
      ['diff', '--cached', '--binary', '--no-ext-diff', base],
      { env, timeout: GIT_WRITE_TIMEOUT_MS },
    );

    return {
      stat: stat.trimEnd(),
      patch,
      files: names.split('\n').map((l) => l.trim()).filter(Boolean),
    };
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

// 서브 브랜치가 원본에서 갈라진 자리. 원본이 앞으로 나갔어도 갈라진 커밋을 그대로 낸다.
export async function forkPoint(treePath: string, repoPath: string): Promise<string> {
  const repoHead = (await runGit(repoPath, ['rev-parse', 'HEAD'])).trim();
  const base = await runGit(treePath, ['merge-base', 'HEAD', repoHead]);
  return base.trim();
}

export interface SubagentDiff extends Snapshot {
  // worktree에서 돌았는가. 아니면 원본 폴더의 HEAD 대비 변경을 본 것이다.
  isolated: boolean;
  // 격리였을 때의 분기점.
  base?: string;
}

// 서브의 변경. 격리 여부는 폴더의 존재로 본다 — 레코드에 적으면 디스크와 어긋날 자리가 생긴다.
export async function subagentDiff(repoPath: string, treePath: string): Promise<SubagentDiff> {
  if (await worktreeExists(treePath)) {
    const base = await forkPoint(treePath, repoPath);
    return { isolated: true, base, ...(await snapshotAgainst(treePath, base)) };
  }
  return { isolated: false, ...(await snapshotAgainst(repoPath, 'HEAD')) };
}

// 파일 경계에서 자른다. 반쪽 hunk를 내면 읽는 쪽이 그것을 온전한 변경으로 읽는다.
export function truncatePatch(
  patch: string,
  limit = PATCH_LIMIT_BYTES,
): { patch: string; omitted: string[] } {
  if (Buffer.byteLength(patch, 'utf8') <= limit) return { patch, omitted: [] };

  // `diff --git a/x b/x` 한 줄이 파일 하나의 시작이다.
  const chunks: string[] = [];
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ') || chunks.length === 0) chunks.push(line);
    else chunks[chunks.length - 1] += '\n' + line;
  }

  const kept: string[] = [];
  const omitted: string[] = [];
  let size = 0;
  for (const chunk of chunks) {
    const bytes = Buffer.byteLength(chunk, 'utf8') + 1;
    if (omitted.length === 0 && size + bytes <= limit) {
      kept.push(chunk);
      size += bytes;
      continue;
    }
    // `diff --git a/<path> b/<path>` 에서 뒤쪽 경로를 쓴다. 이름이 바뀐 파일은 새 이름이 나온다.
    const m = /^diff --git a\/.* b\/(.*)$/.exec(chunk.split('\n')[0] ?? '');
    omitted.push(m ? m[1] : '(이름 불명)');
  }
  return { patch: kept.join('\n'), omitted };
}

// ─── 머지 ───────────────────────────────────────────────────────────────

export interface MergeResult {
  // 얹혔는가.
  applied: boolean;
  // 얹었거나 얹으려던 파일.
  files: string[];
  // 실패했을 때 걸린 파일들. 비어 있는데 실패면 error에 원문이 있다.
  conflicts: string[];
  // 아무것도 안 한 이유. 격리가 아니거나 변경이 없으면 실패가 아니다.
  reason?: 'not-isolated' | 'no-changes' | 'conflict';
  error?: string;
}

// `git apply --check`가 거절할 때 내는 줄에서 파일 이름을 뽑는다.
//   error: patch failed: src/a.ts:12
//   error: src/a.ts: patch does not apply
//   error: b.txt: already exists
function conflictFiles(stderr: string): string[] {
  const found: string[] = [];
  for (const line of stderr.split('\n')) {
    const m =
      /^error: patch failed: (.+?):\d+$/.exec(line.trim()) ??
      /^error: (.+?): (?:patch does not apply|already exists|No such file or directory|does not exist in index)/.exec(
        line.trim(),
      );
    if (m && !found.includes(m[1])) found.push(m[1]);
  }
  return found;
}

// worktree에서 돈 서브의 변경을 원본 워킹트리에 얹는다 (B-9).
//
// 전부 얹히거나 아무것도 안 얹힌다. --check가 먼저 보고, 통과해야 실제로 얹는다. 원본이 더러운
// 상태에서 부르는 것이 정상 사용법이라(서브를 띄워놓고 메인과 계속 일한다) 반쯤 얹히면 사용자의
// 미커밋 작업과 서브의 변경이 구분이 안 되고, 사본을 안 만들기로 했으므로 되돌릴 수단도 없다.
//
// 이력은 안 옮긴다. 서브 worktree는 브랜치가 분기점 그대로이고 워킹트리만 더러운 채로 끝나는
// 경우가 대부분이라 옮길 이력이 대개 없다.
export async function mergeSubagent(repoPath: string, treePath: string): Promise<MergeResult> {
  if (!(await worktreeExists(treePath))) {
    return { applied: false, files: [], conflicts: [], reason: 'not-isolated' };
  }

  const base = await forkPoint(treePath, repoPath);
  const snap = await snapshotAgainst(treePath, base);
  if (snap.files.length === 0) {
    return { applied: false, files: [], conflicts: [], reason: 'no-changes' };
  }

  // 패치를 파일로 넘긴다. 큰 패치를 stdin으로 밀면 버퍼에서 막히고, 임시 파일은 얹는 동안만 산다.
  const scratch = await fsp.mkdtemp(join(tmpdir(), 'agentbridge-patch-'));
  const patchFile = join(scratch, 'merge.patch');
  // 원본 저장소의 꼭대기. workspacePath가 저장소의 하위 폴더여도 패치 경로는 꼭대기 기준이다.
  const top = (await runGit(repoPath, ['rev-parse', '--show-toplevel'])).trim();
  try {
    await fsp.writeFile(patchFile, snap.patch, 'utf8');
    try {
      await runGit(top, ['apply', '--check', patchFile], { timeout: GIT_WRITE_TIMEOUT_MS });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        applied: false,
        files: snap.files,
        conflicts: conflictFiles(message),
        reason: 'conflict',
        error: message,
      };
    }
    await runGit(top, ['apply', patchFile], { timeout: GIT_WRITE_TIMEOUT_MS });
    return { applied: true, files: snap.files, conflicts: [] };
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

// 명령의 출력. 소비자가 모델이라 다음에 무엇을 할 수 있는지까지 문장으로 적는다.
export function renderMerge(name: string, r: MergeResult): string {
  if (r.reason === 'not-isolated') {
    return `${name}은 격리 없이 원본 폴더에서 돌았다. 그 변경은 이미 원본에 있으므로 얹을 것이 없다.`;
  }
  if (r.reason === 'no-changes') {
    return `${name}이 바꾼 파일이 없다. 얹을 것이 없다.`;
  }
  if (r.applied) {
    return [
      `${name}의 변경 ${r.files.length}개 파일을 원본에 얹었다.`,
      '',
      ...r.files.map((f) => `  ${f}`),
      '',
      '커밋하지 않았고 이력도 옮기지 않았다. 서브는 그대로 살아 있다 — 정리는 close가 한다.',
    ].join('\n');
  }
  const head = `${name}의 변경을 얹지 못했다. 원본은 전혀 건드리지 않았다.`;
  if (r.conflicts.length === 0) {
    return [head, '', r.error ?? ''].join('\n');
  }
  return [
    head,
    '',
    '걸린 파일:',
    ...r.conflicts.map((f) => `  ${f}`),
    '',
    `걸린 자리는 이 서브와 원본이 같은 곳을 고친 자리다. 이 서브의 변경 전부는 \`agent diff ${name}\`으로 본다.`,
  ].join('\n');
}
