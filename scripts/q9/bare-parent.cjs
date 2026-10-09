// Q9 (research): a BARE Node parent at oom_score_adj 0 inside a capped scope, with NO keeper code. It runs the same one-at-a-time chain of hog tools as the keeper arm
// (each tool = bash that raises itself to adj 1000 then execs a python hog that exceeds the cap), optionally with KEEPER-LIKE ACTIVITY (a tick that reads the cgroup and
// /proc and allocates, like the kill watch does while the scope is hot). argv: <tools> <gapMs> <hogMb> <activity: none|tick:<ms>|spin:<ms>> <sentinels>
// stdout: one JSON line per tool + a final {done:true}. If this process is OOM-killed there is no final line (the driver reads that as «parent lost»).
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const [tools, gapMs, hogMb, activity = 'none', sentinels = '0'] = process.argv.slice(2);
const N = Number(tools), GAP = Number(gapMs), MB = Number(hogMb);
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const cg = '/sys/fs/cgroup' + read('/proc/self/cgroup').trim().split('\n').find((l) => l.startsWith('0::')).slice(3);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let keep = [];
function tick() {
  // what the kill watch does while hot: cgroup files + a /proc scan of the members + garbage
  read(cg + '/memory.current'); read(cg + '/memory.events'); read(cg + '/memory.stat');
  for (const pid of read(cg + '/cgroup.procs').split('\n').filter(Boolean).slice(0, 64)) { read(`/proc/${pid}/stat`); read(`/proc/${pid}/statm`); read(`/proc/${pid}/cmdline`); read(`/proc/${pid}/oom_score_adj`); }
  keep.push(Buffer.alloc(256 * 1024, 1)); if (keep.length > 8) keep = keep.slice(-4); // heap/arena churn
}
if (activity.startsWith('tick:')) setInterval(tick, Number(activity.slice(5)));
// REACTION to a kill, like the keeper's watch (inotify on memory.events -> look): onkill:tick = read+allocate only; onkill:fork = the same plus a fork/exec of /bin/true (like the journalctl lookup)
if (activity.startsWith('onkill:')) {
  const doFork = activity === 'onkill:fork';
  let lastKills = -1;
  const react = () => {
    const k = Number((read(cg + '/memory.events').match(/oom_kill (\d+)/) || [])[1]);
    if (k === lastKills) return; lastKills = k;
    tick();
    if (doFork) spawn('/bin/true', [], { stdio: 'ignore' });
  };
  react();
  try { fs.watch(cg + '/memory.events', react).unref?.(); } catch { setInterval(react, 2); }
}
if (activity.startsWith('spin:')) { const ms = Number(activity.slice(5)); const loop = () => { tick(); setImmediate(() => setTimeout(loop, ms)); }; loop(); }
for (let i = 0; i < Number(sentinels); i++) spawn('/bin/bash', ['-c', 'echo 1000 > /proc/self/oom_score_adj; exec setsid sleep 3600'], { stdio: 'ignore', detached: true }).unref();
const hog = `import sys; b = bytearray(b"\\xa5") * (${MB} * 1024 * 1024)`;
let i = 0;
function next() {
  if (i >= N) { out({ done: true, tools: i }); setTimeout(() => process.exit(0), 200); return; }
  const t0 = Date.now();
  const c = spawn('/bin/bash', ['-c', `echo 1000 > /proc/self/oom_score_adj; exec python3 -c '${hog}'`], { stdio: 'ignore' });
  c.on('close', (code, signal) => { out({ tool: i, code, signal, ms: Date.now() - t0 }); i += 1; setTimeout(next, GAP); });
}
setTimeout(next, 500);
