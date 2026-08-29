// CLI 어댑터 — claude/codex/agy 각 CLI의 spawn 옵션을 빌드한다.
// hook 설치 + envProbe + hookStatusStore 인스턴스를 의존성으로 받는 팩토리.

import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import type { SpawnOptions } from '../pty/types';
import type { EnvProbe, ProbeResult } from '../envProbe';
import type { HookInstaller } from '../hookInstaller';
import type { HookStatusStore } from '../hookStatusStore';
import type { Logger } from '../interfaces';
import { noopLogger } from '../interfaces';
import { resolveResumeArgs } from './agyResume';
import { resolveHookCaptureFile } from './hookSessionCapture';
import { resolveTurnSignalFile } from './turnSignal';

// 첨부는 저장소 루트의 attachments/에 평평하게 쌓인다 (0.5.0 B-1).
// 워크스페이스 폴더가 <루트>/workspaces/<id>이므로 두 단계 올라가면 루트다.
function attachmentsDir(workspaceDirPath: string): string {
  return join(dirname(dirname(workspaceDirPath)), 'attachments');
}

export type CliAdapterOptions = {
  envProbe: EnvProbe;
  // 옵셔널 — 미제공 시 buildSpawnOptions가 hook 설치 단계 skip. 데스크탑처럼 자체 hook 시스템을
  // 가진 호스트는 hookInstaller 안 주입하고 spawn 후 별도로 hooks 설치 가능.
  hookInstaller?: HookInstaller;
  hookStatusStore?: HookStatusStore;
  // <storageRoot>/workspaces/<workspaceId> — 그 워크스페이스의 데이터 폴더.
  // 훅이 신원으로 쓰는 AGENTBRIDGE_WS_DIR이자 캡처 파일이 떨어지는 자리다.
  workspaceDir: (workspaceId: string) => string;
  logger?: Logger;
};

export interface CliAdapterSet {
  claude: {
    isAvailable(): ProbeResult;
    buildSpawnOptions(cwd: string, workspaceId: string, resumeSessionId?: string): Promise<SpawnOptions>;
  };
  codex: {
    isAvailable(): ProbeResult;
    buildSpawnOptions(
      cwd: string,
      workspaceId: string,
      resumeSessionId?: string,
      resumeModelSessionId?: string,
    ): Promise<SpawnOptions>;
  };
  agy: {
    isAvailable(): ProbeResult;
    buildSpawnOptions(
      cwd: string,
      workspaceId: string,
      resumeSessionId?: string,
      resumeModelSessionId?: string,
    ): Promise<SpawnOptions>;
  };
}

export function createCliAdapters(opts: CliAdapterOptions): CliAdapterSet {
  const log = opts.logger ?? noopLogger;
  const { envProbe, hookInstaller, hookStatusStore, workspaceDir } = opts;

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

      async buildSpawnOptions(cwd, workspaceId, resumeSessionId) {
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
            hookStatusStore?.clearDisabled(workspaceId, 'claude');
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(`claudeAdapter: hook install failed — ${msg}`);
            hookStatusStore?.setDisabled(workspaceId, 'claude', msg);
          }
        }

        // 우리 폴더는 작업 폴더 밖이라 claude가 읽기 전에 승인을 요구한다. 워크스페이스 데이터와
        // 첨부는 서로 다른 자리에 있어(첨부는 저장소 루트의 attachments/) 둘 다 열어야 한다.
        // 세션 인자라 우리가 띄운 세션에만 걸린다. 에이전트용 CLI 명령 허용(--allowedTools)은
        // 그 CLI가 생기는 3단계(B-5)에서 같은 자리에 붙는다.
        const accessArgs = ['--add-dir', wsDir, '--add-dir', attachmentsDir(workspaceDir(workspaceId))];
        const sessionArgs = !resumeSessionId
          ? ['--session-id', sessionId]
          : (await claudeSessionFileExists(sessionId))
            ? ['--resume', sessionId]
            : (log.log(
                `claudeAdapter: resume 불가 (jsonl 없음) — 새 세션으로 fallback (sessionId=${sessionId.slice(0, 8)})`,
              ),
              ['--session-id', sessionId]);
        const args = [...sessionArgs, ...accessArgs];

        return {
          command,
          args,
          cwd,
          env,
          terminalName: 'Claude',
          model: 'claude',
          workspaceId,
          sessionId,
          turnSignalFilePath: resolveTurnSignalFile(wsDir, sessionId),
        };
      },
    },

    codex: {
      isAvailable: () => envProbe.probe('codex'),

      async buildSpawnOptions(cwd, workspaceId, resumeSessionId, resumeModelSessionId) {
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
            hookStatusStore?.clearDisabled(workspaceId, 'codex');
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(`codexAdapter: hook install failed — ${msg}`);
            hookStatusStore?.setDisabled(workspaceId, 'codex', msg);
          }
        }

        let args: string[];
        let modelSessionId: string | undefined = resumeModelSessionId;

        if (!resumeSessionId) {
          args = [];
        } else if (resumeModelSessionId) {
          args = ['resume', resumeModelSessionId];
        } else {
          log.warn(
            `codexAdapter: resume 요청이지만 thread_id 없음 — 새 세션으로 fallback (sessionId=${sessionId.slice(0, 8)})`,
          );
          args = [];
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
          hookCaptureFilePath,
          turnSignalFilePath,
        };
      },
    },

    agy: {
      isAvailable: () => envProbe.probe('agy'),

      async buildSpawnOptions(cwd, workspaceId, resumeSessionId, resumeModelSessionId) {
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
            hookStatusStore?.clearDisabled(workspaceId, 'agy');
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(`agyAdapter: hook install failed — ${msg}`);
            hookStatusStore?.setDisabled(workspaceId, 'agy', msg);
          }
        }

        const cwdArgs = cwd ? ['--add-dir', cwd] : [];

        let args: string[];
        let modelSessionId: string | undefined = resumeModelSessionId;

        if (!resumeSessionId) {
          args = [...cwdArgs, '--dangerously-skip-permissions'];
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
          hookCaptureFilePath,
          turnSignalFilePath,
        };
      },
    },
  };
}
