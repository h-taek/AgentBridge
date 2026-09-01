// 전역 스킬 설치 (0.5.0 3단계 W4, B-5).
//
// 규칙은 하나다. 사용자의 전역 설정 폴더에 설치하고, 사용자의 프로젝트 폴더에는 쓰지 않는다.
// 훅과 같은 자리, 같은 규칙이다(A-3). 커밋할지 말지를 사용자가 정해야 하는 파일을 우리가
// 만들어 두는 것은 남의 diff를 더럽히는 일이다.
//
// 자리가 셋인 것은 실측 결과다(research 06 §3). codex는 `~/.agents/skills/`와
// `$CODEX_HOME/skills/` 둘 다 싣지만 agy는 `~/.agents/skills/`를 아예 안 읽고
// `~/.gemini/config/skills/`만 싣는다. agy의 `~/.gemini/antigravity-cli/skills/`는 조회
// 목록에는 뜨는데 모델 프롬프트에는 안 실리므로 쓰지 않는다.
//
// 설치 시점은 훅과 같다 — 그 하니스의 세션을 처음 열 때 그 하니스에만. 익스텐션이 켜질 때
// 셋에 한꺼번에 깔지 않는다.

import { promises as fsp } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import type { CliKind } from './shared/cli';
import type { Logger } from './interfaces';
import { noopLogger } from './interfaces';
import { SKILL_DIR_NAME, renderSkillMarkdown } from './skillTemplate';

// 하니스별 스킬 루트 — 실측으로 확정한 자리(research 06 §3).
const SKILL_ROOTS: Record<CliKind, string[]> = {
  claude: ['.claude', 'skills'],
  codex: ['.agents', 'skills'],
  agy: ['.gemini', 'config', 'skills'],
};

// status와 uninstall(W7)이 같은 지식을 쓴다 — 어디에 무엇이 깔렸는지 아는 자리와 걷어내는
// 자리가 갈리면 둘 중 하나가 먼저 틀린다.
export function skillFilePath(agent: CliKind, homeDir?: string): string {
  return join(homeDir ?? homedir(), ...SKILL_ROOTS[agent], SKILL_DIR_NAME, 'SKILL.md');
}

export type SkillInstallerOptions = {
  // 스킬 본문에 박히는 런타임 절대경로. 훅과 같은 값이다(설치 시점의 process.execPath).
  execPath: string;
  // 설치된 agentbridge.js의 canonical 경로.
  cliPath: string;
  homeDir?: string;
  logger?: Logger;
};

export interface SkillInstaller {
  install(agent: CliKind): Promise<string>;
}

export function createSkillInstaller(opts: SkillInstallerOptions): SkillInstaller {
  const log = opts.logger ?? noopLogger;
  const home = opts.homeDir ?? homedir();

  return {
    async install(agent: CliKind): Promise<string> {
      const file = skillFilePath(agent, home);
      const content = renderSkillMarkdown({ execPath: opts.execPath, cliPath: opts.cliPath });
      // 내용이 같으면 안 쓴다. 경로가 바뀌면 내용도 바뀌므로 버전 마커만 보는 것보다 넓게 잡는다.
      let existing: string | null = null;
      try {
        existing = await fsp.readFile(file, 'utf8');
      } catch {
        /* 미설치 */
      }
      if (existing === content) return file;

      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await fsp.mkdir(dirname(file), { recursive: true });
      await fsp.writeFile(tmp, content, 'utf8');
      await fsp.rename(tmp, file);
      log.log(`skillInstaller: ${agent} 스킬 → ${file} (${existing ? '갱신' : '설치'})`);
      return file;
    },
  };
}
