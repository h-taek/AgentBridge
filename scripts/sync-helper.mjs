// core/bin 단일 소스 → 익스텐션 resources/bin로 번들 동기화 (V-16 + §G3).
//
// 원본: packages/core/bin/{agentbridge-memory,agentbridge}.js (번들 엔트리 둘)
// 산출: apps/extension/resources/bin/ — esbuild로 core 검색을 인라인한 self-contained CJS.
//   호스트가 `node <resources/bin/...>`로 별도 프로세스 spawn하므로 실제 파일이 앱에 있어야 한다.
//
// 과거엔 단순 copy였으나(§G3 이전), 이제 검색 로직을 헬퍼에 인라인해야 해 esbuild 번들로 바뀜.
// core/bin/agentbridge-memory.js 또는 core 검색 모듈만 고치면 이 스크립트가 복사본을 자동으로 맞춘다.
// 익스텐션 빌드(compile) 직전에 실행된다.
import { BINS, bundleBin } from './bundle-helper.mjs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const destDir = join(root, 'apps/extension/resources/bin');

for (const [name, bin] of Object.entries(BINS)) {
  const dest = join(destDir, bin.outName);
  await bundleBin(name, dest);
  console.log(`[sync-helper] ${bin.outName} bundled → ${dest}`);
}
