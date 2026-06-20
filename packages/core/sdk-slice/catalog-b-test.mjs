// Output style / MCP / Agents 어댑터 검증 (claude).
import { claudeAdapter } from '../dist/sdkAdapter/claudeAdapter.js';
const s = await claudeAdapter.start({ cwd: process.cwd(), workspaceId: 'b-ws', detail: 'compact' });
const os = await s.listOutputStyles();
console.log('outputStyles:', JSON.stringify(os));
const mcp = await s.listMcpServers();
console.log('mcp:', mcp.map(m=>`${m.name}[${m.connected?'on':'off'},${m.toolCount}t]`).join(' | ') || '(없음)');
const ag = await s.listAgents();
console.log('agents:', ag.map(a=>a.name).join(', '));
await s.end();
const ok = os.available.includes('default') && os.available.length>=2 && mcp.length>=0 && ag.some(a=>/Explore/i.test(a.name));
console.log('\nCATALOG-B(Output/MCP/Agents)', ok?'PASS ✓':'FAIL ✗');
process.exit(ok?0:1);
