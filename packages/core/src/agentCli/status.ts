// `status` — 어디에 무엇이 깔려 있는지와 배선 자가 진단 (0.5.0 3단계 W7, B-5).
//
// 후보가 아니라 필수다. 맥락을 전부 모델의 자발적 호출에 걸었으므로(B-4), 호출률을 잴 때
// **안 부른 것과 못 부른 것을 갈라야** 한다. 런타임 경로가 죽었을 때 사용자가 확인할 수 있는
// 유일한 자리이기도 하다.
//
// 진단은 설치 목록에서 끝나지 않고 호스트 왕복까지 실제로 해 본다. 파일이 제자리에 있는 것과
// 배선이 도는 것은 다른 사실이고, 후자를 확인하는 자리가 여기뿐이다.

import { promises as fsp } from 'fs';
import { join } from 'path';
import type { CliKind } from '../shared/cli';
import { inspectGlobalHooks } from '../hookInstaller';
import { skillFilePath } from '../skillInstaller';
import { HOST_PING, sendHostRequest } from '../hostRequest';

const AGENTS: CliKind[] = ['claude', 'codex', 'agy'];
const VERSION_RES: Record<string, RegExp> = {
  'agentbridge.js': /@agentbridge-cli-version (\d+\.\d+\.\d+)/,
  'agentbridge-memory.js': /@agentbridge-helper-version (\d+\.\d+\.\d+)/,
  'SKILL.md': /@agentbridge-skill-version (\d+\.\d+\.\d+)/,
};

async function fileVersion(path: string): Promise<string | null> {
  const name = path.split('/').pop() ?? '';
  const re = VERSION_RES[name];
  try {
    const raw = await fsp.readFile(path, 'utf8');
    return re ? (re.exec(raw)?.[1] ?? '알 수 없음') : '있음';
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await fsp.access(path);
    return true;
  } catch {
    return false;
  }
}

export type StatusOptions = {
  // 호스트 왕복에 쓸 세션 폴더. 신원 환경변수가 없으면 건너뛴다.
  sessionDir?: string;
  homeDir?: string;
  execPath?: string;
  timeoutMs?: number;
};

export async function readStatus(
  storageRoot: string,
  wsDir: string,
  opts: StatusOptions = {},
): Promise<string> {
  const execPath = opts.execPath ?? process.execPath;
  const cliPath = join(storageRoot, 'bin', 'agentbridge.js');
  const helperPath = join(storageRoot, 'bin', 'agentbridge-memory.js');

  const lines = ['## AgentBridge 배선', ''];
  lines.push(`워크스페이스  ${wsDir}`);
  lines.push(`런타임        ${execPath}${(await exists(execPath)) ? '' : '  (없음)'}`);
  lines.push(`CLI           ${cliPath}  ${(await fileVersion(cliPath)) ?? '없음'}`);
  lines.push(`훅 헬퍼       ${helperPath}  ${(await fileVersion(helperPath)) ?? '없음'}`);
  lines.push('');

  lines.push('### 훅');
  for (const h of await inspectGlobalHooks(opts.homeDir)) {
    lines.push(`- ${h.agent.padEnd(7)}${h.path}  ${h.installed ? '깔림' : '안 깔림'}`);
  }
  lines.push('');

  lines.push('### 스킬');
  for (const agent of AGENTS) {
    const path = skillFilePath(agent, opts.homeDir);
    const version = await fileVersion(path);
    lines.push(`- ${agent.padEnd(7)}${path}  ${version ? `깔림 ${version}` : '안 깔림'}`);
  }
  lines.push('');

  lines.push('### 호스트');
  if (!opts.sessionDir) {
    lines.push('- 세션 신원이 없어 왕복을 건너뛴다.');
  } else {
    const res = await sendHostRequest(
      opts.sessionDir,
      { id: `status-${process.pid}-${Date.now()}`, kind: HOST_PING, at: Date.now() },
      { timeoutMs: opts.timeoutMs },
    );
    lines.push(res.ok ? `- 응답함 — ${res.output}` : `- 응답 없음 — ${res.output}`);
  }

  return lines.join('\n');
}
