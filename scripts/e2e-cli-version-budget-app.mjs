#!/usr/bin/env node
// #211 built-app rig — the re-run wired in MAIN, in the PACKAGED app. Boots the unpacked packaged Orchestra
// (release/linux-arm64-unpacked/orchestra, asar + unpacked natives, exactly what electron-builder ships) under a private
// headless sway with a scratch HOME / ORCHESTRA_HOME / CLAUDE_CONFIG_DIR, a `claude` wrapper on PATH, and waits out the
// REAL 90 s startup delay. Run it through scripts/e2e-cli-version-budget-app.sh (contained rig: own sway, allowlist env).
//   S1 new CLI version → ONE run, at nice 19, from INSIDE app.asar under the packaged binary; silent pass; record
//   S2 restart, same version → zero runs (durable record)
//   S3 `claude update` that adds startup calls → BUDGET BROKEN log + notice call + record naming the budget
//   S4 quit (close the window) while a run is in flight → run killed, record + lock restored, no survivors
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [APP_DIR, REAL_CLAUDE, REAL_HOME] = process.argv.slice(2);
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : 'all';
// How long to wait for the run to appear after the 90 s delay. Default covers one D7 deferral (retried by the next 10-min poll);
// a MUTANT run passes `--max-wait 40` so the expected red arrives in ~2.5 min instead of ~12.
const MAX_WAIT_S = process.argv.includes('--max-wait') ? Number(process.argv[process.argv.indexOf('--max-wait') + 1]) : 660;
const say = (m) => process.stderr.write(`${m}\n`);
const die = (m) => { say(`ABORT: ${m}`); process.exit(2); };
for (const k of ['RIG_DIR', 'ORCHESTRA_HOME', 'HOME', 'CLAUDE_CONFIG_DIR', 'WAYLAND_DISPLAY', 'SWAYSOCK']) if (!process.env[k]) die(`${k} unset — run through e2e-cli-version-budget-app.sh`);
if (!APP_DIR || !REAL_CLAUDE || !REAL_HOME) die('usage: <unpacked app dir> <real claude path> <invoker real HOME>');
const { RIG_DIR, ORCHESTRA_HOME, HOME, CLAUDE_CONFIG_DIR } = process.env;
if (process.env.WAYLAND_DISPLAY === 'wayland-1') die('WAYLAND_DISPLAY is the human\'s compositor');

// D7 / incidents 2026-09-29/30: every dir the app boot can write must be scratch. Refuse anything live BEFORE booting.
const { assertScratch } = await import(`${REPO}/scripts/session-budget/scratch-guard.mjs`);
// scratch-guard's liveDirs() is os.homedir()-relative, and inside this rig HOME is the FAKE one — so build the live list from
// the invoker's REAL home (passed in): every ~/.claude*, ~/.orchestra*, ~/.config/orchestra.
const LIVE = [path.join(REAL_HOME, '.claude'), path.join(REAL_HOME, '.orchestra'), path.join(REAL_HOME, '.config', 'orchestra')];
for (const n of fs.readdirSync(REAL_HOME)) if (n.startsWith('.claude') || n.startsWith('.orchestra')) LIVE.push(path.join(REAL_HOME, n));
if (LIVE.length < 4) die(`live-dir list looks empty (${LIVE.join(',')}) — refusing to trust an unmeasured guard`);
if (path.resolve(REAL_HOME) === path.resolve(HOME)) die('HOME is the invoker\'s real home — the contained rig should have replaced it');
const SCRATCH_BASE = path.dirname(RIG_DIR); // E2E_RIG_BASE: the contained rig's dir and the pinned scratch config dir both live under it
for (const [k, v] of [['HOME', HOME], ['ORCHESTRA_HOME', ORCHESTRA_HOME], ['CLAUDE_CONFIG_DIR', CLAUDE_CONFIG_DIR]]) assertScratch(k, v, SCRATCH_BASE, LIVE);
fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });

const shim = await import(`${REPO}/scripts/session-budget/claude-shim.mjs`);
const SHIM = path.join(RIG_DIR, 'shim');
shim.makeShim(SHIM);
const APP = path.join(APP_DIR, 'orchestra');
const ASAR = path.join(APP_DIR, 'resources', 'app.asar');
for (const f of [APP, ASAR]) if (!fs.existsSync(f)) die(`${f} missing`);

