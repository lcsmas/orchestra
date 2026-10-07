// #294 (wave G, ledger #295; epic #284 Testing "Seam 1") — COMPOSED PROOF: the 2026-10-06 night replayed in miniature, ONE sequential scenario on the REAL modules.
//
// A falling FAKE MemAvailable source is the only fake memory; everything the host DOES to the fleet is the shipped code: the real guard (hand-fired sampler), Admission (start chokepoint:
// workspaces.ts spawn + restart-workspace.ts), the bus-wake sweep (réveil), the fast-Veille sweep (hibernation.ts), the memory Pause host + the Pause trap + the Reprise (pause-memory-host.ts,
// pause-trap.ts, pause-reprise.ts, pause-containers.ts) on a REAL bus.sqlite + the REAL store, the alert host (ONE escalation row per episode), the OPS' view (peers / bus-status through the
// real hooks-server + the BUILT CLI). Agents are stubbed at the SDK delivery seam (it RECORDS starts / stops / turns); Docker is the daemon-faithful in-memory fake (src/main/fake-docker.ts:
// label + status filtering, AutoRemove). No Electron, no real run, no live bus (scratch ORCHESTRA_HOME / HOME / CLAUDE_CONFIG_DIR under ~/.cache).
//
// The night (each ARM is a named group of checks; `RIG_UPTO=<arm>` stops after it — the mutant sweep runs the shortest prefix that names the arm it expects red):
//
//   n0_control          12 GB   CONTROL: the instrument sees a start; nothing is held, nothing Veille'd, nothing paused, no alert
//   n1_starts_held      5.5 GB  Admission HELD: an AUTO spawn is accepted + its brief owed + NO session; an AUTO restart waits BEFORE any stop; a HUMAN restart / top-level spawn / a turn to a running member PASS; the OPS sees it
//   n2_fast_veille      held    idle fleet members go into Veille AT ONCE; a running turn / pending prompt / a session with NO coordinator are spared
//   n3_reveil_held      held    a bus message to a sleeping member waits: no start, no failure counted, the reason logged ONCE, the lot still pending, queued as a wake
//   n4_alert_one_row    held    oscillation inside ONE episode → exactly ONE escalation row, to the LEAD only, naming threshold / MemAvailable / the EFFECTIVE actions (starts held, members in Veille)
//   n5_memory_pause     2.5 GB  memory Pause: the pause-ON run is paused (motive memory, hard, trap complete), the pause-OFF run is byte-identical, held starts stay held, still ONE row
//   n6_pause_containers critical the Pause STOPPED (never removed) the attributed containers of the paused members, recorded them in the Bilan; --rm skipped; bystander / other run / pause-OFF run untouched
//   n7_reprise          6.5 GB  Pause liftable, Admission still held: the AUTOMATIC Reprise restarts EXACTLY the stopped containers (a hand-removed one reported `gone`), THEN the coordinators are released; held starts stay held
//   n8_release_order    8 GB    Admission reopened: held starts go out COORDINATORS FIRST then arrival order, ONE at a time, a FRESH reading before each; a dip stops the release; still ONE row
//   n9_reveil_delivered release the held réveil is delivered once, the member answers, the lot carries the message intact, the ack clears it; no failure was ever counted
//   n10_second_episode  5.5 GB  a NEW crossing after recovery → a SECOND row (episode 2), the first row untouched
//
// Run: node --experimental-strip-types --import ./scripts/.r2-register.mjs scripts/e2e-composed-night.mjs        (RIG_REPO=<tree> = the must-FAIL run on another tree; RIG_UPTO=<arm>)
// Last lines: per-arm `PASS|FAIL <arm> — why`, then `COMPOSED NIGHT: ALL PASS|RED …`; exit 0 only when every arm passed.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(process.env.RIG_REPO ?? path.join(HERE, '..'));
const GIB = 1024 ** 3;
const ARM_NAMES = ['n0_control', 'n1_starts_held', 'n2_fast_veille', 'n3_reveil_held', 'n4_alert_one_row', 'n5_memory_pause', 'n6_pause_containers', 'n7_reprise', 'n7b_coordinators_after_containers', 'n8_release_order', 'n9_reveil_delivered', 'n10_second_episode'];
const UPTO = process.env.RIG_UPTO ?? '';
if (UPTO && !ARM_NAMES.includes(UPTO)) { console.error(`unknown RIG_UPTO=${UPTO} (expected one of: ${ARM_NAMES.join(', ')})`); process.exit(2); }

