// 6-5 라이브 증명: 이미지를 프로젝트로 복사하고 그 경로만 메시지에 주면 에이전트가 실제로 읽나.
//   (호스트 attachmentStore 복사 부분은 VS Code API라 헤드리스 불가 → 동일 결과를 손으로 재현:
//    cwd 아래 .agentbridge/attachments/<sid>/ 에 빨간 PNG를 두고 상대경로를 메시지로 전달.)
//   (core build 후) node packages/core/sdk-slice/attach-test.mjs
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import zlib from 'zlib';
import { claudeAdapter } from '../dist/sdkAdapter/claudeAdapter.js';

// 단색 RGB PNG 생성 (crc32 + zlib).
function makeSolidPng(w, h, r, g, b) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type, 'ascii'); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit, truecolor RGB
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) { let o = y * (1 + w * 3); raw[o++] = 0; for (let x = 0; x < w; x++) { raw[o++] = r; raw[o++] = g; raw[o++] = b; } }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const root = await fs.mkdtemp(join(tmpdir(), 'sdk-attach-'));
const sid = 'sess-test';
const relDir = join('.agentbridge', 'attachments', sid);
await fs.mkdir(join(root, relDir), { recursive: true });
const relPath = join(relDir, '1700000000000-red.png');
await fs.writeFile(join(root, relPath), makeSolidPng(48, 48, 220, 30, 30)); // 빨강
console.log('이미지 복사 위치:', relPath);

const session = await claudeAdapter.start({ cwd: root, workspaceId: 'attach-ws', detail: 'compact' });

// 패널 sendMsg가 만드는 것과 동일한 형태: 질문 + 빈 줄 + 경로.
const sent = 'What is the single dominant color of the attached image? Reply with just one color word.\n\n' + relPath;
let finalText = '', readPath = false;
for await (const e of session.send(sent)) {
  if (e.t === 'tool' && e.name === 'Read') { const inp = JSON.stringify(e.input || ''); if (inp.includes('red.png')) readPath = true; process.stdout.write('[Read]'); }
  else if (e.t === 'text' && e.final === true) finalText += e.text;
  else if (e.t === 'approval') session.respondApproval(e.id, true);
}
await session.end();

const said = finalText.trim();
console.log('\n에이전트 응답 =', JSON.stringify(said.slice(0, 80)));
const colorOK = /red/i.test(said);
console.log('이미지 Read 도구 사용 =', readPath, '| 색(red) 정답 =', colorOK);

const ok = readPath && colorOK;
console.log('\nPHASE-6-5', ok ? 'PASS ✓ (복사 경로 주입 → 에이전트가 이미지 읽음)' : 'FAIL ✗');
await fs.rm(root, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