// Artifact identity: the version read OUT of the packaged asar, and the runner bundle it must contain.
const req = createRequire(path.join(REPO, 'package.json'));
const asar = createRequire(req.resolve('electron-builder/package.json'))('@electron/asar'); // pnpm: only electron-builder can see it
const pkgVersion = JSON.parse(asar.extractFile(ASAR, 'package.json').toString()).version;
const repoVersion = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
const inAsar = asar.listPackage(ASAR).map((p) => p.replace(/^[\\/]/, '')).filter((p) => /dist-electron\/(session-budget|keeper|main)\.js$/.test(p));
say(`identity: packaged app.asar version=${pkgVersion} (repo package.json ${repoVersion}); runner bundles in asar: ${inAsar.join(', ')}`);
if (pkgVersion !== repoVersion) die('packaged version != repo version — stale package');
if (!inAsar.some((p) => p.endsWith('session-budget.js'))) die('session-budget.js is not in the packaged asar');

const results = [];
let failed = 0;
const check = (arm, name, ok, detail = '') => { results.push({ arm, name, ok: !!ok, detail }); if (!ok) failed++; say(`${ok ? '  ok  ' : '  FAIL'} [${arm}] ${name}${detail ? ` — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG = path.join(ORCHESTRA_HOME, 'logs', 'orchestra.log');
const RECORD = path.join(ORCHESTRA_HOME, 'session-budget', 'cli-version-record.json');
const SUITE_LOCK = path.join(ORCHESTRA_HOME, 'session-budget', 'suite.lock');
const readLog = (from = 0) => { try { return fs.readFileSync(LOG).subarray(from).toString('utf8'); } catch { return ''; } }; // BYTE offset (the log holds multibyte em-dashes: a string slice by byte size skips new lines)
const logSize = () => { try { return fs.statSync(LOG).size; } catch { return 0; } };
const readRecord = () => { try { return JSON.parse(fs.readFileSync(RECORD, 'utf8')); } catch { return null; } };
async function waitFor(pred, ms, every = 500) { const t0 = Date.now(); for (;;) { const v = pred(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(every); } }

/** pids (host view) whose argv names `needle`. */
function pidsByArgv(needle) {
  const out = [];
  for (const n of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(n)) continue;
    try { if (fs.readFileSync(`/proc/${n}/cmdline`, 'latin1').split('\0').join(' ').includes(needle)) out.push(Number(n)); } catch { /* gone */ }
  }
  return out;
}
const niceOf = (pid) => { try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[16]); } catch { return null; } };
function survivors() { // processes whose environment carries this rig's scratch ORCHESTRA_HOME or HARNESS scratch root
  const needles = [`ORCHESTRA_HOME=${ORCHESTRA_HOME}\0`, '.cache/session-budget/cli-version-rerun-'];
  const out = [];
  for (const n of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(n) || Number(n) === process.pid) continue;
    try { const e = fs.readFileSync(`/proc/${n}/environ`, 'latin1'); if (needles.some((x) => e.includes(x)) && e.includes(ORCHESTRA_HOME.slice(0, 20))) out.push(Number(n)); } catch { /* gone / not ours */ }
  }
  return out;
}

/** D7: the app's own gate DEFERS a run at load1 > 20 (seen live: "not running the suite for claude 9.1.1: load"), so a boot at a
 *  loaded moment measures the gate, not the feature. Start each boot only once the machine is quiet (max 20 min, else VOID). */
async function waitQuiet(label) {
  const t0 = Date.now();
  for (;;) {
    const l1 = Number(fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);
    if (l1 < 14) { if (Date.now() - t0 > 5000) say(`[${label}] machine quiet (load1 ${l1}) after ${((Date.now() - t0) / 1000).toFixed(0)} s`); return l1; }
    if (Date.now() - t0 > 20 * 60_000) die(`VOID: load1 stayed >= 14 for 20 min before boot ${label} — a run would be deferred by the D7 gate, nothing measured`);
    await sleep(10_000);
  }
}
let app = null;
async function boot(label) {
  await waitQuiet(label);
  const off = logSize();
  const env = { ...process.env, PATH: `${SHIM}:${process.env.PATH}`, ORCHESTRA_SELF_TUNE_CMD: '/bin/true' };
  for (const k of ['APPIMAGE', 'APPDIR', 'OWD', 'ARGV0', 'DISPLAY']) delete env[k];
  const out = fs.openSync(path.join(RIG_DIR, `app-${label}.out`), 'w');
  app = spawn(APP, ['--no-sandbox', '--ozone-platform=wayland'], { env, stdio: ['ignore', out, out], detached: true });
  const up = await waitFor(() => /=== Orchestra .* starting ===/.test(readLog(off)), 60_000);
  const banner = readLog(off).split('\n').find((l) => /=== Orchestra .* starting ===/.test(l)) ?? '';
  if (!up) die(`[${label}] the app never logged its start banner (see ${RIG_DIR}/app-${label}.out)`);
  return { off, t0: Date.now(), banner };
}
async function quit(label) { // the user path: close the window → window-all-closed → shutdownSubsystems
  spawnSync('swaymsg', ['[app_id=".*"] kill'], { env: process.env, encoding: 'utf8' });
  const gone = await waitFor(() => { try { process.kill(app.pid, 0); return false; } catch { return true; } }, 20_000);
  if (!gone) { try { process.kill(-app.pid, 'SIGKILL'); } catch { /* gone */ } say(`[${label}] window close did not quit the app — SIGKILLed the group`); }
  app = null;
  return !!gone;
}
async function killApp() { if (app) { try { process.kill(-app.pid, 'SIGKILL'); } catch { /* gone */ } app = null; await sleep(1500); } }

