// #285 (wave G, ledger #295) — the memory guard's STATE, driven end to end: a fake MemAvailable source → the REAL sampler
// (src/main/memory-guard.ts) → the REAL `/busStatus` route of the REAL hooks-server (headless, scratch home) → the REAL BUILT CLI
// (`dist-electron/cli.js bus-status`) whose `memory:` line is what is asserted. The only fakes: the memory number and the timer
// (hand-fired — the 10 s / 60 s cadence itself is asserted on real setTimeout in src/main/memory-guard.test.ts). NO start is held here.
//
// SAFETY (D4): scratch ORCHESTRA_HOME + HOME + CLAUDE_CONFIG_DIR under ~/.cache (btrfs), refused anywhere near a live ~/.orchestra / ~/.claude*;
// the hooks socket name is a hash of the SCRATCH home; no claude CLI, no network, never the live bus.
//
// Arms (one per process — module state is global; no arg = run them all and aggregate):
//   walk        open → HELD → memory Pause → (Pause lifted, Admission still HELD) → open, each read from `bus-status`; every
//               transition logged WITH MemAvailable in orchestra.log
//   b_held      Admission holds strictly BELOW 6 GB: 6 GB open, 6 GB − 1 B HELD
//   b_reopen    …reopens strictly ABOVE 7 GB: 7 GB stays HELD, 7 GB + 1 B open
//   b_pause_due the memory Pause is due strictly BELOW 3 GB: 3 GB none, 3 GB − 1 B in effect
//   b_pause_lift …lifts strictly ABOVE 6 GB (the Admission threshold, not 7): 6 GB stays, 6 GB + 1 B lifts
//   episodes    jitter around 6 GB is ONE episode (bus-status says episode 1); a recovery above 7 GB then a new fall is episode 2
//   hot         a threshold change applies WITHOUT restart or timer (real setMemoryGuardSettings + real store); an invalid pair
//               is refused and writes nothing; the toggle OFF is printed
//   unreadable  an unreadable MemAvailable keeps the state and says so; never a fabricated figure
//   real_source NO injected source: the shipped /proc/meminfo reader feeds the guard and `bus-status` prints a numeric reading that
//               agrees with an independent read of /proc/meminfo (a broken platform check would read UNMEASURED here)
//
// Run all: node --experimental-strip-types --import ./scripts/.r2-register.mjs scripts/e2e-memory-guard.mjs
//   (RIG_REPO=<other tree> points the modules AND the built CLI at that tree — the must-FAIL run on master)

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(process.env.RIG_REPO ?? path.join(HERE, '..'));
const ARM = process.argv[2] ?? '';
const ARMS = ['walk', 'b_held', 'b_reopen', 'b_pause_due', 'b_pause_lift', 'episodes', 'hot', 'unreadable', 'real_source'];
const GIB = 1024 ** 3;