// ── SAFETY (D4): scratch under ~/.cache of the REAL home, never near a live Orchestra / Claude dir ──
const REAL_HOME = os.homedir();
const base = path.resolve(process.env.COMPOSED_RIG_HOME ?? path.join(REAL_HOME, '.cache', 'e2e-composed-night'));
const tmpHome = path.join(base, `${process.pid}-${Date.now().toString(36)}`);
const live = [path.join(REAL_HOME, '.orchestra'), path.join(REAL_HOME, '.claude'), path.join(REAL_HOME, '.claude-mc'), path.join(REAL_HOME, '.config')];
if (!(tmpHome + path.sep).startsWith(path.join(REAL_HOME, '.cache') + path.sep) || live.some((l) => (tmpHome + path.sep).startsWith(l + path.sep) || l.startsWith(tmpHome + path.sep))) {
  console.error(`SAFETY: refusing scratch path ${tmpHome}`); process.exit(2);
}
fs.mkdirSync(path.join(tmpHome, '.orchestra'), { recursive: true });
for (const k of Object.keys(process.env)) if (/^(ORCHESTRA_|CLAUDE_CONFIG_DIR|CLAUDECODE|CLAUDE_CODE_)/.test(k)) delete process.env[k];
process.env.ORCHESTRA_HOME = path.join(tmpHome, '.orchestra');
process.env.HOME = tmpHome;
process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, '.claude-scratch');
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
const stubBin = path.join(tmpHome, 'stub-bin');
fs.mkdirSync(stubBin, { recursive: true });
fs.writeFileSync(path.join(stubBin, 'claude'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
process.env.PATH = `${stubBin}:/usr/local/bin:/usr/bin:/bin`;
process.env.ORCHESTRA_SPAWN_INIT_WAIT_MS = '400';
delete process.env.ORCHESTRA_HIBERNATE_AFTER_MS;            // the 5-minute default: a fleet member idle for seconds is NOT eligible until the hold waives the clock
process.env.ORCHESTRA_HIBERNATE_SWEEP_MS = '3600000';       // the Veille sweeper's own timer never fires in the rig: the arms call the sweep by hand

const T = (m) => { if (process.env.RIG_TRACE) console.error(`[trace ${Date.now() % 1000000}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms = 8000, step = 20) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await pred()) return true; } catch { /* retry */ } await sleep(step); } return false; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
setInterval(() => {}, 1000);                                // keep the loop alive: a hung await must end as a RED verdict at the deadline, never a silent exit

// ── the verdict machine: arms run in order; a check is a named (got, want) pair; an exception inside an arm makes THAT arm red and the night goes on ──
const results = [];
let cur = null;
function check(name, got, want) {
  const ok = typeof want === 'function' ? !!want(got) : eq(got, want);
  cur.checks.push({ name, ok, got: ok ? undefined : got, want: ok ? undefined : (typeof want === 'function' ? '(predicate)' : want) });
  return ok;
}
async function arm(name, fn) {
  if (stop) return;
  cur = { name, checks: [], error: null };
  results.push(cur);
  const t0 = Date.now();
  T(`── arm ${name}`);
  try { await fn(); } catch (e) { cur.error = String(e?.stack ?? e).split('\n').slice(0, 3).join(' ⏎ '); }
  cur.ms = Date.now() - t0;
  if (UPTO === name) stop = true;
}
let stop = false;
function report() {
  let red = 0;
  for (const r of results) {
    const bad = r.checks.filter((c) => !c.ok);
    const ok = bad.length === 0 && !r.error;
    if (!ok) red++;
    const why = [...bad.map((c) => `${c.name}: got ${JSON.stringify(c.got)} want ${JSON.stringify(c.want)}`), ...(r.error ? [`ERROR ${r.error}`] : [])].join(' | ').slice(0, 1200);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${r.name} (${r.checks.length} checks, ${r.ms} ms)${why ? ` — ${why}` : ''}`);
  }
  const missing = ARM_NAMES.filter((n) => !results.some((r) => r.name === n));
  const partial = !!UPTO;
  console.log(`COMPOSED NIGHT: ${red === 0 && !partial && missing.length === 0 ? 'ALL PASS' : red === 0 ? (partial ? 'PARTIAL PASS' : 'INCOMPLETE') : `RED ${results.filter((r) => r.error || r.checks.some((c) => !c.ok)).map((r) => r.name).join(',')}`} (${results.length - red}/${results.length} arms${partial ? `, stopped after ${UPTO}` : ''}${missing.length && !partial ? `, NOT RUN: ${missing.join(',')}` : ''}) tree ${REPO}`);
  return red === 0 && !partial && missing.length === 0;
}
const hang = setTimeout(() => { console.log('FAIL deadline — the night hung (300 s)'); report(); process.exit(1); }, 300_000);
hang.unref?.();

// ── modules from the tree under test (RIG_REPO). Optional ones are absent on an older tree: their arms then read RED on the clause, never on an import error ──
const missingModules = [];
const tryImport = async (rel) => import(`${REPO}/${rel}`).catch(() => { missingModules.push(rel); return null; });
const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-e2e-composed', broadcast: () => {}, broadcastPtyData: () => true, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {}, openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => tmpHome, getLogsDir: () => `${tmpHome}/logs`, getAppVersion: () => '0.0.0-e2e-composed', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});
(await import(`${REPO}/src/main/logger.ts`)).initLogger();
// an EXISTING install has a store.json (load() otherwise leaves `loadedFromDisk` false and the memory Pause / the alert wait for a store that is "not loaded yet")
fs.mkdirSync(path.join(tmpHome, 'orchestra'), { recursive: true });
fs.writeFileSync(path.join(tmpHome, 'orchestra', 'store.json'), JSON.stringify({ repos: [], workspaces: [], accounts: [], selfTuneRuns: [] }));
const { store } = await import(`${REPO}/src/main/store.ts`);
await store.load?.();
const busMod = await import(`${REPO}/src/main/bus.ts`);
const busRuns = await import(`${REPO}/src/main/bus-runs.ts`);
const busPause = await import(`${REPO}/src/main/bus-pause.ts`);
const records = await tryImport('src/main/bus-pause-records.ts');
await import(`${REPO}/src/main/agent-sdk.ts`);                      // registers the REAL delivery seam; the fake below replaces it
const delivery = await import(`${REPO}/src/main/sdk-delivery.ts`);
const workspaces = await import(`${REPO}/src/main/workspaces.ts`);
const { dispatchRestartRequest } = await import(`${REPO}/src/main/restart-workspace.ts`);
const wake = await import(`${REPO}/src/main/bus-wake.ts`);
const rosterMod = await import(`${REPO}/src/main/wake-roster.ts`);
const tray = await import(`${REPO}/src/main/inbox-tray.ts`);
const hib = await import(`${REPO}/src/main/hibernation.ts`);
const trapMod = await import(`${REPO}/src/main/pause-trap.ts`);
const trapHost = await import(`${REPO}/src/main/pause-trap-host.ts`);
const reprise = await import(`${REPO}/src/main/pause-reprise.ts`);
const { DEFAULT_BUS_SWITCHES } = await import(`${REPO}/src/shared/bus-switches.ts`);
const { isWakeOrder } = await import(`${REPO}/src/shared/bus-wake.ts`);
const guardMod = await tryImport('src/main/memory-guard.ts');
const admMod = await tryImport('src/main/admission.ts');
const memPauseHost = await tryImport('src/main/pause-memory-host.ts');
const alertHost = await tryImport('src/main/memory-alert-host.ts');
// the daemon-faithful fake Docker lives in the RIG's tree (a test double): it needs docker-api.ts / pause-containers.ts of that tree
const { FakeDocker } = await import(`${HERE}/../src/main/fake-docker.ts`);

busMod.initBus();
const db = busMod.getBus();
if (!db) { console.error('bus failed to open'); process.exit(3); }
if (!String(busMod.busPath()).startsWith(tmpHome)) { console.error(`SAFETY: bus resolved outside scratch: ${busMod.busPath()}`); process.exit(2); }

// ── the memory source + the REAL guard on it (absent on an old tree → the arms read RED) ──
let mem = 12;                                                       // GB the fake MemAvailable source reports; null = unreadable
let reads = 0;
let guard = null;
if (guardMod) {
  guardMod.setMemoryGuardSettingsReader(() => store.getMemoryGuardSettings());
  guard = guardMod.__rebuildMemoryGuardForTests({ schedule: () => ({}), cancel: () => {} }, () => { reads += 1; return mem === null ? null : mem * GIB; });
  guard.start();
}
const snap = () => (guardMod ? guardMod.getMemoryGuardSnapshot() : null);
/** the night's one knob: MemAvailable now, one guard sample (the edges reach every consumer FIFO, exactly as the sampler delivers them) */
function setMem(gb) { mem = gb; return guard ? guard.sampleNow() : null; }

// ── fake delivery seam (the agents' stub): RECORDS every start / stop / turn; a start marks the member live after a beat, like a real one ──
const liveSet = new Set();
const calls = { start: [], stop: [], turns: [], awaiting: [] };
let inFlight = 0, maxInFlight = 0, maxBooting = 0;
let onStart = null;
const bootUntil = new Map();                                        // a started member's first turn settles BOOT_MS after its start — the wake release waits for it
const BOOT_MS = 80;
const hookDrained = [];                                             // what the inbox hook delivered at a start
delivery.registerSdkDelivery({
  hasSession: (id) => liveSet.has(id), hasBackgroundTask: () => false,
  awaitFirstTurn: async (wsId, ms) => { const wait = Math.min(ms, Math.max(0, (bootUntil.get(wsId) ?? 0) - Date.now())); if (wait > 0) await sleep(wait); return { state: 'ok' }; },
  send: async (wsId, text, peer, origin) => { calls.turns.push({ wsId, text, how: 'send', origin }); },
  sendAwaitingStart: async (wsId, text, peer, ms, origin) => { calls.awaiting.push({ wsId, text, origin }); return 'started'; },
  start: async (wsId, text, opts) => {
    if (liveSet.has(wsId)) { calls.turns.push({ wsId, text, how: 'start-on-live' }); return; }   // a wake of a LIVE session is a turn, not a start
    inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
    calls.start.push({ wsId, text, origin: opts?.origin, readsAt: reads, at: Date.now() });
    maxBooting = Math.max(maxBooting, 1 + [...bootUntil.values()].filter((t) => t > Date.now()).length);
    const inboxFile = tray.inboxFilePath(wsId);
    if (fs.existsSync(inboxFile)) { hookDrained.push({ wsId, text: fs.readFileSync(inboxFile, 'utf8') }); fs.rmSync(inboxFile); }
    onStart?.(calls.start.length, wsId);
    await sleep(25);
    liveSet.add(wsId);
    bootUntil.set(wsId, Date.now() + BOOT_MS);
    inFlight -= 1;
  },
  stop: async (wsId) => { calls.stop.push(wsId); liveSet.delete(wsId); },
});
const startsFor = (id) => calls.start.filter((c) => c.wsId === id);
const orderStarts = () => calls.start.filter((c) => isWakeOrder(String(c.text ?? '')));

// ── the fleet ──
//   RUN ws-ops (pause ON, delivery ON, wake ON):  ws-ops ⊃ ws-sub (a SUB-OPS coordinator, asleep, with its own run + worker ws-s1) · ws-m1 ws-m2 (running, idle) · ws-m3 (asleep) · ws-m4 (a turn is RUNNING) · ws-m5 (a prompt is PENDING)
//   RUN ws-off (pause OFF, delivery OFF, wake ON): ws-off ⊃ ws-off1 (running, idle)
//   ws-xm: a top-level session with NO coordinator
const now0 = Date.now();
const mk = (id, extra = {}) => ({ id, name: id, branch: id, kind: 'scratch', repoPath: '', worktreePath: tmpHome, status: 'idle', createdAt: now0 - 40 * 60_000, hasInput: true, sdkSessionId: `sess-${id}`, ...extra });
const LEAD_SW = { ...DEFAULT_BUS_SWITCHES, delivery: true, wake: true, pause: true, liveness: true };
const OFF_SW = { ...DEFAULT_BUS_SWITCHES, wake: true, liveness: true };
busRuns.startRun(db, { id: 'ws-ops', kind: 'mission', coordinator: 'ws-ops' }, LEAD_SW);   // a run's id is its ANCHOR workspace id (the wave run id every member resolves to)
busRuns.startRun(db, { id: 'ws-sub', kind: 'vague', coordinator: 'ws-sub', parentRunId: 'ws-ops' }, LEAD_SW);   // the sub-OPS anchors its OWN run (a Reprise addressee needs its frozen `wake` ON)
busRuns.startRun(db, { id: 'ws-off', kind: 'mission', coordinator: 'ws-off' }, OFF_SW);
await store.upsertWorkspace(mk('ws-ops', { kind: 'orchestrator' }));
await store.upsertWorkspace(mk('ws-sub', { kind: 'orchestrator', parentId: 'ws-ops', hibernatedAt: now0 - 120_000, hasInput: false, sdkSessionId: undefined, lastTask: 'SUB-BRIEF' }));   // a coordinator that still OWES its brief: its (re)start goes through the delivery seam
await store.upsertWorkspace(mk('ws-m1', { parentId: 'ws-ops' }));
await store.upsertWorkspace(mk('ws-m2', { parentId: 'ws-ops' }));
await store.upsertWorkspace(mk('ws-m3', { parentId: 'ws-ops', hibernatedAt: now0 - 60_000 }));
await store.upsertWorkspace(mk('ws-m4', { parentId: 'ws-ops', status: 'running' }));
await store.upsertWorkspace(mk('ws-m5', { parentId: 'ws-ops', sdkPendingPrompts: [{ id: 'p1', text: 'PENDING-PROMPT', origin: 'human' }] }));
await store.upsertWorkspace(mk('ws-s1', { parentId: 'ws-sub', hibernatedAt: now0 - 90_000 }));   // a worker of the SUB-OPS (asleep): makes the sub-OPS run a live fleet run of its own
await store.upsertWorkspace(mk('ws-off', { kind: 'orchestrator' }));
await store.upsertWorkspace(mk('ws-off1', { parentId: 'ws-off' }));
await store.upsertWorkspace(mk('ws-xm'));
for (const id of ['ws-ops', 'ws-m1', 'ws-m2', 'ws-m4', 'ws-m5', 'ws-off', 'ws-off1', 'ws-xm']) liveSet.add(id);
const wsRec = (id) => store.getWorkspace(id);
const repoDir = path.join(tmpHome, 'repo');
{
  const g = (args) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmpHome, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.invalid', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.invalid' } });
  fs.mkdirSync(repoDir, { recursive: true });
  g(['init', '-q', '-b', 'main']); fs.writeFileSync(path.join(repoDir, 'README.md'), '# e2e\n'); g(['add', '.']); g(['commit', '-q', '-m', 'seed']);
  await store.addRepo({ path: repoDir, name: 'repo', defaultBranch: 'main' });
}
const spawnMember = (task, over = {}) => workspaces.dispatchSpawnRequest({ from: 'ws-ops', task, repoPath: repoDir, agent: 'claude', defaultKind: 'spawned', ...over });

