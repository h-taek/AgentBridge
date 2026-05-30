// Minimal vscode module stub for unit tests. Routed via Module._resolveFilename in setup.ts.
// Only the surface area the tested modules touch is implemented — extend on demand.

class EventEmitterStub<T> {
  private listeners: Array<(e: T) => void> = [];
  event = (l: (e: T) => void): { dispose: () => void } => {
    this.listeners.push(l);
    return { dispose: () => { this.listeners = this.listeners.filter(x => x !== l); } };
  };
  fire(e: T): void {
    for (const l of this.listeners) l(e);
  }
  dispose(): void { this.listeners = []; }
}

export const EventEmitter = EventEmitterStub;

export const workspace = {
  workspaceFolders: undefined as undefined | Array<{ uri: { fsPath: string } }>,
  getConfiguration: (_section?: string) => ({
    get: (_key: string, def?: unknown) => def,
  }),
  fs: {},
};

export const window = {
  createOutputChannel: (_name: string) => ({
    appendLine: (_s: string) => { /* noop */ },
    append: (_s: string) => { /* noop */ },
    dispose: () => { /* noop */ },
    show: () => { /* noop */ },
  }),
  showInformationMessage: (..._args: unknown[]) => Promise.resolve(undefined),
  showWarningMessage: (..._args: unknown[]) => Promise.resolve(undefined),
  showErrorMessage: (..._args: unknown[]) => Promise.resolve(undefined),
};

export const Uri = {
  file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }),
  joinPath: (base: { fsPath: string }, ...segs: string[]) => ({
    fsPath: [base.fsPath, ...segs].join('/'),
    toString: () => `file://${[base.fsPath, ...segs].join('/')}`,
  }),
};

export const commands = {
  registerCommand: (_id: string, _cb: unknown) => ({ dispose: () => { /* noop */ } }),
  executeCommand: (..._args: unknown[]) => Promise.resolve(undefined),
};
