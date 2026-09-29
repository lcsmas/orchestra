import fs from 'node:fs';
const src = fs.readFileSync('/home/lmas/rev-a2-cand/scripts/e2e-keeper-lifecycle.mjs', 'utf8');
const headEnd = src.indexOf('// ═════════════════════════════════ arms');
let head = src.slice(0, headEnd);
// 1. replace ARMS table
const a0 = head.indexOf('const ARMS = {'); const a1 = head.indexOf('};', a0) + 2;
head = head.slice(0, a0) + `const ARMS = { churn2:{}, churn3:{}, stopped_keeper:{}, prune_timing_fast:{}, prune_timing_sigterm_ignored:{}, delete_inflight_start:{}, unlink_fallback_pidless:{}, keeper_log_survives_stop:{}, hello_preempt:{} };` + head.slice(a1);
// 2. configurable fake CLI: argv[3]=tag; env INIT_MS (delay first response), IGNORE_TERM=1, SPAWN_LOG appends pid at start
const f0 = head.indexOf('const FAKE_CLI = `'); const f1 = head.indexOf('`;', f0) + 2;
head = head.slice(0, f0) + `const FAKE_CLI = \`
const fs = require('node:fs');
const T0 = Date.now();
if (process.env.SPAWN_LOG) fs.appendFileSync(process.env.SPAWN_LOG, process.pid + ' ' + Date.now() + '\\\\n');
if (process.env.IGNORE_TERM === '1') process.on('SIGTERM', () => {}); else process.on('SIGTERM', () => process.exit(0));
const INIT_MS = Number(process.env.INIT_MS || 0);
const pending = [];
function flush() { for (const m of pending.splice(0)) process.stdout.write(JSON.stringify({ type: 'assistant', echo: m.echo, pid: process.pid }) + '\\\\n'); }
setTimeout(flush, INIT_MS);
process.stdin.on('data', (d) => {
  for (const line of d.toString('utf8').split('\\\\n')) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.echo !== undefined) { pending.push(m); if (Date.now() - T0 >= INIT_MS) flush(); }
  }
});
setInterval(() => {}, 1000);
\`;` + head.slice(f1);
// 3. spawnOpts: pass env
head = head.replace("env: { PATH: process.env.PATH }, signal", "env: { PATH: process.env.PATH, ...(globalThis.__CLI_ENV || {}), SPAWN_LOG: path.join(base, 'spawns.log') }, signal");
head = head.replace("const KEEPER_JS = path.join(REPO, 'dist-electron', 'keeper.js');", "const KEEPER_JS = process.env.KEEPER_JS_OVERRIDE || path.join(REPO, 'dist-electron', 'keeper.js');");
fs.writeFileSync('/home/lmas/rev-a2-probes/probe-head.mjs', head);
console.log('head bytes', head.length);
