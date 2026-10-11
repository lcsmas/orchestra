#!/usr/bin/env node
// Pause canary 1b — the MEMORY-HOG exercise driver (#324, wave H ledger #329, ADR 0005). ONE PROCESS = ONE DRILL (agent-sdk-style singletons: one bus, one logger per ORCHESTRA_HOME); the runner (memhog-run.mjs) spawns it.
//   node --experimental-strip-types --import ./scripts/.r2-register.mjs scripts/pause-canary/memhog.mjs --base <scratch> --prefix <8 hex> [--exercise memhog|chain] [--members 3] [--cycles 3] [--switch on|off] [--sabotage <name>]
// SUBSTRATE (ledger D2: a real `claude` is ~330 MB and cannot live in a ≤300 MB scope): the REAL keeper bundle launched by the REAL keeper-client facade into REAL systemd user scopes (256 MiB), the REAL decision
// (`memoryCapSpecFor` over a REAL scratch bus), the PRODUCTION #322 sink (`memory-notice.ts` + `memory-notice-bus.ts` `sendGated`) — and the stand-in CLI of the H1 rig (scripts/memory-cap/standin-cli.cjs).
// FLEET: LEAD (mission run) ⊃ OPS (vague run, the workers' coordinator) ⊃ w1..wN, the canary's `fleetSpec`. Only the workers run sessions; LEAD and OPS are bus identities read through the real `check` relève.
// `--cli claude` (the packaged-app canary shape, ~330 MB sessions) is REFUSED here: it needs the LEAD's waiver of D2.
// Output: PC-CHECK / PC-CYCLE / PC-EXERCISE / PC-HOST / PC-CHAIN JSON lines (the pause canary's shape) + `MEMHOG-DRIVE <verdict>`. Exit 0 = measured (read the verdict), 3 = VOID (host / tooling), 1 = the driver broke.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fleetSpec } from './ids.mjs';
import { readSafe, ticks, ident, alive, scopeDirOfPid, oomKillFromDir, backstopCountersFromDir, KEEPER_LEAF, unitsNow, unitActive, hostAvailGB, scopeFactsOf, oomKillOf, rigProcesses, killByIdentity, standinCliEnv } from './memhog-os.mjs';
import { MEMHOG_BARS, evaluateMemhogCycle, summarizeMemhogCycle, evaluateChainRun, chainVerdict, backstopDelta, drillVerdict, memberToldWhy, coordinatorToldWhy, hogMarker, parseSwarm } from './memhog-bars.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const RIG_DIR = path.join(REPO, 'scripts', 'memory-cap');
const REAL_HOME = process.env.MC_REAL_HOME ?? os.homedir();   // the child's HOME is the scratch dir: the real one travels in MC_REAL_HOME
const UNIT_PREFIX = 'orchestra-rig-wh-h3-';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const EXERCISE = opt('exercise', 'memhog');
const MEMBERS = Number(opt('members', '3'));
const CYCLES = Number(opt('cycles', '3'));
const SWITCH_ON = opt('switch', 'on') !== 'off';
const SABOTAGE = opt('sabotage', null);
const CAP_GB = Number(opt('cap-gb', '0.25'));    // 256 MiB: page-aligned, ≤ 300 MB (ledger D2)
const SOFT_GB = Number(opt('soft-gb', '0.2'));
const HOG_MB = Number(opt('hog-mb', SABOTAGE === 'hog-small' ? '40' : '400'));
const HOG_HOLD_S = Number(opt('hog-hold-s', '5'));
const CHAIN_N = Number(opt('chain-n', String(MEMHOG_BARS.chainPlanned)));
const CHAIN_GAP_MS = Number(opt('chain-gap-ms', String(MEMHOG_BARS.chainGapMs)));
const MIN_AVAIL_GB = Number(opt('min-avail-gb', '6'));
const SABOTAGES = ['session', 'member-sink', 'coord-sink', 'stray-lead', 'hog-small', 'leak', 'leak-unit', 'no-worker', 'backstop'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (tag, o) => console.log(`${tag} ${JSON.stringify(o)}`);
const say = (s) => console.log(s);
const die = (code, msg) => { console.log(msg); process.exit(code); };

if (opt('cli', 'stand-in') !== 'stand-in') die(3, 'MEMHOG-DRIVE VOID — `--cli claude` needs the LEAD\'s waiver of ledger D2 (test scopes ≤ 300 MB; the real claude is ~330 MB): not run');
if (!['memhog', 'chain'].includes(EXERCISE)) die(2, `usage: --exercise memhog|chain (got ${EXERCISE})`);
if (CAP_GB > 0.3) die(3, `MEMHOG-DRIVE VOID — a test scope above 300 MB (--cap-gb ${CAP_GB}) needs the LEAD's waiver of ledger D2: not run`);
if (SABOTAGE && !SABOTAGES.includes(SABOTAGE)) die(2, `usage: --sabotage ⊂ ${SABOTAGES} (got ${SABOTAGE})`);
if (!Number.isInteger(MEMBERS) || MEMBERS < 1 || MEMBERS > 10 || !Number.isInteger(CYCLES) || CYCLES < 1 || (EXERCISE === 'chain' && CYCLES > 10)) die(2, 'usage: --members 1..10, --cycles ≥ 1 (chain: ≤ 10, one fresh worker per cycle)');
const PREFIX = opt('prefix', null);
if (!/^[0-9a-f]{8}$/.test(PREFIX ?? '')) die(2, 'usage: --prefix <8 hex> (the per-rig id prefix: workspace ids — hence keeper sockets and scope names — must be unique per rig)');
const BASE = path.resolve(opt('base', ''));
if (!opt('base', '')) die(2, 'usage: --base <scratch dir under ~/.cache>');
if (!BASE.startsWith(path.join(REAL_HOME, '.cache') + path.sep)) die(3, `MEMHOG-DRIVE VOID — refusing rig dir outside ~/.cache: ${BASE}`);

// A rig run from a capped member's Bash tool inherits oom_score_adj 1000 — and so would the keeper and the stand-in CLI it spawns, making the victim ranking meaningless: lower to the floor (0), loudly if it cannot.
try { fs.writeFileSync('/proc/self/oom_score_adj', '0'); } catch { /* not Linux / floor above 0 */ }
if (readSafe('/proc/self/oom_score_adj')?.trim() !== '0') die(3, 'MEMHOG-DRIVE VOID — this process cannot lower its oom_score_adj to 0 (the keeper/CLI baseline would be wrong)');

// the wipe below is `rm -rf`: only a directory this tooling created (the runner leaves the sentinel) or one that does not exist yet
const SENTINEL = path.join(BASE, '.memhog-scratch');
if (fs.existsSync(BASE) && !fs.existsSync(SENTINEL)) die(3, `MEMHOG-DRIVE VOID — refusing to wipe ${BASE}: no .memhog-scratch sentinel (not a directory this harness made)`);
fs.rmSync(BASE, { recursive: true, force: true });
fs.mkdirSync(BASE, { recursive: true });
fs.writeFileSync(SENTINEL, `${process.pid}\n`);
const home = path.join(BASE, 'home');
fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
process.env.ORCHESTRA_HOME = home;
process.env.HOME = home;
process.env.ORCHESTRA_MEMORY_SCOPE_PREFIX = UNIT_PREFIX;
process.env.ORCHESTRA_MEMCAP_RESERVE_BYTES = '0';   // #332: disposable scopes stay ≤ 300 MB — no scope-level backstop, the WORK leaf carries the cap (ignored by a keeper without leaves)
process.env.ORCHESTRA_KEEPER_LINGER_MS = '300000';
const { assertScratch } = await import(`${REPO}/scripts/session-budget/scratch-guard.mjs`);
const liveNames = fs.readdirSync(REAL_HOME).filter((n) => n.startsWith('.claude') || n.startsWith('.orchestra'));
assertScratch('ORCHESTRA_HOME', home, BASE, [...liveNames.map((n) => path.join(REAL_HOME, n)), path.join(REAL_HOME, '.config', 'orchestra')]);

// The daemon bundle the run EXECUTES: rebuilt when missing or older than ANY keeper/shared source (a stale bundle reproduces perfectly in isolation).
const KEEPER_JS = path.join(REPO, 'dist-electron', 'keeper.js');
const newest = (dir) => { let m = 0; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) m = Math.max(m, newest(p)); else if (!/\.test\.ts$/.test(e.name)) m = Math.max(m, fs.statSync(p).mtimeMs); } return m; };
const bundleStale = !fs.existsSync(KEEPER_JS) || Math.max(newest(path.join(REPO, 'src', 'keeper')), newest(path.join(REPO, 'src', 'shared'))) > fs.statSync(KEEPER_JS).mtimeMs;
if (bundleStale) execFileSync(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.keeper.config.ts'], { cwd: REPO, stdio: 'ignore' });
fs.copyFileSync(KEEPER_JS, path.join(home, 'bin', 'keeper.js'));

// ── the app side, as the headless rig wires it ─────────────────────────────────────────────────────────────────────
/** Everything the app would broadcast to the renderer's `agent:event` channel (the members' event streams), in order. */
const agentEvents = [];
const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-memhog-canary',
  broadcast: () => {}, broadcastPtyData: () => {}, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {}, openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => home, getLogsDir: () => `${home}/logs`, getAppVersion: () => '0.0.0-memhog-canary', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});
