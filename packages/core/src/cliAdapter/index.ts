// CLI 어댑터 — claude/codex/agy 각 CLI의 spawn 옵션을 빌드한다.
// hook 설치 + envProbe + hookStatusStore 인스턴스를 의존성으로 받는 팩토리.

import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { SpawnOptions } from '../pty/types';
import type { EnvProbe, ProbeResult } from '../envProbe';
import type { HookInstaller } from '../hookInstaller';
import type { SkillInstaller } from '../skillInstaller';
import type { CliKind } from '../shared/cli';
import type { HookStatusStore } from '../hookStatusStore';
import type { Logger } from '../interfaces';
import { noopLogger } from '../interfaces';
import { resolveResumeArgs } from './agyResume';
import { resolveHookCaptureFile } from './hookSessionCapture';
import { resolveTurnSignalFile } from './turnSignal';
import { parseWritableRoots, buildWritableRootsArgs } from './codexSandbox';

export type CliAdapterOptions = {
  envProbe: EnvProbe;
  // 옵셔널 — 미제공 시 buildSpawnOptions가 hook 설치 단계 skip. 데스크탑처럼 자체 hook 시스템을
  // 가진 호스트는 hookInstaller 안 주입하고 spawn 후 별도로 hooks 설치 가능.
  hookInstaller?: HookInstaller;
  // 옵셔널 — 미제공 시 스킬 설치 단계를 건너뛴다. 훅과 같은 자리에서 같은 시점에 돈다(B-5).
  skillInstaller?: SkillInstaller;
  hookStatusStore?: HookStatusStore;
  // <storageRoot>/workspaces/<workspaceId> — 그 워크스페이스의 데이터 폴더.
  // 훅이 신원으로 쓰는 AGENTBRIDGE_WS_DIR이자 캡처 파일이 떨어지는 자리다.
  workspaceDir: (workspaceId: string) => string;
  // 저장소 루트. codex 샌드박스에 쓰기 허용으로 더할 폴더다(B-5). 없으면 그 인자를 붙이지 않는다.
  storageRoot?: string;
  // 모델이 우리 CLI를 부를 때 치는 문자열의 앞부분(renderRunPrefix). claude의 --allowedTools가
  // 이 값으로 규칙을 만든다. 없으면 승인 개방 인자를 붙이지 않는다.
  cliRunPrefix?: string;
  // 테스트만 오버라이드 — codex 설정을 읽을 홈.
  homeDir?: string;
  logger?: Logger;
};

// 서브에이전트를 띄울 때 함께 넘기는 값 (0.5.0 B-6·B-8).
//
// 첫 프롬프트는 기동 인자로 들어간다. 셋 다 인자로 받고 그대로 대화형에 남는 것을 실측으로
// 확인했다(research 10 §1). 띄운 뒤 화면에 타이핑해 넣는 경로를 두지 않는 이유는 그쪽이
// 하니스마다 다르고 조용히 실패하기 때문이다.
//
// resume에는 첫 프롬프트를 다시 넣지 않는다. 이어서 여는 세션은 이미 그 말을 들었다.
export type SpawnExtras = {
  initialPrompt?: string;
  // 이 세션이 서브라면 부모의 세션 id. 기록의 뿌리를 세션 폴더로 가르는 것은 호스트 몫이고
  // 여기서는 SpawnOptions에 실어 나르기만 한다.
  parentSessionId?: string;
};

export interface CliAdapterSet {
  claude: {
    isAvailable(): ProbeResult;
    buildSpawnOptions(
      cwd: string,
      workspaceId: string,
      resumeSessionId?: string,
      extras?: SpawnExtras,
    ): Promise<SpawnOptions>;
  };
  codex: {
    isAvailable(): ProbeResult;
    buildSpawnOptions(
      cwd: string,
      workspaceId: string,
      resumeSessionId?: string,
      resumeModelSessionId?: string,
      extras?: SpawnExtras,
    ): Promise<SpawnOptions>;
  };
  agy: {
    isAvailable(): ProbeResult;
    buildSpawnOptions(
      cwd: string,
      workspaceId: string,
      resumeSessionId?: string,
      resumeModelSessionId?: string,
      extras?: SpawnExtras,
    ): Promise<SpawnOptions>;
  };
}