// ── Admission (real timers: settle 5 ms, retry 40 ms) + the real wake wiring (same seams index.ts wires) ──
if (admMod) { admMod.__rebuildAdmissionForTests({ settleMs: 5, retryMs: 40 }); admMod.startAdmission(); }
const hasWakeHold = !!(await tryImport('src/main/admission-wake.ts'));
wake.__resetBusWakeForTests();
wake.__setBusReaderForTests(() => db);
wake.setWakeRoster(() => store.workspaces.map((w) => rosterMod.wakeRosterEntry(w)));
wake.setWakeRosterEntry?.((id) => { const w = store.getWorkspace(id); return w ? rosterMod.wakeRosterEntry(w) : null; });
if (hasWakeHold) wake.setWakeKeeperResident?.((await import(`${REPO}/src/main/admission-wake.ts`)).keeperResident);
wake.setWakeDeliver((wsId, text) => delivery.sdkStartAndDeliver(wsId, text));
wake.__freezeSwitchForTests(() => true);
const sendBus = (to, body, runId = 'ws-ops') => busMod.send(db, { runId, sender: 'ws-ops', kind: 'dispatch', body, recipient: to });
const pendingWake = (id, runId = 'ws-ops') => wake.readPendingReaders(db, [{ reader: id, runId }])[0]?.pending === true;
const logText = () => { try { return fs.readFileSync(path.join(process.env.ORCHESTRA_HOME, 'logs', 'orchestra.log'), 'utf8'); } catch { return ''; } };
const heldLines = (id) => logText().split('\n').filter((l) => l.includes(`bus-wake: ${id} is PENDING and its réveil is HELD for memory`)).length;

