// codex app-server — skills/list · mcpServerStatus/list · config 관련 RPC 실응답 probe.
//   node packages/core/sdk-slice/codex-tools-probe.mjs
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const child = spawn('codex', ['app-server', '--stdio'], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
const rl = createInterface({ input: child.stdout });
let id = 0;
const pending = new Map();
const write = (m) => child.stdin.write(JSON.stringify(m) + '\n');
const request = (method, params) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); write({ jsonrpc: '2.0', id: i, method, params }); });
const notify = (method, params) => write({ jsonrpc: '2.0', method, params });
rl.on('line', (line) => { let m; try { m = JSON.parse(line); } catch { return; } if (m.id != null && (m.result !== undefined || m.error !== undefined) && !m.method) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error !== undefined ? p.reject(m.error) : p.resolve(m.result); } } });
child.stderr.on('data', () => {});

async function tryRpc(method, params = {}) {
  try { const r = await request(method, params); const v = JSON.stringify(r, null, 2); console.log(`\n──── ${method} ────\n  keys: ${r && typeof r === 'object' ? Object.keys(r).join(', ') : typeof r}\n  ${v.slice(0, 1500)}`); }
  catch (e) { console.log(`\n──── ${method} ────\n  ✗ ${JSON.stringify(e).slice(0, 200)}`); }
}

await request('initialize', { clientInfo: { name: 'agentbridge', title: null, version: '0' }, capabilities: null });
notify('initialized', {});
// thread 필요할 수 있어 하나 띄움
const ts = await request('thread/start', { model: null, cwd: process.cwd(), approvalPolicy: 'on-request', sandbox: 'workspace-write' }).catch(() => null);
const threadId = ts?.thread?.id;
console.log('threadId:', threadId);

await tryRpc('skills/list');
await tryRpc('mcpServerStatus/list');
await tryRpc('config/read');

child.stdin.end();
child.kill();
process.exit(0);
