// Runs INSIDE `unshare --user --map-root-user --pid --fork --mount-proc` (see recycle-rig.mjs): a REAL pid recycle.
// The killer plans a tool shell R under a stand-in CLI; right after its table read (the plan→signal window) R is killed and
// the kernel is told (`ns_last_pid`) to hand R's pid to the NEXT process — a non-tool sidecar the stand-in CLI spawns. The
// killer then verifies + signals with its stale plan: the innocent that inherited the pid must NOT die (D4 identity re-read).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { isTagged, requireOwnPidNs } from './pidns-guard.mjs';

const cfg = JSON.parse(process.env.PT_CONFIG ?? '{}');
const { REPO, mutant = null } = cfg;
const TAG = requireOwnPidNs(cfg, 'recycle_rig'); // D8: own pid namespace only; spawns carry the tag
if (mutant) register(pathToFileURL(`${REPO}/scripts/pause-trap/mutants.mjs`).href, { parentURL: import.meta.url, data: { mutant } });
const { killToolTrees, realKillDeps } = await import(`${REPO}/src/main/pause-kill.ts`);
const real = realKillDeps();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (id, ok, detail = '') => checks.push({ id, ok: !!ok, detail: String(detail).slice(0, 400) });

const STANDIN = `
const { spawn } = require('child_process');
const env = { ...process.env, CLAUDE_PID: String(process.pid) };
const kids = {};
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const cmd = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
  if (cmd === 'spawn-tool') { const c = spawn('/bin/bash', ['-c', 'sleep 7801; true'], { detached: true, stdio: 'ignore', env }); console.log(JSON.stringify({ tool: c.pid })); }
  if (cmd === 'spawn-sidecar') { const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', 'recycle-innocent-sidecar'], { stdio: 'ignore' }); console.log(JSON.stringify({ sidecar: c.pid })); }
} });
setInterval(() => {}, 1000); console.log(JSON.stringify({ ready: process.pid }));
`;
const standin = spawn(process.execPath, ['-e', STANDIN, 'recycle-standin-cli'], { stdio: ['pipe', 'pipe', 'inherit'] });
const replies = [];
let buf = '';
standin.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { try { replies.push(JSON.parse(buf.slice(0, i))); } catch { /* */ } buf = buf.slice(i + 1); } });
const ask = async (cmd, key) => { const n = replies.length; standin.stdin.write(`${cmd}\n`); for (let i = 0; i < 100; i++) { const r = replies.slice(n).find((x) => key in x); if (r) return r[key]; await sleep(50); } throw new Error(`no reply to ${cmd}`); };
const result = { recycle_rig: true, mutant };
try {
  while (!replies.some((r) => r.ready)) await sleep(20);
  const cliPid = replies.find((r) => r.ready).ready;
  const R = await ask('spawn-tool', 'tool');
  await sleep(400);
  const cliId = real.read(cliPid);
  if (cliId === 'gone' || cliId === 'unreadable') throw new Error('stand-in CLI unreadable');
  let recycled = null;
  let sidecarPid = null;
  const block = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); // the killer is mid-call: nothing else may run here
  const untilGone = (pid) => { const end = Date.now() + 3000; while (Date.now() < end && real.read(pid) !== 'gone') block(10); return real.read(pid) === 'gone'; };
  const wrapped = {
    ...real,
    readTable: () => {
      const t = real.readTable();
      if (recycled === null) {
        recycled = 'armed';
        // kill the planned tool (its child first, so bash reaps it), wait until R's pid is REALLY free (a zombie still holds it)
        for (const c of t.filter((x) => x.ppid === R)) { try { process.kill(c.pid, 'SIGKILL'); } catch { /* gone */ } untilGone(c.pid); }
        try { process.kill(R, 'SIGKILL'); } catch { /* gone */ }
        untilGone(R);
        // hand R's pid to the NEXT process the kernel creates: a non-tool sidecar the stand-in CLI spawns (retry: threads also consume pids)
        for (let attempt = 0; attempt < 12 && sidecarPid !== R; attempt++) {
          if (sidecarPid !== null) { try { process.kill(sidecarPid, 'SIGKILL'); } catch { /* */ } untilGone(sidecarPid); sidecarPid = null; }
          fs.writeFileSync('/proc/sys/kernel/ns_last_pid', String(R - 1));
          standin.stdin.write('spawn-sidecar\n');
          const end = Date.now() + 3000;
          while (Date.now() < end && sidecarPid === null) {
            block(20);
            sidecarPid = real.readTable().find((x) => x.ppid === cliPid && x.argv?.at(-1) === 'recycle-innocent-sidecar')?.pid ?? null;
          }
        }
      }
      return t; // the STALE table the killer plans from: R is still in it
    },
  };
  const before = real.readTable().filter((x) => x.ppid === cliPid).length;
  const rep = await killToolTrees({ pid: cliPid, startTicks: cliId.startTicks }, process.pid, wrapped, { termGraceMs: 500, maxRounds: 1 });
  const side = sidecarPid === null ? 'gone' : real.read(sidecarPid);
  const sideAlive = side !== 'gone' && side !== 'unreadable' && side.state !== 'Z';
  check('recycle_is_real_control', sidecarPid === R, `planned tool pid ${R}; the innocent sidecar the CLI spawned next got pid ${sidecarPid} (children of the CLI before: ${before})`);
  check('innocent_inheritor_survives', sideAlive, sideAlive ? `sidecar ${sidecarPid} alive; refused=${JSON.stringify(rep.refused.map((x) => `${x.pid}:${x.reason}`))}` : `sidecar ${sidecarPid} was KILLED (signals: killed=${JSON.stringify(rep.killed.map((k) => k.pid))})`);
  check('cli_alive', real.read(cliPid) !== 'gone', 'stand-in CLI alive');
} catch (e) {
  check('rig_ran_to_completion', false, String(e?.stack ?? e).slice(0, 400));
}
result.checks = checks;
result.ok = checks.length > 0 && checks.every((c) => c.ok);
for (const n of ['recycle-innocent-sidecar', 'recycle-standin-cli']) for (const p of real.readTable()) if (p.argv?.at(-1) === n && isTagged(p.pid, TAG)) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* */ } }
console.log(JSON.stringify(result));
process.exit(0);
