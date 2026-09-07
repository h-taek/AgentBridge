// core/bin의 실행 파일들을 esbuild로 번들 — 의존 .ts를 인라인(§G3, 옵션 나). core/bin 원본을
// 엔트리로, 의존 .ts를 트리쉐이크 번들 → self-contained CJS 한 파일. 앱 빌드(sync-helper)와
// 통합테스트가 공유 = 단일 번들 로직.
//
// 대상은 둘이다(0.5.0 B-5). 훅 헬퍼는 커맨드가 동결이라 버전이 거의 안 오르고, 에이전트용
// CLI는 사이클마다 자란다. 그래서 파일도 버전 마커도 따로 둔다.
//
// 헬퍼 옆엔 node_modules가 없어 런타임 require('@agentbridge/core') 불가하므로, 빌드 때 인라인이 필수.
// node 빌트인(fs/path)은 platform:'node'로 external 유지. 엔트리의 shebang은 esbuild가 보존한다.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, chmodSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const BINS = {
  helper: {
    entry: join(root, 'packages/core/bin/agentbridge-memory.js'),
    outName: 'agentbridge-memory.js',
    versionRe: /@agentbridge-helper-version (\d+\.\d+\.\d+)/,
    marker: '@agentbridge-helper-version',
  },
  cli: {
    entry: join(root, 'packages/core/bin/agentbridge.js'),
    outName: 'agentbridge.js',
    versionRe: /@agentbridge-cli-version (\d+\.\d+\.\d+)/,
    marker: '@agentbridge-cli-version',
  },
};

export async function bundleBin(name, outFile) {
  const bin = BINS[name];
  if (!bin) throw new Error(`bundle-helper: 알 수 없는 대상 ${name} (helper|cli)`);
  await build({
    entryPoints: [bin.entry],
    outfile: outFile,
    // 번들 내 모듈 라벨 주석을 *실행 cwd와 무관하게* 루트 기준으로 고정 — dev(apps/* cwd)와
    // 릴리스/테스트(root cwd)가 동일 출력을 내, resources/bin이 매 빌드 diff로 뜨는 노이즈 제거.
    absWorkingDir: root,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    legalComments: 'none',
    logLevel: 'silent',
  });
  // esbuild가 주석을 제거하므로 버전 마커가 번들 출력에서 사라진다.
  // hookInstaller(installBinToCanonicalPath)는 이 마커를 grep해 install 버전비교를 하는데,
  // 사라지면 번들 버전이 0.0.0으로 읽혀 *기존 설치본을 영영 갱신하지 않는다*(주입 미동작 버그).
  // → 엔트리 소스를 단일 버전 출처로 삼아, 번들 출력 shebang 다음 줄에 마커를 다시 주입한다.
  const entryVer = bin.versionRe.exec(readFileSync(bin.entry, 'utf8'))?.[1];
  if (!entryVer) throw new Error(`bundle-helper: 엔트리에 ${bin.marker} 마커가 없음`);
  let out = readFileSync(outFile, 'utf8');
  if (!bin.versionRe.test(out)) {
    const marker = `// ${bin.marker} ${entryVer}\n`;
    const nl = out.startsWith('#!') ? out.indexOf('\n') + 1 : 0;
    out = out.slice(0, nl) + marker + out.slice(nl);
    writeFileSync(outFile, out);
  }
  chmodSync(outFile, 0o755); // hook host가 직접 실행 — 실행권한 유지
}

// 직접 실행 지원 — `node scripts/bundle-helper.mjs <outFile> [helper|cli]`. CJS 테스트 하네스
// (ts-node, module:commonjs)는 `await import(file://)`를 require로 다운레벨해 .mjs를 못 불러오므로,
// 테스트는 이 CLI로 spawn해 번들한다.
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const outFile = process.argv[2];
  const name = process.argv[3] || 'helper';
  if (!outFile) {
    console.error('usage: node scripts/bundle-helper.mjs <outFile> [helper|cli]');
    process.exit(2);
  }
  await bundleBin(name, outFile);
}
