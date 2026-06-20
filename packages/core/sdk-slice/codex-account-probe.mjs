// codex app-server — 계정/사용량 RPC 실응답 probe (getAccountUsage codex 매핑 확정용).
//   node packages/core/sdk-slice/codex-account-probe.mjs
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const child = spawn('codex', ['app-server', '--stdio'], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
const rl = createInterface({ input: child.stdout });
let id = 0;
const pending = new Map();
const write = (m) => child.stdin.write(JSON.stringify(m) + '\n');
const request = (method, params) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); write({ jsonrpc: '2.0', id: i, method, params }); });
const notify = (method, params) => write({ jsonrpc: '2.0', method, params });

rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id != null && (m.result !== undefined || m.error !== undefined) && !m.method) {
    const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error !== undefined ? p.reject(m.error) : p.resolve(m.result); }
  }
});
child.stderr.on('data', () => {});

async function tryRpc(method, params = {}) {
  try { const r = await request(method, params); console.log(`\n──── ${method} ────\n  keys: ${r && typeof r === 'object' ? Object.keys(r).join(', ') : typeof r}\n  ${JSON.stringify(r, null, 2).slice(0, 1800)}`); }
  catch (e) { console.log(`\n──── ${method} ────\n  ✗ ${JSON.stringify(e).slice(0, 300)}`); }
}

await request('initialize', { clientInfo: { name: 'agentbridge', title: null, version: '0' }, capabilities: null });
notify('initialized', {});

await tryRpc('account/read');
await tryRpc('account/rateLimits/read');
await tryRpc('account/usage/read');

child.stdin.end();
child.kill();
process.exit(0);
