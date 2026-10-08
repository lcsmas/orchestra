// Minimal stdio MCP server for the real-CLI victim-protection proof (#320): on start it records the oom_score_adj of ITSELF and of a grandchild it spawns, then answers the
// handshake just enough for the CLI to connect (initialize, tools/list → none). Output file: $ADJ_OUT (lines `MCP-ADJ=…`, `MCP-CHILD-ADJ=…`).
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const out = process.env.ADJ_OUT;
const adj = () => fs.readFileSync('/proc/self/oom_score_adj', 'utf8').trim();
if (out) {
  fs.appendFileSync(out, `MCP-ADJ=${adj()}\n`);
  spawn('sh', ['-c', 'echo MCP-CHILD-ADJ=$(cat /proc/self/oom_score_adj) >> "$ADJ_OUT"'], { stdio: 'ignore', env: process.env });
}
let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === undefined) continue; // notification
    if (m.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'adj-probe', version: '1.0.0' } } }) + '\n');
    else if (m.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [] } }) + '\n');
    else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }) + '\n');
  }
});
process.stdin.on('end', () => process.exit(0));
