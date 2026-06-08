import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function getOutputChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('AgentBridge');
  }
  return channel;
}

export function log(msg: string): void {
  getOutputChannel().appendLine(`[AgentBridge] ${msg}`);
}

export function warn(msg: string): void {
  getOutputChannel().appendLine(`[AgentBridge WARN] ${msg}`);
}

export function error(msg: string): void {
  getOutputChannel().appendLine(`[AgentBridge ERROR] ${msg}`);
}
