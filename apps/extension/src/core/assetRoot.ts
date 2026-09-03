// 확장 루트와 에셋 루트가 한 겹 어긋나는 자리 (0.6.0 패키징 재배치).
//
// 매니페스트는 저장소 루트에 있고(마켓에 올라가는 자리와 같다), 에셋은 `apps/extension` 아래에
// 그대로 있다 — out·media·resources·l10n. VSIX도 그 구조를 그대로 담으므로 개발본과 설치본이
// 같은 모양이다. 그래서 VS Code가 주는 확장 루트에 한 겹을 더해야 우리 파일에 닿는다.
//
// 그 한 겹을 더하는 자리는 여기 하나뿐이어야 한다. 흩어지면 새 리소스를 붙일 때마다 같은
// 버그가 다시 난다 — 로드가 조용히 실패하고 아이콘만 안 보이거나 활성화가 통째로 죽는다.

import * as vscode from 'vscode';
import { join } from 'path';

const ASSET_SEGMENTS = ['apps', 'extension'] as const;

export function assetRootUri(extensionUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, ...ASSET_SEGMENTS);
}

export function assetRootPath(extensionPath: string): string {
  return join(extensionPath, ...ASSET_SEGMENTS);
}
