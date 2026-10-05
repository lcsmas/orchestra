#!/usr/bin/env node
// Structured-Reprise rig runner (#255, wave E ledger #276 G3, E2):  node scripts/pause-trap/reprise-run.mjs [--arm <name>[,…]|all|normal|mutants] [--json] [--keep]
//
// REAL path, zero tokens (the pause-trap rig's own stack): the real detached keeper → the real `claude` CLI → real Bash-tool processes against a scripted local
// fake Anthropic API, in net+pid namespaces, scratch HOME / CLAUDE_CONFIG_DIR / ORCHESTRA_HOME. Pause, resume, release and accusé are the REAL BUILT CLI
// (`orchestra run pause|resume|release|confirm reprise`); the host is the REAL pause-trap + reprise sweep wired like index.ts (app.mjs stand-in); the
// coordinator releases its workers and the members confirm FROM THEIR OWN SESSIONS' TOOLS (scripted by the fake API) — the identity is the real env.
// A fleet lead ⊃ ops ⊃ {w1, w2}: every cycle pauses `lead` (the whole fleet), resumes it, and checks that only the coordinators wake, the workers stay
// blocked until their OPS releases them, each gets a Consigne with the LITERAL snapshot ref / killed command / dirty tree, nothing the Pause killed is
// re-run, no uncommitted work is lost, and every member is reprise-accused.
// Arms (each must be fully green):
//   reprise                  3 cycles pause → resume → release → confirm on the same fleet (0 lost work, every member accused, each cycle)
//   reprise-restart-pause    the app DIES during the Pause (after the trap); the Reprise starts while it is DOWN (store-less verbs), the restarted app completes it
//   reprise-restart-resuming the app DIES during the Reprise (coordinators released, workers blocked); the restarted app still blocks them until released
//   reprise-repause          a Pause lands WHILE RESUMING, with the released OPS mid-command: the NEW epoch's host trap interrupts/kills it again (fresh snapshot), it is blocked again,
//                            a second Reprise completes, and the Consigne still names what the FIRST Pause killed
// Must-FAIL (the same rig, 1 cycle; the named check must go red):
//   unfixed:master           the SAME rig against a built copy of the PRE-Reprise master (PT_REPRISE_UNFIXED_SHA, default 0963ade2: plain lift, no release verb): workers are NOT blocked  → c0:workers_blocked_no_mass_wake
//   mutant:reprise-gate-ignores-release   a released coordinator is still gated        → c0:ops_coordinator_may_start
//   mutant:reprise-gate-releases-everyone every roster member reads as released        → c0:workers_blocked_no_mass_wake
// Exit: 0 every arm as expected · 1 an arm broke expectation · 3 VOID (containment/tooling unavailable: nothing measured).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { detectContainment, findOnPath } from '../session-budget/harness.mjs';
import { liveDirs, assertScratch } from '../session-budget/scratch-guard.mjs';
import { MUTANTS } from './mutants-reprise-rig.mjs';

const MY_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const JSON_OUT = args.includes('--json');
const KEEP = args.includes('--keep') || process.env.PT_KEEP === '1';
const WANT = opt('arm', 'all');

const NORMAL = [
  { name: 'reprise', arm: 'reprise', cycles: 3 },
  { name: 'reprise-restart-pause', arm: 'reprise', cycles: 1, restartAt: 'pause' },
  { name: 'reprise-restart-resuming', arm: 'reprise', cycles: 1, restartAt: 'resuming' },
  { name: 'reprise-repause', arm: 'reprise', cycles: 1, repause: true },
];
const MUTANT_ARMS = [
  { name: 'unfixed:master', arm: 'reprise', cycles: 1, mutant: null, master: true, mustRedden: 'c0:workers_blocked_no_mass_wake' },
  { name: 'mutant:reprise-gate-ignores-release', arm: 'reprise', cycles: 1, mutant: 'reprise-gate-ignores-release' },
  { name: 'mutant:reprise-gate-releases-everyone', arm: 'reprise', cycles: 1, mutant: 'reprise-gate-releases-everyone' },
];
const all = [...NORMAL, ...MUTANT_ARMS];
const wanted = new Set(WANT.split(',').map((x) => x.trim()));
const selected = WANT === 'all' ? all : WANT === 'normal' ? NORMAL : WANT === 'mutants' ? MUTANT_ARMS : all.filter((x) => wanted.has(x.name) || wanted.has(x.name.replace(/^(mutant|unfixed):/, '')));
if (selected.length === 0) { console.error(`unknown arm: ${WANT} (have: ${all.map((x) => x.name).join(', ')})`); process.exit(2); }
const say = (s = '') => { if (!JSON_OUT) console.log(s); };

