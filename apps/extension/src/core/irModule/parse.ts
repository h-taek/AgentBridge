// parseRefineOutput은 코어 그대로. assembleIR은 익스텐션 측에서 git probe를 수행해 코어의
// 동기 assembleIR에 gitInfo를 넘기는 형태로 facade.

import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  assembleIR as coreAssembleIR,
  type CliKind,
  type IR,
  type ParsedIRBody,
} from '@agentbridge/core';

export { parseRefineOutput } from '@agentbridge/core';
export type { ParsedIRBody, ParseRefineResult } from '@agentbridge/core';

const execFileAsync = promisify(execFile);

async function probeGit(cwd: string): Promise<{ branch?: string; head?: string }> {
  try {
    const [{ stdout: branchOut }, { stdout: headOut }] = await Promise.all([
      execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: 3000 }),
      execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd, timeout: 3000 }),
    ]);
    const branch = branchOut.toString().trim();
    const head = headOut.toString().trim();
    return { branch: branch || undefined, head: head || undefined };
  } catch {
    return {};
  }
}

export async function assembleIR(args: {
  contextId: string;
  body: ParsedIRBody;
  fromModel: CliKind;
  workspacePath: string;
  previousIR: IR | null;
}): Promise<IR> {
  const gitInfo = await probeGit(args.workspacePath);
  return coreAssembleIR({ ...args, gitInfo });
}