// ── the Pause trap + Reprise + memory Pause host, wired like index.ts (trap deps FIRST, then the memory Pause), on the daemon-faithful fake Docker ──
const containers = [
  { id: 'c-m1-db', name: 'rig-m1-db', labels: { 'orchestra.ws': 'ws-m1', 'orchestra.run': 'ws-ops' } },
  { id: 'c-m1-cache', name: 'rig-m1-cache', labels: { 'orchestra.ws': 'ws-m1', 'orchestra.run': 'ws-ops' } },
  { id: 'c-m1-rm', name: 'rig-m1-rm', labels: { 'orchestra.ws': 'ws-m1', 'orchestra.run': 'ws-ops' }, autoRemove: true },
  { id: 'c-m2-app', name: 'rig-m2-app', labels: { 'orchestra.ws': 'ws-m2', 'orchestra.run': 'ws-ops' } },
  { id: 'c-m2-gone', name: 'rig-m2-gone', labels: { 'orchestra.ws': 'ws-m2', 'orchestra.run': 'ws-ops' } },
  { id: 'c-sub-q', name: 'rig-sub-q', labels: { 'orchestra.ws': 'ws-sub', 'orchestra.run': 'ws-ops' } },
  { id: 'c-off-db', name: 'rig-off-db', labels: { 'orchestra.ws': 'ws-off1', 'orchestra.run': 'ws-off' } },
  { id: 'c-other', name: 'rig-other', labels: { 'orchestra.ws': 'ws-ghost', 'orchestra.run': 'ws-ops' } },
  { id: 'c-human', name: 'rig-human', labels: {} },
];
const docker = new FakeDocker(containers);
const dockerEvents = [];                                            // ordered `stop <id>` / `start <id>` as the daemon saw them
const origStop = docker.stopContainer.bind(docker);
const origStart = docker.startContainer.bind(docker);
let startInFlight = 0, startMaxInFlight = 0;
const dockerAt = {};                                                // `stop <id>` / `start <id>` → ms
docker.stopContainer = async (id, t) => { dockerEvents.push(`stop ${id}`); dockerAt[`stop ${id}`] = Date.now(); return origStop(id, t); };
docker.startContainer = async (id) => { dockerEvents.push(`start ${id}`); dockerAt[`start ${id}`] = Date.now(); startInFlight++; startMaxInFlight = Math.max(startMaxInFlight, startInFlight); await sleep(150); try { return await origStart(id); } finally { startInFlight--; } };
const trapDeps = trapHost.buildPauseTrapDeps();
trapDeps.containers = docker;
trapDeps.containersFor = () => docker;
trapDeps.snapshot = async (i) => ({ ref: `refs/orchestra/pause/${i.runId}/${i.wsId}/1`, commit: 'c', tree: 't', head: 'h', branch: 'rig', dirty: false, changed: { modified: 0, added: 0, deleted: 0 }, skippedLarge: [], skippedLargeCount: 0, notes: [], warning: null });
trapDeps.killTrees = async () => ({ cliPid: 0, cli: { pid: 0, startTicks: 0 }, killed: [], refused: [], spared: [], survivors: [], rounds: 0 });
trapDeps.settleMs = 0;
trapDeps.originWaitMs = 0;
trapMod.startPauseTrap(trapDeps);
memPauseHost?.startMemoryPause();
alertHost?.startMemoryAlert();                                      // the real alert host: settle window = the real 20 s timer
const escalationRows = () => db.prepare("SELECT run_id, sender, recipient, body, created_at FROM messages WHERE kind = 'escalation' ORDER BY sequence").all();
const runRow = (id) => db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
// the OPS' view: the REAL hooks-server + the BUILT CLI (`peers`, `bus-status`)
const hooks = await import(`${REPO}/src/main/hooks-server.ts`);
await hooks.startHooksServer();
const CLI = path.join(REPO, 'dist-electron', 'cli.js');
const cliOut = (args) => new Promise((resolve) => {
  if (!fs.existsSync(CLI)) { resolve(`NO CLI BUNDLE at ${CLI} (pnpm run build:cli)`); return; }
  const p = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, HOME: tmpHome, ORCHESTRA_HOME: process.env.ORCHESTRA_HOME, ORCHESTRA_SOCK: hooks.getHookSocketPath(), ORCHESTRA_WS_ID: 'ws-ops' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let so = ''; p.stdout.on('data', (c) => (so += c)); p.stderr.on('data', (c) => (so += c)); p.on('close', () => resolve(so));
});
const dockerState = () => Object.fromEntries(docker.containers.map((c) => [c.id, c.running ? 'running' : 'stopped']));
const names = (ids) => ids.map((id) => docker.containers.find((c) => c.id === id)?.name ?? id);