(await import(`${REPO}/src/main/logger.ts`)).initLogger();
const kc = await import(`${REPO}/src/main/keeper-client.ts`);
const capSwitch = await import(`${REPO}/src/main/memory-cap-switch.ts`);
const { makeMemNotice } = await import(`${REPO}/src/shared/mem-notice.ts`);
const memNoticeMod = await import(`${REPO}/src/main/memory-notice.ts`);
const { sendGated } = await import(`${REPO}/src/main/memory-notice-bus.ts`);

const spec = fleetSpec(EXERCISE === 'chain' ? Math.max(1, CYCLES) : MEMBERS, PREFIX);
const NAMES = Object.fromEntries([[spec.lead, 'pc-lead'], [spec.ops, 'pc-ops'], ...spec.workers.map((w) => [w.id, `pc-${w.k}`])]);

// A REAL scratch bus: LEAD's mission run and OPS's vague run (parent LEAD) — the worker's `memory_cap` switch is FROZEN on the vague run, as at a wave start.
let settings = { capSoftGb: SOFT_GB, capHardGb: CAP_GB };
let busDb;
let bus;
try {
  bus = await import(`${REPO}/src/main/bus.ts`);
  const { startRun } = await import(`${REPO}/src/main/bus-runs.ts`);
  const { DEFAULT_BUS_SWITCHES } = await import(`${REPO}/src/shared/bus-switches.ts`);
  bus.initBus();
  busDb = bus.getBus();
  const sw = { ...DEFAULT_BUS_SWITCHES, liveness: true };   // liveness ON: the mechanism the shipped sink's gate follows (#322 review round 2 F6)
  startRun(busDb, { id: spec.lead, kind: 'mission', coordinator: spec.lead }, sw);
  startRun(busDb, { id: spec.ops, kind: 'vague', coordinator: spec.ops, parentRunId: spec.lead }, { ...sw, memoryCap: SWITCH_ON });
  const { store } = await import(`${REPO}/src/main/store.ts`);
  await store.load?.();
  await store.setMemoryGuardSettings({ ...store.getMemoryGuardSettings(), capSoftGb: SOFT_GB, capHardGb: CAP_GB });
  settings = store.getMemoryGuardSettings();
} catch (e) {
  die(/NODE_MODULE_VERSION|better_sqlite3|bindings/.test(String(e)) ? 3 : 1, `MEMHOG-DRIVE ${/NODE_MODULE_VERSION|better_sqlite3|bindings/.test(String(e)) ? 'VOID' : 'ERROR'} — scratch bus: ${String(e?.message ?? e).slice(0, 300)}`);
}
try { kc.installKeeper(); } catch { /* the driver copies the bundle itself; installKeeper also lays down the oom wrapper */ }

