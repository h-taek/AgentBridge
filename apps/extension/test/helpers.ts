// 테스트용 coreInstances 초기화 — phase 5.1 core cutover 이후 src/core/* facade들은
// initializeCore(ExtensionContext)가 선행돼야 동작한다. 테스트에서는 실제 VS Code 컨텍스트가
// 없으므로, initializeCore가 실제로 사용하는 표면(globalStorageUri / extensionPath / globalState)만
// 스텁으로 채워 호출한다. beforeEach마다 호출해도 안전 (싱글톤이 새 인스턴스로 교체됨).
import { resolve } from 'path';
import type * as vscode from 'vscode';
import { initializeCore } from '../src/core/coreInstances';

export function initCoreForTest(storagePath: string): void {
  const globalState = new Map<string, unknown>();
  const context = {
    globalStorageUri: { fsPath: storagePath },
    extensionPath: resolve(__dirname, '..'),
    globalState: {
      get: (key: string) => globalState.get(key),
      update: async (key: string, value: unknown) => {
        globalState.set(key, value);
      },
    },
  } as unknown as vscode.ExtensionContext;
  initializeCore(context);
}
