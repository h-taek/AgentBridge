// VS Code globalState 기반 QuotaStore 어댑터. UI 없이 저장만 — 미래 UI 추가 시 데이터 모델 통일.
//
// globalState는 동기 API라 read/write를 Promise로 wrapping. 키 하나에 전체 QuotaFileMap 저장.

import type * as vscode from 'vscode';
import type { QuotaFileMap, QuotaStore } from '@agentbridge/core';

const KEY = 'agentbridge.cliQuota';

export function createQuotaStore(context: vscode.ExtensionContext): QuotaStore {
  return {
    async read(): Promise<QuotaFileMap> {
      const v = context.globalState.get<QuotaFileMap>(KEY);
      return v ?? {};
    },
    async write(map: QuotaFileMap): Promise<void> {
      await context.globalState.update(KEY, map);
    },
  };
}
