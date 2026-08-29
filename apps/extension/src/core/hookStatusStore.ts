import type { EventEmitter } from 'events';
import type { CliKind } from '../shared/types';
import type { HookIssue, HookIssueKind } from '@agentbridge/core';
import { getHookStatusStore } from './coreInstances';

// hookStatusEvents 호환 — 코어 인스턴스의 events EventEmitter를 그대로 노출.
// 인스턴스가 lazy하므로 Proxy 형태가 되면 까다로움 → getter property로 reflect.
export const hookStatusEvents: EventEmitter = new Proxy({} as EventEmitter, {
  get(_target, prop) {
    const target = getHookStatusStore().events;
    const v = (target as unknown as Record<PropertyKey, unknown>)[prop];
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
  },
});

export function setHookDisabled(
  workspaceId: string,
  model: CliKind,
  reason: string,
  kind: HookIssueKind = 'install',
): void {
  getHookStatusStore().setDisabled(workspaceId, model, reason, kind);
}

export function clearHookDisabled(
  workspaceId: string,
  model: CliKind,
  kind: HookIssueKind = 'install',
): void {
  getHookStatusStore().clearDisabled(workspaceId, model, kind);
}

export function getHookDisabledReasons(workspaceId: string): HookIssue[] {
  return getHookStatusStore().getDisabledReasons(workspaceId);
}
