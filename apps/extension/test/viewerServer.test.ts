import { strict as assert } from 'assert';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { request } from 'http';
import { startViewerServer, resolveServePath } from '@agentbridge/core';

// 날 것의 요청. fetch는 경로의 ..를 보내기 전에 정규화하고 Host 헤더를 못 바꾼다.
function rawStatus(port: number, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('viewerServer.resolveServePath', () => {
  const root = '/ws';
  it('루트 안의 파일을 통과시킨다', () => {
    assert.equal(resolveServePath(root, '/docs/a.html'), '/ws/docs/a.html');
  });
  it('루트 밖으로 나가는 경로를 거절한다', () => {
    assert.equal(resolveServePath(root, '/../etc/passwd'), null);
    assert.equal(resolveServePath(root, '/docs/../../etc/passwd'), null);
    assert.equal(resolveServePath(root, '/%2e%2e/etc/passwd'), null);
  });
  it('점으로 시작하는 세그먼트와 node_modules를 거절한다', () => {
    assert.equal(resolveServePath(root, '/.git/config'), null);
    assert.equal(resolveServePath(root, '/.env'), null);
    assert.equal(resolveServePath(root, '/a/.claude/settings.json'), null);
    assert.equal(resolveServePath(root, '/node_modules/x/index.js'), null);
  });
  it('질의와 조각을 떼고 본다', () => {
    assert.equal(resolveServePath(root, '/a.html?v=1#top'), '/ws/a.html');
  });
});

describe('viewerServer', () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-viewer-'));
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'a.html'), '<html>\n<body>\n<p>x</p>\n</body>\n</html>');
  writeFileSync(join(root, 'sub', 'b.css'), 'p{color:red}');
  writeFileSync(join(root, '.env'), 'SECRET=1');
  const picker = join(root, 'picker.js');
  writeFileSync(picker, '/* picker */');

  let s: Awaited<ReturnType<typeof startViewerServer>>;
  before(async () => {
    s = await startViewerServer({ root, webviewOrigin: 'vscode-webview://abc', pickerPath: picker });
  });
  after(async () => {
    await s.close();
  });

  it('127.0.0.1에만 붙는다', () => {
    assert.match(s.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('HTML에 도장과 짚기 스크립트가 끼워져 나온다', async () => {
    const body = await (await fetch(`${s.origin}/a.html`)).text();
    assert.match(body, /<p data-ab-line="3">/);
    assert.match(
      body,
      /<script src="\/__agentbridge\/picker\.js" data-ab-origin="vscode-webview:\/\/abc"><\/script>/,
    );
    assert.equal(body.split('\n').length >= 5, true);
  });

  it('HTML이 아닌 것은 그대로 내보낸다', async () => {
    const res = await fetch(`${s.origin}/sub/b.css`);
    assert.equal(res.headers.get('content-type'), 'text/css; charset=utf-8');
    assert.equal(await res.text(), 'p{color:red}');
  });

  it('짚기 스크립트를 자기 경로로 내보낸다', async () => {
    const res = await fetch(`${s.origin}/__agentbridge/picker.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /javascript/);
  });

  it('거름망에 걸리는 것은 403이다', async () => {
    assert.equal((await fetch(`${s.origin}/.env`)).status, 403);
    // fetch는 ..를 보내기 전에 정규화한다. 경로 탈출은 날 것으로 쳐야 잰다.
    assert.equal(await rawStatus(s.port, '/../../etc/passwd'), 403);
  });

  it('없는 파일은 404다', async () => {
    assert.equal((await fetch(`${s.origin}/none.html`)).status, 404);
  });

  it('Host가 우리 주소가 아니면 거절한다', async () => {
    assert.equal(await rawStatus(s.port, '/a.html', { Host: 'evil.example' }), 403);
  });

  it('CORS 헤더를 붙이지 않는다', async () => {
    const res = await fetch(`${s.origin}/a.html`);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });

  it('내보낸 파일을 기억한다', async () => {
    await fetch(`${s.origin}/sub/b.css`);
    const served = s.servedFiles();
    assert.ok(served.includes(join(root, 'a.html')));
    assert.ok(served.includes(join(root, 'sub', 'b.css')));
    assert.equal(served.includes(picker), false); // 우리 산출물은 감시 대상이 아니다
  });

  it('닫으면 포트를 놓는다', async () => {
    const t = await startViewerServer({ root, webviewOrigin: 'vscode-webview://abc', pickerPath: picker });
    const origin = t.origin;
    await t.close();
    await assert.rejects(fetch(`${origin}/a.html`));
  });
});
