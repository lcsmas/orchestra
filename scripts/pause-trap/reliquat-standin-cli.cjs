// Stand-in for the `claude` CLI under the REAL keeper (Reliquat rig only, #325). The real CLI is ~330 MB RSS — it cannot live in a ≤300 MB rig scope (ledger D2). It models what the
// Pause dure interacts with: a CLI-sized process that is the keeper's child, an MCP-like SIDECAR child (a direct child that is not a shell), and TOOL commands spawned THE WAY THE REAL
// CLI DOES (`$SHELL -c "<CLAUDE_CODE_SHELL_PREFIX> '<command string>'"`, measured on CLI 2.1.291), with `CLAUDE_PID=<this pid>` exported to every tool (the D4 env marker).
//   stdin  {"tool":"<shell cmd>","id":"t1"} → run it, then emit {type:"user",tool_result:{id,code,signal,stdout}}
//   stdout stream-json-ish lines; EOF on stdin → {type:"result"} and a clean exit (what the keeper's graceful stop expects).
const { spawn } = require('node:child_process');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const hold = Number(process.env.STANDIN_CLI_RSS_MB || 0) > 0 ? Buffer.alloc(Number(process.env.STANDIN_CLI_RSS_MB) * 1024 * 1024, 0xa5) : null;
let sidecar = null;
if (process.env.STANDIN_SIDECAR === '1') {
  sidecar = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e6)', 'mcp-server.js'], { stdio: 'ignore' }); // an MCP server: a direct child that is NOT a shell (the tool planner spares it)
  sidecar.unref();
}
out({ type: 'system', subtype: 'init', pid: process.pid, sidecar: sidecar ? sidecar.pid : null, heldMb: hold ? hold.length / 1048576 : 0 });
let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (!m.tool) continue;
    const prefix = process.env.CLAUDE_CODE_SHELL_PREFIX;
    const shell = process.env.SHELL || '/bin/bash';
    const full = prefix ? `${prefix} ${shq(m.tool)}` : m.tool;
    out({ type: 'assistant', toolStart: m.id });
    const c = spawn(shell, ['-c', full], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CLAUDE_PID: String(process.pid) } });
    let so = '';
    c.stdout.on('data', (b) => (so += b));
    c.stderr.on('data', (b) => (so += b));
    c.on('close', (code, signal) => out({ type: 'user', tool_result: { id: m.id, code, signal, stdout: so.slice(-4000) } }));
  }
});
process.stdin.on('end', () => { out({ type: 'result', subtype: 'eof' }); process.exit(0); });
setInterval(() => {}, 1000);
