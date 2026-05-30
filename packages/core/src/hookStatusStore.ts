// hook 비활성 사유를 in-memory로 워크스페이스 × 모델 단위로 보관.
// 사용자 UI는 'changed' 이벤트를 구독해 현재 사유 목록을 갱신.

import { EventEmitter } from 'events';
import type { CliKind } from './shared/cli';

type Key = string;

export interface HookStatusStore {
  readonly events: EventEmitter;
  setDisabled(workspaceId: string, model: CliKind, reason: string): void;
  clearDisabled(workspaceId: string, model: CliKind): void;
  getDisabledReasons(workspaceId: string): Array<{ model: CliKind; reason: string }>;
}

export function createHookStatusStore(): HookStatusStore {
  const reasons = new Map<Key, string>();
  const events = new EventEmitter();

  function makeKey(workspaceId: string, model: CliKind): Key {
    return `${workspaceId}::${model}`;
  }

  return {
    events,
    setDisabled(workspaceId, model, reason) {
      const key = makeKey(workspaceId, model);
      const prev = reasons.get(key);
      reasons.set(key, reason);
      if (prev !== reason) events.emit('changed', workspaceId);
    },
    clearDisabled(workspaceId, model) {
      const key = makeKey(workspaceId, model);
      if (!reasons.has(key)) return;
      reasons.delete(key);
      events.emit('changed', workspaceId);
    },
    getDisabledReasons(workspaceId) {
      const out: Array<{ model: CliKind; reason: string }> = [];
      for (const [key, reason] of reasons) {
        const [wid, model] = key.split('::');
        if (wid === workspaceId) out.push({ model: model as CliKind, reason });
      }
      return out;
    },
  };
}