// Host guards: a loaded / low-memory host makes the timing arms meaningless — refuse, say why.
const load = Number(fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);
const memAvailGB = Number(/MemAvailable:\s+(\d+) kB/.exec(fs.readFileSync('/proc/meminfo', 'utf8'))[1]) / 1048576;
if (process.env.PT_IGNORE_LOAD !== '1' && (load > 20 || memAvailGB < 6)) {
  console.log(`PAUSE-REPRISE: VOID — host too loaded for a timing rig (load ${load.toFixed(1)} > 20 or MemAvailable ${memAvailGB.toFixed(1)} GB < 6); nothing was measured`);
  process.exit(3);
}
const containment = detectContainment();
if (containment.name !== 'netns+pidns') {
  console.log(`PAUSE-REPRISE: VOID — containment is '${containment.name}', not 'netns+pidns': egress/process containment is part of the measurement, nothing was measured`);
  process.exit(3);
}
const claude = findOnPath('claude');
if (!claude) { console.log('PAUSE-REPRISE: VOID — no `claude` CLI on PATH'); process.exit(3); }
say(`pause-reprise rig: claude ${spawnSync(claude, ['--version'], { encoding: 'utf8' }).stdout.trim()} · containment ${containment.name} · load ${load.toFixed(1)} · MemAvailable ${memAvailGB.toFixed(1)} GB`);

const build = (cwd) => {
  for (const script of ['build:cli', 'build:keeper']) {
    const r = spawnSync('pnpm', ['run', script], { cwd, encoding: 'utf8' });
    if (r.status !== 0) { console.log(`PAUSE-REPRISE: VOID — ${script} failed in ${cwd}: ${(r.stdout + r.stderr).slice(-300)}`); process.exit(3); }
  }
};
// Rebuild what the run EXECS (a stale bundle reproduces perfectly in isolation).
build(MY_REPO);

const base = path.join(os.homedir(), '.cache', 'pause-trap');
fs.mkdirSync(base, { recursive: true });
const live = liveDirs(process.env);

/** A BUILT copy of the PRE-Reprise master + THIS rig's scripts overlaid: the SAME rig against the unfixed code. PINNED (default 0963ade2, the last master before structured Reprise): `origin/master` itself
 *  contains the Reprise once it merged, and a must-FAIL arm that goes green on the fixed tree is a vacuous gate. Removed at the end unless --keep. */
let masterDir = null;
function masterCopy() {
  if (masterDir) return masterDir;
  const git = (...a) => spawnSync('git', ['-C', MY_REPO, ...a], { encoding: 'utf8' });
  git('fetch', '-q', 'origin', 'master');
  const pin = process.env.PT_REPRISE_UNFIXED_SHA ?? '0963ade2';
  const sha = git('rev-parse', `${pin}^{commit}`).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) { console.log(`PAUSE-REPRISE: VOID — cannot resolve the unfixed reference ${pin}`); process.exit(3); }
  const dir = path.join(base, `master-copy-${sha.slice(0, 8)}-${process.pid}`);
  const r = git('worktree', 'add', '--detach', dir, sha);
  if (r.status !== 0) { console.log(`PAUSE-REPRISE: VOID — git worktree add failed: ${r.stderr.slice(-200)}`); process.exit(3); }
  masterDir = dir;
  fs.symlinkSync(path.join(MY_REPO, 'node_modules'), path.join(dir, 'node_modules'));
  for (const rel of ['scripts/pause-trap', 'scripts/session-budget']) fs.cpSync(path.join(MY_REPO, rel), path.join(dir, rel), { recursive: true });
  for (const f of fs.readdirSync(path.join(MY_REPO, 'scripts')).filter((x) => x.startsWith('.r2-'))) fs.copyFileSync(path.join(MY_REPO, 'scripts', f), path.join(dir, 'scripts', f));
  build(dir);
  say(`  (unfixed arm runs against a built copy of the pre-Reprise master ${sha.slice(0, 8)} at ${dir})`);
  return dir;
}