// ── observation helpers (read from /proc and cgroupfs, never from the subject's own opinion) ────────────────────────
const pidFilePid = (ws) => { try { return JSON.parse(fs.readFileSync(path.join(home, 'keepers', `${ws}.pid`), 'utf8')).pid; } catch { return null; } };
async function waitFor(pred, ms, step = 50) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return true; await sleep(step); } return !!(await pred()); }
const armUnits = (ws) => unitsNow(`${UNIT_PREFIX}${ws}-*`);

/** A facade (what the SDK's query() gets) over the stand-in CLI — the H1 rig's, unchanged. */
function open(ws, launch, { rssMb = 80 } = {}) {
  const st = { ws, lines: [], attached: false, exited: false, errors: [] };
  const h = kc.makeKeeperSpawn(ws, () => { st.attached = true; }, undefined, launch)({
    command: process.execPath, args: [path.join(RIG_DIR, 'standin-cli.cjs')], cwd: BASE,
    env: standinCliEnv(home, rssMb), signal: new AbortController().signal,
  });
  let buf = '';
  h.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { st.lines.push(JSON.parse(l)); } catch { /* not json */ } }
  });
  h.on('error', (e) => st.errors.push(String(e?.message ?? e)));
  h.on('exit', () => { st.exited = true; });
  st.h = h;
  st.send = (o) => h.stdin.write(JSON.stringify(o) + '\n');
  return st;
}
const initOf = (st) => st.lines.find((l) => l.type === 'system' && l.subtype === 'init');
const resultOf = (st, id) => st.lines.find((l) => l.type === 'user' && l.tool_result?.id === id)?.tool_result;
async function runTool(st, cmd, id, ms = 60_000) { st.send({ tool: cmd, id }); await waitFor(() => resultOf(st, id) || st.exited, ms, 100); return resultOf(st, id) ?? null; }
/** The decision exactly as agent-sdk.ts makes it (same function, same inputs): the worker's wave run is OPS's vague run, its coordinator is OPS. */
const decide = (ws) => capSwitch.memoryCapSpecFor({ wsId: ws, runId: spec.ops, ws: { parentId: spec.ops }, remote: false, settings });

