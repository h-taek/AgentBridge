// CLI별 refine spawn 인자 조립 — refineDispatcher에서 분리. 두 호스트가 같은 인자를 쓰도록
// 단일 위치 SSOT. 응답 파싱(onLine 콜백)도 함께 정의해 호스트 간 차이 없게 한다.

import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync } from 'fs';
import type { CliKind } from './shared/cli';

export const REFINE_MODEL_HINT: Record<CliKind, string | null> = {
  agy: null,
  codex: 'gpt-5.4-mini',
  claude: 'claude-haiku-4-5',
};

export type AssistantTextAccumulator = (text: string) => void;

export type CliRefineSpawnArgs = {
  // spawn 인자 (envProbe resolvedPath와 함께 runRefineSpawn에 전달).
  args: string[];
  // codex처럼 stdin으로 prompt 전달하는 경우. null이면 stdin close.
  stdinPayload?: string | null;
  // claude/agy는 spawn cwd 전달 가능. agy는 격리 cwd 사용(아래 isolatedCwd 참조).
  cwd?: string;
  // agy 등 격리 tmpdir에서 실행하는 CLI는 spawn 후 호스트가 청소할 수 있도록 cwd를 노출.
  // 호스트는 spawn 종료 시점에 cwd + 매핑된 UUID 기반으로 9종 잔재 정리.
  isolatedCwd?: string;
  // 라인별 응답 파서 — accumulator에 assistantText를 누적.
  onLine: (line: string, accumulate: AssistantTextAccumulator) => void;
};

export function buildClaudeRefineSpawn(prompt: string, cwd?: string): CliRefineSpawnArgs {
  const modelArgs = REFINE_MODEL_HINT.claude ? ['--model', REFINE_MODEL_HINT.claude] : [];
  return {
    args: [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
      ...modelArgs,
    ],
    cwd,
    onLine: (line, accumulate) => {
      let evt: unknown;
      try {
        evt = JSON.parse(line);
      } catch {
        return;
      }
      const o = evt as {
        type?: string;
        message?: { content?: Array<{ type?: string; text?: string }> };
      };
      if (o.type === 'assistant' && o.message?.content) {
        for (const c of o.message.content) {
          if (c.type === 'text' && typeof c.text === 'string') {
            accumulate(c.text);
          }
        }
      }
    },
  };
}

export function buildCodexRefineSpawn(prompt: string, cwd?: string): CliRefineSpawnArgs {
  const modelArgs = REFINE_MODEL_HINT.codex ? ['-c', `model="${REFINE_MODEL_HINT.codex}"`] : [];
  return {
    args: [...modelArgs, 'exec', '--json', '--skip-git-repo-check', '-s', 'read-only', '-'],
    cwd,
    stdinPayload: prompt,
    onLine: (line, accumulate) => {
      try {
        const o = JSON.parse(line) as {
          type?: string;
          item?: { text?: string };
        };
        if (o.type === 'item.completed' && o.item?.text) accumulate(o.item.text);
      } catch {
        /* skip */
      }
    },
  };
}

// agy는 다른 대화에 join되지 않도록 격리 cwd(임시 디렉토리)에서 실행.
// **잔재 청소**: agy는 spawn마다 9곳(tmpdir, last_conversations.json, conversations/.pb,
// brain/, implicit/, log/, config/projects/, history/, settings.json trustedWorkspaces)에
// 흔적을 남김. 호스트가 isolatedCwd를 받아 spawn 종료 시점에 청소해야 함.
export function buildAgyRefineSpawn(
  prompt: string,
  platform: NodeJS.Platform = process.platform,
): CliRefineSpawnArgs {
  const onLine: CliRefineSpawnArgs['onLine'] = (line, accumulate) => {
    // agy print 모드는 plain text — accumulator는 줄바꿈으로 연결.
    accumulate(line);
  };
  const spawnArgs = ['-p', prompt, '--dangerously-skip-permissions'];
  if (platform === 'darwin') {
    // darwin은 격리 HOME 박스(ensureRefineHome)가 격리를 담당 — agy는 세션 데이터를
    // cwd가 아닌 격리 HOME에 기록하므로 per-run 디렉토리·9종 청소가 불필요.
    // cwd는 공유 os 임시 루트로 두고 isolatedCwd는 미설정(finally 청소 자동 스킵).
    return { args: spawnArgs, cwd: tmpdir(), onLine };
  }
  const isolatedCwd = join(tmpdir(), `agentbridge-refine-${Date.now()}-${process.pid}`);
  mkdirSync(isolatedCwd, { recursive: true });
  return {
    args: spawnArgs,
    cwd: isolatedCwd,
    isolatedCwd,
    onLine,
  };
}

export function buildRefineSpawnRequest(
  cli: CliKind,
  prompt: string,
  opts?: { cwd?: string; platform?: NodeJS.Platform },
): CliRefineSpawnArgs {
  switch (cli) {
    case 'claude':
      return buildClaudeRefineSpawn(prompt, opts?.cwd);
    case 'codex':
      return buildCodexRefineSpawn(prompt, opts?.cwd);
    case 'agy':
      // platform은 agy의 darwin isolatedCwd 게이트만 좌우 — claude/codex에선 무시됨.
      return buildAgyRefineSpawn(prompt, opts?.platform);
  }
}