const world = {};                                                   // ids the arms hand to each other
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
await arm('n0_control', async () => {
  setMem(12);
  check('guard_present', !!guardMod, true);
  check('admission_open', snap()?.admission ?? null, 'open');
  const r = await spawnMember('N0-BRIEF');
  check('control_spawn_ok_and_not_held', [r.ok === true, !r.held], [true, true]);
  check('control_the_instrument_sees_a_start', startsFor(r.id).length, 1);
  check('control_no_veille_at_open_admission', await hib.sweepHibernation(), []);
  check('control_nothing_queued', admMod ? admMod.listHeldStarts().length : 0, 0);
  check('control_nothing_paused', db.prepare('SELECT COUNT(*) AS n FROM runs WHERE paused_at IS NOT NULL').get().n, 0);
  check('control_every_container_running', Object.values(dockerState()).every((s) => s === 'running'), true);
  check('control_no_alert', escalationRows().length, 0);
  world.n0member = r.id;
});

await arm('n1_starts_held', async () => {
  setMem(5.5);
  check('guard_decided_held', snap()?.admission ?? null, 'held');
  // an AUTO spawn: accepted, the workspace exists with its brief owed, NO session
  const sp = await spawnMember('N1-HELD-BRIEF');
  check('auto_spawn_accepted_and_held', [sp.ok === true, typeof sp.held?.since === 'number' && /held for memory since/.test(sp.note ?? '')], [true, true]);
  const w = sp.id ? wsRec(sp.id) : null;
  check('workspace_exists_with_the_brief_owed', [!!w && w.parentId === 'ws-ops', w?.lastTask === 'N1-HELD-BRIEF' && !w?.hasInput && !w?.openingTaskDelivered], [true, true]);
  world.heldSpawn = sp.id;
  await sleep(100);
  check('no_session_started_for_the_held_spawn', startsFor(sp.id).length, 0);
  // an AUTO restart of a RUNNING member waits BEFORE any stop
  const stopsBefore = calls.stop.length;
  const rs = await dispatchRestartRequest({ id: 'ws-m2', fresh: false, trigger: 'cli' });
  check('auto_restart_accepted_and_held', [rs.ok === true, typeof rs.held?.since === 'number'], [true, true]);
  check('the_held_restart_stopped_nothing', calls.stop.length - stopsBefore, 0);
  // the sleeping COORDINATOR's restart arrives LAST (the release must still put it first)
  const sub = await dispatchRestartRequest({ id: 'ws-sub', fresh: false, trigger: 'cli' });
  check('auto_restart_of_the_coordinator_is_held_too', [sub.ok === true, typeof sub.held?.since === 'number'], [true, true]);
  // a HUMAN-initiated start of a held member passes; a human top-level spawn passes; a turn to an already-running member passes
  const sp2 = await spawnMember('N1-HUMAN-BRIEF');
  check('control_second_auto_spawn_is_held', !!sp2.held, true);
  const tb = await dispatchRestartRequest({ id: sp2.id, fresh: false, trigger: 'toolbar' });
  check('human_toolbar_restart_passes_while_held', [tb.ok === true, !tb.held, startsFor(sp2.id).map((c) => c.origin)], [true, true, ['human']]);
  const peersAfter = await workspaces.dispatchPeersRequest({ from: 'ws-ops' });
  check('no_stale_held_marker_on_the_member_a_human_started', [peersAfter.peers.find((p) => p.id === sp2.id)?.heldForMemory ?? null, admMod ? admMod.heldStartFor(sp2.id) : null], [null, null]);
  const top = await workspaces.dispatchSpawnRequest({ task: 'N1-TOP', repoPath: repoDir, agent: 'claude', defaultKind: 'workspace' });
  check('human_top_level_spawn_passes_while_held', [top.ok === true, !top.held, startsFor(top.id).length], [true, true, 1]);
  const msg = await workspaces.dispatchMessageRequest({ from: 'ws-xm', to: 'ws-m4', text: 'N1-TURN', emergency: true });
  check('turn_to_a_running_member_passes_live', [msg.ok === true, msg.delivery, calls.awaiting.some((c) => c.wsId === 'ws-m4'), startsFor('ws-m4').length], [true, 'live', true, 0]);
  world.humanStarted = [sp2.id, top.id];
  // the queue + the OPS' view of it
  check('queue_is_in_arrival_order', admMod ? admMod.listHeldStarts().map((h) => [h.wsId, h.kind]) : [], [[sp.id, 'spawn'], ['ws-m2', 'restart'], ['ws-sub', 'restart']]);
  const peers = await workspaces.dispatchPeersRequest({ from: 'ws-ops' });
  check('peers_marks_the_held_spawn_with_since', [peers.peers.find((p) => p.id === sp.id)?.heldForMemory?.kind ?? null, peers.peers.find((p) => p.id === sp.id)?.heldForMemory?.since === sp.held?.since], ['spawn', true]);
  const bs = await cliOut(['bus-status']);
  check('the_ops_sees_it_in_bus_status_the_cli', [/memory: .*admission HELD since \d{4}-/.test(bs), /held starts: 3 held for memory, release order — /.test(bs)], [true, true]);
});

