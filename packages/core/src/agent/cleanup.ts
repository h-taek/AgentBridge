// 서브 정리 (0.5.0 4단계 W7, B-7 "정리가 하는 일").
//
// 정리를 부르는 자리는 여럿이지만 하는 일은 하나다. 이 파일이 그 하나이고, `agent close`도
// 메인 세션 삭제의 캐스케이드도 트리의 삭제 액션도 전부 여기로 들어온다. 그래서 어느 경로로
// 지우든 결과가 같다.
//
// 여섯 단계이고 순서가 고정이다.
//   1. PTY 세션 종료
//   2. 워킹트리가 더러우면 그 브랜치에 마감 커밋   (worktree가 있는 경우)
//   3. worktree 폴더 삭제
//   4. 브랜치 삭제
//   5. 세션 레코드에 닫힘 표시 (레코드 자체는 보존 — 이름 재사용의 근거다)
//   6. 영수증 반환
//
// 3과 4 사이에서 멈추면 폴더 없이 브랜치만 남고, 그 이름은 재발급 때 부딪혀 worktree 생성이
// 실패한다. 여섯을 한 단위로 묶는 이유가 그것이다.
//
// 마감 커밋이 있어야 복구 식별자가 전부를 가리킨다. 에이전트는 시키지 않으면 커밋하지 않으므로
// 대부분의 서브는 워킹트리만 더러운 채 끝나는데, 그 상태로 강제 삭제하면 SHA가 살리는 것은
// 커밋뿐이라 실제 작업물이 사라진다. 사본을 만드는 것이 아니라 git이 이미 가진 것을 가리키게
// 만드는 일이다.
//
// 중간에서 실패하면 되돌리지 않는다. PTY를 되살릴 수 없고, 되돌리는 코드가 그 자체로 또 중간에
// 실패할 수 있다. 대신 무엇이 남았는지를 사실대로 영수증에 적고, 그 이름은 살아 있는 것으로
// 취급해 재발급하지 않는다.

import { promises as fsp } from 'fs';
import { join } from 'path';
import {
  commitAll,
  deleteBranch,
  removeWorktree,
  summarizeWorktree,
  AGENT_BRANCH_PREFIX,
} from './gitWorktree';

export type CleanupStep = 'pty' | 'commit' | 'worktree' | 'branch' | 'record';

export interface CleanupReceipt {
  name: string;
  // 격리 서브였는가. 아니면 지울 폴더도 브랜치도 없다.
  isolated: boolean;
  // 지우기 전에 모은 값들. 조회 자체가 실패하면 없다.
  changedFiles?: number;
  insertions?: number;
  deletions?: number;
  untracked?: number;
  // 복구 식별자. 마감 커밋을 했으면 그 SHA, 아니면 삭제 시점의 HEAD.
  recoverySha?: string;
  // 마감 커밋을 실제로 만들었는가.
  sealed: boolean;
  // 끝까지 갔는가. 아니면 어디서 멈췄는지가 아래에 있다.
  ok: boolean;
  failedAt?: CleanupStep;
  error?: string;
  // 남은 것. 사용자가 같은 정리를 다시 부르면 여기서부터 이어간다.
  remaining: CleanupStep[];
}

export interface CleanupTarget {
  name: string;
  // 원본 저장소 경로. worktree와 브랜치를 지우는 주체다.
  repoPath: string;
  // <워크스페이스>/trees/<이름>. 없으면 격리를 안 고른 서브다.
  treePath?: string;
}

export interface CleanupDeps {
  // PTY 세션을 끝낸다. 이미 끝나 있으면 그냥 참을 낸다.
  stopSession: () => Promise<void> | void;
  // 세션 레코드에 닫힘·정리 표시. 레코드 자체는 지우지 않는다 — 이름 재사용의 근거다.
  markClosed: () => Promise<void>;
  // 이 서브의 세션 폴더. 주면 기록을 함께 지운다 — 서브의 대화는 정리될 때 사라진다(B-8).
  // 메인이 검수 시점에 전문을 읽어 가고, 읽은 것을 자기 말로 쓰면 그것이 프로젝트의 기록에
  // 남는다. 원문을 두 벌로 보관하지 않는다.
  sessionDir?: string;
}