if (!ARM) {
  // ── parent: one child process per arm, aggregate ────────────────────────────────────────────────────────────
  const rows = [];
  for (const arm of ARMS) {
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--import', pathToFileURL(path.join(HERE, '.r2-register.mjs')).href, fileURLToPath(import.meta.url), arm], {
      env: { ...process.env }, encoding: 'utf8', timeout: 120_000,
    });
    const lastJson = (r.stdout ?? '').split('\n').reverse().find((l) => l.startsWith('{') && l.includes('"arm"'));
    let v = null;
    try { v = lastJson ? JSON.parse(lastJson) : null; } catch { /* below */ }
    rows.push({ arm, ok: v?.ok === true, detail: v ? (v.ok ? '' : v.why ?? v.abort ?? '') : `no verdict (exit ${r.status}) ${(r.stderr ?? '').split('\n').slice(-3).join(' ')}` });
  }
  for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.arm}${r.detail ? ` — ${r.detail}` : ''}`);
  const red = rows.filter((r) => !r.ok);
  console.log(`MEMORY-GUARD RIG: ${red.length === 0 ? 'ALL PASS' : `RED ${red.map((r) => r.arm).join(',')}`} (${rows.length - red.length}/${rows.length}) tree ${REPO}`);
  process.exit(red.length === 0 ? 0 : 1);
}
if (!ARMS.includes(ARM)) { console.error(`unknown arm: ${ARM} (expected: ${ARMS.join(', ')})`); process.exit(2); }

// ── SAFETY: scratch home under ~/.cache of the REAL home; never near a live Claude/Orchestra dir ──────────────────────
const REAL_HOME = os.homedir();
const base = path.resolve(process.env.MEMGUARD_RIG_HOME ?? path.join(REAL_HOME, '.cache', 'e2e-memory-guard'));
const tmpHome = path.join(base, ARM);
const live = [path.join(REAL_HOME, '.orchestra'), path.join(REAL_HOME, '.claude'), path.join(REAL_HOME, '.claude-mc'), path.join(REAL_HOME, '.config')];
if (!(tmpHome + path.sep).startsWith(path.join(REAL_HOME, '.cache') + path.sep) || live.some((l) => (tmpHome + path.sep).startsWith(l + path.sep) || l.startsWith(tmpHome + path.sep))) {
  console.error(`SAFETY: refusing scratch path ${tmpHome}`); process.exit(2);
}
fs.rmSync(tmpHome, { recursive: true, force: true });
fs.mkdirSync(path.join(tmpHome, '.orchestra'), { recursive: true });
for (const k of Object.keys(process.env)) if (/^(ORCHESTRA_|CLAUDE_CONFIG_DIR|CLAUDECODE|CLAUDE_CODE_)/.test(k)) delete process.env[k];
process.env.ORCHESTRA_HOME = path.join(tmpHome, '.orchestra');
process.env.HOME = tmpHome;
process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, '.claude-scratch');
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });

const out = { arm: ARM };
const verdict = (ok, extra = {}) => { console.log(JSON.stringify({ ...out, ...extra, ok })); process.exit(ok ? 0 : 1); };
setTimeout(() => verdict(false, { abort: 'deadline: the arm hung' }), 90_000).unref?.();

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-e2e-memory-guard',
  broadcast: () => {}, broadcastPtyData: () => true, canBroadcast: () => true,
  isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {},
  openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => tmpHome, getLogsDir: () => `${tmpHome}/logs`,
  getAppVersion: () => '0.0.0-e2e-memory-guard', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});
(await import(`${REPO}/src/main/logger.ts`)).initLogger();   // the log sinks open here: the transition lines are asserted from the real orchestra.log
const { store } = await import(`${REPO}/src/main/store.ts`);
await store.load?.();
const busMod = await import(`${REPO}/src/main/bus.ts`);
busMod.initBus();
if (busMod.getBus() && !String(busMod.busPath()).startsWith(tmpHome)) { console.error(`SAFETY: bus resolved outside scratch: ${busMod.busPath()}`); process.exit(2); }
const hooks = await import(`${REPO}/src/main/hooks-server.ts`);
await hooks.startHooksServer();
const sock = hooks.getHookSocketPath();
if (!sock || !String(sock).includes('orchestra-')) { console.error(`SAFETY: odd socket ${sock}`); process.exit(2); }

// ── the memory guard under test: the REAL sampler on a fake source + a hand-fired timer (absent on master → no injection, the rig then reads RED) ──
const hasGuard = fs.existsSync(path.join(REPO, 'src/main/memory-guard.ts'));
out.tree = REPO;
out.hasGuard = hasGuard;
let mem = 12 * GIB;           // what the fake MemAvailable source reports; null = unreadable
let now = Date.parse('2026-10-07T14:00:00Z');
let pending = null;
const delays = [];
let guardMod = null;
let settingsMod = null;
if (hasGuard) {
  guardMod = await import(`${REPO}/src/main/memory-guard.ts`);
  settingsMod = await import(`${REPO}/src/main/memory-guard-settings.ts`);
  guardMod.setMemoryGuardSettingsReader(() => store.getMemoryGuardSettings());
  const g = guardMod.__rebuildMemoryGuardForTests(
    { now: () => now, schedule: (fn, ms) => { delays.push(ms); pending = { fn, ms }; return pending; }, cancel: (h) => { if (pending === h) pending = null; } },
    ARM === 'real_source' ? null : () => mem,   // real_source: NO injected source — the shipped reader is what runs
  );
  g.start();
}
/** Set the fake memory and let the sampler's own timer fire once (the sampler, not the rig, decides what that means). */
function step(bytes) { mem = bytes; now += pending?.ms ?? 0; const p = pending; pending = null; p?.fn(); }

// ── the instrument: the real built CLI against the real socket (ASYNC — the server lives in THIS process) ───────────────
const CLI = path.join(REPO, 'dist-electron', 'cli.js');
if (!fs.existsSync(CLI)) { verdict(false, { abort: `${CLI} not built (pnpm run build:cli)` }); }
function cli(args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, HOME: tmpHome, ORCHESTRA_HOME: process.env.ORCHESTRA_HOME, ORCHESTRA_SOCK: sock }, stdio: ['ignore', 'pipe', 'pipe'] });
    let so = '', se = '';
    p.stdout.on('data', (c) => (so += c)); p.stderr.on('data', (c) => (se += c));
    p.on('close', (code) => resolve({ code, stdout: so, stderr: se }));
  });
}
/** The `memory:` line of `orchestra bus-status`, parsed into the facts the arms assert (null = no such line). */
async function memory() {
  const r = await cli(['bus-status']);
  if (r.code !== 0) return { line: null, err: `bus-status exit ${r.code}: ${r.stderr.slice(0, 200)}` };
  const line = r.stdout.split('\n').find((l) => l.startsWith('memory:')) ?? null;
  if (!line) return { line: null, err: 'no `memory:` line in bus-status output' };
  const m = (re) => re.exec(line)?.[1] ?? null;
  return {
    line,
    avail: m(/^memory: ([\d.]+) GB available/),
    admission: /admission HELD/.test(line) ? 'HELD' : /admission open/.test(line) ? 'open' : '?',
    pause: /memory Pause IN EFFECT/.test(line) ? 'IN EFFECT' : /memory Pause none/.test(line) ? 'none' : '?',
    episode: m(/episode (\d+)/) === null ? null : Number(m(/episode (\d+)/)),
    toggleOff: /toggle OFF/.test(line),
    unmeasured: /UNMEASURED/.test(line),
    stale: /last good reading/.test(line),
  };
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fails = [];
/** Record one named check; the verdict is red if any failed — with the observed value, never just "false". */
function check(name, got, want) { const ok = eq(got, want); out[name] = got; if (!ok) fails.push(`${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); return ok; }
const state = (m) => (m.line === null ? m.err : `${m.admission}/${m.pause}`);
const logText = () => { try { return fs.readFileSync(path.join(process.env.ORCHESTRA_HOME, 'logs', 'orchestra.log'), 'utf8'); } catch { return ''; } };
const finish = () => verdict(fails.length === 0, fails.length ? { why: fails.join(' | ') } : {});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
if (ARM === 'walk') {
  check('s0_12GB', state(await memory()), 'open/none');
  step(8 * GIB);   check('s1_8GB', state(await memory()), 'open/none');
  step(5.5 * GIB); const held = await memory();
  check('s2_5.5GB', state(held), 'HELD/none'); check('s2_episode', held.episode, 1); check('s2_avail', held.avail, '5.5');
  step(4 * GIB);   check('s3_4GB', state(await memory()), 'HELD/none');
  step(2.4 * GIB); check('s4_2.4GB', state(await memory()), 'HELD/IN EFFECT');
  step(2.9 * GIB); check('s5_2.9GB', state(await memory()), 'HELD/IN EFFECT');
  step(6.5 * GIB); check('s6_6.5GB', state(await memory()), 'HELD/none');   // Pause lifted above 6 GB; Admission still held (needs > 7)
  step(7.5 * GIB); check('s7_7.5GB', state(await memory()), 'open/none');
  const log = logText();
  check('log_held', /\[memory-guard\] admission HELD \(episode 1\) — MemAvailable 5\.50 GB < 6\.00 GB/.test(log), true);
  check('log_pause_due', /\[memory-guard\] memory Pause DUE \(episode 1\) — MemAvailable 2\.40 GB < critical 3\.00 GB/.test(log), true);
  check('log_pause_liftable', /\[memory-guard\] memory Pause LIFTABLE \(episode 1\) — MemAvailable 6\.50 GB > 6\.00 GB/.test(log), true);
  check('log_reopened', /\[memory-guard\] admission REOPENED \(episode 1 over\) — MemAvailable 7\.50 GB > 7\.00 GB/.test(log), true);
  check('log_edges_only', (log.match(/\[memory-guard\] (admission|memory Pause) /g) ?? []).length, 4);
  finish();
}

