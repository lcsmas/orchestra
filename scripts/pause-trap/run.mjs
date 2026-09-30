#!/usr/bin/env node
// Pause-trap rig driver (#252 D1b, ledger #261 G3/G2):  node scripts/pause-trap/run.mjs [--arm <name>|all] [--json] [--keep]
//
// REAL path, zero tokens: the real detached keeper → the real `claude` CLI → real Bash-tool processes, against a
// scripted local fake Anthropic API, inside net+pid namespaces (nothing leaves loopback, every descendant dies with the
// run), scratch HOME / CLAUDE_CONFIG_DIR / ORCHESTRA_HOME (scratch-guard refuses anything live). The pause is written by
// the REAL built CLI (`orchestra run pause --hard`); the host trap is the REAL pause-trap code wired like index.ts.
// Arms (each must be fully green):
//   blocking          pause during ONE long blocking command (sleep)
//   foreground        pause during a tool call that is a process TREE (bash → sleep & sleep)
//   background        pause during a background task + a job that outlived its shell + a blocking command
//   app-restart       the app DIES mid-turn; the pause lands with the app DOWN; the restarted app finishes the trap
//   app-restart-bg    same, with a background task + a daemonized job (only the boot drain's KILL can stop them)
//   pauser-exempt     the OPS pauses ITS OWN run: its live session + running tool are left alone (snapshotted + recorded), w1 is trapped
//   turn-while-paused a background task is killed, the CLI starts a turn BY ITSELF (task notification) → interrupted + noted
// Must-FAIL mutants (load-time edits of the shipped source; the named check must go red):
//   kill-cli · kill-keeper · snapshot-touches-index · skip-kill · skip-snapshot · no-turn-observer · no-pauser-exemption
// Exit: 0 every arm as expected · 1 an arm broke expectation · 3 VOID (containment/tooling unavailable: nothing measured).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { detectContainment, findOnPath } from '../session-budget/harness.mjs';
import { liveDirs, assertScratch } from '../session-budget/scratch-guard.mjs';
import { MUTANTS } from './mutants.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const JSON_OUT = args.includes('--json');
const KEEP = args.includes('--keep') || process.env.PT_KEEP === '1';
const WANT = opt('arm', 'all');

const NORMAL = ['blocking', 'foreground', 'background', 'app-restart', 'app-restart-bg', 'turn-while-paused', 'pauser-exempt'];
const MUTANT_ARMS = [
  { name: 'mutant:kill-cli', arm: 'blocking', mutant: 'kill-cli' },
  { name: 'mutant:kill-keeper', arm: 'blocking', mutant: 'kill-keeper' },
  { name: 'mutant:snapshot-touches-index', arm: 'blocking', mutant: 'snapshot-touches-index' },
  { name: 'mutant:skip-kill', arm: 'background', mutant: 'skip-kill' },
  { name: 'mutant:skip-snapshot', arm: 'blocking', mutant: 'skip-snapshot' },
  { name: 'mutant:no-turn-observer', arm: 'turn-while-paused', mutant: 'no-turn-observer' },
  { name: 'mutant:no-pauser-exemption', arm: 'pauser-exempt', mutant: 'no-pauser-exemption' },
];
const all = [...NORMAL, 'probe-interrupt', 'probe-dbg'].map((a) => ({ name: a, arm: a, mutant: null }));
all.push(...MUTANT_ARMS);
const selected = WANT === 'all' ? all.filter((x) => !x.arm.startsWith('probe-')) : all.filter((x) => x.name === WANT || x.name === `mutant:${WANT}`);
if (selected.length === 0) { console.error(`unknown arm: ${WANT} (have: ${all.map((x) => x.name).join(', ')})`); process.exit(2); }

const say = (s = '') => { if (!JSON_OUT) console.log(s); };

// Host guards: a loaded / low-memory host makes the timing arms meaningless — refuse, say why.
const load = Number(fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);
const memAvailGB = Number(/MemAvailable:\s+(\d+) kB/.exec(fs.readFileSync('/proc/meminfo', 'utf8'))[1]) / 1048576;
if (process.env.PT_IGNORE_LOAD !== '1' && (load > 20 || memAvailGB < 6)) {
  console.log(`PAUSE-TRAP: VOID — host too loaded for a timing rig (load ${load.toFixed(1)} > 20 or MemAvailable ${memAvailGB.toFixed(1)} GB < 6); nothing was measured`);
  process.exit(3);
}

