// agentbridge-memory.js를 esbuild로 번들 — core 검색(globalSearch/globalInject/globalStore)을
// 헬퍼에 인라인(§G3, 옵션 나). core/bin 원본을 엔트리로, 의존 .ts를 트리쉐이크 번들 →
// self-contained CJS 한 파일. 두 앱 빌드(sync-helper)와 통합테스트가 공유 = 단일 번들 로직.
//
// 헬퍼 옆엔 node_modules가 없어 런타임 require('@agentbridge/core') 불가하므로, 빌드 때 인라인이 필수.
// node 빌트인(fs/path)은 platform:'node'로 external 유지. 엔트리의 shebang은 esbuild가 보존한다.
import { build } from 'esbuild';
import { chmodSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const HELPER_ENTRY = join(root, 'packages/core/bin/agentbridge-memory.js');

export async function bundleHelper(outFile) {
  await build({
    entryPoints: [HELPER_ENTRY],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    legalComments: 'none',
    logLevel: 'silent',
  });
  chmodSync(outFile, 0o755); // hook host가 직접 실행 — 실행권한 유지
}