if (ARM === 'b_held') {
  step(6 * GIB);     check('at_6GB', state(await memory()), 'open/none');
  step(6 * GIB - 1); check('6GB_minus_1B', state(await memory()), 'HELD/none');
  finish();
}

if (ARM === 'b_reopen') {
  step(5 * GIB);     check('held_at_5GB', state(await memory()), 'HELD/none');
  step(7 * GIB);     check('at_7GB', state(await memory()), 'HELD/none');
  step(7 * GIB + 1); check('7GB_plus_1B', state(await memory()), 'open/none');
  finish();
}

if (ARM === 'b_pause_due') {
  step(5 * GIB);     check('held_at_5GB', state(await memory()), 'HELD/none');
  step(3 * GIB);     check('at_3GB', state(await memory()), 'HELD/none');
  step(3 * GIB - 1); check('3GB_minus_1B', state(await memory()), 'HELD/IN EFFECT');
  finish();
}

if (ARM === 'b_pause_lift') {
  step(2 * GIB);     check('critical_at_2GB', state(await memory()), 'HELD/IN EFFECT');
  step(6 * GIB);     check('at_6GB', state(await memory()), 'HELD/IN EFFECT');
  step(6 * GIB + 1); check('6GB_plus_1B', state(await memory()), 'HELD/none');
  finish();
}