// Rebuild what the run EXECS (a stale bundle reproduces perfectly in isolation).
for (const script of ['build:cli', 'build:keeper']) {
  const r = spawnSync('pnpm', ['run', script], { cwd: REPO, encoding: 'utf8' });
  if (r.status !== 0) { console.log(`PAUSE-TRAP: VOID — ${script} failed: ${(r.stdout + r.stderr).slice(-300)}`); process.exit(3); }
}
const containment = detectContainment();
if (containment.name !== 'netns+pidns') {
  console.log(`PAUSE-TRAP: VOID — containment is '${containment.name}', not 'netns+pidns' (bwrap --unshare-net --unshare-pid unusable): egress/process containment is part of the measurement, nothing was measured`);
  process.exit(3);
}
const claude = findOnPath('claude');
if (!claude) { console.log('PAUSE-TRAP: VOID — no `claude` CLI on PATH'); process.exit(3); }
const cliVersion = spawnSync(claude, ['--version'], { encoding: 'utf8' }).stdout.trim();
say(`pause-trap rig: claude ${cliVersion} · containment ${containment.name} · load ${load.toFixed(1)} · MemAvailable ${memAvailGB.toFixed(1)} GB`);

const base = path.join(os.homedir(), '.cache', 'pause-trap');
const live = liveDirs(process.env);
let bad = 0;
for (const sel of selected) {
  const root = path.join(base, `${sel.name.replace(/[^a-z0-9-]/gi, '_')}-${process.pid}-${Date.now().toString(36).slice(-4)}`);
  fs.mkdirSync(root, { recursive: true });
  assertScratch('root', root, base, live);
  const apiPort = 31000 + Math.floor(Math.random() * 15000);
  const cfg = { REPO, root, arm: sel.arm, mutant: sel.mutant, live, apiPort };
  const env = { PATH: [path.dirname(claude), path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'), HOME: path.join(root, 'home'), LANG: 'C.UTF-8', TERM: 'dumb', PT_CONFIG: JSON.stringify(cfg) };
  fs.mkdirSync(path.join(root, 'home'), { recursive: true });
  const argv = [...containment.prefix, process.execPath, '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--experimental-strip-types', '--import', path.join(REPO, 'scripts', '.r2-register.mjs'), path.join(REPO, 'scripts', 'pause-trap', 'driver.mjs')];
  const t0 = Date.now();
  const child = spawn(argv[0], argv.slice(1), { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let out = '', err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const rc = await new Promise((resolve) => {
    const t = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } resolve('TIMEOUT'); }, 420_000);
    child.on('close', (code, sig) => { clearTimeout(t); resolve(code ?? sig); });
  });
  const line = out.split('\n').reverse().find((l) => l.startsWith('{"pause_trap"'));
  let res;
  try { res = line ? JSON.parse(line) : null; } catch { res = null; }
  const secs = Math.round((Date.now() - t0) / 1000);
  if (!res) {
    bad++;
    console.log(`== ${sel.name}: RUN BROKE (rc=${rc}, ${secs}s) — no result line. stderr tail: ${err.trim().slice(-400).replace(/\s+/g, ' ')} | stdout tail: ${out.trim().slice(-300).replace(/\s+/g, ' ')}\n   scratch kept at ${root}`);
    continue;
  }
  let asExpected, why;
  const red = res.checks.filter((c) => !c.ok);
  if (sel.mutant) {
    const want = MUTANTS[sel.mutant].mustRedden;
    const named = res.checks.find((c) => c.id === want);
    const ran = !res.checks.some((c) => c.id === 'rig_ran_to_completion' && !c.ok);
    asExpected = !!named && !named.ok && ran;
    why = asExpected ? `mutant caught: check '${want}' went RED (${named.detail})${red.length > 1 ? ` · also red: ${red.filter((c) => c.id !== want).map((c) => c.id).join(', ')}` : ''}` : !ran ? `the rig itself broke under the mutant: ${red.map((c) => `${c.id}: ${c.detail}`).join(' | ')}` : `MUTANT SURVIVED — check '${want}' stayed ${named ? 'green' : 'absent'}`;
  } else {
    asExpected = res.ok;
    why = res.ok ? `${res.checks.length} checks green` : `RED: ${red.map((c) => `${c.id} (${c.detail})`).join(' | ')}`;
  }
  if (!asExpected) bad++;
  if (JSON_OUT) { console.log(JSON.stringify({ arm: sel.name, asExpected, why, secs, res })); }
  else {
    console.log(`== ${sel.name} (${sel.mutant ? 'must-FAIL' : 'must-PASS'}) ${secs}s: ${asExpected ? 'AS EXPECTED' : 'UNEXPECTED'} — ${why}`);
    for (const c of res.checks) console.log(`   ${c.ok ? 'ok ' : 'RED'} ${c.id}${c.detail ? ` — ${c.detail.slice(0, 220)}` : ''}`);
    if (res.strays?.length) console.log(`   strays in the namespace: ${res.strays.join(' ; ')}`);
  }
  if (!KEEP && asExpected) fs.rmSync(root, { recursive: true, force: true });
  else console.log(`   scratch kept at ${root}`);
}
console.log(`PAUSE-TRAP: ${bad === 0 ? (WANT === 'all' ? 'PASS' : 'PARTIAL') : 'FAIL'}`);
process.exit(bad === 0 ? 0 : 1);