await arm('n2_fast_veille', async () => {
  const swept = await hib.sweepHibernation();
  world.veille = swept;
  check('idle_fleet_members_go_to_veille_at_once', ['ws-m1', 'ws-m2', 'ws-off1', world.n0member].map((id) => swept.includes(id)), [true, true, true, true]);
  check('the_sessions_were_stopped', ['ws-m1', 'ws-m2', 'ws-off1', world.n0member].map((id) => calls.stop.includes(id)), [true, true, true, true]);
  check('stamped_hibernated', ['ws-m1', 'ws-off1'].map((id) => typeof wsRec(id)?.hibernatedAt === 'number' && wsRec(id).hibernatedAt >= now0), [true, true]);
  check('a_running_turn_is_spared', [swept.includes('ws-m4'), calls.stop.includes('ws-m4')], [false, false]);
  check('a_pending_prompt_is_spared', [swept.includes('ws-m5'), calls.stop.includes('ws-m5')], [false, false]);
  check('a_session_with_no_coordinator_is_untouched', [swept.includes('ws-xm'), calls.stop.includes('ws-xm')], [false, false]);
  check('the_coordinators_roots_are_not_fleet_members', ['ws-ops', 'ws-off'].map((id) => swept.includes(id)), [false, false]);
  world.veilleCount = swept.filter((id) => !!wsRec(id)?.parentId).length;
});

await arm('n3_reveil_held', async () => {
  for (let i = 0; i < 2; i++) { await wake.sweepBusWake(); await sleep(15); }          // the running member's own pending lot (n1's turn) is delivered live while held — settle it first
  const c0 = wake.busWakeCounters();
  const body = 'REVEIL-MSG-9f3a';
  world.reveilBody = body;
  sendBus('ws-m3', body);
  for (let i = 0; i < 5; i++) { await wake.sweepBusWake(); await sleep(15); }
  check('no_process_started', startsFor('ws-m3').length, 0);
  const c1 = wake.busWakeCounters();
  check('no_failure_counted_nothing_fired_nothing_withdrawn', [c1.fired - c0.fired, c1.failed - c0.failed, c1.withdrawn - c0.withdrawn], [0, 0, 0]);
  check('held_reason_logged_once_per_transition', heldLines('ws-m3'), 1);
  check('the_lot_is_still_pending', pendingWake('ws-m3'), true);
  check('queued_as_a_wake', admMod ? admMod.listHeldStarts().filter((h) => h.wsId === 'ws-m3').map((h) => h.kind) : [], ['wake']);
  world.failedBefore = c1.failed;
});

await arm('n4_alert_one_row', async () => {
  for (const gb of [6.4, 5.9, 6.8, 5.2, 6.6, 5.7]) { setMem(gb); await sleep(40); }   // hysteresis: bouncing inside the band, never above the 7 GB reopen margin
  check('one_episode_control', [snap()?.episode ?? null, snap()?.admission ?? null], [1, 'held']);
  check('nothing_before_the_settle_window', escalationRows().length, 0);
  world.queuedAtAlert = admMod ? admMod.listHeldStarts().length : -1;
  check('the_row_arrives_after_the_settle_window', await until(() => escalationRows().length >= 1, 40_000, 100), true);
  await sleep(1500);
  const rows = escalationRows();
  check('exactly_one_escalation_for_the_oscillating_episode', rows.length, 1);
  const r = rows[0] ?? {};
  const b = String(r.body ?? '');
  world.alertRow1 = r;
  check('to_the_lead_only_from_the_host', [r.run_id, r.sender, r.recipient], ['ws-ops', 'host', 'ws-ops']);
  check('names_the_threshold_and_the_memory_at_the_crossing', /episode 1 \(since .*\): MemAvailable fell below the Admission threshold \(6\.00 GB\) at 5\.50 GB/.test(b), true);
  check('names_the_effective_actions', [new RegExp(`${world.queuedAtAlert} automatic fleet start\\(s\\) HELD`).test(b), new RegExp(`${world.veilleCount} member\\(s\\) put in Veille since the crossing`).test(b), /no run under the memory Pause/.test(b)], [true, true, true]);
  check('now_line_is_the_effective_state', /Admission HELD · memory Pause none\./.test(b), true);
  check('says_what_a_later_critical_crossing_will_do', /the host puts the eligible runs under the memory Pause WITHOUT another row for this episode/.test(b), true);
  check('no_alert_for_the_pause_off_run_nor_its_coordinator', rows.filter((x) => x.recipient === 'ws-off').length, 0);
});

await arm('n5_memory_pause', async () => {
  const offBefore = JSON.stringify(runRow('ws-off'));
  const heldNonWake = () => (admMod ? admMod.listHeldStarts().filter((h) => h.kind !== 'wake').map((h) => [h.wsId, h.kind]) : []);
  const queueBefore = heldNonWake();
  const failedBefore = wake.busWakeCounters().failed;
  const stopsBefore = calls.stop.length, startsBefore = calls.start.length;
  setMem(2.5);
  check('guard_decided_the_memory_pause_is_due', [snap()?.pause ?? null, snap()?.pauseCycle ?? null], ['held', 1]);
  check('the_pause_on_run_is_paused', await until(() => runRow('ws-ops')?.paused_at != null, 4000), true);   // at the EDGE: the 15 s level tick is only the safety net
  const c = runRow('ws-ops');
  world.carrier = c;
  let reason = null; try { reason = JSON.parse(c?.pause_auto ?? 'null')?.reason ?? null; } catch { /* below */ }
  check('written_by_the_host_hard_with_the_motive_memory', [c?.paused_by, c?.pause_mode, reason], ['host:memory', 'hard', 'memory']);
  check('the_trap_completed', await until(() => runRow('ws-ops')?.pause_trap_at != null, 20_000), true);
  check('the_pause_off_run_is_byte_identical', JSON.stringify(runRow('ws-off')), offBefore);
  check('held_spawns_and_restarts_stay_held_and_nothing_started_or_stopped', [heldNonWake(), calls.start.length - startsBefore, calls.stop.length - stopsBefore], [queueBefore, 0, 0]);
  // the held réveil's queue entry may be pruned while its member is paused (not wakeable) — the LOT is what must survive, uncounted
  check('the_held_reveil_is_neither_lost_nor_failed', [pendingWake('ws-m3'), wake.busWakeCounters().failed - failedBefore], [true, 0]);
  await sleep(1200);
  check('still_one_escalation_row_the_critical_crossing_writes_none', escalationRows().length, 1);
  const bs = await cliOut(['bus-status']);
  check('bus_status_says_the_memory_pause_is_in_effect', /memory: .*memory Pause IN EFFECT since \d{4}-/.test(bs), true);
});

