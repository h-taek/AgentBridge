// 인-프로세스 CJS→ESM 동적 import 검증 — 익스텐션 호스트(CJS)가 자식 프로세스 없이
// ESM 어댑터를 직접 로드·구동할 수 있나. (.cjs라 core의 type:module 무시하고 CJS로 실행 → 호스트 모사)
//   (core build 후) node packages/core/sdk-slice/inproc-test.cjs
const { pathToFileURL } = require('node:url');
const { join } = require('node:path');

(async () => {
  // 런타임 변수 specifier — 번들러(esbuild)가 정적 분석 못 해 require로 못 바꾸고 진짜 import()로 남긴다.
  // 배럴(index.js) 아닌 어댑터 전용 경로 — 호스트가 로드하는 방식과 동일.
  const adapterUrl = pathToFileURL(join(__dirname, '..', 'dist', 'sdkAdapter', 'claudeAdapter.js')).href;
  const mod = await import(adapterUrl); // CJS에서 ESM 동적 import

  const session = await mod.claudeAdapter.start({ cwd: process.cwd(), workspaceId: 'inproc', detail: 'compact' });
  let final = '';
  for await (const ev of session.send('Reply with exactly: INPROC_OK')) {
    if (ev.t === 'text' && ev.final) final += ev.text;
  }
  await session.end();

  const ok = /INPROC_OK/.test(final);
  console.log('인-프로세스 CJS→ESM 동적 import + 구동:', ok ? 'PASS ✓' : 'FAIL ✗', JSON.stringify(final.trim()));
  process.exit(ok ? 0 : 1);
})();
