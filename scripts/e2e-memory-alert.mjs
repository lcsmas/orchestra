// #289 (wave G, ledger #295; epic #284 Visibility) — ONE `escalation` bus row per memory EPISODE to the LEAD, driven end to end in a headless main-process rig: a fake MemAvailable source → the REAL guard
// (src/main/memory-guard.ts) → the REAL alert host (src/main/memory-alert-host.ts: real store, real bus, real Admission queue, real setTimeout settle) → the LEAD reads the row through the REAL BUILT CLI
// (`dist-electron/cli.js check`). Only fakes: the memory number and the guard's own timer (hand-fired; the alert's settle window is REAL — ~21 s per episode).
//
// SAFETY (D4): scratch ORCHESTRA_HOME + HOME + CLAUDE_CONFIG_DIR under ~/.cache (btrfs), refused anywhere near a live ~/.orchestra / ~/.claude*; the bus is the scratch one; no claude CLI, no network, no real run.
//
// Arms (one per process — module state is global; no arg = run them all and aggregate):
//   oscillation  jitter inside ONE Admission episode (5.5/6.5/5.9/6.9/5.2 GB — never above the 7 GB reopen) writes EXACTLY ONE escalation; recovery above 7 GB then a NEW fall writes a SECOND; the LEAD reads each
//                through the real CLI and the row names the threshold, MemAvailable and the actions (held starts, Veille, runs paused, unattributed containers)
//   critical     one sample straight below the CRITICAL threshold names BOTH thresholds in the ONE row
//   lead_rule    only the coordinator of a ROOT run with a live fleet and delivery ON is told (a delivery-OFF root, a child run and a root without a fleet are not)
//   boot_held    the alert starts while the guard is ALREADY held: the episode is told once (subscribe first, then reconcile)
//
// Run all: node --experimental-strip-types --import ./scripts/.r2-register.mjs scripts/e2e-memory-alert.mjs
//   (RIG_REPO=<other tree> points the modules AND the built CLI at that tree — the must-FAIL run on master: no alert module ⇒ zero rows)

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(process.env.RIG_REPO ?? path.join(HERE, '..'));
const ARM = process.argv[2] ?? '';
const ARMS = ['oscillation', 'critical', 'lead_rule', 'boot_held'];
const GIB = 1024 ** 3;
const SETTLE_WAIT_MS = 23_000; // ALERT_SETTLE_MS (20 s) + margin

