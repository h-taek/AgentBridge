import * as workspaceStore from './workspaceStore';
import { getHookInstaller } from './coreInstances';

export async function installClaudeHooks(workspaceId: string): Promise<string> {
  // 원본은 workspaceStore.getWorkspacePath(workspaceId)를 코어 내부에서 사용했으나
  // 코어는 workspaceClaudeDir을 외부에서 받도록 분리. 그래서 facade에서 그 경로를 만들어 전달.
  return getHookInstaller().installClaudeHooks(
    workspaceStore.getWorkspacePath(workspaceId),
    workspaceId,
  );
}

export async function installCodexHooks(
  cwd: string,
  workspaceId: string,
): Promise<{ hooksJsonPath: string; configTomlPath: string }> {
  return getHookInstaller().installCodexHooks(cwd, workspaceId);
}

export async function installAgyHooks(
  cwd: string,
  workspaceId: string,
): Promise<{ hooksJsonPath: string }> {
  return getHookInstaller().installAgyHooks(cwd, workspaceId);
}
