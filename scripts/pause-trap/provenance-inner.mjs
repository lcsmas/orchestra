// Runs INSIDE `unshare --user --map-root-user --pid --fork --mount-proc` (see recycle-rig.mjs): LEAD ruling D11 with REAL pids.
// The killer may kill an ORPHAN (left the CLI's tree) only when `CLAUDE_PID` names THIS member CLI's IDENTITY (pid + /proc start-time).
//   (a) another member's orphan (CLAUDE_PID = another CLI's pid) survives;
//   (b) a process whose CLAUDE_PID names a RECYCLED pid — the pid is now this CLI's, but the process belongs to the previous incarnation — survives;
//   (c) a process that started BEFORE the member CLI survives (same scenario, seen from the start-time rule).
// Controls: the recycle is real (this CLI got the pid the stale orphan's marker names, asserted from /proc) and the member's OWN daemonized orphan IS killed
// (so "survives" is not a rig that kills nothing).
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

const cfg = JSON.parse(process.env.PT_CONFIG ?? '{}');
const { REPO, mutant = null } = cfg;
if (mutant) register(pathToFileURL(`${REPO}/scripts/pause-trap/mutants.mjs`).href, { parentURL: import.meta.url, data: { mutant } });
const { killToolTrees, realKillDeps } = await import(`${REPO}/src/main/pause-kill.ts`);
const real = realKillDeps();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (id, ok, detail = '') => checks.push({ id, ok: !!ok, detail: String(detail).slice(0, 500) });
const P = 5000; // the pid the member CLI will be forced to get (and that the stale orphan's marker names)
const procs = () => real.readTable();
const find = (n) => procs().filter((p) => p.comm === 'sleep' && p.argv[1] === String(n) && p.state !== 'Z');
const alive = (n) => find(n).length > 0;
const envOf = (pid) => { try { return fs.readFileSync(`/proc/${pid}/environ`, 'latin1').split('\0').find((x) => x.startsWith('CLAUDE_PID=')) ?? null; } catch { return null; } };

// Stand-in CLI: spawns (on command) a tool shell and a DAEMONIZED orphan (its shell exits at once), both with CLAUDE_PID=<its own pid>.
const STANDIN = `
const { spawn } = require('child_process');
const env = { ...process.env, CLAUDE_PID: String(process.pid) };
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { if (d.includes('go')) {
  spawn('/bin/bash', ['-c', 'sleep %TOOL%; true'], { detached: true, stdio: 'ignore', env }).unref();
  spawn('/bin/bash', ['-c', 'sleep %DAEMON% >/dev/null 2>&1 & exit 0'], { detached: true, stdio: 'ignore', env }).unref();
  console.log(JSON.stringify({ spawned: true })); } });
setInterval(() => {}, 1000); console.log(JSON.stringify({ ready: process.pid }));
`;
function standin(tool, daemon, tag) {
  const c = spawn(process.execPath, ['-e', STANDIN.replace('%TOOL%', tool).replace('%DAEMON%', daemon), tag], { stdio: ['pipe', 'pipe', 'inherit'] });
  const replies = [];
  let buf = '';
  c.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { try { replies.push(JSON.parse(buf.slice(0, i))); } catch { /* */ } buf = buf.slice(i + 1); } });
  return { c, replies };
}
const result = { provenance_rig: true, mutant };
const cleanup = [];
try {
  // (b)/(c): the STALE orphan — started before any of the CLIs below, marker naming pid P, its own session, parent = this process
  const stale = spawn('/bin/sleep', ['7811'], { detached: true, stdio: 'ignore', env: { ...process.env, CLAUDE_PID: String(P) } });
  stale.unref();
  cleanup.push(stale);
  await sleep(300);
  // THIS member's CLI: forced to pid P by the kernel (ns_last_pid) — a REAL recycled pid
  let me = null;
  for (let attempt = 0; attempt < 12 && (!me || me.c.pid !== P); attempt++) {
    if (me) { try { me.c.kill('SIGKILL'); } catch { /* */ } await sleep(100); }
    fs.writeFileSync('/proc/sys/kernel/ns_last_pid', String(P - 1));
    me = standin(7812, 7813, 'provenance-member-cli');
  }
  cleanup.push(me.c);
  while (!me.replies.some((r) => r.ready)) await sleep(20);
  me.c.stdin.write('go\n');
  await sleep(700);
  // (a): ANOTHER member — started AFTER this member's CLI, so the start-time rule alone cannot spare it: only the CLAUDE_PID identity match can.
  const other = standin(7821, 7822, 'provenance-other-cli');
  cleanup.push(other.c);
  while (!other.replies.some((r) => r.ready)) await sleep(20);
  other.c.stdin.write('go\n');
  await sleep(700);
  const cliId = real.read(P);
  const staleProc = find(7811)[0];
  check('recycle_is_real_control', me.c.pid === P && cliId !== 'gone' && cliId !== 'unreadable' && !!staleProc && staleProc.startTicks < cliId.startTicks && envOf(staleProc.pid) === `CLAUDE_PID=${P}`,
    `member CLI pid=${me.c.pid} (want ${P}); the stale orphan (pid ${staleProc?.pid}, start ${staleProc?.startTicks}) carries ${envOf(staleProc?.pid)} and started before the CLI (start ${cliId.startTicks})`);
  check('member_has_tool_and_orphan_control', alive(7812) && alive(7813) && alive(7821) && alive(7822), `tool 7812=${alive(7812)} daemon 7813=${alive(7813)} other tool 7821=${alive(7821)} other daemon 7822=${alive(7822)}`);
  const rep = await killToolTrees({ pid: P, startTicks: cliId.startTicks }, process.pid, real, { termGraceMs: 500 });
  await sleep(300);
  check('own_orphan_killed_control', !alive(7813) && !alive(7812), `the member's own daemonized orphan (7813) and tool (7812) are dead: ${JSON.stringify(rep.killed.map((k) => `${k.cmd}:${k.via}`))}`);
  const d = rep.killed.find((k) => k.cmd === 'sleep 7813');
  check('killed_orphan_is_listed_with_cwd_and_reason', !!d && d.via === 'env' && typeof d.cwd === 'string' && /CLAUDE_PID=5000 names this member's CLI \(pid 5000, start-time \d+\)/.test(d.evidence), JSON.stringify(d ?? null));
  check('other_member_orphan_survives', alive(7822) && alive(7821), `another member's daemon (CLAUDE_PID names ITS CLI) alive=${alive(7822)}, its tool alive=${alive(7821)}`);
  check('stale_orphan_before_cli_survives', alive(7811), `the process whose CLAUDE_PID names the RECYCLED pid ${P} but started before this CLI is alive=${alive(7811)}`);
  check('cli_alive', real.read(P) !== 'gone', 'the member CLI stand-in is alive');
} catch (e) {
  check('rig_ran_to_completion', false, String(e?.stack ?? e).slice(0, 400));
}
result.checks = checks;
result.ok = checks.length > 0 && checks.every((c) => c.ok);
for (const n of [7811, 7812, 7813, 7821, 7822]) for (const p of find(n)) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* */ } }
for (const c of cleanup) { try { c.kill('SIGKILL'); } catch { /* */ } }
console.log(JSON.stringify(result));
process.exit(0);