const START_DELAY_S = 90; // CLI_BUDGET_RERUN.startupDelayMs (S1 asserts the run really starts after it)

const SCENARIOS = {
  async s1() {
    const A = 'S1';
    shim.setVersion(SHIM, '9.1.1', REAL_CLAUDE);
    const b = await boot('s1');
    check(A, 'boot banner carries the packaged version', b.banner.includes(`Orchestra ${pkgVersion}`), b.banner.slice(0, 90));
    check(A, 'the watcher armed at boot (log line, real logger)', !!(await waitFor(() => /\[cli-budget\] cli-budget: watching the installed claude \(first check in 90s, then every 10 min\)/.test(readLog(b.off)), 30_000)));
    check(A, 'nothing runs before the startup delay (record absent at +20 s)', (await sleep(20_000), readRecord() === null && shim.starts(SHIM).length === 0));
    // watch the run: the runner bundle, executed from INSIDE app.asar by the packaged binary, at nice 19
    let seen = null;
    const rec = await waitFor(() => {
      if (!seen) { const p = pidsByArgv('app.asar/dist-electron/session-budget.js').filter((x) => { try { return fs.readlinkSync(`/proc/${x}/exe`).endsWith('/orchestra'); } catch { return false; } }); if (p.length) seen = { pid: p[0], nice: niceOf(p[0]), exe: (() => { try { return fs.readlinkSync(`/proc/${p[0]}/exe`); } catch { return null; } })(), cmd: fs.readFileSync(`/proc/${p[0]}/cmdline`, 'latin1').split('\0').join(' ') }; }
      const r = readRecord();
      return r && r.status !== 'running' ? r : null;
    }, (START_DELAY_S + MAX_WAIT_S) * 1000, 250); // a D7 deferral at the first check is retried by the next poll, 10 min later
    const elapsed = (Date.now() - b.t0) / 1000;
    check(A, 'the run finished with a PASS record for the new version', rec?.status === 'pass' && rec?.version === '9.1.1' && rec?.attempts === 1, JSON.stringify(rec));
    check(A, `the run started after the ${START_DELAY_S} s delay, not at boot`, elapsed > START_DELAY_S - 5, `${elapsed.toFixed(0)} s after the banner`);
    check(A, 'the runner bundle ran from INSIDE app.asar under the PACKAGED binary', !!seen && seen.exe?.endsWith('/orchestra') && seen.exe?.startsWith(APP_DIR) && /ELECTRON|app\.asar/.test(seen.cmd), JSON.stringify(seen));
    check(A, 'that process ran at nice 19', seen?.nice === 19, `nice=${seen?.nice}`);
    check(A, 'independent counter: the wrapper saw exactly ONE session start, at nice 19', shim.starts(SHIM).length === 1 && /nice=19$/.test(shim.starts(SHIM)[0] ?? ''), shim.starts(SHIM).join(' | '));
    const lg = readLog(b.off);
    check(A, 'log: one "differs from the last budgeted (none)" line and one "within every session budget" line', (lg.match(/claude 9\.1\.1 differs from the last budgeted \(none\)/g) ?? []).length === 1 && (lg.match(/claude 9\.1\.1 is within every session budget/g) ?? []).length === 1);
    check(A, 'a pass is SILENT: no notice line, no BUDGET BROKEN', !/cli-budget\] notice:|BUDGET BROKEN/.test(lg));
    check(A, 'the suite lock is freed', !fs.existsSync(SUITE_LOCK));
    check(A, 'the run left no process behind', survivors().filter((p) => p !== app.pid && pidsByArgv('session-budget.js').includes(p)).length === 0 && pidsByArgv('session-budget.js').length === 0, pidsByArgv('session-budget.js').join(','));
    await quit('s1');
  },
  async s2() {
    const A = 'S2';
    const before = shim.starts(SHIM).length;
    const recBefore = fs.readFileSync(RECORD, 'utf8');
    const b = await boot('s2');
    await sleep((START_DELAY_S + 45) * 1000); // past the first check by 45 s (a check + a run would both be visible by then)
    const lg = readLog(b.off);
    check(A, 'the watcher armed again (a check ran: it is not merely disabled)', /watching the installed claude/.test(lg));
    check(A, 'same version after a restart → ZERO runs (wrapper count unchanged)', shim.starts(SHIM).length === before, `${before} → ${shim.starts(SHIM).length}`);
    check(A, 'no "running the session budget suite" line this boot', !/running the session budget suite once/.test(lg));
    check(A, 'the record is byte-identical (durable, not rewritten)', fs.readFileSync(RECORD, 'utf8') === recBefore);
    await quit('s2');
  },
  async s3() {
    const A = 'S3';
    shim.setVersion(SHIM, '9.1.2', REAL_CLAUDE);
    shim.setMode(SHIM, 'inflate');
    const before = shim.starts(SHIM).length;
    const b = await boot('s3');
    const rec = await waitFor(() => { const r = readRecord(); return r && r.version === '9.1.2' && r.status !== 'running' ? r : null; }, (START_DELAY_S + MAX_WAIT_S) * 1000, 500);
    const lg = readLog(b.off);
    check(A, 'exactly ONE more run for the new version', shim.starts(SHIM).length === before + 1, `${before} → ${shim.starts(SHIM).length}`);
    check(A, 'record = broken, naming the budget', rec?.status === 'broken' && rec?.broken?.[0]?.id === 'session.beforeFirstReply.countTokensRequests', JSON.stringify(rec));
    check(A, 'WARN log line names the budget and the CLI version', /\[WARN\] \[cli-budget\] cli-budget: BUDGET BROKEN on claude 9\.1\.2: .*countTokensRequests/.test(lg));
    check(A, 'exactly ONE notice reached platform.notify (call-site log), naming version + budget', (lg.match(/\[cli-budget\] notice: Claude Code 9\.1\.2 broke a session budget — session\.beforeFirstReply\.countTokensRequests: allowed at most 0, saw 6/g) ?? []).length === 1, (lg.match(/\[cli-budget\] notice:.*/g) ?? []).join(' || '));
    await sleep(15_000);
    check(A, 'not re-run or re-announced afterwards', shim.starts(SHIM).length === before + 1);
    await quit('s3');
  },
  async s4() {
    const A = 'S4';
    shim.setVersion(SHIM, '9.1.3', REAL_CLAUDE);
    shim.setMode(SHIM, 'slow');
    if (!fs.existsSync(RECORD)) { // `--only s4`: seed the record S3 would have left (a budgeted older version)
      fs.mkdirSync(path.dirname(RECORD), { recursive: true });
      fs.writeFileSync(RECORD, `${JSON.stringify({ schema: 1, version: '9.0.0', status: 'pass', attempts: 1, startedAt: 1, finishedAt: 2, broken: [] }, null, 2)}\n`);
    }
    const prior = fs.readFileSync(RECORD, 'utf8');
    const before = shim.starts(SHIM).length;
    const b = await boot('s4');
    const running = await waitFor(() => { const r = readRecord(); return r && r.status === 'running' && r.version === '9.1.3' ? r : null; }, (START_DELAY_S + MAX_WAIT_S) * 1000, 250);
    check(A, 'a run is IN FLIGHT (record running, suite lock held, runner process alive)', !!running && fs.existsSync(SUITE_LOCK) && pidsByArgv('session-budget.js').length > 0, JSON.stringify(running));
    await sleep(3000);
    const t0 = Date.now();
    const exited = await quit('s4');
    const took = Date.now() - t0;
    check(A, 'closing the window quits the app', exited, `${took} ms`);
    check(A, 'the record is RESTORED to the previous one (the cancelled attempt is not consumed)', fs.readFileSync(RECORD, 'utf8') === prior, fs.readFileSync(RECORD, 'utf8').slice(0, 120));
    check(A, 'the suite lock is gone', !fs.existsSync(SUITE_LOCK));
    await sleep(2500);
    check(A, 'no runner / claude / MCP process of the run survives the quit', pidsByArgv('session-budget.js').length === 0 && survivors().length === 0, `argv:${pidsByArgv('session-budget.js').join(',')} env:${survivors().join(',')}`);
    check(A, 'the run was started once and never announced', shim.starts(SHIM).length === before + 1 && !/\[cli-budget\] notice:.*9\.1\.3/.test(readLog(b.off)));
  },
};

const t0 = Date.now();
try {
  for (const [name, fn] of Object.entries(SCENARIOS)) {
    if (only !== 'all' && only !== name) continue;
    say(`== ${name}`);
    await fn();
  }
} catch (e) {
  failed++;
  say(`RIG THREW: ${e?.stack ?? e}`);
} finally {
  await killApp();
  const left = survivors();
  if (left.length) { failed++; say(`teardown: survivors ${left.join(',')}`); for (const p of left) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } } }
}
const ok = failed === 0 && results.length > 0;
say(`${results.filter((r) => r.ok).length}/${results.length} checks in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
say(`CLI-VERSION-BUDGET-APP-RIG: ${ok ? 'PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
