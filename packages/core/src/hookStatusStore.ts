// hook 문제 사유를 in-memory로 워크스페이스 × 모델 × 종류 단위로 보관.
// 사용자 UI는 'changed' 이벤트를 구독해 현재 사유 목록을 갱신.
//
// 종류가 둘인 이유 (0.5.0 A-2): 설치는 성공했는데 실행이 값을 안 주는 상태가 따로 있다.
// 폴백을 걷어낸 뒤로 그 상태를 덮어 줄 것이 없으므로 침묵 대신 표시로 남긴다.
// 둘은 서로를 지우면 안 된다 — 설치 성공이 실행 실패 표시를 지우면 문제가 다시 감춰진다.

import { EventEmitter } from 'events';
import type { CliKind } from './shared/cli';

type Key = string;

// install: 훅 파일을 심지 못했다. runtime: 심었는데 실행이 우리가 기대한 값을 안 준다.
export type HookIssueKind = 'install' | 'runtime';

export interface HookIssue {
  model: CliKind;
  kind: HookIssueKind;
  reason: string;
}

export interface HookStatusStore {
  readonly events: EventEmitter;
  setDisabled(workspaceId: string, model: CliKind, reason: string, kind?: HookIssueKind): void;
  clearDisabled(workspaceId: string, model: CliKind, kind?: HookIssueKind): void;
  getDisabledReasons(workspaceId: string): HookIssue[];
}

export function createHookStatusStore(): HookStatusStore {
  const reasons = new Map<Key, string>();
  const events = new EventEmitter();

  function makeKey(workspaceId: string, model: CliKind, kind: HookIssueKind): Key {
    return `${workspaceId}::${model}::${kind}`;
  }

  return {
    events,
    setDisabled(workspaceId, model, reason, kind = 'install') {
      const key = makeKey(workspaceId, model, kind);
      const prev = reasons.get(key);
      reasons.set(key, reason);
      if (prev !== reason) events.emit('changed', workspaceId);
    },
    clearDisabled(workspaceId, model, kind = 'install') {
      const key = makeKey(workspaceId, model, kind);
      if (!reasons.has(key)) return;
      reasons.delete(key);
      events.emit('changed', workspaceId);
    },
    getDisabledReasons(workspaceId) {
      const out: HookIssue[] = [];
      for (const [key, reason] of reasons) {
        const [wid, model, kind] = key.split('::');
        if (wid === workspaceId) {
          out.push({ model: model as CliKind, kind: kind as HookIssueKind, reason });
        }
      }
      return out;
    },
  };
}
