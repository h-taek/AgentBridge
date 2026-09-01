// 격리 서브가 새 worktree에서 겪는 조용한 결손을 알려주는 머리말 (0.5.0 3단계, B-8).
//
// 새 체크아웃에는 git이 추적하는 파일만 들어간다. 결손은 두 종류다 — node_modules처럼 없으면
// 명령이 즉시 에러를 내는 시끄러운 실패는 에이전트가 스스로 알아채므로 우리가 다룰 일이 아니다.
// 여기서 다루는 것은 CLAUDE.md·AGENTS.md 같은 지침 파일처럼 없어도 아무 에러가 안 나는 조용한
// 실패다 — 서브는 지침이 없다는 사실 자체를 모른 채 다르게 일한다(research 02 §1).
//
// 언어별 의존성 자동화는 하지 않는다. 여기 목록은 무엇이 없는지 알려주는 것으로 끝나고, 설치
// 명령을 지시하지 않는다.

import { execFile } from 'node:child_process';

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

// 머리말에 나열하는 결손 항목의 상한. 이 값은 서브의 첫 프롬프트 맨 앞에 매번 실리므로 길게
// 두지 않는다 — 넘는 만큼은 개수만 알린다.
const MAX_LISTED_MISSING = 12;

// 부모 지침 파일의 예시일 뿐, 존재 여부를 여기서 검사하지 않는다. 저장소마다 쓰는 하니스가
// 다를 수 있어 목록을 우리가 확정할 수 없다.
const INSTRUCTION_FILE_EXAMPLES = 'CLAUDE.md, AGENTS.md, GEMINI.md';

// `git status --porcelain --ignored`의 `!!` 접두 행 = 새 체크아웃에 안 생기는 것의 정의
// 그 자체다(research 02 §1.1). git이 디렉토리 단위로 접어서 주므로 그대로 쓴다.
//
// 셸을 거치지 않는다 — 경로에 공백이 있을 수 있다(gitWorktree.ts와 같은 패턴). 실패하면
// 빈 배열을 낸다. 조회 실패로 스폰을 막을 일이 아니라 머리말이 조금 부실해지는 것으로
// 그친다 — git 저장소가 아닌 경우도 이 경로로 흡수된다.
export async function listMissingPaths(repoPath: string): Promise<string[]> {
  let stdout: string;
  try {
    stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        'git',
        ['status', '--porcelain', '--ignored'],
        { cwd: repoPath, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: GIT_MAX_BUFFER },
        (err, out) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(String(out ?? ''));
        },
      );
    });
  } catch {
    return [];
  }

  return stdout
    .split('\n')
    .filter((line) => line.startsWith('!! '))
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

// 격리된 서브의 첫 프롬프트 앞에 붙는 머리말. 영어로 쓴다 — 모델 프롬프트 언어를 영어로
// 통일하는 저장소 규칙(skillTemplate.ts와 같다). 사용자에게 내는 답의 언어는 훅 지시문이
// 매 턴 따로 정하므로 여기서 건드리지 않는다.
export function buildIsolationPreamble(args: {
  parentPath: string;
  worktreePath: string;
  missing: string[];
}): string {
  const { parentPath, worktreePath, missing } = args;

  const total = missing.length;
  const shown = missing.slice(0, MAX_LISTED_MISSING);
  const missingLine =
    total === 0
      ? 'Nothing else is gitignored in the original — this checkout has everything git tracks.'
      : total <= MAX_LISTED_MISSING
        ? `Also missing here (gitignored in the original repo): ${shown.join(', ')}.`
        : `Also missing here (gitignored in the original repo), showing ${MAX_LISTED_MISSING} of ${total} total: ${shown.join(', ')}, and more.`;

  return `This directory (${worktreePath}) is a git worktree of the parent repository — a fresh checkout containing only git-tracked files. Untracked and gitignored files from the parent do not exist here.

The parent repository is at: ${parentPath}
Read its instruction files there first (e.g. ${INSTRUCTION_FILE_EXAMPLES}) — this worktree does not have them.

${missingLine}

If something you need (like installed dependencies) is missing, handle it yourself as needed.`;
}