export function createCliAdapters(opts: CliAdapterOptions): CliAdapterSet {
  const log = opts.logger ?? noopLogger;
  const { envProbe, hookInstaller, skillInstaller, hookStatusStore, workspaceDir } = opts;
  const home = opts.homeDir ?? homedir();

  // codex 설정의 쓰기 허용 폴더. 못 읽으면 빈 목록으로 본다 — 그 경우 우리 폴더만 열린다.
  async function readCodexWritableRoots(): Promise<string[]> {
    try {
      return parseWritableRoots(await fs.readFile(join(home, '.codex', 'config.toml'), 'utf8'));
    } catch {
      return [];
    }
  }

  // 스킬은 발견 가능성을 높이는 수단이지 전제가 아니다(B-5). 실패해도 명령은 그대로 돌므로
  // 훅과 달리 세션 상태를 내리지 않고 로그만 남긴다.
  async function installSkill(agent: CliKind): Promise<void> {
    if (!skillInstaller) return;
    try {
      await skillInstaller.install(agent);
    } catch (err) {
      log.warn(`skillInstaller: ${agent} 스킬 설치 실패 — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function claudeSessionFileExists(uuid: string): Promise<boolean> {
    const root = join(homedir(), '.claude', 'projects');
    let projects: string[];
    try {
      projects = await fs.readdir(root);
    } catch {
      return false;
    }
    for (const p of projects) {
      try {
        await fs.access(join(root, p, `${uuid}.jsonl`));
        return true;
      } catch {
        /* next */
      }
    }
    return false;
  }

  return {
    claude: {
      isAvailable: () => envProbe.probe('claude'),

      async buildSpawnOptions(cwd, workspaceId, resumeSessionId, extras) {
        const sessionId = resumeSessionId ?? randomUUID();
        const wsDir = workspaceDir(workspaceId);
        const env = {
          ...envProbe.getShellEnv(),
          AGENTBRIDGE_WS_SESSION: sessionId,
          AGENTBRIDGE_WS_DIR: wsDir,
        };
        const probe = envProbe.probe('claude');
        const command = probe.resolvedPath ?? 'claude';

        if (hookInstaller) {
          try {
            await hookInstaller.installClaudeHooks();
            await hookInstaller.cleanupLegacyHooks(cwd);
            await installSkill('claude');
            hookStatusStore?.clearDisabled(workspaceId, 'claude');
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(`claudeAdapter: hook install failed — ${msg}`);
            hookStatusStore?.setDisabled(workspaceId, 'claude', msg);
          }
        }

        // 우리 워크스페이스 폴더는 작업 폴더 밖이라 claude가 읽기 전에 승인을 요구한다.
        // 세션 인자라 우리가 띄운 세션에만 걸린다.
        //
        // 첨부 폴더(저장소 루트의 attachments/)는 열지 않는다. 프로젝트 공용이라 열면 이 세션이
        // 다른 프로젝트의 첨부까지 읽게 된다. 첨부는 대화형 승인 한 번으로 읽힌다.
        //
        // 우리 CLI 하나만 승인 없이 열어준다(B-5). 호출마다 승인 창이 뜨면 맥락을 모델의
        // 자발적 호출에 건 것이 성립하지 않는다. 여는 것은 이 명령 하나이고 세션에만 걸린다.
        const accessArgs = [
          '--add-dir',
          wsDir,
          ...(opts.cliRunPrefix ? ['--allowedTools', `Bash(${opts.cliRunPrefix} *)`] : []),
        ];
        const sessionArgs = !resumeSessionId
          ? ['--session-id', sessionId]
          : (await claudeSessionFileExists(sessionId))
            ? ['--resume', sessionId]
            : (log.log(
                `claudeAdapter: resume 불가 (jsonl 없음) — 새 세션으로 fallback (sessionId=${sessionId.slice(0, 8)})`,
              ),
              ['--session-id', sessionId]);
        // 첫 프롬프트 앞에는 `--`가 필요하다. `--add-dir`와 `--allowedTools`가 값을 여러 개 받는
        // 옵션이라, 구분자 없이 뒤에 붙이면 프롬프트가 그 옵션의 값으로 먹힌다(라이브에서 확인:
        // "Input must be provided ... when using --print"). resume에는 붙이지 않는다 — 이어서
        // 여는 세션은 이미 그 말을 들었다.
        const promptArgs = !resumeSessionId && extras?.initialPrompt ? ['--', extras.initialPrompt] : [];
        const args = [...sessionArgs, ...accessArgs, ...promptArgs];

        return {
          command,
          args,
          cwd,
          env,
          terminalName: 'Claude',
          model: 'claude',
          workspaceId,
          sessionId,
          parentSessionId: extras?.parentSessionId,
          turnSignalFilePath: resolveTurnSignalFile(wsDir, sessionId),
        };
      },
    },

    codex: {
      isAvailable: () => envProbe.probe('codex'),

      async buildSpawnOptions(cwd, workspaceId, resumeSessionId, resumeModelSessionId, extras) {
        const sessionId = resumeSessionId ?? randomUUID();
        const wsDir = workspaceDir(workspaceId);
        const env = {
          ...envProbe.getShellEnv(),
          AGENTBRIDGE_WS_SESSION: sessionId,
          AGENTBRIDGE_WS_DIR: wsDir,
        };
        const hookCaptureFilePath = resolveHookCaptureFile(wsDir, sessionId);
        const turnSignalFilePath = resolveTurnSignalFile(wsDir, sessionId);
        const probe = envProbe.probe('codex');
        const command = probe.resolvedPath ?? 'codex';

        if (hookInstaller) {
          try {
            await hookInstaller.installCodexHooks();
            await hookInstaller.cleanupLegacyHooks(cwd);
            await installSkill('codex');
            hookStatusStore?.clearDisabled(workspaceId, 'codex');
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(`codexAdapter: hook install failed — ${msg}`);
            hookStatusStore?.setDisabled(workspaceId, 'codex', msg);
          }
        }

        // 우리 저장소 한 폴더만 쓰기 허용으로 더한다. 샌드박스 모드는 건드리지 않는다 —
        // 사용자가 read-only로 두었으면 그 결정이 유지된다.
        const sandboxArgs = opts.storageRoot
          ? buildWritableRootsArgs(opts.storageRoot, await readCodexWritableRoots())
          : [];

        let args: string[];
        let modelSessionId: string | undefined = resumeModelSessionId;

        // 첫 프롬프트는 위치 인자다. 새 세션일 때만 붙는다.
        const promptArgs = !resumeSessionId && extras?.initialPrompt ? [extras.initialPrompt] : [];

        if (!resumeSessionId) {
          args = [...sandboxArgs, ...promptArgs];
        } else if (resumeModelSessionId) {
          args = [...sandboxArgs, 'resume', resumeModelSessionId];
        } else {
          log.warn(
            `codexAdapter: resume 요청이지만 thread_id 없음 — 새 세션으로 fallback (sessionId=${sessionId.slice(0, 8)})`,
          );
          args = [...sandboxArgs];
          modelSessionId = undefined;
        }

        return {
          command,
          args,
          cwd,
          env,
          terminalName: 'Codex',
          model: 'codex',
          workspaceId,
          sessionId,
          modelSessionId,
          parentSessionId: extras?.parentSessionId,
          hookCaptureFilePath,
          turnSignalFilePath,
        };
      },
    },

    agy: {
      isAvailable: () => envProbe.probe('agy'),

      async buildSpawnOptions(cwd, workspaceId, resumeSessionId, resumeModelSessionId, extras) {
        const sessionId = resumeSessionId ?? randomUUID();
        const wsDir = workspaceDir(workspaceId);
        const env = {
          ...envProbe.getShellEnv(),
          AGENTBRIDGE_WS_SESSION: sessionId,
          AGENTBRIDGE_WS_DIR: wsDir,
        };
        const hookCaptureFilePath = resolveHookCaptureFile(wsDir, sessionId);
        const turnSignalFilePath = resolveTurnSignalFile(wsDir, sessionId);
        const probe = envProbe.probe('agy');
        const command = probe.resolvedPath ?? 'agy';

        if (hookInstaller) {
          try {
            await hookInstaller.installAgyHooks();
            await hookInstaller.cleanupLegacyHooks(cwd);
            await installSkill('agy');
            hookStatusStore?.clearDisabled(workspaceId, 'agy');
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(`agyAdapter: hook install failed — ${msg}`);
            hookStatusStore?.setDisabled(workspaceId, 'agy', msg);
          }
        }

        const cwdArgs = cwd ? ['--add-dir', cwd] : [];
        // agy의 첫 프롬프트는 위치 인자가 아니라 -i다. --print와 달리 답한 뒤에도 대화형으로 남는다.
        const promptArgs = !resumeSessionId && extras?.initialPrompt ? ['-i', extras.initialPrompt] : [];

        let args: string[];
        let modelSessionId: string | undefined = resumeModelSessionId;

        if (!resumeSessionId) {
          args = [...cwdArgs, '--dangerously-skip-permissions', ...promptArgs];
        } else if (resumeModelSessionId) {
          try {
            const resumeArgs = await resolveResumeArgs({
              sessionId: resumeModelSessionId,
              logger: log,
            });
            args = [...cwdArgs, ...resumeArgs, '--dangerously-skip-permissions'];
          } catch (err) {
            log.warn(`agyAdapter: resume 불가 — 새 세션으로 fallback (${String(err)})`);
            args = [...cwdArgs, '--dangerously-skip-permissions'];
            modelSessionId = undefined;
          }
        } else {
          log.warn(
            `agyAdapter: resume 요청이지만 conversation UUID 없음 — 새 세션으로 fallback (sessionId=${sessionId.slice(0, 8)})`,
          );
          args = [...cwdArgs, '--dangerously-skip-permissions'];
        }

        return {
          command,
          args,
          cwd,
          env,
          terminalName: 'Antigravity',
          model: 'agy',
          workspaceId,
          sessionId,
          modelSessionId,
          parentSessionId: extras?.parentSessionId,
          hookCaptureFilePath,
          turnSignalFilePath,
        };
      },
    },
  };
}
