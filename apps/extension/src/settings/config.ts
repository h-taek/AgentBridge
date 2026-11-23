import * as vscode from 'vscode';
import type { CliKind } from '../shared/types';

type RefinePolicy = 'priority' | 'fixed' | 'active' | 'off';
type AssistantDetail = 'full' | 'compact' | 'minimal';

export interface AgentBridgeConfig {
  refinePolicy: RefinePolicy;
  refinePriorityOrder: CliKind[];
  refineFixedCli: CliKind;
  assistantDetail: AssistantDetail;
  maxArchiveSnapshots: number;
}

const SECTION = 'agentbridge';

function read(): AgentBridgeConfig {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  return {
    refinePolicy: cfg.get<RefinePolicy>('refine.policy', 'active'),
    refinePriorityOrder: cfg.get<CliKind[]>('refine.priorityOrder', ['agy', 'codex', 'claude']),
    refineFixedCli: cfg.get<CliKind>('refine.fixedCli', 'agy'),
    assistantDetail: cfg.get<AssistantDetail>('turns.assistantDetail', 'compact'),
    maxArchiveSnapshots: Math.max(5, cfg.get<number>('memory.maxArchiveSnapshots', 15)),
  };
}

let cached: AgentBridgeConfig = read();

export function getConfig(): AgentBridgeConfig {
  return cached;
}

// 띄우는 순간마다 읽으므로 캐시하지 않는다 (0.10.0 spec/01 §2).
export function readLaunchArgs(kind: CliKind): string[] {
  const raw = vscode.workspace.getConfiguration(SECTION).get<unknown>(`launchArgs.${kind}`);
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string');
}

export function registerConfigWatcher(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SECTION)) {
        cached = read();
      }
    }),
  );
}