let bad = 0;
for (const sel of selected) {
  const REPO = sel.master ? masterCopy() : MY_REPO;
  const root = path.join(base, `reprise-${sel.name.replace(/[^a-z0-9-]/gi, '_')}-${process.pid}-${Date.now().toString(36).slice(-4)}`);
  fs.mkdirSync(root, { recursive: true });
  assertScratch('root', root, base, live);
  const apiPort = 31000 + Math.floor(Math.random() * 15000);
  const cfg = { REPO, root, arm: sel.arm, mutant: sel.mutant ?? null, live, apiPort, cycles: Number(opt('cycles', sel.cycles)), restartAt: sel.restartAt ?? null, repause: sel.repause ?? false,
    // the fleet app.mjs seeds: the legacy w1 (driven by `scenario`) + a second worker with ITS OWN uncommitted work
    workers: [{ id: 'w1', legacy: true }, { id: 'w2', files: { 'a.txt': 'W2-UNCOMMITTED-EDIT\n', 'untracked.txt': 'W2-UNTRACKED-WORK\n' } }] };
  const env = { PATH: [path.dirname(claude), path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'), HOME: path.join(root, 'home'), LANG: 'C.UTF-8', TERM: 'dumb', PT_CONFIG: JSON.stringify(cfg) };
  fs.mkdirSync(path.join(root, 'home'), { recursive: true });
  const argv = [...containment.prefix, process.execPath, '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--experimental-strip-types', '--import', path.join(REPO, 'scripts', '.r2-register.mjs'), path.join(REPO, 'scripts', 'pause-trap', 'reprise-driver.mjs')];
  const t0 = Date.now();
  const child = spawn(argv[0], argv.slice(1), { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let out = '', err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const rc = await new Promise((resolve) => {
    const t = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } resolve('TIMEOUT'); }, 900_000);
    child.on('close', (code, sig) => { clearTimeout(t); resolve(code ?? sig); });
  });
  const line = out.split('\n').reverse().find((l) => l.startsWith('{"pause_reprise"'));
  let res;
  try { res = line ? JSON.parse(line) : null; } catch { res = null; }
  const secs = Math.round((Date.now() - t0) / 1000);
  if (!res) {
    bad++;
    console.log(`== ${sel.name}: RUN BROKE (rc=${rc}, ${secs}s) — no result line. stderr tail: ${err.trim().slice(-400).replace(/\s+/g, ' ')} | stdout tail: ${out.trim().slice(-300).replace(/\s+/g, ' ')}\n   scratch kept at ${root}`);
    continue;
  }
  const mustFail = !!(sel.mutant || sel.master);
  const want = sel.mustRedden ?? (sel.mutant ? MUTANTS[sel.mutant].mustRedden : null);
  const red = res.checks.filter((c) => !c.ok);
  let asExpected, why;
  if (mustFail) {
    const named = res.checks.find((c) => c.id === want);
    const ran = !res.checks.some((c) => c.id === 'rig_ran_to_completion' && !c.ok) || sel.master; // on master the verbs it lacks may legitimately stop the flow: the NAMED check is what counts
    asExpected = !!named && !named.ok && ran;
    why = asExpected ? `caught: check '${want}' went RED (${named.detail})${red.length > 1 ? ` · also red: ${red.filter((c) => c.id !== want).map((c) => c.id).join(', ')}` : ''}` : !named ? `the check '${want}' never ran — nothing measured` : !ran ? `the rig itself broke: ${red.map((c) => `${c.id}: ${c.detail}`).join(' | ')}` : `SURVIVED — check '${want}' stayed green`;
  } else {
    asExpected = res.ok;
    why = res.ok ? `${res.checks.length} checks green` : `RED: ${red.map((c) => `${c.id} (${c.detail})`).join(' | ')}`;
  }
  if (!asExpected) bad++;
  if (JSON_OUT) console.log(JSON.stringify({ arm: sel.name, asExpected, why, secs, res }));
  else {
    console.log(`== ${sel.name} (${mustFail ? 'must-FAIL' : 'must-PASS'}) ${secs}s: ${asExpected ? 'AS EXPECTED' : 'UNEXPECTED'} — ${why}`);
    for (const c of res.checks) console.log(`   ${c.ok ? 'ok ' : 'RED'} ${c.id}${c.detail ? ` — ${c.detail.slice(0, 220)}` : ''}`);
    if (res.strays?.length) console.log(`   strays in the namespace: ${res.strays.join(' ; ')}`);
  }
  if (!KEEP && asExpected) fs.rmSync(root, { recursive: true, force: true });
  else console.log(`   scratch kept at ${root}`);
}
if (masterDir && !KEEP) {
  spawnSync('git', ['-C', MY_REPO, 'worktree', 'remove', '--force', masterDir], { encoding: 'utf8' });
  fs.rmSync(masterDir, { recursive: true, force: true });
}
console.log(`PAUSE-REPRISE: ${bad === 0 ? (WANT === 'all' ? 'PASS' : 'PARTIAL') : 'FAIL'}`);
process.exit(bad === 0 ? 0 : 1);
