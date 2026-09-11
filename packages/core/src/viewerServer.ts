// HTML 뷰어 — 127.0.0.1 정적 서버 (0.7.0 spec 3.1·3.5).
//
// 워크스페이스 폴더를 서빙 루트로 삼아 로컬 파일을 내보낸다.
// 보안과 격리를 위해 다음 규칙을 강제한다:
//   - 127.0.0.1에만 바인딩하고 포트는 커널이 준다.
//   - Host 헤더가 127.0.0.1:<port>가 아니면 403으로 거절한다 (DNS 리바인딩 방어).
//   - 서빙 루트 밖으로 나가는 경로, 점으로 시작하는 세그먼트, node_modules는 거절한다 (403).
//   - 심볼릭 링크로 루트 밖이나 숨김 폴더를 가리키는 것도 realpath로 잡아 거절한다 (403).
//   - HTML 파일에는 줄 번호 도장을 박고 문서 끝에 짚기 스크립트를 끼운다.
//   - 내보낸 파일의 절대 경로를 기억해 감시기(viewerWatch)에 넘긴다.

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { stampLines } from './viewerStamp';

export interface ViewerServerOptions {
  root: string; // 서빙 루트. 워크스페이스 폴더
  webviewOrigin: string; // 짚기 스크립트에 박아 줄 출처
  pickerPath: string; // 짚기 스크립트 산출물의 절대 경로. 호스트가 넘긴다
}

export interface ViewerServer {
  readonly port: number;
  readonly origin: string; // http://127.0.0.1:<port>
  servedFiles(): string[]; // 지금까지 내보낸 절대 경로
  close(): Promise<void>;
}

// 확장자별 MIME 타입 표. 텍스트 계열에는 charset=utf-8을 붙인다.
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

// 요청 URL 경로를 서빙 루트 기준의 절대 경로로 푼다.
// 루트 밖으로 나가거나 점으로 시작하는 숨김 세그먼트, node_modules는 null을 돌려준다.
export function resolveServePath(root: string, urlPath: string): string | null {
  const clean = urlPath.split(/[?#]/)[0];
  let decoded: string;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  const relPath = decoded.replace(/^\/+/, '');
  const norm = path.posix.normalize(relPath);

  // 루트 밖으로 나가는 경로 거절
  if (norm === '..' || norm.startsWith('../')) {
    return null;
  }

  // 숨김 파일 세그먼트와 node_modules 거절
  const segments = norm.split('/');
  for (const seg of segments) {
    if (seg === '.' || seg === '') continue;
    if (seg.startsWith('.') || seg === 'node_modules') {
      return null;
    }
  }

  const rootResolved = path.resolve(root);
  const target = path.resolve(rootResolved, norm);
  const rel = path.relative(rootResolved, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }

  return target;
}

// 뷰어 서버를 기동하고 127.0.0.1에서 사용 가능한 포트에 바인딩한다.
export async function startViewerServer(opts: ViewerServerOptions): Promise<ViewerServer> {
  const served = new Set<string>();
  let assignedPort = 0;

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      res.end('Method Not Allowed');
      return;
    }

    // 1. Host 헤더 검사 — DNS 리바인딩 방지
    if (req.headers.host !== `127.0.0.1:${assignedPort}`) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    const urlPath = req.url ?? '/';
    const cleanPath = urlPath.split(/[?#]/)[0];

    // 2. 짚기 스크립트 산출물 서빙 — 내보낸 파일 목록에는 넣지 않는다
    if (cleanPath === '/__agentbridge/picker.js') {
      try {
        const data = await fs.promises.readFile(opts.pickerPath);
        res.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Content-Length': data.byteLength,
        });
        if (req.method === 'HEAD') {
          res.end();
        } else {
          res.end(data);
        }
        return;
      } catch {
        res.statusCode = 404;
        res.end('Not Found');
        return;
      }
    }

    // 3. 경로 검사
    const filePath = resolveServePath(opts.root, urlPath);
    if (!filePath) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    // 4. realpath 검사 — 심볼릭 링크 탈출 방지
    let realRoot: string;
    try {
      realRoot = await fs.promises.realpath(opts.root);
    } catch {
      realRoot = path.resolve(opts.root);
    }

    let realTarget: string;
    try {
      realTarget = await fs.promises.realpath(filePath);
    } catch {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    const relFromRoot = path.relative(realRoot, realTarget);
    if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    const realSegments = relFromRoot.split(/[/\\]/);
    for (const seg of realSegments) {
      if (!seg || seg === '.') continue;
      if (seg.startsWith('.') || seg === 'node_modules') {
        res.statusCode = 403;
        res.end('Forbidden');
        return;
      }
    }

    // 5. 디렉터리면 404
    try {
      const stat = await fs.promises.stat(realTarget);
      if (stat.isDirectory()) {
        res.statusCode = 404;
        res.end('Not Found');
        return;
      }
    } catch {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    // 6. 확장자별 MIME 타입
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';

    // 7. HTML이면 stampLines 태우고 짚기 스크립트 주입
    if (ext === '.html') {
      try {
        const content = await fs.promises.readFile(realTarget, 'utf8');
        const stamped = stampLines(content);
        const scriptTag = `<script src="/__agentbridge/picker.js" data-ab-origin="${opts.webviewOrigin}"></script>`;
        const body = stamped.endsWith('\n') ? `${stamped}${scriptTag}\n` : `${stamped}\n${scriptTag}`;
        const buf = Buffer.from(body, 'utf8');

        served.add(filePath);

        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': buf.byteLength,
        });
        if (req.method === 'HEAD') {
          res.end();
        } else {
          res.end(buf);
        }
        return;
      } catch {
        res.statusCode = 500;
        res.end('Internal Server Error');
        return;
      }
    }

    // 일반 정적 파일 서빙
    try {
      const data = await fs.promises.readFile(realTarget);
      served.add(filePath);

      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': data.byteLength,
      });
      if (req.method === 'HEAD') {
        res.end();
      } else {
        res.end(data);
      }
    } catch {
      res.statusCode = 500;
      res.end('Internal Server Error');
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  assignedPort = addr.port;
  const origin = `http://127.0.0.1:${assignedPort}`;

  return {
    get port() {
      return assignedPort;
    },
    get origin() {
      return origin;
    },
    servedFiles() {
      return Array.from(served);
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}
