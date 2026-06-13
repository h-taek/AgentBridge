import * as vscode from 'vscode';
import type { CliKind } from '../shared/types';

type RefinePolicy = 'priority' | 'fixed' | 'active' | 'off';
type AssistantDetail = 'full' | 'compact' | 'minimal';

export interface AgentBridgeConfig {
  refinePolicy: RefinePolicy;
  refinePriorityOrder: CliKind[];
  refineFixedCli: CliKind;
  refineUseClaude: boolean;
  assistantDetail: AssistantDetail;
  maxArchiveSnapshots: number;
  proposalEveryN: number;
}

const SECTION = 'agentbridge';

function read(): AgentBridgeConfig {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  return {
    refinePolicy: cfg.get<RefinePolicy>('refine.policy', 'priority'),
    refinePriorityOrder: cfg.get<CliKind[]>('refine.priorityOrder', ['agy', 'codex', 'claude']),
    refineFixedCli: cfg.get<CliKind>('refine.fixedCli', 'agy'),
    refineUseClaude: cfg.get<boolean>('refine.useClaude', true),
    assistantDetail: cfg.get<AssistantDetail>('turns.assistantDetail', 'compact'),
    maxArchiveSnapshots: Math.max(1, cfg.get<number>('memory.maxArchiveSnapshots', 15)),
    proposalEveryN: Math.max(0, Math.floor(cfg.get<number>('memory.proposalEveryN', 5))),
  };
}

let cached: AgentBridgeConfig = read();

export function getConfig(): AgentBridgeConfig {
  return cached;
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