// ── the PRODUCTION #322 sink, wired the way index.ts wires it (real bus, real gate, real builder; the workspace map is the fleet's) ─────────────────────
const fakeWs = new Map();
fakeWs.set(spec.lead, { id: spec.lead, name: NAMES[spec.lead], branch: NAMES[spec.lead], runId: spec.lead });
fakeWs.set(spec.ops, { id: spec.ops, name: NAMES[spec.ops], branch: NAMES[spec.ops], parentId: spec.lead, runId: spec.ops });
for (const w of spec.workers) fakeWs.set(w.id, { id: w.id, name: NAMES[w.id], branch: NAMES[w.id], parentId: spec.ops, runId: spec.ops });
const sinkLogs = [];
const coordSent = [];   // { at, wsId, kind } — when the coordinator's message was written
let seq = 1;
const sinkDeps = {
  getWorkspace: (id) => fakeWs.get(id),
  patchWorkspace: async (id, patch) => { fakeWs.set(id, { ...fakeWs.get(id), ...patch }); },
  emitLive: (wsId, entry) => { if (SABOTAGE === 'member-sink') return; agentEvents.push({ wsId, at: Date.now(), ev: makeMemNotice({ seq: seq++ }, entry) }); },
  sendToCoordinator: (m) => {
    if (SABOTAGE === 'coord-sink') return 'sent';   // control: the escalation is silently dropped
    const r = sendGated(busDb, m, { warn: (x) => console.error(`  sink: ${x}`) });   // the SHIPPED gate, on the scratch bus
    coordSent.push({ at: Date.now(), wsId: m.sender, kind: m.kind });
    if (SABOTAGE === 'stray-lead') sendGated(busDb, { ...m, runId: spec.lead, recipient: spec.lead }, { warn: () => {} });   // control: a copy to the coordinator's coordinator
    return r;
  },
  resolveRunId: (w) => w.runId ?? spec.ops,
  log: { info: (m) => sinkLogs.push(m), warn: (m) => console.error(`  sink: ${m}`) },
};
const kills = [];   // distinct kill records (a retried delivery calls the listeners again — at-least-once; the sink dedupes, a bare list must too)
const seenRec = new Set();
const noteRec = (ws, rec) => { const k = `${ws}:${rec.unit}:${rec.seq}`; if (seenRec.has(k)) return; seenRec.add(k); kills.push({ ws, ...rec }); };
kc.onMemoryKill((ws, rec) => noteRec(ws, rec));
if (EXERCISE === 'memhog') memNoticeMod.startMemoryNotices(sinkDeps, { onMemoryKill: kc.onMemoryKill, onMemorySoft: kc.onMemorySoft });
const isSoftText = (t) => /warning level \(/.test(t ?? '');
const notified = async (wsId) => { await memNoticeMod.__memNoticeIdle(wsId); };

let leak = null;   // { pid, ticks } of the control's deliberate leftover process — left alone by teardown so the PARENT's survivors report must see it
let leakPid = null;
const sessions = new Map();   // ws → st
async function teardown() {
  const ids = spec.workers.map((w) => w.id);
  for (const ws of ids) { try { kc.forbidKeeperLaunch?.(ws); await kc.killKeeper(ws, 'memhog-canary'); } catch { /* best effort */ } }
  await sleep(300);
  for (const ws of ids) for (const u of armUnits(ws)) spawnSync('systemctl', ['--user', 'stop', u], { encoding: 'utf8' });   // by NAME: rig prefix + this rig's ws id
  await sleep(300);
  // whatever still carries this drill's marker (exact `ORCHESTRA_HOME=<home>` in its environment; never an ancestor, never a wrapper whose argv merely names the path), identity re-read at signal time —
  // except the control's deliberate leak, which the PARENT's survivors report must catch
  killByIdentity(rigProcesses(home).filter((p) => !(leak && p.pid === leak.pid && p.ticks === leak.ticks)), home);
  await sleep(200);
}

const hostSamples = [];
const sampleHost = () => { hostSamples.push(hostAvailGB()); };
const hostBelow = () => hostAvailGB() < MIN_AVAIL_GB;
const startedAt = Date.now();
let verdict = 'ERROR';
let hostVoid = false;   // VOID because the HOST dipped under the bar (exit 3) — a Q9 chain whose premise failed is a VOID VERDICT, not a void run
const allChecks = [];
/** SABOTAGE `backstop` (the #343 witness): shrink the KEEPER leaf's limit below what its keeper + CLI hold in anonymous memory, so the kernel kills something INSIDE `k` — the very shape of a scope-backstop episode. Only ever on a scope carrying the rig prefix. */
async function injectBackstopKill(keeperPid, cliPid) {
  const sd = scopeDirOfPid(keeperPid);
  if (!sd || !path.basename(sd).startsWith(UNIT_PREFIX)) { say('   SABOTAGE backstop: no rig scope for that keeper — nothing injected'); return null; }
  const kd = path.join(sd, KEEPER_LEAF);
  const anon = Number(/^anon (\d+)$/m.exec(readSafe(path.join(kd, 'memory.stat')) ?? '')?.[1]);
  if (!Number.isFinite(anon) || anon <= 0) { say('   SABOTAGE backstop: the keeper leaf has no readable anon figure — nothing injected'); return null; }
  const limit = Math.max(4 * 1024 * 1024, Math.floor(anon * 0.4));
  fs.writeFileSync(path.join(kd, 'memory.max'), String(limit));
  say(`   SABOTAGE backstop: k/memory.max ${limit} B (anon ${anon} B) — waiting for a kill inside the keeper leaf`);
  let seen = null;
  await waitFor(() => { const b = backstopCountersFromDir(sd); if (b) seen = b; return (b && b.k > 0) || !alive(keeperPid) || !alive(cliPid); }, 20_000, 250);
  return { counters: seen };   // the counters AS THEY WERE when the kill showed: the scope may be gone a moment later
}
const report = (exercise, cycle, checks) => { for (const c of checks) { allChecks.push({ exercise, cycle, ...c }); emit('PC-CHECK', { exercise, cycle, id: c.id, ok: c.ok, detail: c.detail }); say(`${c.ok ? 'ok ' : 'RED'} ${exercise} c${cycle} ${c.id} — ${c.detail}`); } };

try {
  sampleHost();
  if (args.includes('--dry')) {
    // WIRING SMOKE (no scope, no keeper, no kill — light): the production sink + the scratch bus + the coordinator's real relève + the bars' predicates, fed ONE synthetic kill record per worker.
    const d0 = decide(spec.workers[0].id);
    say(`dry: switch ${SWITCH_ON ? 'ON' : 'OFF'} → decision ${d0 ? JSON.stringify(d0).slice(0, 160) : 'none (no scope)'}`);
    const seq0 = busDb.prepare('SELECT COALESCE(MAX(sequence), 0) AS s FROM messages').get().s;
    for (const w of spec.workers) memNoticeMod.handleMemRecord(sinkDeps, w.id, { kind: 'kill', source: 'kernel', seq: 1, at: Date.now(), level: 'hard', command: `python3 swarm.py 1 ${HOG_MB} ${HOG_HOLD_S} memhog-${w.k}-c1`, pid: 4242, rssBytes: null, candidates: [], unit: `${UNIT_PREFIX}${w.id}-dry.scope`, hardBytes: Math.round(CAP_GB * 1024 ** 3) });
    for (const w of spec.workers) await notified(w.id);
    const lot = bus.check(busDb, spec.ops, spec.ops, 500);
    const lead = busDb.prepare('SELECT COUNT(*) AS n FROM messages WHERE recipient = ? AND sequence > ?').get(spec.lead, seq0).n;
    let bad = 0;
    for (const w of spec.workers) {
      const wk = { id: w.id, oomKillDelta: 1, memberKillRows: agentEvents.filter((e) => e.wsId === w.id && !isSoftText(e.ev.text)).map((e) => e.ev.text), coordMsgs: busDb.prepare('SELECT kind, recipient, body FROM messages WHERE sender = ? AND sequence > ?').all(w.id, seq0), coordRead: lot.messages.filter((x) => x.sender === w.id && x.kind === 'escalation').length };
      const a = memberToldWhy(wk, { capGb: CAP_GB }); const b = coordinatorToldWhy(wk, { capGb: CAP_GB, opsId: spec.ops });
      say(`dry: ${w.k} member=${a ?? 'ok'} coordinator=${b ?? 'ok'} row="${wk.memberKillRows[0] ?? ''}"`);
      if (a || b) bad++;
    }
    say(`dry: OPS relève ${lot.messages.length} message(s), LEAD saw ${lead}, sink logs ${sinkLogs.length}`);
    verdict = bad === 0 && lead === 0 ? 'DRY-OK' : 'DRY-RED';
  } else if (EXERCISE === 'memhog') {
    // ── open the fleet: every worker's keeper in its own scope (or NOT, with the switch OFF) ───────────────────────────
    const decisions = spec.workers.map((w) => decide(w.id));
    const never = SABOTAGE === 'no-worker' ? spec.workers[0].id : null;   // control: the first worker's session is never started — the « fleet is up » instrument must say so
    for (const w of spec.workers) sessions.set(w.id, w.id === never ? { ws: w.id, lines: [], attached: false, exited: true, errors: ['sabotage no-worker: never started'], send: () => {}, h: null } : open(w.id, decisions[spec.workers.indexOf(w)]));
    const up = await Promise.all(spec.workers.map((w) => (w.id === never ? Promise.resolve([w.id, false]) : waitFor(() => initOf(sessions.get(w.id)), 45_000).then((ok) => [w.id, ok]))));
    const upMap = new Map(up);
    say(`fleet: ${spec.workers.length} worker(s) up=${up.filter(([, ok]) => ok).length} · switch ${SWITCH_ON ? 'ON' : 'OFF'} · scope decision ${decisions[0] ? 'scope' : 'none'} · cap ${CAP_GB} GB · hog ${HOG_MB} MB${SABOTAGE ? ` · SABOTAGE ${SABOTAGE}` : ''}`);
    const idsOf = new Map();
    for (const w of spec.workers) { const st = sessions.get(w.id); const kp = pidFilePid(w.id); idsOf.set(w.id, { keeperPid: kp, keeperId: ident(kp), cliPid: initOf(st)?.pid ?? null, cliId: ident(initOf(st)?.pid) }); }
    if (SABOTAGE === 'leak') {   // `sleep` itself (detached = its own session): the pid we hold IS the leftover process, and it inherits the marker
      const c = spawn('sleep', ['3000'], { detached: true, stdio: 'ignore', env: process.env }); c.unref(); leakPid = c.pid; await sleep(200);
      leak = { pid: c.pid, ticks: ticks(c.pid) };
    }
    if (SABOTAGE === 'leak-unit') {   // a ≤ 64 MB transient unit carrying the rig prefix + this rig's id prefix, never stopped by the drill: the PARENT's scope count must see it
      const r = spawnSync('systemd-run', ['--user', '--collect', `--unit=${UNIT_PREFIX}${PREFIX}-leak`, '-p', 'MemoryMax=64M', 'sleep', '3000'], { encoding: 'utf8' });
      say(`leak-unit: systemd-run rc=${r.status} ${String(r.stderr).trim().slice(0, 120)}`);
    }

    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      if (hostBelow()) { emit('PC-EXERCISE', { exercise: 'memhog', result: 'VOID', cycles: cycle - 1, wanted: CYCLES, reason: `host below the ${MIN_AVAIL_GB} GB bar (MemAvailable ${hostAvailGB().toFixed(2)} GB)` }); verdict = 'VOID'; hostVoid = true; break; }
      sampleHost();
      const ev0 = agentEvents.length;
      const seq0 = busDb.prepare('SELECT COALESCE(MAX(sequence), 0) AS s FROM messages').get().s;
      const rec0 = new Map(spec.workers.map((w) => [w.id, kills.filter((k) => k.ws === w.id).length]));
      const oomAt = (w) => oomKillOf(idsOf.get(w.id).keeperPid);
      const lastOom = new Map(spec.workers.map((w) => [w.id, oomAt(w)]));
      const oom0 = new Map(lastOom);
      const bsAt = (w) => backstopCountersFromDir(scopeDirOfPid(idsOf.get(w.id).keeperPid));
      const bs0 = new Map(spec.workers.map((w) => [w.id, bsAt(w)]));
      const lastBs = new Map(bs0);
      const refreshBs = () => { for (const w of spec.workers) { const b = bsAt(w); if (b) lastBs.set(w.id, b); } };
      // all hogs at once: each worker's tool command touches HOG_MB in 10 MB steps 0.1 s apart (slow enough for the keeper's snapshot to see it by name) — far more than the scope holds
      const t0 = Date.now();
      for (const w of spec.workers) { if (upMap.get(w.id)) sessions.get(w.id).send({ tool: `python3 ${RIG_DIR}/swarm.py 1 ${HOG_MB} ${HOG_HOLD_S} ${hogMarker(w.k, cycle)}`, id: `hog-c${cycle}` }); }
      await Promise.all(spec.workers.map((w) => waitFor(() => resultOf(sessions.get(w.id), `hog-c${cycle}`) || sessions.get(w.id).exited || !upMap.get(w.id), 120_000, 100)));
      // settle: the kernel counts stop moving (two readings 1.5 s apart), then the kernel-log lookup + delivery
      let prev = '';
      await waitFor(() => { const cur = spec.workers.map((w) => { const v = oomAt(w); if (v !== null) lastOom.set(w.id, v); return lastOom.get(w.id); }).join(','); refreshBs(); const stable = cur === prev; prev = cur; return stable; }, 40_000, 1500);
      // the notices are DUE for every kill the kernel counted: wait for them (the keeper's kernel-log lookup + delivery take a moment — a fixed sleep would read a late one as a bug), then a beat so a surplus (a duplicate) can show
      const killRowsOf = (w) => agentEvents.slice(ev0).filter((e) => e.wsId === w.id && e.ev?.type === 'notice' && !isSoftText(e.ev.text)).length;
      const dueOf = (w) => { const a = lastOom.get(w.id), b = oom0.get(w.id); return typeof a === 'number' && typeof b === 'number' ? Math.max(0, a - b) : 0; };
      await waitFor(async () => {
        for (const w of spec.workers) {
          const d = dueOf(w);
          if (d === 0) continue;
          await notified(w.id);
          if (killRowsOf(w) < d || kills.filter((k) => k.ws === w.id).length - rec0.get(w.id) < d || coordSent.filter((x) => x.wsId === w.id && x.kind === 'escalation' && x.at >= t0).length < d) return false;
        }
        return true;
      }, 30_000, 500);
      await sleep(1500);
      for (const w of spec.workers) await notified(w.id);
      if (SABOTAGE === 'session' && cycle === 1) {   // control: the first worker's CLI is SIGTERMed after the kill — the session instrument must see a REPLACED/GONE CLI (identity re-read at signal time)
        const w1 = spec.workers[0]; const ids = idsOf.get(w1.id);
        if (ids.cliPid && ident(ids.cliPid) === ids.cliId) { process.kill(ids.cliPid, 'SIGTERM'); await waitFor(() => !alive(ids.cliPid), 10_000); }
      }
      if (SABOTAGE === 'backstop' && cycle === 1) { const w1 = spec.workers[0]; const ids = idsOf.get(w1.id); const inj = await injectBackstopKill(ids.keeperPid, ids.cliPid); if (inj?.counters) lastBs.set(w1.id, inj.counters); }
      refreshBs();
      // read the world: the coordinator reads its OWN relève (the real `check`), then acks it as the coordinator would
      const lot = bus.check(busDb, spec.ops, spec.ops, 500);
      if (lot.delivery) bus.ack(busDb, spec.ops, spec.ops, lot.delivery.id);
      const leadSeen = busDb.prepare('SELECT COUNT(*) AS n FROM messages WHERE recipient = ? AND sequence > ?').get(spec.lead, seq0).n;
      const workers = [];
      for (const w of spec.workers) {
        const st = sessions.get(w.id); const pre = idsOf.get(w.id); const marker = hogMarker(w.k, cycle);
        const kp = pre.keeperPid; const scope = scopeFactsOf(kp, UNIT_PREFIX);
        const sw = parseSwarm(resultOf(st, `hog-c${cycle}`)?.stdout);
        const oomNow = lastOom.get(w.id); const delta = oomNow === null || oom0.get(w.id) === null ? null : oomNow - oom0.get(w.id);
        const probe = alive(pre.cliPid) ? await runTool(st, `echo alive-${w.k}-c${cycle}`, `probe-c${cycle}`, 20_000) : null;
        const pr = alive(kp) ? await kc.probeKeeper(w.id) : null;
        const rows = agentEvents.slice(ev0).filter((e) => e.wsId === w.id && e.ev?.type === 'notice');
        const killRows = rows.filter((e) => !isSoftText(e.ev.text));
        const msgs = busDb.prepare('SELECT sequence, kind, recipient, body FROM messages WHERE sender = ? AND sequence > ? ORDER BY sequence').all(w.id, seq0);
        workers.push({
          k: w.k, id: w.id, up: upMap.get(w.id) === true, marker,
          scope,
          swarm: sw,
          oomKillDelta: delta,
          records: kills.filter((k) => k.ws === w.id).slice(rec0.get(w.id)).map((k) => ({ level: k.level, command: k.command ?? null, pid: k.pid, source: k.source })),
          backstop: backstopDelta(bs0.get(w.id), lastBs.get(w.id)),
          session: { keeperAlive: alive(kp), cliAlive: alive(pre.cliPid), keeperSame: alive(kp) && ident(kp) === pre.keeperId, cliSame: alive(pre.cliPid) && ident(pre.cliPid) === pre.cliId, answered: probe?.code === 0 && (probe.stdout ?? '').includes(`alive-${w.k}-c${cycle}`), scopeActive: unitActive(scope.unit), capState: pr?.cap?.state ?? null },
          memberKillRows: killRows.map((e) => e.ev.text), softRows: rows.length - killRows.length,
          coordMsgs: msgs.map((x) => ({ kind: x.kind, recipient: x.recipient, body: x.body })),
          coordRead: lot.messages.filter((x) => x.sender === w.id && x.kind === 'escalation' && x.sequence > seq0).length,
          firstRowMs: killRows.length ? Math.min(...killRows.map((e) => e.at)) - t0 : null,
          firstEscMs: (() => { const c = coordSent.filter((x) => x.wsId === w.id && x.kind === 'escalation' && x.at >= t0); return c.length ? Math.min(...c.map((x) => x.at)) - t0 : null; })(),
        });
      }
      const maxMs = (key) => (workers.every((x) => typeof x[key] === 'number') ? Math.max(...workers.map((x) => x[key])) / 1000 : null);
      const m = { exercise: 'memhog', cycle, expectWorkers: spec.workers.length, capGb: CAP_GB, opsId: spec.ops, leadSeen, workers, tMemberToldS: maxMs('firstRowMs'), tCoordToldS: maxMs('firstEscMs') };
      const checks = evaluateMemhogCycle(m);
      const summary = summarizeMemhogCycle(m);
      report('memhog', cycle, checks);
      emit('PC-CYCLE', { exercise: 'memhog', cycle, expectWorkers: m.expectWorkers, mode: 'memhog', summary, tMemberToldS: m.tMemberToldS, tCoordToldS: m.tCoordToldS, softRows: workers.reduce((a, x) => a + x.softRows, 0), checks });
      await sleep(1000);
    }
    if (verdict !== 'VOID') {
      const mine = allChecks.filter((c) => c.exercise === 'memhog');
      verdict = drillVerdict(mine);
      emit('PC-EXERCISE', { exercise: 'memhog', result: verdict, cycles: CYCLES, wanted: CYCLES });
    }
  } else {
    // ── Q9 chain (residual (d) of #320, ledger c/6070521692): single tool commands OOM-killed ONE AFTER THE OTHER, stand-in CLI at 0 MB as in the H1 repro. A BAR since #332 closed Q9: a lost session, or any scope-backstop kill (#343), is RED. ──
    const runs = [];
    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      if (hostBelow()) { emit('PC-EXERCISE', { exercise: 'chain', result: 'VOID', cycles: cycle - 1, wanted: CYCLES, reason: `host below the ${MIN_AVAIL_GB} GB bar` }); verdict = 'VOID'; hostVoid = true; break; }
      sampleHost();
      const w = spec.workers[cycle - 1];
      const st = open(w.id, decide(w.id), { rssMb: 0 });
      sessions.set(w.id, st);
      await waitFor(() => initOf(st), 45_000);
      const kp = pidFilePid(w.id); const cliPid = initOf(st)?.pid ?? null;
      const sdir = kp ? scopeDirOfPid(kp) : null;   // the scope itself, whether the keeper sits in it or in its keeper leaf (#332)
      const inScope = !!sdir && path.basename(sdir).startsWith(UNIT_PREFIX);
      const oomOf = () => oomKillFromDir(sdir) ?? undefined;   // re-resolved at each reading: the work leaf appears at keeper boot
      const oom0 = sdir ? oomOf() ?? 0 : 0;
      let lastKills = 0; let done = 0; let lostAfter = null;
      const bs0 = backstopCountersFromDir(sdir); let lastBs = bs0;
      for (let i = 0; i < CHAIN_N; i++) {
        if (SABOTAGE === 'backstop' && i === 3) { const inj = await injectBackstopKill(kp, cliPid); if (inj?.counters) lastBs = inj.counters; }   // the #343 witness, mid-chain
        await runTool(st, `python3 -c 'b = bytearray(b"\\xa5") * (400 * 1024 * 1024)'`, `t-chain-${i}`, 30_000);
        done++;
        await sleep(CHAIN_GAP_MS);
        const ev = alive(kp) && sdir ? oomOf() : undefined;
        if (ev !== undefined) lastKills = ev - oom0;   // the last reading while the scope exists
        { const b = alive(kp) && sdir ? backstopCountersFromDir(sdir) : null; if (b) lastBs = b; }
        if (!alive(kp) || !alive(cliPid)) { lostAfter = lastKills; break; }
      }
      const keeperAlive = alive(kp); const cliAlive = alive(cliPid);
      let probe = null;   // three tries: ONE flaky answer must not read as a lost session (a flaky answer would otherwise fail a fixed chain)
      for (let k = 0; k < 3 && keeperAlive && cliAlive && !(probe?.code === 0 && (probe.stdout ?? '').includes('chain-alive')); k++) probe = await runTool(st, 'echo chain-alive', `t-chain-probe${k}`, 20_000);
      const r = { cycle, planned: CHAIN_N, done, killsTotal: inScope ? lastKills : 0, lostAfter, backstop: backstopDelta(bs0, lastBs), keeperAlive, cliAlive, answered: probe?.code === 0 && (probe.stdout ?? '').includes('chain-alive'), inScope, cliSeen: cliPid !== null };
      const checks = evaluateChainRun(r);
      runs.push(checks);
      emit('PC-CHAIN', r);
      report('chain', cycle, checks);
      try { kc.forbidKeeperLaunch?.(w.id); await kc.killKeeper(w.id, 'memhog-canary-chain'); } catch { /* best effort */ }
      for (const u of armUnits(w.id)) spawnSync('systemctl', ['--user', 'stop', u], { encoding: 'utf8' });
      await sleep(500);
    }
    if (verdict !== 'VOID') { const cv = chainVerdict(runs); verdict = cv.verdict; emit('PC-EXERCISE', { exercise: 'chain', result: cv.verdict, cycles: CYCLES, wanted: CYCLES, detail: cv.detail }); say(`chain: ${cv.verdict} — ${cv.detail}`); }
  }
  sampleHost();
} catch (e) {
  emit('DRIVE-ERROR', { error: String(e?.stack ?? e).slice(0, 600) });
  verdict = 'ERROR';
} finally {
  await teardown();
}
emit('PC-HOST', { minAvailGB: Math.min(...hostSamples), samples: hostSamples.length, sabotage: SABOTAGE, leakPid });
console.log(`MEMHOG-DRIVE ${verdict}${leakPid ? ` leakPid=${leakPid}` : ''} (${((Date.now() - startedAt) / 1000).toFixed(0)} s)`);
process.exit(hostVoid ? 3 : verdict === 'ERROR' || verdict === 'DRY-RED' ? 1 : 0);
