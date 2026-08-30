// VS Code 익스텐션 번들 — src/extension.ts와 그 의존(@agentbridge/core 포함)을 단일
// out/extension.js로 묶는다. tsc만으로는 `require("@agentbridge/core")`가 출력에 남아
// VSIX 설치 시 모듈을 못 찾는다(core가 pnpm workspace 심링크라 VSIX에 안 들어감).
//
// 외부(external): vscode(런타임 제공), node-pty(네이티브 모듈 — 번들 불가, 동봉).
//
// pnpm + vsce 패키징 문제: node_modules의 의존이 전부 심링크라
//   - `vsce package`(기본)는 npm ls로 트리를 풀다 깨지고
//   - `--no-dependencies`는 node_modules를 통째로 건너뛴다.
// 그래서 번들 못 하는 런타임 에셋(xterm webview 파일, node-pty 네이티브)을 빌드 시
// 실제(심링크 아님) 디렉토리로 vendoring하고 `vsce package --no-dependencies`로 싼다.
//   - xterm → media/vendor/xterm/<pkg>/...  (webview가 asWebviewUri로 로드)
//   - node-pty → node_modules/node-pty (lib + darwin prebuild만, 실디렉토리로 복사)
//
// 타입 체크는 esbuild가 안 함 — `npm run typecheck`(tsc --noEmit)로 분리.

