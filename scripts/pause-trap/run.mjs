#!/usr/bin/env node
// Pause-trap rig driver (#252 D1b, ledger #261 G3/G2):  node scripts/pause-trap/run.mjs [--arm <name>[,…]|all|normal|mutants] [--json] [--keep]
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
//   app-restart-idle  the keeper is IDLE when the app dies; the boot drain must arm (attach) it so the CLI's own task-notification turn is caught (row 29 after a restart)
//   app-restart-bg    same, with a background task + a daemonized job (only the boot drain's KILL can stop them)
//   pauser-self       the OPS pauses ITS OWN run from inside its own tool: its turn + that tool tree are spared, its other tool tree (a bg task) is killed, w1 is trapped (review F5)
//   pauser-human      a human types `--as <coordinator>` in a plain shell: the coordinator is NOT exempt (interrupted, tool killed)
//   keeper-stopped    the keeper is SIGSTOPped (alive, unresponsive): nothing killed, trap NOT stamped done, completes once it answers (review F4)
//   queue-kept        an AUTO prompt queued behind the running turn is NOT dropped by the pause interrupt, is held while paused (a human prompt still runs first), and runs after the Reprise releases w1 (`run resume` + `run release`)
//   turn-while-paused a background task is killed BY SIGNAL (the documented fallback, `noStopTask`), the CLI starts a turn BY ITSELF (task notification) → interrupted + noted
//   bg-notify         (#282) the hard pause lands on an IDLE member with a background task: the trap ends it THROUGH THE CLI (stop_task) → ZERO model requests from the paused member; the Bilan lists it
//   bg-notify-running (#282) same with the member MID-TURN (blocked in a foreground command) + a background task + a daemonized job
//   bg-notify-deleted (#282 R1) the task's `.output` file is unlinked before the pause (`(deleted)` link) · bg-notify-wedged (#282 R2) the member's CLI is SIGSTOPped: the stop_task request is bounded, the task ends by signal, 0 requests
//   bg-notify-restart (#282) same, the app dies first and the boot drain arms the idle keeper + stops the task
// Must-FAIL mutants (load-time edits of the shipped source; the named check must go red):
//   no-trap (the unfixed build) · kill-cli · kill-keeper · snapshot-touches-index · skip-kill · skip-snapshot · no-turn-observer · no-arm · no-pauser-exemption · exempt-by-handle · stamp-on-unknown · drop-queue-on-pause-interrupt
//   #282: unfixed:bg-notify (master v0.5.306) · no-stop-task · stop-task-after-signals · no-arm-bg-notify
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

