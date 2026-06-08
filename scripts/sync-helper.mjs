// agentbridge-memory.js 단일 소스 동기화 (V-16).
//
// 원본: packages/core/bin/agentbridge-memory.js
// 복사본: 두 앱의 resources/bin/ — 호스트가 `node <resources/bin/agentbridge-memory.js>`로
//   별도 프로세스 spawn하므로 실제 파일이 각 앱에 있어야 한다(extension은 번들 밖,
//   desktop은 electron-builder asarUnpack). 번들로 합칠 수 없는 런타임 파일.
//
// 과거엔 헬퍼 수정 시 3곳을 수동 cp + md5 대조해야 했다. 이제 core/bin만 편집하고
// 각 앱 빌드(및 이 스크립트)가 복사본을 자동으로 맞춘다. 빌드 전에 실행된다.

import { copyFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'packages/core/bin/agentbridge-memory.js');
const dests = [
  join(root, 'apps/desktop/resources/bin/agentbridge-memory.js'),
  join(root, 'apps/extension/resources/bin/agentbridge-memory.js'),
];

for (const dest of dests) {
  copyFileSync(src, dest);
}
console.log(`[sync-helper] agentbridge-memory.js → ${dests.length} app(s)`);