// worktree 폴더가 실제로 있는가. 격리 여부를 레코드에 적지 않고 디스크로 판단하는 근거다 —
// 같은 사실이 두 군데 있으면 어긋났을 때 어느 쪽이 진짜인지 정하는 문제가 따라온다.
export async function worktreeExists(treePath: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(treePath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export function resolveTreePath(workspaceDir: string, name: string): string {
  return join(workspaceDir, 'trees', name);
}

const ISOLATED_STEPS: CleanupStep[] = ['pty', 'commit', 'worktree', 'branch', 'record'];
const PLAIN_STEPS: CleanupStep[] = ['pty', 'record'];

export async function cleanupSubagent(
  target: CleanupTarget,
  deps: CleanupDeps,
): Promise<CleanupReceipt> {
  const isolated = !!target.treePath && (await worktreeExists(target.treePath));
  const steps = isolated ? [...ISOLATED_STEPS] : [...PLAIN_STEPS];
  const receipt: CleanupReceipt = { name: target.name, isolated, sealed: false, ok: false, remaining: steps };

  const done = (step: CleanupStep): void => {
    receipt.remaining = receipt.remaining.filter((s) => s !== step);
  };
  const fail = (step: CleanupStep, err: unknown): CleanupReceipt => {
    receipt.failedAt = step;
    receipt.error = err instanceof Error ? err.message : String(err);
    return receipt;
  };

  // 1. PTY 종료. 첫 단계인 이유는 영수증의 틈을 닫기 위해서다 — 조회와 삭제 사이에 서브가
  //    커밋을 더 하면 영수증이 옛 값이 된다.
  try {
    await deps.stopSession();
    done('pty');
  } catch (err) {
    return fail('pty', err);
  }

  if (isolated && target.treePath) {
    // 영수증의 내용은 지우기 전에 한 번 모은다. 확인 창과 명령의 출력이 같은 값을 쓴다.
    try {
      const summary = await summarizeWorktree(target.treePath);
      receipt.changedFiles = summary.changedFiles;
      receipt.insertions = summary.insertions;
      receipt.deletions = summary.deletions;
      receipt.untracked = summary.untracked;
      receipt.recoverySha = summary.head;

      // 2. 마감 커밋. 깨끗하면 아무것도 안 만든다.
      if (summary.dirty) {
        const sha = await commitAll(target.treePath, `agentbridge: ${target.name} 마감`);
        if (sha) {
          receipt.recoverySha = sha;
          receipt.sealed = true;
        }
      }
      done('commit');
    } catch (err) {
      return fail('commit', err);
    }

    // 3. worktree 폴더 삭제.
    try {
      await removeWorktree(target.repoPath, target.treePath);
      done('worktree');
    } catch (err) {
      return fail('worktree', err);
    }

    // 4. 브랜치 삭제. 폴더와 항상 함께 지운다 — 그래야 한쪽만 남는 상태가 정의상 안 생긴다.
    try {
      await deleteBranch(target.repoPath, target.name);
      done('branch');
    } catch (err) {
      return fail('branch', err);
    }
  }

  // 5. 레코드에 닫힘·정리 표시. 레코드는 보존하고 기록만 지운다.
  try {
    if (deps.sessionDir) await fsp.rm(deps.sessionDir, { recursive: true, force: true });
    await deps.markClosed();
    done('record');
  } catch (err) {
    return fail('record', err);
  }

  receipt.ok = true;
  return receipt;
}

// 6. 영수증을 사람이 읽는 한 줄로. 명령의 출력과 확인 창이 같은 값을 쓴다.
export function renderReceipt(r: CleanupReceipt): string {
  const lines: string[] = [];
  if (!r.isolated) {
    lines.push(`${r.name}을 정리했다. 격리를 안 쓴 서브라 지운 폴더와 브랜치가 없다.`);
  } else {
    const changed =
      r.changedFiles === undefined
        ? '변경 내역을 못 읽었다'
        : `파일 ${r.changedFiles}개 변경(+${r.insertions ?? 0}/-${r.deletions ?? 0})` +
          (r.untracked ? `, 새 파일 ${r.untracked}개` : '');
    lines.push(`${r.name}을 정리했다 — ${changed}.`);
    lines.push(`  폴더 trees/${r.name}와 브랜치 ${AGENT_BRANCH_PREFIX}${r.name}를 지웠다.`);
    if (r.recoverySha) {
      lines.push(
        `  되살리려면: git checkout -b ${r.name}-복구 ${r.recoverySha}` +
          (r.sealed ? '  (마감 커밋을 만들어 두었다)' : ''),
      );
    }
  }
  if (!r.ok) {
    lines.push(`  ${r.failedAt} 단계에서 멈췄다: ${r.error}`);
    lines.push(`  남은 것: ${r.remaining.join(', ')}. 같은 정리를 다시 부르면 이어서 한다.`);
  }
  return lines.join('\n');
}

// 프로젝트를 열 때 도는 고아 스캔 (B-7 정리 시점 셋째).
//
// 스폰은 레코드를 먼저 쓰고 worktree를 만든다. 그래서 레코드 없이 남은 폴더만 비정상 종료의
// 흔적이 되고, 레코드가 있고 닫힘 표시만 찍힌 서브는 여기 안 걸린다. 훑는 것은 이 프로젝트의
// trees/ 하나뿐이다.
export async function findOrphanTrees(
  workspaceDir: string,
  knownNames: Iterable<string>,
): Promise<string[]> {
  const known = new Set(knownNames);
  let entries: string[];
  try {
    entries = await fsp.readdir(join(workspaceDir, 'trees'));
  } catch {
    return []; // trees/가 없다 — 격리를 쓴 적이 없는 프로젝트다
  }
  return entries.filter((name) => !known.has(name));
}

// ─── 라운드 정리 (0.5.0 5단계 W4, B-7 정리 시점 첫째) ────────────────────

export interface RoundCandidate {
  sessionId: string;
  name: string;
  // 원본에 얹은 시각. 없으면 안 얹은 서브다.
  mergedAt?: string;
  // 이미 정리된 서브. 다시 지우지 않는다.
  cleanedAt?: string;
  // 직전 라운드 정리에서 남겨진 서브. 이번에는 지워진다.
  roundKeptAt?: string;
}

export interface RoundPlan {
  remove: RoundCandidate[];
  keep?: RoundCandidate;
}

// 라운드가 끝났을 때 무엇을 지우고 무엇을 남기는가.
//
// **아직 안 남겨진 것 중 가장 최근에 머지된 하나만 남기고 나머지를 전부 지운다.**
//
// 조건이 둘인 이유는 스펙의 문장이 둘이기 때문이다. 머지된 것을 남기는 것이 하나이고, 직전
// 정리에서 남겨둔 것을 이번에 함께 지우는 것이 다른 하나다. 남겨진 표시를 안 보면 새 머지가
// 나올 때까지 같은 서브가 매번 '가장 최근에 머지된 것'으로 뽑혀 영원히 안 지워진다 — 상한이
// 생긴다는 근거가 무너진다.
//
// 남기는 이유는 머지됐기 때문이 아니라 채택한 줄기라 이어서 시킬 가능성이 높기 때문이다. 정리를
// 부르는 시점이 곧 이전 라운드가 끝났다는 선언이므로, 살아 있는 서브는 항상 최대 하나이고
// 시간이나 창 닫힘을 안 쓰고도 상한이 생긴다.
export function planRoundCleanup(children: RoundCandidate[]): RoundPlan {
  const live = children.filter((c) => !c.cleanedAt);
  const keep = live
    .filter((c) => c.mergedAt && !c.roundKeptAt)
    .sort((a, b) => (a.mergedAt as string).localeCompare(b.mergedAt as string))
    .pop();
  return { keep, remove: live.filter((c) => c !== keep) };
}