const DOUCE = ['douce-keeperstopped', 'douce-forged', 'douce-humanmark', 'douce-obey', 'douce-failcall', 'douce-subagent', 'douce-quota', 'douce-blocked', 'douce-silent', 'douce-mixed', 'douce-fleet', 'douce-restart', 'douce-off'];
const NORMAL = [...DOUCE, 'blocking', 'foreground', 'background', 'app-restart', 'app-restart-bg', 'app-restart-idle', 'turn-while-paused', 'bg-notify', 'bg-notify-running', 'bg-notify-deleted', 'bg-notify-wedged', 'bg-notify-restart', 'pauser-human', 'pauser-self', 'keeper-stopped', 'queue-kept'];
const MUTANT_ARMS = [
  // #254 Pause douce. G1: the UNFIXED build (master: `run pause` without --hard is refused, no douce at all) must FAIL the same rig.
  { name: 'unfixed:no-douce', arm: 'douce-obey', mutant: 'master', master: true },
  // each load-time mutant must redden its named check; `deadlineSec` shortens the real 3 min (a fixture) so a mutant arm does not wait for it
  { name: 'mutant:no-deadline-escalation', arm: 'douce-blocked', mutant: 'no-deadline-escalation', deadlineSec: 25 },
  { name: 'mutant:escalate-on-any-confirm', arm: 'douce-mixed', mutant: 'escalate-on-any-confirm' },
  { name: 'mutant:trap-owed-before-escalation', arm: 'douce-mixed', mutant: 'trap-owed-before-escalation' },
  { name: 'mutant:no-order-file', arm: 'douce-obey', mutant: 'no-order-file' },
  { name: 'mutant:host-idle-for-running', arm: 'douce-obey', mutant: 'host-idle-for-running' },
  { name: 'mutant:summary-counts-all', arm: 'douce-mixed', mutant: 'summary-counts-all' },
  // follow-up (R1-1): a BUILT mutant — the guard lives in the CLI bundle, which a load-time mutant of the app stand-in cannot reach: a detached worktree of HEAD is mutated, built, and driven (SRC).
  // the "0 lost work" instrument can say FAIL: no snapshot ⇒ the blocked member's work is in no ref (reviewer-e1 coverage note)
  { name: 'mutant:skip-snapshot-douce', arm: 'douce-blocked', mutant: 'skip-snapshot', redden: 'lost_work_is_zero', deadlineSec: 25 },
  { name: 'mutant:keeper-unknown-is-none', arm: 'douce-keeperstopped', mutant: 'keeper-unknown-is-none' },
  { name: 'mutant:confirm-accepts-non-members', arm: 'douce-forged', mutant: 'confirm-accepts-non-members', built: { file: 'src/main/pause-douce.ts', find: '  if (opts.proven !== true && !listRoster(db, carrier.runId, carrier.pausedAt).some((r) => r.wsId === who.wsId)) {', replace: '  if (false) {' }, redden: 'ghost_confirm_refused' },
  { name: 'mutant:mark-left-in-pausing', arm: 'douce-humanmark', mutant: 'mark-left-in-pausing', redden: 'human_mark_spent_cli_turn_trapped_after_escalation' },
  { name: 'mutant:subagent-takes-order', arm: 'douce-subagent', mutant: 'subagent-takes-order' },
  { name: 'mutant:no-trap-roster', arm: 'douce-blocked', mutant: 'no-trap-roster', deadlineSec: 25 },
  { name: 'mutant:sweep-ignores-switch', arm: 'douce-off', mutant: 'sweep-ignores-switch' },
  // #282 G1: the UNFIXED build (master v0.5.306: the bg task is SIGTERMed, the CLI starts a task-notification turn by itself) must FAIL the same rig on the request count.
  { name: 'unfixed:bg-notify', arm: 'bg-notify', mutant: 'master', master: true, masterPin: 'bg-notify', redden: 'no_model_request_while_paused' },
  { name: 'unfixed:bg-notify-running', arm: 'bg-notify-running', mutant: 'master', master: true, masterPin: 'bg-notify', redden: 'no_model_request_while_paused' },
  { name: 'mutant:deleted-link-unmatched', arm: 'bg-notify-deleted', mutant: 'deleted-link-unmatched', redden: 'no_model_request_while_paused' },
  { name: 'mutant:no-stop-timeout', arm: 'bg-notify-wedged', mutant: 'no-stop-timeout', redden: 'trap_finished' },
  { name: 'mutant:no-stop-task', arm: 'bg-notify', mutant: 'no-stop-task' },
  { name: 'mutant:no-stop-task-running', arm: 'bg-notify-running', mutant: 'no-stop-task' },
  { name: 'mutant:stop-task-after-signals', arm: 'bg-notify', mutant: 'stop-task-after-signals' },
  { name: 'mutant:no-arm-bg-notify', arm: 'bg-notify-restart', mutant: 'no-arm', redden: 'no_model_request_while_paused' },
  // G1: the UNFIXED build (no host trap, as on master) must FAIL the same rig: nothing is interrupted, killed or snapshotted.
  { name: 'unfixed:no-trap', arm: 'background', mutant: 'no-trap' },
  { name: 'mutant:kill-cli', arm: 'blocking', mutant: 'kill-cli' },
  { name: 'mutant:kill-keeper', arm: 'blocking', mutant: 'kill-keeper' },
  { name: 'mutant:snapshot-touches-index', arm: 'blocking', mutant: 'snapshot-touches-index' },
  { name: 'mutant:skip-kill', arm: 'background', mutant: 'skip-kill' },
  { name: 'mutant:skip-snapshot', arm: 'blocking', mutant: 'skip-snapshot' },
  { name: 'mutant:no-turn-observer', arm: 'turn-while-paused', mutant: 'no-turn-observer' },
  { name: 'mutant:no-arm', arm: 'app-restart-idle', mutant: 'no-arm' },
  { name: 'mutant:drop-queue-on-pause-interrupt', arm: 'queue-kept', mutant: 'drop-queue-on-pause-interrupt' },
  { name: 'mutant:no-pauser-exemption', arm: 'pauser-self', mutant: 'no-pauser-exemption' },
  { name: 'mutant:exempt-by-handle', arm: 'pauser-human', mutant: 'exempt-by-handle' },
  { name: 'mutant:stamp-on-unknown', arm: 'keeper-stopped', mutant: 'stamp-on-unknown' },
];
const all = [...NORMAL, 'probe-interrupt', 'probe-dbg', 'probe-bg-sigterm', 'probe-bg-stoptask'].map((a) => ({ name: a, arm: a, mutant: null }));
all.push(...MUTANT_ARMS);
const wanted = new Set(WANT.split(',').map((x) => x.trim()));
const selected = WANT === 'all'
  ? all.filter((x) => !x.arm.startsWith('probe-'))
  : WANT === 'normal' ? all.filter((x) => !x.mutant && !x.arm.startsWith('probe-'))
  : WANT === 'mutants' ? all.filter((x) => !!x.mutant)
  : all.filter((x) => wanted.has(x.name) || wanted.has(x.name.replace(/^(mutant|unfixed):/, '')));
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
// #254: the MASTER tree the `unfixed:` arms drive (G1: the same rig on master must go red). Built once, in a detached worktree of origin/master.
const masterDirs = new Map();
// Each `unfixed:` arm names the commit that predates ITS fix (`sel.masterSha`; env override `sel.masterEnv`): `origin/master` would go green-for-the-wrong-reason once the fix itself is merged.
function masterTree(pin = { sha: 'b34c8b58', env: 'PT_UNFIXED_SHA', what: 'pre-douce' }) {
  const wantSha = process.env[pin.env] ?? pin.sha;
  if (masterDirs.has(wantSha)) return masterDirs.get(wantSha);
  const sha = spawnSync('git', ['rev-parse', `${wantSha}^{commit}`], { cwd: REPO, encoding: 'utf8' }).stdout.trim();
  if (!sha) { console.log(`PAUSE-TRAP: VOID — the ${pin.what} commit ${wantSha} is not in this repo (set ${pin.env})`); process.exit(3); }
  const dir = path.join(base, `master-${sha.slice(0, 8)}`);
  if (!fs.existsSync(path.join(dir, 'dist-electron', 'cli.js'))) {
    if (!fs.existsSync(dir)) {
      const w = spawnSync('git', ['worktree', 'add', '--detach', dir, sha], { cwd: REPO, encoding: 'utf8' });
      if (w.status !== 0) { console.log(`PAUSE-TRAP: VOID — cannot create the master worktree: ${w.stderr.slice(-200)}`); process.exit(3); }
      fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'));
    }
    for (const script of ['build:cli', 'build:keeper']) {
      const r = spawnSync('pnpm', ['run', script], { cwd: dir, encoding: 'utf8' });
      if (r.status !== 0) { console.log(`PAUSE-TRAP: VOID — master ${script} failed: ${(r.stdout + r.stderr).slice(-300)}`); process.exit(3); }
    }
  }
  masterDirs.set(wantSha, dir);
  return dir;
}
/** The pins: `unfixed:no-douce` = master before wave E; `unfixed:bg-notify` = master v0.5.306, before #282 (stop_task through the CLI). */
const PIN_BG_NOTIFY = { sha: '53e93c81', env: 'PT_BGNOTIFY_UNFIXED_SHA', what: 'pre-#282' };
const pinOf = (sel) => (sel.masterPin === 'bg-notify' ? PIN_BG_NOTIFY : undefined);