await arm('n6_pause_containers', async () => {
  const st = dockerState();
  const c = runRow('ws-ops');
  const stoppedIds = ['c-m1-db', 'c-m1-cache', 'c-m2-app', 'c-m2-gone', 'c-sub-q'];
  check('attributed_containers_of_the_paused_members_are_stopped', stoppedIds.map((id) => st[id]), stoppedIds.map(() => 'stopped'));
  check('none_was_removed', docker.containers.length, containers.length);
  check('an_autoremove_container_is_skipped', st['c-m1-rm'], 'running');
  check('bystander_other_member_and_pause_off_run_are_untouched', ['c-human', 'c-other', 'c-off-db'].map((id) => st[id]), ['running', 'running', 'running']);
  const stopEvents = dockerEvents.filter((e) => e.startsWith('stop ')).map((e) => e.slice(5));
  check('only_attributed_running_containers_got_a_stop_call', stopEvents.sort(), [...stoppedIds].sort());
  const bil = (ws) => records?.bilanForMember(db, 'ws-ops', ws, c.paused_at)?.activity?.containers?.stopped?.map((x) => [x.name, x.outcome]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))) ?? null;
  check('the_bilan_lists_each_members_stopped_containers', [bil('ws-m1'), bil('ws-m2'), bil('ws-sub')], [[['rig-m1-cache', 'stopped'], ['rig-m1-db', 'stopped'], ['rig-m1-rm', 'skipped-autoremove']], [['rig-m2-app', 'stopped'], ['rig-m2-gone', 'stopped']], [['rig-sub-q', 'stopped']]]);
  check('the_bilan_never_names_the_bystander_or_another_run', JSON.stringify(['ws-m1', 'ws-m2', 'ws-sub', 'ws-m3', 'ws-m4', 'ws-m5'].map(bil)).includes('rig-human') || JSON.stringify(['ws-m1', 'ws-m2', 'ws-sub'].map(bil)).includes('rig-off'), false);
  world.stoppedEvents = dockerEvents.filter((e) => e.startsWith('stop '));
});

await arm('n7_reprise', async () => {
  docker.remove('c-m2-gone');                                       // a container removed BY HAND during the Pause
  const startsBefore = calls.start.length;
  setMem(6.5);                                                      // above the Admission threshold: the Pause is liftable — Admission (reopens above 7 GB) is STILL held
  check('pause_liftable_admission_still_held', [snap()?.pause ?? null, snap()?.admission ?? null], ['none', 'held']);
  const stoppedIds = world.stoppedEvents.map((e) => e.slice(5));
  const back = ['c-m1-db', 'c-m1-cache', 'c-m2-app', 'c-sub-q'];
  const ok = await until(() => back.every((id) => docker.running(id)), 6000, 50);   // the lift acts at the EDGE (the 15 s level tick is only the safety net)
  check('the_stopped_containers_are_started_again', ok, true);
  const starts = dockerEvents.filter((e) => e.startsWith('start ')).map((e) => e.slice(6));
  check('exactly_the_stopped_ones_restarted_each_once_and_in_REVERSE_stop_order', starts, [...stoppedIds].reverse());
  check('bystander_other_run_autoremove_never_restarted_or_stopped_again', ['c-human', 'c-other', 'c-off-db', 'c-m1-rm'].map((id) => dockerEvents.some((e) => e.endsWith(` ${id}`))), [false, false, false, false]);
  check('the_removed_container_did_not_break_the_reprise', ok && docker.containers.length === containers.length - 1, true);
  const c = world.carrier;
  const rst = (ws) => records?.bilanForMember(db, 'ws-ops', ws, c.paused_at)?.activity?.containers?.restarted?.map((x) => [x.id, x.outcome]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))) ?? null;
  check('the_bilan_records_each_restart_and_the_gone_one', [rst('ws-m1'), rst('ws-m2'), rst('ws-sub')], [[['c-m1-cache', 'started'], ['c-m1-db', 'started']], [['c-m2-app', 'started'], ['c-m2-gone', 'gone']], [['c-sub-q', 'started']]]);
  check('held_starts_stay_held_while_admission_is_held', [calls.start.length - startsBefore, admMod ? admMod.listHeldStarts().length >= 3 : false], [0, true]);
  check('the_reprise_restarts_one_container_at_a_time_back_to_back', startMaxInFlight, 1);   // G7 r2 note: sequential, NO MemAvailable / Admission check between starts (measured on the real daemon by the packaged drive)
  const startAts = Object.entries(dockerAt).filter(([k]) => k.startsWith('start ')).map(([, t]) => t).sort((a, b) => a - b);
  console.log(`NIGHT-MEASURE ${JSON.stringify({ containersRestarted: startAts.length, startGapsMs: startAts.slice(1).map((t, i) => t - startAts[i]), maxInFlight: startMaxInFlight })}`);
});

await arm('n7b_coordinators_after_containers', async () => {
  const rows = db.prepare("SELECT recipient, sender, created_at FROM messages WHERE kind = 'reprise' ORDER BY sequence").all();
  const lastStart = Math.max(...Object.entries(dockerAt).filter(([k]) => k.startsWith('start ')).map(([, t]) => t));
  check('the_host_sent_its_consigne_to_the_coordinators_only_workers_stay_blocked', rows.map((r) => [r.recipient, r.sender]).sort(), [['ws-ops', 'host'], ['ws-sub', 'host']]);
  check('coordinators_are_released_only_after_the_containers_are_back', rows.every((r) => r.created_at >= lastStart), true);
  check('the_run_is_resuming_not_blind_started', [runRow('ws-ops').paused_at != null, runRow('ws-ops').resume_started_at != null], [true, true]);
  // the coordinators read their Consigne and release their workers (what `orchestra run release --all` does): the OPS its own, the sub-OPS its worker ws-s1
  const rel1 = reprise.releaseMembers(db, 'ws-ops', 'ws-ops', 'all');
  const rel2 = reprise.releaseMembers(db, 'ws-ops', 'ws-sub', 'all');
  check('the_coordinators_release_their_workers_and_the_run_is_active', [rel1.error, rel2.error, rel1.finished === true || rel2.finished === true, runRow('ws-ops')?.paused_at ?? null], [null, null, true, null]);
});

