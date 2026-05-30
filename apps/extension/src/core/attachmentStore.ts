// VS Code workspaceFolders[0]를 cwd로 resolve해 코어의 attachmentStore 함수를 호출.

import * as vscode from 'vscode';
import * as core from '@agentbridge/core';
import { getLogger } from './coreInstances';

function workspaceCwd(): string | null {
  const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
  return folderUri ? folderUri.fsPath : null;
}

export function attachmentPathFor(
  _workspaceId: string,
  sessionId: string,
  filename: string,
): string {
  const cwd = workspaceCwd();
  if (!cwd) throw new Error('No workspace folder');
  return core.attachmentPathFor(cwd, sessionId, filename);
}

export async function writeAttachment(absPath: string, base64: string): Promise<void> {
  const cwd = workspaceCwd();
  if (!cwd) throw new Error('No workspace folder');
  await core.writeAttachment(cwd, absPath, base64, { logger: getLogger() });
}

export async function cleanupSessionAttachments(
  _workspaceId: string,
  sessionId: string,
): Promise<void> {
  const cwd = workspaceCwd();
  if (!cwd) return;
  await core.cleanupSessionAttachments(cwd, sessionId, { logger: getLogger() });
}

export async function cleanupStaleAttachments(): Promise<void> {
  const cwd = workspaceCwd();
  if (!cwd) return;
  await core.cleanupStaleAttachments(cwd, { logger: getLogger() });
}