import * as esbuild from 'esbuild';
import { rmSync, cpSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode', 'node-pty'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

// xterm webview 에셋 — out/vendor/@xterm/<pkg>/{css,lib}. webview가 asWebviewUri로 로드하므로
// 번들 불가, 파일로 동봉해야 한다. chatPanel의 로드 경로도 여기를 가리킨다.
function vendorXterm() {
  const want = [
    ['@xterm/xterm', ['css', 'lib', 'package.json']],
    ['@xterm/addon-fit', ['lib', 'package.json']],
    ['@xterm/addon-webgl', ['lib', 'package.json']],
    ['@xterm/addon-unicode11', ['lib', 'package.json']],
  ];
  for (const [pkg, subs] of want) {
    for (const sub of subs) {
      cpSync(join('node_modules', pkg, sub), join('out/vendor', pkg, sub), {
        recursive: true,
        dereference: true,
        filter: (s) => !s.endsWith('.map'),
      });
    }
  }
}

// node-pty(네이티브) — out/node_modules/node-pty로 동봉. require("node-pty")가 out/extension.js
// 기준 node 해석에서 가장 먼저 보는 위치라 코드 변경 없이 해결된다. lib + darwin-arm64
// prebuild만 (Apple Silicon 전용, *.pdb 제외). pnpm 심링크라 dereference 복사.
function vendorNodePty() {
  const root = 'node_modules/node-pty';
  const dest = 'out/node_modules/node-pty';
  for (const sub of ['lib', 'package.json']) {
    cpSync(join(root, sub), join(dest, sub), {
      recursive: true,
      dereference: true,
      filter: (s) => !s.endsWith('.pdb'),
    });
  }
  for (const arch of ['darwin-arm64']) {
    cpSync(join(root, 'prebuilds', arch), join(dest, 'prebuilds', arch), {
      recursive: true,
      dereference: true,
    });
  }
}

// 브랜드 에셋 — @agentbridge/assets(단일 원본)를 media/로 vendoring. xterm/node-pty와 같은 패턴.
//   - logos → media/logos/*.svg              (chatPanel 탭 아이콘·로딩 화면이 로드)
//   - brand → media/icon{,-light,-dark}.svg  (package.json 아이콘·로딩 화면 마크)
//   - dots → media/dots/*.svg                (colors.json 색을 박아 생성 — 트리뷰 상태 점)
// media/icon.png(마켓 래스터)만 커밋된 정적 파일이라 여기서 안 만진다.
function vendorAssets() {
  const A = join('..', '..', 'packages', 'assets');
  cpSync(join(A, 'logos'), 'media/logos', { recursive: true, dereference: true });
  cpSync(join(A, 'brand', 'agentbridge.svg'), 'media/icon.svg', { dereference: true });
  cpSync(join(A, 'brand', 'agentbridge-light.svg'), 'media/icon-light.svg', { dereference: true });
  cpSync(join(A, 'brand', 'agentbridge-dark.svg'), 'media/icon-dark.svg', { dereference: true });

  // dot — colors.json 색을 박아 모델 3종 × 닫힘 2종 × 상태 4종 생성. 단일 출처=colors.json.
  // VS Code TreeItem.iconPath가 파일 Uri만 받아 인라인 색을 못 줘서 파일로 굽는다.
  // 파일명 규칙(sessionTreeModel.ts의 iconKey와 맞춘다): <model>[-closed][-<activity>].svg
  // idle은 접미사 없음(기존 파일명 유지, 상태 표시 자체가 없는 것이 노는 상태라는 스펙과 일치).
  const colors = JSON.parse(readFileSync(join(A, 'colors.json'), 'utf8'));
  rmSync('media/dots', { recursive: true, force: true });
  mkdirSync('media/dots', { recursive: true });

  // 도형은 16×16 캔버스 가운데를 기준으로 75%로 줄여 그린다(선 굵기도 같은 비율로 얇아진다).
  // 네 상태의 바깥 원 반지름이 6으로 같아서 행이 바뀌어도 아이콘 크기가 흔들리지 않는다.
  const SCALE = 0.75;
  const R = 6;
  const svg = (body, opacity) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">` +
    `<g transform="translate(8,8) scale(${SCALE}) translate(-8,-8)" opacity="${opacity}">${body}</g></svg>`;
  // 완료·모름이 공유하는 옅은 링 — 글리프를 담는 그릇이라 색을 죽인다.
  const faintRing = (color) =>
    `<circle cx="8" cy="8" r="${R}" fill="none" stroke="${color}" stroke-width="1.3" opacity="0.4"/>`;

  // idle — 채운 원.
  const dot = (color, opacity) => svg(`<circle cx="8" cy="8" r="${R}" fill="${color}"/>`, opacity);
  // running — 3/4 호가 도는 스피너. VS Code가 SMIL을 안 돌리면 정지한 호로 보인다.
  const spinner = (color, opacity) =>
    svg(
      `<g><animateTransform attributeName="transform" attributeType="XML" type="rotate"` +
        ` from="0 8 8" to="360 8 8" dur="0.9s" repeatCount="indefinite"/>` +
        `<path d="M8 ${8 - R} A${R} ${R} 0 1 1 ${8 - R} 8" fill="none" stroke="${color}"` +
        ` stroke-width="2" stroke-linecap="round"/></g>`,
      opacity,
    );
  // done — 옅은 링 안에 체크.
  const check = (color, opacity) =>
    svg(
      faintRing(color) +
        `<path d="M5.0 8.3 L6.9 10.2 L11.0 6.0" fill="none" stroke="${color}"` +
        ` stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`,
      opacity,
    );
  // unknown — 옅은 링 안에 물음표(글리프가 아니라 선으로 그린다. 폰트에 안 기댄다).
  const unknown = (color, opacity) =>
    svg(
      faintRing(color) +
        `<path d="M6.0 6.3 a2.05 2.05 0 1 1 2.0 2.05 v1.0" fill="none" stroke="${color}"` +
        ` stroke-width="1.5" stroke-linecap="round"/>` +
        `<circle cx="8" cy="11.4" r="0.85" fill="${color}"/>`,
      opacity,
    );

  const STATES = [
    ['', dot],
    ['-running', spinner],
    ['-done', check],
    ['-unknown', unknown],
  ];
  // 닫힌 세션은 상태를 안 그린다(sessionTreeModel.visibleActivity) — 기본 원 하나면 된다.
  for (const [model, color] of Object.entries(colors)) {
    for (const [stateSuffix, draw] of STATES) {
      writeFileSync(join('media', 'dots', `${model}${stateSuffix}.svg`), draw(color, 1));
    }
    writeFileSync(join('media', 'dots', `${model}-closed.svg`), dot(color, 0.4));
  }
}

// 단일 outfile 빌드는 이전 tsc 산출물(out/core, out/views 등)을 지우지 않으므로 선청소.
rmSync('out', { recursive: true, force: true });
vendorXterm();
vendorNodePty();
vendorAssets();

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('esbuild: watching…');
} else {
  await esbuild.build(options);
}