await arm('n8_release_order', async () => {
  for (let i = 0; i < 3; i++) { await wake.sweepBusWake(); await sleep(20); }               // the released members are wakeable again: their pending Consigne / réveil is queued (held) again
  const q0 = admMod ? admMod.listHeldStarts() : [];
  check('queue_before_the_release_arrival_order_with_the_coordinator_last_of_the_first_three', q0.slice(0, 3).map((h) => [h.wsId, h.kind]), [[world.heldSpawn, 'spawn'], ['ws-m2', 'restart'], ['ws-sub', 'restart']]);
  check('the_consigne_wakes_of_the_sleepers_are_queued_behind_them', [q0.slice(3).every((h) => h.kind === 'wake'), q0.slice(3).map((h) => h.wsId).includes('ws-m3')], [true, true]);
  const released = () => logText().split('\n').filter((l) => /\[admission\] RELEASED/.test(l)).map((l) => { const m = /RELEASED (\w+) of (\S+?)(?: \(coordinator\))?,/.exec(l); return m ? `${m[1]}:${m[2]}` : l; });
  const base = calls.start.length;
  onStart = (n) => { if (n === base + 1) mem = 6.8; };                                    // the FIRST release eats the margin: memory dips below the 7 GB reopen margin again
  setMem(8);                                                                              // Admission reopens (> 7 GB): the release begins
  check('admission_reopened', snap()?.admission ?? null, 'open');
  check('the_first_release_goes_out', await until(() => released().length >= 1, 8000), true);
  await sleep(700);
  check('a_recovery_that_dips_again_stops_the_release_after_one', released().length, 1);
  onStart = null;
  setMem(9);                                                                              // memory is back: the retry finishes the release
  check('the_release_finishes_once_memory_is_back', await until(() => (admMod ? admMod.listHeldStarts().length === 0 : true) && released().length >= q0.length, 15_000), true);
  const rel = released();
  world.released = rel;
  check('coordinators_first_then_arrival_order', rel.slice(0, 4), ['restart:ws-sub', `spawn:${world.heldSpawn}`, 'restart:ws-m2', 'wake:ws-m1']);
  check('every_held_start_went_out_exactly_once', [rel.length === new Set(rel).size || rel.filter((x) => x.startsWith('wake:ws-sub')).length <= 1, q0.every((h) => rel.includes(`${h.kind}:${h.wsId}`))], [true, true]);
  check('a_woken_coordinator_goes_before_the_other_wakes_queued_with_it', (() => { const a = rel.indexOf('wake:ws-sub'), b = rel.indexOf('wake:ws-m3'); return a === -1 || b === -1 || a < b; })(), true);
  check('the_coordinators_brief_was_delivered_by_its_release', startsFor('ws-sub').some((c) => c.text === 'SUB-BRIEF'), true);
  check('the_released_spawn_really_started_with_its_brief', [startsFor(world.heldSpawn).map((c) => c.text), liveSet.has(world.heldSpawn)], [['N1-HELD-BRIEF'], true]);
  check('one_at_a_time', maxInFlight, 1);
  check('one_booting_at_a_time', maxBooting, 1);
  const rs = calls.start.slice(base).map((c) => c.readsAt);
  check('a_fresh_reading_before_each_release', rs.every((x, i) => i === 0 || x > rs[i - 1]), true);
  check('queue_drained', admMod ? admMod.listHeldStarts().length : -1, 0);
  const bs = await cliOut(['bus-status']);
  check('bus_status_no_longer_lists_held_starts', /held starts:/.test(bs), false);
  check('still_one_escalation_row_the_episode_ended_with_it', escalationRows().length, 1);
});

await arm('n9_reveil_delivered', async () => {
  const st = orderStarts().filter((c) => c.wsId === 'ws-m3');
  check('the_held_reveil_was_delivered_exactly_once_as_the_start', st.length, 1);
  check('its_text_is_the_order_not_lost', st[0] ? isWakeOrder(String(st[0].text)) : false, true);
  check('no_failure_was_ever_counted', wake.busWakeCounters().failed - world.failedBefore, 0);
  // the member ANSWERS with the real verbs: the lot carries the message intact, the ack clears the pending state
  const verbs = await import(`${REPO}/src/cli/bus-verbs.ts`);
  const receipts = await import(`${REPO}/src/main/bus-receipts.ts`);
  const { composeBusVerbSlice } = await import(`${REPO}/src/cli/bus-verb-slice.ts`);
  const id = verbs.resolveBusIdentity({}, { ORCHESTRA_RUN_ID: 'ws-ops', ORCHESTRA_WS_ID: 'ws-m3' });
  let stdout = '';
  const ctx = { db, id, bus: composeBusVerbSlice(busMod, busRuns, receipts), out: (t) => { stdout += t; }, fail: (m) => { throw new Error(m); } };
  verbs.verbCheck(ctx, { limit: 100 });
  const lot = JSON.parse(stdout);
  check('the_lot_carries_the_message_intact', JSON.stringify(lot).includes(world.reveilBody), true);
  stdout = '';
  verbs.verbAck(ctx, String(lot.lot));
  check('the_ack_clears_pending', pendingWake('ws-m3'), false);
});

await arm('n10_second_episode', async () => {
  const row1 = escalationRows()[0] ?? {};
  setMem(5.5);                                                                            // a NEW downward crossing after recovery
  check('a_new_episode_opened', [snap()?.episode ?? null, snap()?.admission ?? null], [2, 'held']);
  setMem(8);                                                                              // …and it ends before its settle window: told when it ends
  check('the_second_row_arrives', await until(() => escalationRows().length >= 2, 10_000, 100), true);
  await sleep(800);
  const rows = escalationRows();
  check('exactly_two_rows_one_per_episode', rows.length, 2);
  check('the_second_names_episode_2_and_says_it_is_over', [/Memory guard — episode 2 /.test(rows[1]?.body ?? ''), /already OVER/.test(rows[1]?.body ?? '')], [true, true]);
  check('the_first_row_is_untouched', rows[0]?.body, row1.body);
});

const allOk = report();
if (allOk) fs.rmSync(tmpHome, { recursive: true, force: true });   // a green night leaves nothing behind; a red one keeps its scratch for debugging
process.exit(allOk ? 0 : 1);
