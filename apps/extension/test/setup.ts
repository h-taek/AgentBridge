// Route `import 'vscode'` to our stub. Mocha loads this via .mocharc.json `require`.
import Module from 'module';
import { resolve } from 'path';

const stubPath = resolve(__dirname, 'stubs/vscode.ts');

const origResolve = (Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string })._resolveFilename;
(Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string })._resolveFilename = function (
  request: string,
  ...rest: unknown[]
): string {
  if (request === 'vscode') return stubPath;
  return origResolve.call(this, request, ...rest);
};

// 테스트를 AgentBridge 세션 안에서 돌리면 그 탭의 신원 변수가 이 프로세스에 실려 있다. 테스트는
// 대부분 `{...process.env}`로 자식을 띄우므로 그대로 두면 두 가지가 깨진다 — 신원이 없는 상황을
// 가정한 테스트가 실패하고, 헬퍼가 사용자의 살아 있는 세션 폴더에 hook-error.json을 쓴다.
// 신원은 각 테스트가 명시적으로 넣는 것만 유효해야 한다.
delete process.env.AGENTBRIDGE_WS_SESSION;
delete process.env.AGENTBRIDGE_WS_DIR;