// follow-up: BUILT mutants (`sel.built`): a detached worktree of HEAD (the committed tree), mutated at ONE anchor (exactly once, else VOID), then built; the arm drives it as SRC.
const builtDirs = new Map();
function builtTree(sel) {
  if (builtDirs.has(sel.name)) return builtDirs.get(sel.name);
  const dir = path.join(base, `built-${sel.name.replace(/[^a-z0-9-]/gi, '_')}-${process.pid}`);
  const w = spawnSync('git', ['worktree', 'add', '--detach', dir, 'HEAD'], { cwd: REPO, encoding: 'utf8' });
  if (w.status !== 0) { console.log(`PAUSE-TRAP: VOID — cannot create the built-mutant worktree: ${w.stderr.slice(-200)}`); process.exit(3); }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'));
  const abs = path.join(dir, sel.built.file);
  const src = fs.readFileSync(abs, 'utf8');
  const hits = src.split(sel.built.find).length - 1;
  if (hits !== 1) { console.log(`PAUSE-TRAP: VOID — built mutant ${sel.name}: PATTERN-GONE (anchor matched ${hits}× in ${sel.built.file})`); process.exit(3); }
  fs.writeFileSync(abs, src.replace(sel.built.find, () => sel.built.replace));
  for (const script of ['build:cli', 'build:keeper']) {
    const r = spawnSync('pnpm', ['run', script], { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) { console.log(`PAUSE-TRAP: VOID — built mutant ${sel.name}: ${script} failed: ${(r.stdout + r.stderr).slice(-300)}`); process.exit(3); }
  }
  builtDirs.set(sel.name, dir);
  return dir;
}
for (const sel of selected) if (sel.built) builtTree(sel); // sequential builds, before any arm starts

const PARALLEL = Number(opt('parallel', process.env.PT_PARALLEL ?? '1')) || 1;
const queue = [...selected];
for (const x of selected) if (x.master) masterTree(pinOf(x)); // before any arm starts (one build per pin, not racing builds)

async function runOne(sel) {
  const root = path.join(base, `${sel.name.replace(/[^a-z0-9-]/gi, '_')}-${process.pid}-${Date.now().toString(36).slice(-4)}`);
  fs.mkdirSync(root, { recursive: true });
  assertScratch('root', root, base, live);
  const apiPort = 31000 + Math.floor(Math.random() * 15000);
  const cfg = { REPO, root, arm: sel.arm, mutant: sel.master || sel.built ? null : sel.mutant, live, apiPort, ...(sel.master ? { SRC: masterTree(pinOf(sel)) } : sel.built ? { SRC: builtTree(sel) } : {}), ...(sel.deadlineSec ? { deadlineSec: sel.deadlineSec } : {}) };
  const env = { PATH: [path.dirname(claude), path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'), HOME: path.join(root, 'home'), LANG: 'C.UTF-8', TERM: 'dumb', PT_CONFIG: JSON.stringify(cfg), ...(process.env.PT_DUMP_API ? { PT_DUMP_API: process.env.PT_DUMP_API } : {}) };
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
    return;
  }
  let asExpected, why;
  const red = res.checks.filter((c) => !c.ok);
  if (sel.mutant) {
    const want = sel.redden ?? (sel.master ? 'cli_pause_soft_accepted' : MUTANTS[sel.mutant].mustRedden);
    const named = res.checks.find((c) => c.id === want);
    const ran = sel.master ? true : !res.checks.some((c) => c.id === 'rig_ran_to_completion' && !c.ok);
    asExpected = !!named && !named.ok && ran;
    why = asExpected ? `${sel.master ? 'unfixed (master) caught' : 'mutant caught'}: check '${want}' went RED (${named.detail})${red.length > 1 ? ` · also red: ${red.filter((c) => c.id !== want).map((c) => c.id).join(', ')}` : ''}` : !ran ? `the rig itself broke under the mutant: ${red.map((c) => `${c.id}: ${c.detail}`).join(' | ')}` : `MUTANT SURVIVED — check '${want}' stayed ${named ? 'green' : 'absent'}`;
  } else {
    asExpected = res.ok;
    why = res.ok ? `${res.checks.length} checks green` : `RED: ${red.map((c) => `${c.id} (${c.detail})`).join(' | ')}`;
  }
  if (!asExpected) bad++;
  if (JSON_OUT) { console.log(JSON.stringify({ arm: sel.name, asExpected, why, secs, res })); }
  else {
    console.log(`== ${sel.name} (${sel.mutant ? 'must-FAIL' : 'must-PASS'}) ${secs}s: ${asExpected ? 'AS EXPECTED' : 'UNEXPECTED'} — ${why}`);
    for (const c of res.checks) console.log(`   ${c.ok ? 'ok ' : 'RED'} ${c.id}${c.detail ? ` — ${c.detail.slice(0, 220)}` : ''}`);
    if (res.metrics) { const m = res.metrics; console.log(`   METRICS ${sel.name}: time-to-all-paused ${m.timeToAllPausedMs === null || m.timeToAllPausedMs === undefined ? 'n/a' : (m.timeToAllPausedMs / 1000).toFixed(1) + ' s'} (deadline ${(m.deadlineMs / 1000).toFixed(0)} s, escalated after ${m.escalatedAfterMs === null || m.escalatedAfterMs === undefined ? 'n/a' : (m.escalatedAfterMs / 1000).toFixed(1) + ' s'}) · time-to-all-confirmed ${m.timeToAllConfirmedMs === null || m.timeToAllConfirmedMs === undefined ? 'n/a' : (m.timeToAllConfirmedMs / 1000).toFixed(1) + ' s'} · lost-work ${m.lostWork ?? 'n/a'} · order latency ${JSON.stringify(m.orderLatencyMs ?? {})}`); }
    if (res.strays?.length) console.log(`   strays in the namespace: ${res.strays.join(' ; ')}`);
  }
  if (!KEEP && asExpected) fs.rmSync(root, { recursive: true, force: true });
  else console.log(`   scratch kept at ${root}`);
}
await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => { for (let sel = queue.shift(); sel; sel = queue.shift()) await runOne(sel); }));
for (const d of builtDirs.values()) if (!KEEP) { spawnSync('git', ['worktree', 'remove', '--force', d], { cwd: REPO }); fs.rmSync(d, { recursive: true, force: true }); }
if (!KEEP) for (const d of masterDirs.values()) { spawnSync('git', ['worktree', 'remove', '--force', d], { cwd: REPO }); fs.rmSync(d, { recursive: true, force: true }); }
console.log(`PAUSE-TRAP: ${bad === 0 ? (WANT === 'all' ? 'PASS' : 'PARTIAL') : 'FAIL'}`);
process.exit(bad === 0 ? 0 : 1);
