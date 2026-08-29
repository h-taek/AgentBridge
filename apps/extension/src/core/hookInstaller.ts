import { getHookInstaller } from './coreInstances';

// 코어 설치기를 그대로 노출한다. 0.5.0부터 설치 자리는 사용자 전역이라 호스트가 조립해 넘길
// 경로가 없다.
export async function installClaudeHooks(): Promise<string> {
  return getHookInstaller().installClaudeHooks();
}

export async function installCodexHooks(): Promise<{ hooksJsonPath: string; configTomlPath: string }> {
  return getHookInstaller().installCodexHooks();
}

export async function installAgyHooks(): Promise<{ hooksJsonPath: string }> {
  return getHookInstaller().installAgyHooks();
}

export async function cleanupLegacyHooks(cwd: string): Promise<string[]> {
  return getHookInstaller().cleanupLegacyHooks(cwd);
}
