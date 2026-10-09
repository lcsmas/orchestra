// Stand-in for the `claude` CLI under the REAL keeper (memory-cap rig only, #320). The real CLI is ~330 MB RSS — it cannot live in a ≤300 MB rig scope
// (ledger D2) — so this models exactly what the cap interacts with: a CLI-sized process that holds RSS, and TOOL commands it spawns THE WAY THE REAL CLI DOES
// (measured on CLI 2.1.291: `$SHELL -c "<CLAUDE_CODE_SHELL_PREFIX> '<command string>'"`, the prefix gets the whole command as ONE argument).
//   stdin  {"tool":"<shell cmd>","id":"t1"}  → run it, then emit {type:"user",tool_result:{id,code,signal,stdout}}
//          {"report":1}                      → emit this process's own facts
//   stdout stream-json-ish lines; EOF on stdin → {type:"result"} and a clean exit (what the keeper's graceful stop expects).
const { spawn } = require('node:child_process');
const fs = require('node:fs');

const rssMb = Number(process.env.STANDIN_CLI_RSS_MB || 0);
const hold = rssMb > 0 ? Buffer.alloc(rssMb * 1024 * 1024, 0xa5) : null; // Buffer.alloc(…, fill) touches every page
const read = (p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; } };
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function facts() {
  return { pid: process.pid, adj: Number(read('/proc/self/oom_score_adj')), cgroup: read('/proc/self/cgroup'), shellPrefix: process.env.CLAUDE_CODE_SHELL_PREFIX ?? null, innerPrefix: process.env.ORCHESTRA_INNER_SHELL_PREFIX ?? null, heldMb: hold ? hold.length / 1048576 : 0 };
}
out({ type: 'system', subtype: 'init', ...facts() });

let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.report) out({ type: 'assistant', report: facts() });
    if (m.tool) {
      const prefix = process.env.CLAUDE_CODE_SHELL_PREFIX;
      const shell = process.env.SHELL || '/bin/bash';
      const full = prefix ? `${prefix} ${shq(m.tool)}` : m.tool;
      out({ type: 'assistant', toolStart: m.id });
      const c = spawn(shell, ['-c', full], { stdio: ['ignore', 'pipe', 'pipe'] });
      let so = '';
      c.stdout.on('data', (b) => (so += b));
      c.stderr.on('data', (b) => (so += b));
      c.on('close', (code, signal) => {
        // #332: a CLI PROCESSES the tool result the instant it arrives (it allocates and touches memory) — an adj-0 allocator right after a kill, inside the window where the killed tool's pages are still charged
        const mb = Number(process.env.STANDIN_CLI_RESULT_ALLOC_MB || 0);
        if (mb > 0) { const junk = Buffer.alloc(mb * 1024 * 1024, 0xa5); setTimeout(() => { junk.fill(0); }, 40); }
        out({ type: 'user', tool_result: { id: m.id, code, signal, stdout: so.slice(-4000) } }); out({ type: 'result', subtype: 'success' });
      });
    }
  }
});
process.stdin.on('end', () => { out({ type: 'result', subtype: 'eof' }); process.exit(0); });
setInterval(() => {}, 1000);
