// Runner-kill rig for the keeper test leak (D2): run a keeper test file under a private TMPDIR, SIGKILL the runner's process group once <trigger> scratch dirs exist (default 11 = the D5 test of
// keeper.test.ts has started), then count what the dead runner left behind. A fake CLI whose keeper is gone (ppid not a live keeper) is a FOREVER-ORPHAN; keeper+CLI pairs must end on their own.
//
//   node scripts/keeper-test-leak-rig.mjs --selftest                   positive control (a planted orphan must be counted, then reaped): light
//   node scripts/keeper-test-leak-rig.mjs --check                      print the plan, run NOTHING
//   node scripts/keeper-test-leak-rig.mjs [--file F] [--trigger N] [--bounded-wait S] [--scratch DIR] [--prefix P]     one run: STARTS REAL KEEPERS — heavy-rig token (ledger §Roster) first
//   (keeper-memory-cap.test.ts: --file src/keeper/keeper-memory-cap.test.ts --prefix kmc-; TMPDIR and HOME are both the scratch dir)
//
// Exit 0 iff FOREVER-ORPHANS=0 AND (no --bounded-wait OR 0 carriers after it) AND SURVIVORS=0 (every leftover is killed by identity: pid + /proc start time re-read before the signal).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const opts = { file: 'src/keeper/keeper.test.ts', trigger: 11, boundedWait: 0, scratch: os.tmpdir(), prefix: 'keeper-test-', check: false, selftest: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const val = () => { const v = argv[++i]; if (v === undefined) { console.error(`${a} needs a value`); process.exit(2); } return v; };
  if (a === '--file') opts.file = val();
  else if (a === '--trigger') opts.trigger = Number(val());
  else if (a === '--bounded-wait') opts.boundedWait = Number(val());
  else if (a === '--scratch') opts.scratch = val();
  else if (a === '--prefix') opts.prefix = val();
  else if (a === '--check') opts.check = true;
  else if (a === '--selftest') opts.selftest = true;
  else { console.error(`unknown option ${a} (fail closed)`); process.exit(2); }
}
if (!Number.isInteger(opts.trigger) || opts.trigger < 1 || !(opts.boundedWait >= 0)) { console.error('bad --trigger / --bounded-wait'); process.exit(2); }
if (opts.check) { console.log(`PLAN (nothing run): ${JSON.stringify(opts)}`); process.exit(0); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rd = (p) => { try { return fs.readFileSync(p, 'latin1'); } catch { return null; } };
function stat(pid) {
  const t = rd(`/proc/${pid}/stat`);
  if (!t) return null;
  const f = t.slice(t.lastIndexOf(')') + 2).split(' ');
  return f[19] === undefined ? null : { state: f[0], ppid: Number(f[1]), ticks: f[19] };
}
/** Live processes whose argv carries `dir`. */
function census(dir) {
  const out = [];
  for (const n of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(n) || Number(n) === process.pid) continue;
    const cmd = rd(`/proc/${n}/cmdline`);
    if (!cmd || !cmd.includes(dir)) continue;
    const s = stat(n);
    if (s && s.state !== 'Z') out.push({ pid: Number(n), ppid: s.ppid, ticks: s.ticks, keeper: /keeper\.js/.test(cmd), cmd: cmd.replace(/\0/g, ' ').slice(0, 140) }); // `keeper` is read from the FULL argv (a long node path would push it past the display cut)
  }
  return out;
}
const isKeeper = (c) => c.keeper;
function orphans(list) {
  const keeperPids = new Set(list.filter(isKeeper).map((c) => c.pid));
  return list.filter((c) => !isKeeper(c) && !keeperPids.has(c.ppid));
}
function reap(list) {
  for (const c of list) if (stat(c.pid)?.ticks === c.ticks) { try { process.kill(c.pid, 'SIGKILL'); } catch { /* gone */ } }
}

async function main() {
  const scratch = fs.mkdtempSync(path.join(opts.scratch, 'keeper-leak-rig-'));
  let verdictOk = false;
  try {
    if (opts.selftest) {
      const decoy = path.join(scratch, `${opts.prefix}SELFTEST`, 'fake-cli.cjs');
      const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', decoy], { detached: true, stdio: 'ignore' });
      p.unref();
      await sleep(300);
      const found = orphans(census(scratch));
      console.log(`selftest: planted orphan counted = ${found.length} (expect 1)`);
      reap(census(scratch));
      await sleep(300);
      const left = census(scratch).length;
      console.log(`selftest: SURVIVORS=${left} (expect 0)`);
      verdictOk = found.length === 1 && left === 0;
      console.log(`RIG selftest => ${verdictOk ? 'PASS' : 'FAIL'}`);
      return;
    }
    fs.mkdirSync(path.join(scratch, '.cache')); // HOME is private too: keeper-memory-cap.test.ts makes its dirs under $HOME/.cache/kmc-* — a census of TMPDIR alone would see nothing (pre-review F5)
    const logFd = fs.openSync(path.join(scratch, 'runner.log'), 'w');
    const runner = spawn(process.execPath, ['--test', '--experimental-strip-types', opts.file], { cwd: REPO, env: { ...process.env, TMPDIR: scratch, HOME: scratch }, detached: true, stdio: ['ignore', logFd, logFd] });
    const runnerTicks = stat(runner.pid)?.ticks;
    let dirs = 0;
    for (const t0 = Date.now(); Date.now() - t0 < 90_000; await sleep(20)) {
      dirs = [scratch, path.join(scratch, '.cache')].flatMap((d) => fs.readdirSync(d)).filter((d) => d.startsWith(opts.prefix)).length;
      if (dirs >= opts.trigger || stat(runner.pid)?.ticks !== runnerTicks) break;
    }
    await sleep(400);
    const killed = stat(runner.pid)?.ticks === runnerTicks && runner.exitCode === null;
    if (killed) process.kill(-runner.pid, 'SIGKILL'); // the runner AND the file process (one group); the keepers are detached = their own groups
    console.log(`runner: scratch dirs at kill = ${dirs} (trigger ${opts.trigger}); runner was alive = ${killed}`);
    if (!killed) { console.log('RIG => FAIL (the runner finished/died before the trigger: nothing was tested)'); return; }
    await sleep(3000);
    const after = census(scratch);
    const orph = orphans(after);
    for (const o of orph) console.log(`  FOREVER-ORPHAN pid=${o.pid} ppid=${o.ppid} ${o.cmd}`);
    console.log(`FOREVER-ORPHANS=${orph.length} (carriers at +3 s: ${after.length}, of which keeper+CLI pairs: ${after.length - orph.length})`);
    let boundedOk = true;
    if (opts.boundedWait > 0) {
      let n = after.length;
      for (const t0 = Date.now(); Date.now() - t0 < opts.boundedWait * 1000 && n > 0; await sleep(1000)) n = census(scratch).length;
      boundedOk = n === 0;
      console.log(`BOUNDED: carriers after waiting up to ${opts.boundedWait} s = ${n} (expect 0)`);
    }
    reap(census(scratch));
    await sleep(400);
    const survivors = census(scratch);
    console.log(`SURVIVORS=${survivors.length}`);
    verdictOk = orph.length === 0 && boundedOk && survivors.length === 0;
    console.log(`RIG keeper-test-leak => ${verdictOk ? 'PASS' : 'FAIL'}`);
  } finally {
    reap(census(scratch)); // a crash of the rig itself must not leave anything either
    fs.rmSync(scratch, { recursive: true, force: true });
    process.exitCode = verdictOk ? 0 : 1;
  }
}
main();