if (!ARM) {
  const rows = [];
  for (const arm of ARMS) {
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--import', pathToFileURL(path.join(HERE, '.r2-register.mjs')).href, fileURLToPath(import.meta.url), arm], { env: { ...process.env }, encoding: 'utf8', timeout: 180_000 });
    const lastJson = (r.stdout ?? '').split('\n').reverse().find((l) => l.startsWith('{') && l.includes('"arm"'));
    let v = null;
    try { v = lastJson ? JSON.parse(lastJson) : null; } catch { /* below */ }
    rows.push({ arm, ok: v?.ok === true, detail: v ? (v.ok ? '' : (v.why ?? v.abort ?? '')) : `no verdict (exit ${r.status}) ${(r.stderr ?? '').split('\n').slice(-3).join(' ')}` });
  }
  for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.arm}${r.detail ? ` — ${r.detail}` : ''}`);
  const red = rows.filter((r) => !r.ok);
  console.log(`MEMORY-ALERT RIG: ${red.length === 0 ? 'ALL PASS' : `RED ${red.map((r) => r.arm).join(',')}`} (${rows.length - red.length}/${rows.length}) tree ${REPO}`);
  process.exit(red.length === 0 ? 0 : 1);
}
if (!ARMS.includes(ARM)) { console.error(`unknown arm: ${ARM} (expected: ${ARMS.join(', ')})`); process.exit(2); }

// ── SAFETY: scratch home under ~/.cache of the REAL home; never near a live Claude/Orchestra dir ──
const REAL_HOME = os.homedir();
const base = path.resolve(process.env.MEMALERT_RIG_HOME ?? path.join(REAL_HOME, '.cache', 'e2e-memory-alert'));
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

const out = { arm: ARM, tree: REPO };
const checks = [];
const check = (id, ok, detail = '') => { checks.push({ id, ok: !!ok, detail: String(detail).slice(0, 400) }); return !!ok; };
const verdict = (ok, extra = {}) => { console.log(JSON.stringify({ ...out, ...extra, checks, ok })); process.exit(ok ? 0 : 1); };
setTimeout(() => verdict(false, { abort: 'deadline: the arm hung' }), 150_000).unref?.();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hasAlert = fs.existsSync(path.join(REPO, 'src/main/memory-alert-host.ts'));
const hasGuard = fs.existsSync(path.join(REPO, 'src/main/memory-guard.ts'));
out.hasAlert = hasAlert;

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-e2e-memory-alert',
  broadcast: () => {}, broadcastPtyData: () => true, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {}, openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => path.join(tmpHome, '.orchestra', 'userData'), getLogsDir: () => `${tmpHome}/logs`, getAppVersion: () => '0.0.0-e2e-memory-alert', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});
(await import(`${REPO}/src/main/logger.ts`)).initLogger();
// a fresh install has no store.json (load() then leaves loadedFromDisk=false); the fleet this rig seeds is an EXISTING install
const STORE_FILE = path.join(tmpHome, '.orchestra', 'userData', 'orchestra', 'store.json');
fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
fs.writeFileSync(STORE_FILE, JSON.stringify({ repos: [], workspaces: [], accounts: [], selfTuneRuns: [] }));
const { store } = await import(`${REPO}/src/main/store.ts`);
await store.load?.();
const busMod = await import(`${REPO}/src/main/bus.ts`);
const runsMod = await import(`${REPO}/src/main/bus-runs.ts`);
busMod.initBus();
const db = busMod.getBus();
if (!db || !String(busMod.busPath()).startsWith(tmpHome)) { console.error(`SAFETY: bus resolved outside scratch: ${busMod.busPath()}`); process.exit(2); }
const { DEFAULT_BUS_SWITCHES } = await import(`${REPO}/src/shared/bus-switches.ts`);

// ── the fleet: lead ⊃ ops ⊃ w1 (delivery ON) · other (a root with delivery OFF) ⊃ o1 · empty (a root with NO live workspace below it, delivery ON) ──
const mk = (id, extra = {}) => store.upsertWorkspace({ id, name: id, kind: 'scratch', repoPath: '', baseBranch: '', branch: id, worktreePath: path.join(tmpHome, `wt-${id}`), status: 'idle', createdAt: Date.now(), hasInput: true, ...extra });
await mk('lead', { kind: 'orchestrator' });
await mk('ops', { kind: 'orchestrator', parentId: 'lead' });
await mk('w1', { parentId: 'ops' });
await mk('other', { kind: 'orchestrator' });
await mk('o1', { parentId: 'other' });
await mk('empty', { kind: 'orchestrator' });
const ON = { ...DEFAULT_BUS_SWITCHES, delivery: true };
runsMod.startRun(db, { id: 'lead', kind: 'mission', coordinator: 'lead' }, ON);
runsMod.startRun(db, { id: 'ops', kind: 'vague', coordinator: 'ops', parentRunId: 'lead' }, ON);
runsMod.startRun(db, { id: 'other', kind: 'mission', coordinator: 'other' }, { ...DEFAULT_BUS_SWITCHES }); // delivery OFF
runsMod.startRun(db, { id: 'empty', kind: 'mission', coordinator: 'empty' }, ON);

// ── the memory guard under test: the REAL sampler on a fake source + a hand-fired timer ──
let mem = 12 * GIB;
let now = Date.parse('2026-10-07T14:00:00Z');
let pending = null;
let guardMod = null;
if (hasGuard) {
  guardMod = await import(`${REPO}/src/main/memory-guard.ts`);
  guardMod.setMemoryGuardSettingsReader(() => store.getMemoryGuardSettings());
  const g = guardMod.__rebuildMemoryGuardForTests({ now: () => now, schedule: (fn, ms) => { pending = { fn, ms }; return pending; }, cancel: (h) => { if (pending === h) pending = null; } }, () => mem);
  g.start();
}
/** Set the fake memory and let the sampler's own timer fire once. */
function step(gb) { mem = gb * GIB; now += pending?.ms ?? 10_000; const p = pending; pending = null; p?.fn(); }
if (!hasGuard) verdict(false, { abort: 'no memory guard in this tree' });

// ── the alert under test (absent on MASTER → nothing ever reacts: the rig reads RED) ──
let alertHost = null;
async function startAlert() {
  alertHost = hasAlert ? await import(`${REPO}/src/main/memory-alert-host.ts`) : null;
  alertHost?.startMemoryAlert();
}

// ── the instrument: the LEAD reads its inbox through the real built CLI; counts come from the scratch bus itself ──
const CLI = path.join(REPO, 'dist-electron', 'cli.js');
if (!fs.existsSync(CLI)) verdict(false, { abort: `${CLI} not built (pnpm run build:cli)` });
function cliCheck(handle, runId) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, 'check', '--run', runId], { env: { PATH: process.env.PATH, HOME: tmpHome, ORCHESTRA_HOME: process.env.ORCHESTRA_HOME, ORCHESTRA_WS_ID: handle, ORCHESTRA_RUN_ID: runId }, stdio: ['ignore', 'pipe', 'pipe'] });
    let so = '';
    p.stdout.on('data', (c) => (so += c));
    p.on('close', () => { try { resolve(JSON.parse(so)); } catch { resolve({ raw: so.slice(0, 300), messages: [] }); } });
  });
}
const rows = () => db.prepare("SELECT run_id, sender, recipient, body FROM messages WHERE kind = 'escalation' ORDER BY sequence").all();
const ackAll = (r) => { if (r?.lot) spawnSync(process.execPath, [CLI, 'ack', String(r.lot), '--run', 'lead'], { env: { PATH: process.env.PATH, HOME: tmpHome, ORCHESTRA_HOME: process.env.ORCHESTRA_HOME, ORCHESTRA_WS_ID: 'lead', ORCHESTRA_RUN_ID: 'lead' } }); };

try {
  if (ARM === 'oscillation') {
    await startAlert();
    step(12);
    step(5.5); // Admission HELD: episode 1
    for (const gb of [6.5, 5.9, 6.9, 5.2, 6.8, 5.7]) step(gb); // hysteresis: never above the 7 GB reopen margin
    check('one_episode_control', guardMod.getMemoryGuardSnapshot().episode === 1 && guardMod.getMemoryGuardSnapshot().admission === 'held', JSON.stringify({ episode: guardMod.getMemoryGuardSnapshot().episode, admission: guardMod.getMemoryGuardSnapshot().admission }));
    check('nothing_before_settle', rows().length === 0, `${rows().length} row(s) before the settle window`);
    await sleep(SETTLE_WAIT_MS);
    check('exactly_one_escalation_for_the_oscillating_episode', rows().length === 1, `${rows().length} escalation row(s) after ${SETTLE_WAIT_MS} ms of oscillation inside ONE episode`);
    const r1 = await cliCheck('lead', 'lead');
    const esc = (r1.messages ?? []).filter((m) => m.kind === 'escalation');
    check('the_lead_reads_it_through_the_real_cli', esc.length === 1 && esc[0].sender === 'host', JSON.stringify({ n: esc.length, sender: esc[0]?.sender, lot: r1.lot }));
    const b = esc[0]?.body ?? '';
    check('names_the_threshold_and_the_memory', /below the Admission threshold \(6\.00 GB\) at 5\.50 GB/.test(b), b.split('\n')[0]);
    check('names_the_actions', /automatic fleet start\(s\) HELD/.test(b) && /put in Veille since the crossing/.test(b) && /(memory Pause on run\(s\)|no run under the memory Pause)/.test(b) && /0 unattributed container\(s\)/.test(b), b.split('\n')[1] ?? '');
    ackAll(r1);
    await sleep(SETTLE_WAIT_MS); // no later row for the same episode
    check('still_one_after_a_longer_wait', rows().length === 1, `${rows().length}`);
    step(8); // recovery above 7 GB: episode 1 over
    check('recovery_control', guardMod.getMemoryGuardSnapshot().admission === 'open', guardMod.getMemoryGuardSnapshot().admission);
    step(5.1); // a NEW downward crossing: episode 2
    check('second_episode_control', guardMod.getMemoryGuardSnapshot().episode === 2, `episode ${guardMod.getMemoryGuardSnapshot().episode}`);
    await sleep(SETTLE_WAIT_MS);
    check('a_new_crossing_after_recovery_writes_a_second', rows().length === 2 && /episode 2 /.test(rows()[1]?.body ?? ''), `${rows().length} rows; second: ${(rows()[1]?.body ?? '').split('\n')[0]}`);
    const r2 = await cliCheck('lead', 'lead');
    check('the_lead_reads_the_second_too', (r2.messages ?? []).filter((m) => m.kind === 'escalation').length === 1, JSON.stringify({ n: (r2.messages ?? []).length }));
  } else if (ARM === 'critical') {
    await startAlert();
    step(12);
    step(1.2); // admission_held AND pause_due in one sample
    await sleep(SETTLE_WAIT_MS);
    check('one_row', rows().length === 1, `${rows().length}`);
    const b = rows()[0]?.body ?? '';
    check('names_both_thresholds', /below the Admission threshold \(6\.00 GB\) at 1\.20 GB and below the CRITICAL threshold \(3\.00 GB\) at 1\.20 GB/.test(b), b.split('\n')[0]);
    step(2.5); step(8); step(2.2); // a later Pause cycle inside the SAME episode never writes another
    await sleep(SETTLE_WAIT_MS);
    check('later_pause_cycle_is_not_a_new_alert', rows().length === 1 || rows().length === 2 && /episode 2 /.test(rows()[1].body), `${rows().length} rows`);
  } else if (ARM === 'lead_rule') {
    await startAlert();
    step(12);
    step(5);
    await sleep(SETTLE_WAIT_MS);
    const who = rows().map((r) => `${r.recipient}@${r.run_id}`);
    check('only_the_root_coordinator_with_a_fleet_and_delivery_is_told', who.length === 1 && who[0] === 'lead@lead', JSON.stringify(who));
  } else if (ARM === 'boot_held') {
    step(12);
    step(5); // the guard is ALREADY held when the alert starts
    await startAlert();
    await sleep(SETTLE_WAIT_MS);
    check('boot_while_held_tells_the_episode_once', rows().length === 1 && /episode 1 /.test(rows()[0]?.body ?? ''), `${rows().length} rows`);
    step(4.5);
    await sleep(SETTLE_WAIT_MS);
    check('no_duplicate_for_the_same_episode', rows().length === 1, `${rows().length}`);
  }
} catch (e) {
  check('rig_ran_to_completion', false, String(e?.stack ?? e).slice(0, 300));
}
alertHost?.stopMemoryAlert?.();
verdict(checks.length > 0 && checks.every((c) => c.ok), { alertRows: rows().length, episodes: alertHost?.memoryAlert?.().episodes?.() ?? null });
