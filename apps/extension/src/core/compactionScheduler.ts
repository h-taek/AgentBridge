// Facade — 코어 CompactionScheduler 인스턴스에 위임. 기존 모듈 시그니처(workspaceId 기반)와의
// 호환을 위해 workspaceStore.getWorkspacePath로 workspaceRoot resolve.

import type { EventEmitter } from 'events';
import type { ManualCompactionResult } from '@agentbridge/core';
import type { CliKind } from '../shared/types';
import * as workspaceStore from './workspaceStore';
import { getCompactionScheduler } from './coreInstances';

// compactionEvents — 코어 스케줄러 인스턴스의 events EventEmitter를 lazy proxy.
export const compactionEvents: EventEmitter = new Proxy({} as EventEmitter, {
  get(_target, prop) {
    const target = getCompactionScheduler().events;
    const v = (target as unknown as Record<PropertyKey, unknown>)[prop];
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
  },
});

export function markCompactionInFlight(workspaceId: string): boolean {
  return getCompactionScheduler().markInFlight(workspaceId);
}

export function unmarkCompactionInFlight(workspaceId: string): void {
  return getCompactionScheduler().unmarkInFlight(workspaceId);
}

export async function acquireDiskLock(workspaceId: string): Promise<boolean> {
  return getCompactionScheduler().acquireDiskLock(workspaceId);
}

export async function releaseDiskLock(workspaceId: string): Promise<void> {
  return getCompactionScheduler().releaseDiskLock(workspaceId);
}

export async function checkAndRunCompaction(
  workspaceId: string,
  activeModel: CliKind,
  workspacePath: string,
): Promise<void> {
  return getCompactionScheduler().checkAndRun({
    workspaceId,
    workspaceRoot: workspaceStore.getWorkspacePath(workspaceId),
    workspacePath,
    activeModel,
  });
}

// 수동 정제("Refine now") — core runManual에 위임. 락/refine/IR write/2-phase archive를
// 코어가 일괄 처리하므로 호스트별 중복 파이프라인이 사라진다 (V-13).
export async function runManualCompaction(
  workspaceId: string,
  activeModel: CliKind,
  workspacePath: string,
  timeoutMs?: number,
): Promise<ManualCompactionResult> {
  return getCompactionScheduler().runManual({
    workspaceId,
    workspaceRoot: workspaceStore.getWorkspacePath(workspaceId),
    workspacePath,
    activeModel,
    timeoutMs,
  });
}
