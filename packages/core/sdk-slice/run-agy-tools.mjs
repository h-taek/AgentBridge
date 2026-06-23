// agy 빌트인 도구(하니스 실행) 라이브 증명 — 임시 cwd에서 read(list_dir) + write(승인 자동수락) 검증.
//   ANTIGRAVITY_HARNESS_PATH=<localharness> node packages/core/sdk-slice/run-agy-tools.mjs
import fs from 'fs';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { agyAdapter } from '../dist/index.js';

const envPath = new URL('../../../.env', import.meta.url);
let key = fs.readFileSync(envPath, 'utf8').trim();
if (key.includes('=')) key = key.split('=').slice(1).join('=').trim();
process.env.GEMINI_API_KEY = key.replace(/^["']|["']$/g, '');

const cwd = await fsp.mkdtemp(join(tmpdir(), 'agy-tools-'));
await fsp.writeFile(join(cwd, 'alpha.md'), '# Alpha\n');
await fsp.writeFile(join(cwd, 'beta.txt'), 'beta\n');

const session = await agyAdapter.start({ cwd, workspaceId: 'agy-tools', detail: 'compact' });

async function turn(label, text) {
  const tools = []; let approvals = 0, finalText = '';
  process.stdout.write(`\n[${label}] "${text}"\n  `);
  for await (const e of session.send(text)) {
    if (e.t === 'tool') { tools.push(`${e.name}:${e.status}`); process.stdout.write(`[${e.name}:${e.status}]`); }
    else if (e.t === 'approval') { approvals++; process.stdout.write(`[APPROVAL→approve]`); session.respondApproval(e.id, true); }
    else if (e.t === 'text' && e.final) finalText += e.text;
    else if (e.t === 'text') process.stdout.write('·');
    else if (e.t === 'turn_end') process.stdout.write(' [end]');
    else if (e.t === 'error') process.stdout.write(`[ERR:${e.message}]`);
  }
  console.log(`\n  tools=${JSON.stringify(tools)} approvals=${approvals} final="${finalText.trim().slice(0,90)}"`);
  return { tools, approvals, finalText: finalText.trim() };
}

const a = await turn('read', 'List the files in the current working directory, then tell me their names.');
const b = await turn('write', 'Create a file named hello.txt containing exactly the word WORLD in the current directory.');
await session.end();

const sawListTool = a.tools.some((t) => /listdir/i.test(t));
const namedFiles = /alpha/i.test(a.finalText) && /beta/i.test(a.finalText);
let wrote = false;
try { wrote = (await fsp.readFile(join(cwd, 'hello.txt'), 'utf8')).includes('WORLD'); } catch { /* not written */ }
const sawWriteTool = b.tools.some((t) => /create|write|edit/i.test(t));

console.log('\n=== 검증 ===');
console.log('list_dir 도구 =', sawListTool, '| 파일명 응답 =', namedFiles, '| 쓰기 도구 =', sawWriteTool, '| hello.txt=WORLD =', wrote);
const pass = (sawListTool || namedFiles) && (wrote || sawWriteTool);
console.log('\nAGY-TOOLS', pass ? 'PASS ✓' : 'FAIL ✗');
await fsp.rm(cwd, { recursive: true, force: true });
process.exit(pass ? 0 : 1);
