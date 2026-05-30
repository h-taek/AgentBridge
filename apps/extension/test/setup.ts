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
