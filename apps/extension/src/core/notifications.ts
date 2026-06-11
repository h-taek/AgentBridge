import * as vscode from 'vscode';
import * as output from '../log/output';

type NotifyCategory =
  | 'cli-not-found'
  | 'hook-fire-failed'
  | 'refine-failed'
  | 'refine-off'
  | 'agy-fallback'
  | 'codex-hooks-trust'
  | 'first-run';

const sessionMuted = new Set<NotifyCategory>();
let globalStorage: vscode.Memento | undefined;

export function init(storage: vscode.Memento): void {
  globalStorage = storage;
}

function isPermanentlyMuted(cat: NotifyCategory): boolean {
  return globalStorage?.get<boolean>(`notify.muted.${cat}`, false) ?? false;
}

function mutePerma(cat: NotifyCategory): void {
  void globalStorage?.update(`notify.muted.${cat}`, true);
}

function shouldShow(cat: NotifyCategory): boolean {
  if (sessionMuted.has(cat)) return false;
  if (isPermanentlyMuted(cat)) return false;
  sessionMuted.add(cat);
  return true;
}

export function notifyCliNotFound(name: string): void {
  if (!shouldShow('cli-not-found')) return;
  vscode.window.showWarningMessage(
    vscode.l10n.t('AgentBridge: `{0}` CLI not found in PATH. Install it first.', name),
  );
}

export function notifyRefineFailed(reason: string): void {
  if (!shouldShow('refine-failed')) return;
  output.warn(`refine failed: ${reason}`);
  vscode.window.showInformationMessage(
    vscode.l10n.t('AgentBridge: Memory refinement failed — {0}. Will retry on next trigger.', reason),
  );
}

export function notifyRefineOff(): void {
  if (!shouldShow('refine-off')) return;
  output.log('refine is disabled by user setting');
}

export type RefineFallbackReason = 'unavailable' | 'quota' | 'spawn-error';

export function notifyRefineFallback(
  triedCli: string,
  usedModel: string,
  reason: RefineFallbackReason,
): void {
  if (!shouldShow('agy-fallback')) return;
  // "Antigravity CLI not installed"처럼 단정하지 않고 실제 fallback 사유를 그대로 노출.
  // 무료 토큰을 제공하는 agy 외 CLI로 떨어진 경우만 토큰 소모 가능성을 함께 안내.
  const detail = (() => {
    switch (reason) {
      case 'unavailable': return vscode.l10n.t('{0} unavailable (not installed or spawn failed)', triedCli);
      case 'quota': return vscode.l10n.t('{0} quota exhausted', triedCli);
      case 'spawn-error': return vscode.l10n.t('{0} returned an unusable response', triedCli);
    }
  })();
  const tokenNote = usedModel === 'agy' ? '' : vscode.l10n.t(' (may consume your tokens)');
  vscode.window
    .showWarningMessage(
      vscode.l10n.t('AgentBridge: Memory refinement fell back to {0}{1} — {2}.', usedModel, tokenNote, detail),
      vscode.l10n.t('Don\'t show again'),
    )
    .then((choice) => {
      if (choice === vscode.l10n.t('Don\'t show again')) mutePerma('agy-fallback');
    });
}

export function notifyCodexHooksTrust(): void {
  if (!shouldShow('codex-hooks-trust')) return;
  vscode.window
    .showInformationMessage(
      vscode.l10n.t('AgentBridge: In the Codex terminal, type `/hooks` and approve trust to enable memory injection.'),
      vscode.l10n.t('Got it'),
    )
    .then((choice) => {
      if (choice === vscode.l10n.t('Got it')) mutePerma('codex-hooks-trust');
    });
}

export function notifyFirstRun(): void {
  if (!shouldShow('first-run')) return;
  if (isPermanentlyMuted('first-run')) return;
  vscode.window
    .showInformationMessage(
      vscode.l10n.t('Welcome to AgentBridge! Open the sidebar to manage sessions and memory across AI CLIs.'),
      vscode.l10n.t('Open Sidebar'),
      vscode.l10n.t('Don\'t show again'),
    )
    .then((choice) => {
      if (choice === vscode.l10n.t('Open Sidebar')) {
        vscode.commands.executeCommand('agentbridge.sessions.focus');
      }
      if (choice === vscode.l10n.t('Don\'t show again')) mutePerma('first-run');
    });
}
