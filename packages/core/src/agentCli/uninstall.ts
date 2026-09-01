// `uninstall` — 전역에 깔린 훅과 스킬을 걷어낸다 (0.5.0 3단계 W7, B-5).
//
// 전역 설치를 원칙으로 삼는 순간 정리는 제품의 일부가 된다. 익스텐션을 지워도 전역에 깔린
// 것은 남는다 — 제거 시점에 도는 코드가 없기 때문이다.
//
// 사용자 명령이지 에이전트 명령이 아니다. 같은 실행 파일에 살지만 스킬과 지시문의 명령
// 목록에는 싣지 않는다. 전역 설정을 걷어내는 일을 모델의 자발적 호출에 열어둘 이유가 없다.
//
// 저장소(~/agentbridge)는 건드리지 않는다. 그것은 사용자의 대화 기록과 지식이다.

import { promises as fsp } from 'fs';
import { dirname } from 'path';
import type { CliKind } from '../shared/cli';
import { removeGlobalHooks } from '../hookInstaller';
import { skillFilePath } from '../skillInstaller';

const AGENTS: CliKind[] = ['claude', 'codex', 'agy'];

export async function uninstallGlobal(homeDir?: string): Promise<string> {
  const removed: string[] = [];

  for (const path of await removeGlobalHooks(homeDir)) removed.push(path);

  for (const agent of AGENTS) {
    const path = skillFilePath(agent, homeDir);
    try {
      await fsp.unlink(path);
      removed.push(path);
    } catch {
      continue; // 없으면 지울 것도 없다
    }
    // 우리가 만든 폴더만 사라진다. 남의 파일이 있으면 rmdir이 실패하고 그대로 남는다.
    try {
      await fsp.rmdir(dirname(path));
    } catch {
      /* 비어 있지 않다 */
    }
  }

  if (removed.length === 0) {
    return '걷어낼 것이 없다. 전역에 깔린 우리 항목이 없다.';
  }
  return [
    `전역에서 ${removed.length}개를 걷어냈다.`,
    '',
    ...removed.map((p) => `- ${p}`),
    '',
    '저장소(대화 기록과 지식)는 그대로 둔다.',
  ].join('\n');
}