if (ARM === 'episodes') {
  for (const [i, g] of [5.9, 6.1, 5.9, 6.5, 5.5, 6.9, 5.0].entries()) { step(g * GIB); const m = await memory(); if (i === 6) { check('jitter_state', state(m), 'HELD/none'); check('jitter_episode', m.episode, 1); } }
  step(8 * GIB);  check('recovered', state(await memory()), 'open/none');
  step(5 * GIB);  const again = await memory();
  check('second_fall_state', state(again), 'HELD/none'); check('second_fall_episode', again.episode, 2);
  finish();
}

if (ARM === 'hot') {
  if (!hasGuard) { fails.push('this tree has no src/main/memory-guard-settings.ts (the write path under test does not exist)'); finish(); }
  step(8 * GIB);
  check('at_8GB_defaults', state(await memory()), 'open/none');
  // the REAL write path (validate → store → re-sample now): no restart, no timer fired
  const r1 = await settingsMod.setMemoryGuardSettings({ admissionGb: 10, criticalGb: 4 }, store);
  check('raise_ok', r1.ok, true);
  check('raised_applies_at_once', state(await memory()), 'HELD/none');
  check('stored', store.getMemoryGuardSettings(), { admissionGb: 10, criticalGb: 4, admissionEnabled: true });
  const storeJson = JSON.parse(fs.readFileSync(path.join(tmpHome, 'orchestra', 'store.json'), 'utf8'));
  check('persisted_on_disk', storeJson.memoryGuard ?? null, { admissionGb: 10, criticalGb: 4, admissionEnabled: true });
  // an invalid pair writes NOTHING and the guard keeps its thresholds
  const bad = await settingsMod.setMemoryGuardSettings({ criticalGb: 12 }, store);
  check('invalid_refused', [bad.ok, /must be below/.test(bad.error ?? '')], [false, true]);
  check('invalid_wrote_nothing', store.getMemoryGuardSettings(), { admissionGb: 10, criticalGb: 4, admissionEnabled: true });
  check('invalid_state_unchanged', state(await memory()), 'HELD/none');
  // restoring 6/3 applies at once too: 8 GB is above 6 + 1 GB, so Admission reopens with no timer fired
  await settingsMod.setMemoryGuardSettings({ admissionGb: 6, criticalGb: 3 }, store);
  check('restored_applies_at_once', state(await memory()), 'open/none');
  // the global toggle
  await settingsMod.setMemoryGuardSettings({ admissionEnabled: false }, store);
  check('toggle_off_printed', (await memory()).toggleOff, true);
  await settingsMod.setMemoryGuardSettings({ admissionEnabled: true }, store);
  check('toggle_on_printed', (await memory()).toggleOff, false);
  finish();
}

if (ARM === 'real_source') {
  if (!hasGuard) { fails.push('this tree has no memory guard'); finish(); }
  guardMod.sampleMemoryGuardNow();
  const m = await memory();
  const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
  const indep = Number(/^MemAvailable:\s+(\d+)\s+kB/m.exec(meminfo)?.[1]) / 1048576;
  check('not_unmeasured', [m.unmeasured, m.line === null], [false, false]);
  check('numeric_reading', Number.isFinite(Number(m.avail)) && Number(m.avail) > 0, true);
  check('agrees_with_proc_meminfo', Math.abs(Number(m.avail) - indep) < 2, true);
  out.reading = m.avail; out.independent = indep.toFixed(1);
  finish();
}

if (ARM === 'unreadable') {
  step(5 * GIB);  check('held', state(await memory()), 'HELD/none');
  step(null);     const m = await memory();
  check('unreadable_keeps_state', [m.admission, m.stale], ['HELD', true]);
  check('unreadable_keeps_last_good', m.avail, '5.0');
  step(8 * GIB);  const back = await memory();
  check('recovered', [back.admission, back.stale], ['open', false]);
  finish();
}
