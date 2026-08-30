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

// 자동제안 헤드리스 분석 주기(압축 N회마다) — 사용자엔 on/off만 노출, 내부 고정값.
// maxArchiveSnapshots 하한(5) 이하여야 커서가 prune 전에 턴을 읽는다(보존 ≥ 주기).
const PROPOSAL_EVERY_N = 5;

function read(): AgentBridgeConfig {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  return {
    refinePolicy: cfg.get<RefinePolicy>('refine.policy', 'active'),
    refinePriorityOrder: cfg.get<CliKind[]>('refine.priorityOrder', ['agy', 'codex', 'claude']),
    refineFixedCli: cfg.get<CliKind>('refine.fixedCli', 'agy'),
    refineUseClaude: cfg.get<boolean>('refine.useClaude', true),
    assistantDetail: cfg.get<AssistantDetail>('turns.assistantDetail', 'compact'),
    maxArchiveSnapshots: Math.max(5, cfg.get<number>('memory.maxArchiveSnapshots', 15)),
    proposalEveryN: cfg.get<boolean>('memory.proposalEnabled', true) ? PROPOSAL_EVERY_N : 0,
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
