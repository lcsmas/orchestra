// Plafond mémoire rig (#320, wave H ledger #329, ADR 0005): the REAL keeper bundle (dist-electron/keeper.js), launched by the REAL keeper-client facade
// into a REAL systemd user scope (`systemd-run --user --scope`), with the REAL decision (`memoryCapSpecFor` over a REAL scratch bus + store) — and a
// stand-in CLI (scripts/memory-cap/standin-cli.cjs): the real `claude` is ~330 MB RSS and cannot live in a ≤300 MB rig scope (ledger D2). The real CLI's
// side of the contract (CLAUDE_CODE_SHELL_PREFIX → the Bash tool runs at oom_score_adj 1000) is proven by scripts/memory-cap/real-cli-prefix.mjs.
//
//   node --experimental-strip-types --import ./scripts/.r2-register.mjs scripts/e2e-memory-cap.mjs <arm | all>
//   SUBJECT_REPO=<tree> drives another tree's src/ + keeper bundle (G1: origin/master must FAIL every mustFailOnMaster arm).
//   MC_MUTANT_TAG=<id>  is only echoed in the output (scripts/memory-cap-mutants.mjs sets it).
//
// ONE ARM = ONE PROCESS (agent-sdk-style global state: the bus and the logger are singletons per ORCHESTRA_HOME). `all` runs every arm in a child process with an
// ALLOWLISTED env, then prints — per arm — the rig's SURVIVORS (processes carrying the arm's scratch dir, units carrying the rig prefix): must be 0.
// Disposable scopes only: unit prefix `orchestra-rig-wh-h1-`, MemoryMax ≤ 300 MB, `--collect`, stopped by NAME at the end. Nothing existing is ever moved into a scope.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REAL_HOME = process.env.MC_REAL_HOME ?? os.homedir(); // the child's HOME is the scratch dir: the real one travels in MC_REAL_HOME
const HERE_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(process.env.SUBJECT_REPO ?? HERE_REPO);
const RIG_DIR = path.join(HERE_REPO, 'scripts', 'memory-cap');
const UNIT_PREFIX = 'orchestra-rig-wh-h1-';
const HARD_GB = 0.25; // 256 MiB — page-aligned, ≤ 300 MB (ledger D2)
const SOFT_GB = 0.2;

/** mustFailOnMaster: asserts the cap EXISTS (a scope, a kill, a record) — RED on a tree without it. The others are controls: GREEN on both. */
const ARMS = {
  kill_at_hard: { mustFailOnMaster: true },
  below_cap_untouched: {},
  human_no_scope: {},
  switch_off_no_scope: {},
  no_migration: {},
  kill_while_detached: { mustFailOnMaster: true },
  reliquat_outlives_keeper: { mustFailOnMaster: true },
  launcher_fails_plain: { mustFailOnMaster: true },
  wrapper_missing_no_scope: { mustFailOnMaster: true },
  launcher_hangs_plain: { mustFailOnMaster: true },
  not_applied_reported: { mustFailOnMaster: true },
  slow_keeper_keeps_cap: { mustFailOnMaster: true },
  // #327: an EXPLICIT stop (delete / archive / clear / migration) kills the member's Reliquats by identity, then stops ITS scope units — a restart keeps them
  delete_stops_scope: { mustFailOnMaster: true },
  delete_all_generations: { mustFailOnMaster: true },
  other_member_untouched: { mustFailOnMaster: true },
  live_keeper_untouched: {},
  app_restart_keeps_scopes: {},
  clear_then_fresh_start: { mustFailOnMaster: true },
  unit_stop_takes_spared: { mustFailOnMaster: true },
  // #322 (Plafond mémoire: tell the member and its coordinator) — the production sink (src/main/memory-notice.ts) over the REAL keeper, a REAL scope and a REAL scratch bus
  notice_kill_reported: { mustFailOnMaster: true },
  notice_names_victim: { mustFailOnMaster: true },
  notice_soft_reported: { mustFailOnMaster: true },
  notice_app_closed: { mustFailOnMaster: true },
  notice_storm_no_wrong_certainty: { mustFailOnMaster: true },
  // needs a real Chromium (CHROMIUM or /usr/lib64/chromium-browser/chromium-browser): run by `pnpm run test:memory-cap-browser`, skipped by `all` unless MC_BROWSER=1
  browser_contained: { mustFailOnMaster: true, needsChromium: true },
};

const ARM = process.argv[2] ?? '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unitsNow = (glob) => {
  const r = spawnSync('systemctl', ['--user', 'list-units', '--all', '--no-legend', '--plain', glob], { encoding: 'utf8' });
  return (r.stdout ?? '').split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
};

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// PARENT MODE: `all` (or a name with --contained) → one child per arm under an allowlisted env, then the survivors report.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
const RUN_TOKEN = process.env.MC_RUN_TOKEN ?? randomBytes(2).toString('hex');
// Under ~/.cache (btrfs, never /tmp): the scratch guard refuses anything inside ~/.orchestra, which is a LIVE dir.
const RIG_ROOT = path.join(REAL_HOME, '.cache', 'memory-cap-rig', RUN_TOKEN);

function armBase(arm) {
  // Short: a unix socket path must stay < ~100 bytes or keeperSocketPath hashes it into /tmp.
  return path.join(RIG_ROOT, createHash('sha1').update(arm).digest('hex').slice(0, 6));
}

/** Processes carrying the arm's scratch dir in their env / argv / cwd — the rig's own marker. Identity is re-read from /proc. */
function survivorsOf(base) {
  const out = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      const hit = fs.readFileSync(`/proc/${name}/cmdline`, 'latin1').includes(base) || fs.readFileSync(`/proc/${name}/environ`, 'latin1').includes(base) || fs.readlinkSync(`/proc/${name}/cwd`).startsWith(base);
      if (hit) out.push(Number(name));
    } catch { /* gone / not ours */ }
  }
  return out;
}

if (ARM === 'all' || process.argv.includes('--contained')) {
  const names = ARM === 'all' ? Object.keys(ARMS).filter((a) => !ARMS[a].needsChromium || process.env.MC_BROWSER === '1') : [ARM];
  if (ARM === 'all' && process.env.MC_BROWSER !== '1') console.log('NOTE: browser_contained (needs a real Chromium) is not part of `all` — run `pnpm run test:memory-cap-browser`');
  const results = [];
  fs.mkdirSync(RIG_ROOT, { recursive: true });
  for (const arm of names) {
    if (!ARMS[arm]) { console.error(`unknown arm: ${arm}`); process.exit(2); }
    const base = armBase(arm);
    const env = {
      PATH: process.env.PATH, HOME: path.join(base, 'home'), LANG: 'C.UTF-8', SHELL: process.env.SHELL ?? '/bin/bash',
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, // systemd-run --user needs the user manager
      MC_REAL_HOME: REAL_HOME, MC_RUN_TOKEN: RUN_TOKEN, SUBJECT_REPO: process.env.SUBJECT_REPO, MC_MUTANT_TAG: process.env.MC_MUTANT_TAG,
      MC_KEEPER_BUNDLE: process.env.MC_KEEPER_BUNDLE, MC_BROWSER: process.env.MC_BROWSER, CHROMIUM: process.env.CHROMIUM,
    };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    const RUN_UNIT_GLOB = `${UNIT_PREFIX}mc${RUN_TOKEN}*`; // only THIS run's units: a concurrent rig run keeps its own
    const unitsBefore = new Set(unitsNow(RUN_UNIT_GLOB));
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', path.join(HERE_REPO, 'scripts', '.r2-register.mjs'), fileURLToPath(import.meta.url), arm], { env, encoding: 'utf8', timeout: 240_000, cwd: HERE_REPO });
    const line = (r.stdout ?? '').split('\n').reverse().find((l) => l.startsWith('{"arm"'));
    let res;
    try { res = line ? JSON.parse(line) : { ok: false, error: `no result line (rc=${r.status}${r.signal ? ' ' + r.signal : ''}): ${(r.stderr ?? '').trim().slice(-300)}` }; } catch (e) { res = { ok: false, error: `unparsable result: ${e}` }; }
    // G5: after EVERY run, the survivors of THIS arm — printed, not assumed.
    const procs = survivorsOf(base);
    const newUnits = unitsNow(RUN_UNIT_GLOB).filter((u) => !unitsBefore.has(u));
    const leaked = { procs: procs.length, units: newUnits.length };
    for (const u of newUnits) spawnSync('systemctl', ['--user', 'stop', u], { encoding: 'utf8' }); // named: it starts with OUR prefix and did not exist before this arm
    for (const pid of procs) { try { if (fs.readFileSync(`/proc/${pid}/environ`, 'latin1').includes(base) || fs.readFileSync(`/proc/${pid}/cmdline`, 'latin1').includes(base)) process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    const ok = !!res.ok && leaked.procs === 0 && leaked.units === 0;
    results.push({ arm, ok, mustFailOnMaster: ARMS[arm].mustFailOnMaster === true, ...res, leaked });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${arm}${ARMS[arm].mustFailOnMaster ? ' [mustFailOnMaster]' : ''}${res.detail ? ` — ${res.detail}` : ''}${res.error ? ` — ${res.error}` : ''}`);
    for (const l of (r.stderr ?? '').split('\n')) if (/^ {2}(ok  |FAIL) /.test(l) && (process.env.MC_VERBOSE || l.startsWith('  FAIL'))) console.log(l);
    console.log(`SURVIVORS arm=${arm} procs=${leaked.procs} scopes=${leaked.units}${leaked.procs || leaked.units ? '  ← LEAK (cleaned by the parent)' : ''}`);
  }
  const bad = results.filter((r) => !r.ok);
  fs.rmSync(RIG_ROOT, { recursive: true, force: true });
  console.log(`MEMORY-CAP RIG${process.env.MC_MUTANT_TAG ? ` [mutant ${process.env.MC_MUTANT_TAG}]` : ''}${process.env.SUBJECT_REPO ? ` [subject ${process.env.SUBJECT_REPO}]` : ''}: ${results.length - bad.length}/${results.length} arms PASS${bad.length ? ` — FAILED: ${bad.map((r) => r.arm).join(', ')}` : ''}`);
  console.log(`LEFTOVER rig scopes now: ${unitsNow(`${UNIT_PREFIX}*`).length}`);
  process.exit(bad.length ? 1 : 0);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// ARM MODE
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
if (!ARMS[ARM]) { console.error(`unknown arm: ${ARM} (one of ${Object.keys(ARMS).join(', ')}, all)`); process.exit(2); }
// A rig run from a capped member's Bash tool inherits oom_score_adj 1000 — and so would the keeper and the stand-in CLI it spawns, making "keeper/CLI at 0" and the victim ranking
// meaningless. An unprivileged process may lower itself back to 0 (its floor): do it first, loudly if it cannot.
try { fs.writeFileSync('/proc/self/oom_score_adj', '0'); } catch { /* not Linux / floor above 0 */ }
if (readSafe0('/proc/self/oom_score_adj') !== '0') { console.error('VOID: this process cannot lower its oom_score_adj to 0 — the keeper/CLI baseline would be wrong'); process.exit(3); }
function readSafe0(p) { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; } }
const PHASE = process.env.MC_PHASE ?? '1';
const CHILD_PHASE = PHASE === 'app' || PHASE === 'app2'; // helper processes of kill_while_detached: they must not wipe or tear down the arm's world
const base = armBase(ARM);
if (!base.startsWith(path.join(REAL_HOME, '.cache', 'memory-cap-rig') + path.sep)) throw new Error(`refusing rig dir outside the rig cache root: ${base}`);
if (!CHILD_PHASE) fs.rmSync(base, { recursive: true, force: true });
const home = path.join(base, 'home');
fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
process.env.ORCHESTRA_HOME = home;
process.env.HOME = home;
process.env.ORCHESTRA_MEMORY_SCOPE_PREFIX = UNIT_PREFIX;
process.env.ORCHESTRA_KEEPER_LINGER_MS = '300000';
const { assertScratch } = await import(`${HERE_REPO}/scripts/session-budget/scratch-guard.mjs`);
const liveNames = fs.readdirSync(REAL_HOME).filter((n) => n.startsWith('.claude') || n.startsWith('.orchestra')); // every live config/home dir, whatever its suffix
const live = [...liveNames.map((n) => path.join(REAL_HOME, n)), path.join(REAL_HOME, '.config', 'orchestra')];
assertScratch('ORCHESTRA_HOME', home, base, live);

// The daemon bundle the run EXECUTES: rebuild when missing or older than ANY of its sources (a stale bundle reproduces perfectly in isolation).
const KEEPER_JS = process.env.MC_KEEPER_BUNDLE ?? path.join(REPO, 'dist-electron', 'keeper.js');
if (!process.env.MC_KEEPER_BUNDLE) {
  const srcs = ['src/keeper/index.ts', 'src/keeper/memory-watch.ts', 'src/keeper/kernel-oom-log.ts', 'src/shared/keeper-protocol.ts', 'src/shared/memory-scope.ts', 'src/shared/mem-notice-file.ts'].map((s) => path.join(REPO, s)).filter((s) => fs.existsSync(s));
  if (!fs.existsSync(KEEPER_JS) || srcs.some((s) => fs.statSync(s).mtimeMs > fs.statSync(KEEPER_JS).mtimeMs)) {
    execFileSync(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.keeper.config.ts'], { cwd: REPO, stdio: 'ignore' });
  }
}
fs.copyFileSync(KEEPER_JS, path.join(home, 'bin', 'keeper.js'));

/** Everything the app would broadcast to the renderer's `agent:event` channel (the member's event stream), in order. */
const agentEvents = [];
const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-memory-cap-rig',
  broadcast: (ch, ...a) => { if (ch === 'agent:event') agentEvents.push({ wsId: a[0], ev: a[1] }); }, broadcastPtyData: () => {}, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {}, openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => home, getLogsDir: () => `${home}/logs`, getAppVersion: () => '0.0.0-memory-cap-rig', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});
(await import(`${REPO}/src/main/logger.ts`)).initLogger();
const kc = await import(`${REPO}/src/main/keeper-client.ts`);
const hasCap = fs.existsSync(path.join(REPO, 'src', 'main', 'memory-cap-switch.ts'));
const capSwitch = hasCap ? await import(`${REPO}/src/main/memory-cap-switch.ts`) : null;
const scopeMod = hasCap ? await import(`${REPO}/src/main/memory-scope.ts`) : null;

// A REAL scratch bus with two runs: one that froze memory_cap ON, one OFF — and the REAL store for the Garde mémoire levels.
let settings = { capSoftGb: SOFT_GB, capHardGb: HARD_GB };
let busDb = null;
let busSendFn = null;
if (hasCap) {
  const { initBus, getBus, send: busSend } = await import(`${REPO}/src/main/bus.ts`);
  const { startRun } = await import(`${REPO}/src/main/bus-runs.ts`);
  const { DEFAULT_BUS_SWITCHES } = await import(`${REPO}/src/shared/bus-switches.ts`);
  initBus();
  const db = getBus();
  busDb = db;
  busSendFn = busSend;
  startRun(db, { id: 'run-on', kind: 'vague', coordinator: 'rig-coordinator' }, { ...DEFAULT_BUS_SWITCHES, memoryCap: true, liveness: true }); // liveness ON: the escalation mechanism the shipped gate follows (round 2 F6)
  startRun(db, { id: 'run-quiet', kind: 'vague', coordinator: 'rig-coordinator' }, { ...DEFAULT_BUS_SWITCHES, memoryCap: true, liveness: false });
  startRun(db, { id: 'run-off', kind: 'vague', coordinator: 'c' }, { ...DEFAULT_BUS_SWITCHES });
  const { store } = await import(`${REPO}/src/main/store.ts`);
  await store.load?.();
  await store.setMemoryGuardSettings({ ...store.getMemoryGuardSettings(), capSoftGb: SOFT_GB, capHardGb: HARD_GB });
  settings = store.getMemoryGuardSettings();
}
try { kc.installKeeper(); } catch { /* the rig copies the bundle itself; installKeeper also lays down the oom wrapper */ }
const WRAPPER = kc.oomWrapperPath?.() ?? null;

// ── observation helpers (read from /proc and cgroupfs, never from the subject's own opinion) ─────────────────────────
const readSafe = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const ticks = (pid) => { const s = readSafe(`/proc/${pid}/stat`); return s ? s.slice(s.lastIndexOf(')') + 2).split(' ')[19] : null; };
const ident = (pid) => (pid ? `${pid}:${ticks(pid)}` : null);
const alive = (pid) => { if (!pid) return false; const s = readSafe(`/proc/${pid}/stat`); return !!s && s.slice(s.lastIndexOf(')') + 2)[0] !== 'Z'; };
const cgOf = (pid) => { const t = readSafe(`/proc/${pid}/cgroup`); const l = t?.split('\n').find((x) => x.startsWith('0::')); return l ? l.slice(3) : null; };
const cgDir = (pid) => { const c = cgOf(pid); return c ? path.join('/sys/fs/cgroup', c) : null; };
const eventsOf = (dir) => Object.fromEntries((readSafe(path.join(dir, 'memory.events')) ?? '').trim().split('\n').filter(Boolean).map((l) => l.split(' ')).map(([k, v]) => [k, Number(v)]));
const pidFilePid = (ws) => { try { return JSON.parse(fs.readFileSync(path.join(home, 'keepers', `${ws}.pid`), 'utf8')).pid; } catch { return null; } };
async function waitFor(pred, ms, step = 50) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return true; await sleep(step); } return !!(await pred()); }
const orchLog = () => readSafe(path.join(home, 'logs', 'orchestra.log')) ?? '';
const armUnits = (ws) => unitsNow(`${UNIT_PREFIX}${ws}-*`);
const python = ['python3'];

/** A facade (what the SDK's query() gets) over the stand-in CLI. `decide` = the memory-cap spec the app would hand makeKeeperSpawn. */
function open(ws, spec, { rssMb = 80, extraEnv = {} } = {}) {
  const st = { ws, lines: [], attached: false, exited: false, errors: [], waiters: [] };
  const h = kc.makeKeeperSpawn(ws, () => { st.attached = true; }, undefined, spec)({
    command: process.execPath, args: [path.join(RIG_DIR, 'standin-cli.cjs')], cwd: base,
    env: { PATH: process.env.PATH, HOME: home, SHELL: process.env.SHELL ?? '/bin/bash', STANDIN_CLI_RSS_MB: String(rssMb), ...extraEnv }, signal: new AbortController().signal,
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

/** The decision exactly as agent-sdk.ts makes it (same function, same inputs; the call site is pinned by memory-cap-binding.test.ts). */
const decide = (ws, { fleet = true, run = 'run-on' } = {}) =>
  capSwitch ? capSwitch.memoryCapSpecFor({ wsId: ws, runId: run, ws: fleet ? { parentId: 'rig-coordinator' } : {}, remote: false, settings }) : undefined;

/** Everything the arms assert on, as facts about the running pids. */
function factsOf(ws, st) {
  const kp = pidFilePid(ws);
  const init = st ? initOf(st) : null;
  const dir = kp ? cgDir(kp) : null;
  const unit = dir && dir.endsWith('.scope') ? path.basename(dir) : null;
  return { keeperPid: kp, keeperId: ident(kp), cliPid: init?.pid ?? null, cliId: ident(init?.pid), cgroupDir: dir, unit, inRigScope: !!unit && unit.startsWith(UNIT_PREFIX), init };
}
const wsName = (tag) => `mc${RUN_TOKEN}${tag}`;
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail }); };
const killedBy = [];
const stopUnit = (u) => spawnSync('systemctl', ['--user', 'stop', u], { encoding: 'utf8' });

const kills = [];
kc.onMemoryKill?.((ws, rec) => kills.push({ ws, ...rec }));
const softs = [];
kc.onMemorySoft?.((ws, rec) => softs.push({ ws, ...rec }));
/** Distinct records a passive listener saw: a retried delivery (the bus was down) calls the listeners again — at-least-once; the sink dedupes, a bare counter does not. */
const distinct = (arr) => new Set(arr.map((r) => `${r.unit}:${r.seq}`)).size;

// #322: the PRODUCTION sink (src/main/memory-notice.ts) wired the way index.ts wires it — real bus, real builder, a fake workspace map (the real store/agent-sdk need Electron).
// `emitLive` mirrors sdkEmitMemNotice: the REAL makeMemNotice builder, broadcast on the `agent:event` seam. The deps wiring itself is pinned by memory-cap-binding.test.ts.
const noticeSrc = path.join(REPO, 'src', 'main', 'memory-notice.ts');
const hasNotice = fs.existsSync(noticeSrc) && fs.existsSync(path.join(REPO, 'src', 'main', 'memory-notice-bus.ts')) && typeof kc.onMemorySoft === 'function' && typeof kc.drainAllMemNotices === 'function';
let sinkDeps = null;
const sinkLogs = [];
const fakeWs = new Map();
let memNoticeMod = null;
/** A rig switch: while true the coordinator's bus is "down" (the sink throws, the delivery layer must keep the record owed). */
let rigBusDown = false;
async function armSink(wsIds) {
  if (!hasNotice) return false;
  memNoticeMod = await import(noticeSrc);
  const { sendGated } = await import(`${REPO}/src/main/memory-notice-bus.ts`);
  const { makeMemNotice } = await import(`${REPO}/src/shared/mem-notice.ts`);
  fakeWs.set('rig-coordinator', { id: 'rig-coordinator', name: 'rig-coordinator', branch: 'rig-coordinator' });
  for (const id of wsIds) fakeWs.set(id, { id, name: `member-${id.slice(-4)}`, branch: `member-${id.slice(-4)}`, parentId: 'rig-coordinator' });
  let seq = 1;
  sinkDeps = {
    getWorkspace: (id) => fakeWs.get(id),
    patchWorkspace: async (id, patch) => { fakeWs.set(id, { ...fakeWs.get(id), ...patch }); },
    emitLive: (wsId, entry) => agentEvents.push({ wsId, ev: makeMemNotice({ seq: seq++ }, entry) }),
    sendToCoordinator: (m) => { if (!busDb || rigBusDown) throw new Error('no bus'); return sendGated(busDb, m, { warn: (x) => console.error(`  sink: ${x}`) }); }, // the SHIPPED gate, on the scratch bus
    resolveRunId: (w) => w.runId ?? 'run-on',
    log: { info: (m) => sinkLogs.push(m), warn: (m) => console.error(`  sink: ${m}`) },
  };
  memNoticeMod.startMemoryNotices(sinkDeps, { onMemoryKill: kc.onMemoryKill, onMemorySoft: kc.onMemorySoft });
  return true;
}
const busRows = (wsId) => (busDb ? busDb.prepare('SELECT sequence, kind, sender, recipient, body FROM messages WHERE sender = ? ORDER BY sequence').all(wsId) : []);
const noticeEvents = (wsId) => agentEvents.filter((e) => e.wsId === wsId && e.ev?.type === 'notice');
/** The kernel log must be readable for the m2 arms to mean anything (else the inference is all there is): a positive control, printed. */
const journalReadable = () => spawnSync('journalctl', ['-k', '--no-pager', '-q', '-n', '1', '-o', 'cat'], { encoding: 'utf8' }).stdout.trim().length > 0;
/** The swarm also crosses the warning level on its way up (rig soft 0.2 GB < hard 0.25 GB): kill rows/messages and warning rows/messages are counted apart. */
const isSoftText = (t) => /warning level \(/.test(t ?? '');
const killRows = (wsId) => noticeEvents(wsId).filter((e) => !isSoftText(e.ev.text));
const softRows = (wsId) => noticeEvents(wsId).filter((e) => isSoftText(e.ev.text));
const fileRecords = (file) => (readSafe(file) ?? '').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
/** The kernel's own record of which pids a scope's limit killed, read from OUTSIDE the scope — the rig's independent oracle (the keeper under test reads the same log from inside). */
const kernelKilledPids = (unit, sinceSec) => {
  const r = spawnSync('journalctl', ['-k', '--no-pager', '-q', '-o', 'json', '--grep', 'oom-kill:constraint=CONSTRAINT_MEMCG', '--since', `@${sinceSec}`], { encoding: 'utf8', maxBuffer: 16 << 20 });
  return (r.stdout ?? '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l).MESSAGE; } catch { return ''; } })
    .filter((m) => typeof m === 'string' && m.includes(`/${unit},`)).map((m) => Number(/,pid=(\d+),uid=/.exec(m)?.[1])).filter(Boolean);
};
const notified = async (wsId) => { if (memNoticeMod) await memNoticeMod.__memNoticeIdle(wsId); };

async function teardown(wsList) {
  for (const ws of wsList) {
    try { kc.forbidKeeperLaunch?.(ws); await kc.killKeeper(ws, 'memory-cap-rig'); } catch { /* best effort */ }
  }
  await sleep(300);
  for (const ws of wsList) for (const u of armUnits(ws)) stopUnit(u); // by NAME: they start with the rig prefix + this arm's ws id
  await sleep(300);
  // Whatever still carries this arm's scratch dir (a tree with NO scope to stop — the pre-#320 world — leaves its Reliquats): killed by identity re-read at signal time.
  for (const pid of survivorsOf(base)) { try { if (pid !== process.pid && (readSafe(`/proc/${pid}/environ`)?.includes(base) || readSafe(`/proc/${pid}/cmdline`)?.includes(base))) process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  await sleep(200);
}

// #327: the app's explicit-stop sequence (no new keeper, keeper + CLI killed AWAITED, THEN the scope stop). On a tree without src/main/scope-stop-host.ts the last step is a no-op: master's behaviour.
const stopMod = fs.existsSync(path.join(REPO, 'src', 'main', 'scope-stop-host.ts')) ? await import(`${REPO}/src/main/scope-stop-host.ts`) : null;
const stopFor = async (w, reason) => (stopMod ? stopMod.stopMemberScopeFor(w, reason) : null);
async function explicitStop(w, reason, { forbid = true } = {}) {
  if (forbid) kc.forbidKeeperLaunch?.(w);
  await kc.killKeeper(w, reason);
  return stopFor(w, reason);
}
/** The pids carrying `marker` in their argv AND this arm's scratch dir (a detached process of THIS arm only). */
const procsMarked = (marker) => survivorsOf(base).filter((pid) => (readSafe(`/proc/${pid}/cmdline`) ?? '').includes(marker));

// ═══ the arms ═══════════════════════════════════════════════════════════════════════════════════════════════════════
const ws = wsName(ARM.slice(0, 4));
/** A fake session-bus address handed to the member: the arms that assert on the CLI env need no real bus (the browser arm uses the real one). */
const FAKE_BUS = 'unix:path=/nonexistent/orchestra-rig-bus';
const wsList = [ws];
let detail = '';
try {
  if (ARM === 'kill_at_hard') {
    const spec = decide(ws);
    const st = open(ws, spec, { extraEnv: { DBUS_SESSION_BUS_ADDRESS: FAKE_BUS } });
    await waitFor(() => initOf(st), 30_000);
    const f = factsOf(ws, st);
    check('a scope exists: the keeper runs in a rig-prefixed .scope', f.inRigScope, `cgroup=${cgOf(f.keeperPid)}`);
    check('the CLI is in the SAME scope as the keeper', f.cliPid && cgOf(f.cliPid) === cgOf(f.keeperPid), `cli=${cgOf(f.cliPid)}`);
    const maxB = Number(readSafe(path.join(f.cgroupDir ?? '/nonexistent', 'memory.max')));
    const want = Math.round(HARD_GB * 1024 ** 3);
    check('levels: memory.max = the Garde mémoire HARD level (±1 page)', Math.abs(maxB - want) <= 65536, `memory.max=${maxB} want=${want}`);
    check('no swap escape: memory.swap.max = 0', readSafe(path.join(f.cgroupDir ?? '/nonexistent', 'memory.swap.max'))?.trim() === '0');
    check('no soft throttle, ever (D-Q2): memory.high = max', readSafe(path.join(f.cgroupDir ?? '/nonexistent', 'memory.high'))?.trim() === 'max');
    const pol = f.unit ? spawnSync('systemctl', ['--user', 'show', '-p', 'OOMPolicy', '--value', f.unit], { encoding: 'utf8' }).stdout.trim() : '';
    check('never group-kill: OOMPolicy=continue', pol === 'continue', `OOMPolicy=${pol}`);
    check('victim protection (CLI side): the CLI keeps adj 0 and the keeper adj 0', f.init?.adj === 0 && Number(readSafe(`/proc/${f.keeperPid}/oom_score_adj`)) === 0, `cli=${f.init?.adj}`);
    const t1 = await runTool(st, 'cat /proc/self/oom_score_adj', 't-adj');
    check('victim protection (tool side): a Bash tool command runs at oom_score_adj 1000', t1?.stdout.trim() === '1000', `tool adj=${t1?.stdout.trim()} prefix=${f.init?.shellPrefix}`);
    const tb = await runTool(st, 'printf "%s" "${DBUS_SESSION_BUS_ADDRESS-unset}"', 't-bus');
    check('H2 F1 counter: a capped member\'s tool env has NO session-bus address (a browser would leave the scope through it) — the driver handed it one', tb?.stdout.trim() === 'unset', `saw=${tb?.stdout.trim().slice(0, 60)}`);
    const events0 = f.cgroupDir ? eventsOf(f.cgroupDir) : {};
    const t2 = await runTool(st, `${python.join(' ')} ${RIG_DIR}/swarm.py 8 50 10 swarm-kill-at-hard`, 't-swarm', 90_000);
    await sleep(1200);
    const ev = f.cgroupDir ? eventsOf(f.cgroupDir) : {};
    check('the kernel killed at the hard level: memory.events oom_kill ≥ 1', (ev.oom_kill ?? 0) - (events0.oom_kill ?? 0) >= 1, `before=${events0.oom_kill} after=${ev.oom_kill} oom=${ev.oom}`);
    check('the tool saw its processes killed (killed ≥ 1, survived < 8)', /killed=([1-9]\d*)/.test(t2?.stdout ?? ''), (t2?.stdout ?? '').trim().slice(-80));
    check('keeper ALIVE (same pid+start)', alive(f.keeperPid) && ident(f.keeperPid) === f.keeperId);
    check('CLI ALIVE (same pid+start)', alive(f.cliPid) && ident(f.cliPid) === f.cliId);
    check('the scope was NOT stopped by systemd (group-kill)', f.unit && spawnSync('systemctl', ['--user', 'is-active', f.unit], { encoding: 'utf8' }).stdout.trim() === 'active');
    const nKilled = (ev.oom_kill ?? 0) - (events0.oom_kill ?? 0);
    await waitFor(() => kills.length >= nKilled && nKilled > 0, 8000);
    const named = kills.find((r) => r.level === 'hard' && /swarm\.py/.test(r.command ?? ''));
    check('every kernel kill is reported: one record per oom_kill, all at the hard level', nKilled > 0 && kills.length === nKilled && kills.every((r) => r.level === 'hard'), `records=${kills.length} oom_kill delta=${nKilled}`);
    check('...and the record NAMES the killed command (a process that lived < one snapshot may stay unnamed, never the others)', !!named, JSON.stringify(kills.map((r) => r.command?.slice(0, 40) ?? null)));
    const rec = named;
    check('the app says the cap is ACTIVE (state read back from the keeper)', await waitFor(() => new RegExp(`memory-cap\\[${ws}\\]: ACTIVE — scope ${f.unit}`).test(orchLog()), 8000), '');
    check('the app log has the line (workspace, killed command, level)', new RegExp(`memory-cap\\[${ws}\\] killed ".*swarm\\.py.*" .* at the hard level`).test(orchLog()), '');
    detail = `scope=${f.unit} memory.max=${maxB} oom_kill=${ev.oom_kill} record=${rec?.command?.slice(0, 40)}`;
  } else if (ARM === 'below_cap_untouched') {
    const st = open(ws, decide(ws));
    await waitFor(() => initOf(st), 30_000);
    const f = factsOf(ws, st);
    check('control: the member IS in its scope (so "untouched" is not vacuous)', f.inRigScope || !hasCap, `unit=${f.unit}`);
    const e0 = f.cgroupDir ? eventsOf(f.cgroupDir) : {};
    const t = await runTool(st, `${python.join(' ')} ${RIG_DIR}/hog.py 30 2 hog-below-cap`, 't-hog');
    const e1 = f.cgroupDir ? eventsOf(f.cgroupDir) : {};
    check('a hog below the cap finishes: exit 0 and "survived"', t?.code === 0 && /survived/.test(t.stdout), `code=${t?.code} ${t?.stdout?.trim().slice(-40)}`);
    check('no kill: oom_kill unchanged, no record', (e1.oom_kill ?? 0) === (e0.oom_kill ?? 0) && kills.length === 0, `oom_kill ${e0.oom_kill}->${e1.oom_kill}`);
    check('keeper + CLI untouched', alive(f.keeperPid) && ident(f.keeperPid) === f.keeperId && alive(f.cliPid) && ident(f.cliPid) === f.cliId);
    detail = `unit=${f.unit}`;
  } else if (ARM === 'human_no_scope' || ARM === 'switch_off_no_scope') {
    const human = ARM === 'human_no_scope';
    const spec = decide(ws, human ? { fleet: false, run: 'run-on' } : { fleet: true, run: 'run-off' });
    check(`the decision is "no scope" (${human ? 'human session, switch ON' : 'fleet member, switch OFF'})`, spec === undefined, JSON.stringify(spec ?? null));
    const st = open(ws, spec, { extraEnv: { DBUS_SESSION_BUS_ADDRESS: FAKE_BUS } });
    await waitFor(() => initOf(st), 30_000);
    const f = factsOf(ws, st);
    check('the keeper is NOT in a rig scope', !f.inRigScope && !(f.unit ?? '').startsWith('orchestra-ws-'), `cgroup=${cgOf(f.keeperPid)}`);
    check('no scope exists for the workspace', scopeMod ? scopeMod.memberScopes(ws).length === 0 : armUnits(ws).length === 0, `units=${armUnits(ws)}`);
    check('the tool wrapper is not installed in the CLI env (tool commands keep adj 0)', f.init?.shellPrefix == null);
    const pr = await kc.probeKeeper(ws);
    check('the keeper reports no cap', pr && pr.cap === undefined, JSON.stringify(pr?.cap ?? null));
    const tb = await runTool(st, 'printf "%s" "${DBUS_SESSION_BUS_ADDRESS-unset}"', 't-bus');
    check('control for the capped-only env change: an UNCAPPED session keeps its session-bus address', tb?.stdout.trim() === FAKE_BUS, `saw=${tb?.stdout.trim().slice(0, 60)}`);
    const t = await runTool(st, `${python.join(' ')} ${RIG_DIR}/swarm.py 4 40 4 swarm-uncapped`, 't-swarm', 60_000);
    check('uncapped: nothing killed (the same swarm a capped member loses processes to)', /killed=0/.test(t?.stdout ?? ''), (t?.stdout ?? '').trim().slice(-60));
    detail = `cgroup=${cgOf(f.keeperPid)}`;
  } else if (ARM === 'no_migration') {
    // A keeper started BEFORE the switch applied (run-off) is attached to as it is, even when the next start's decision says "scope".
    const st1 = open(ws, decide(ws, { run: 'run-off' }));
    await waitFor(() => initOf(st1), 30_000);
    await runTool(st1, 'true', 't-started', 20_000); // a session that has really run: the facade attaches to it (a never-started one is relaunched by design)
    const f1 = factsOf(ws, st1);
    const cg1 = cgOf(f1.keeperPid);
    const spec2 = decide(ws, { run: 'run-on' });
    check('control: the second start WOULD be given a scope', hasCap ? !!spec2 : true, JSON.stringify(spec2 ?? null));
    const st2 = open(ws, spec2);
    await waitFor(() => st2.attached || st2.exited || st2.errors.length, 20_000);
    await sleep(500);
    const f2 = factsOf(ws, st2);
    check('the second facade ATTACHED to the running keeper', st2.attached);
    check('same keeper, same CLI: nothing was relaunched', f2.keeperId === f1.keeperId && alive(f1.cliPid) && ident(f1.cliPid) === f1.cliId, `${f1.keeperId} vs ${f2.keeperId}`);
    check('the running session was NOT migrated into a scope', cgOf(f2.keeperPid) === cg1 && !f2.inRigScope, `cgroup=${cgOf(f2.keeperPid)}`);
    check('no scope exists for the workspace', armUnits(ws).length === 0, `units=${armUnits(ws)}`);
    detail = `keeper=${f1.keeperId}`;
  } else if (ARM === 'kill_while_detached') {
    // The "app" is a SEPARATE process (MC_PHASE=app) that starts the member and the swarm and is then SIGKILLed mid-turn; this process is the app that comes back.
    if (PHASE === 'app2') {
      // a THIRD process: the app restarted AGAIN after the kills were delivered and logged — it must not be told about them a second time
      const st2 = open(ws, decide(ws));
      await waitFor(() => st2.attached, 20_000);
      await sleep(2000);
      fs.writeFileSync(path.join(base, 'app2.json'), JSON.stringify({ attached: st2.attached, kills: kills.length }));
      process.exit(0);
    }
    if (PHASE === 'app') {
      const st = open(ws, decide(ws));
      await waitFor(() => initOf(st), 30_000);
      const f = factsOf(ws, st);
      st.send({ tool: `${python.join(' ')} ${RIG_DIR}/swarm.py 8 50 10 swarm-detached`, id: 't-swarm' });
      await waitFor(() => st.lines.some((l) => l.toolStart === 't-swarm'), 15_000);
      fs.writeFileSync(path.join(base, 'app.json'), JSON.stringify({ keeperPid: f.keeperPid, keeperId: f.keeperId, cliPid: f.cliPid, cliId: f.cliId, cgroupDir: f.cgroupDir, unit: f.unit, inRigScope: f.inRigScope }));
      process.kill(process.pid, 'SIGKILL'); // the app crashes now, mid-turn
      await sleep(5000);
    }
    const app = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { env: { ...process.env, MC_PHASE: 'app' }, encoding: 'utf8', timeout: 120_000 });
    check('the first "app" process died by SIGKILL mid-turn', app.signal === 'SIGKILL', `signal=${app.signal} status=${app.status} ${String(app.stderr).slice(-200)}`);
    const info = JSON.parse(readSafe(path.join(base, 'app.json')) ?? '{}');
    check('the member was in its scope when the app died', hasCap ? !!info.inRigScope : true, `unit=${info.unit}`);
    const killed = await waitFor(() => info.cgroupDir && (eventsOf(info.cgroupDir).oom_kill ?? 0) >= 1, 60_000, 200);
    let lastN = -1;
    await waitFor(() => { const n = eventsOf(info.cgroupDir).oom_kill ?? 0; const stable = n === lastN; lastN = n; return stable; }, 30_000, 2500); // the swarm is done killing
    check('the kernel killed while NO app was attached', killed, `events=${JSON.stringify(info.cgroupDir ? eventsOf(info.cgroupDir) : null)}`);
    check('keeper + CLI survived the app crash AND the kill', alive(info.keeperPid) && ident(info.keeperPid) === info.keeperId && alive(info.cliPid) && ident(info.cliPid) === info.cliId);
    // a NEW app attaches: the keeper catches it up (helloAck.memKills) and the app logs/notifies once
    const st = open(ws, decide(ws));
    await waitFor(() => st.attached, 20_000);
    await waitFor(() => kills.length > 0, 8000);
    const evAfter = info.cgroupDir ? eventsOf(info.cgroupDir) : {};
    check('the reattached app is told about EVERY kill that happened while it was away (one record per oom_kill, hard level)', kills.length === (evAfter.oom_kill ?? -1) && kills.every((r) => r.level === 'hard'), `records=${kills.length} oom_kill=${evAfter.oom_kill}`);
    check('...naming the killed command', kills.some((r) => /swarm\.py/.test(r.command ?? '')), JSON.stringify(kills.map((r) => r.command?.slice(0, 30) ?? null)));
    check('the app log has the line after reattach', new RegExp(`memory-cap\\[${ws}\\] killed`).test(orchLog()));
    const logCount = () => (orchLog().match(new RegExp(`memory-cap\\[${ws}\\] killed`, 'g')) ?? []).length;
    const logged = logCount();
    check('every record was logged exactly once (log lines = oom_kill)', logged === (evAfter.oom_kill ?? -1), `lines=${logged} oom_kill=${evAfter.oom_kill}`);
    const app2 = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { env: { ...process.env, MC_PHASE: 'app2' }, encoding: 'utf8', timeout: 120_000 });
    const out2 = JSON.parse(readSafe(path.join(base, 'app2.json')) ?? '{}');
    check('PRE-REVIEW MAJOR 2: a SECOND app restart re-attaches and replays NOTHING (0 records delivered, no new log line)', out2.attached === true && out2.kills === 0 && logCount() === logged, `attached=${out2.attached} delivered=${out2.kills} lines ${logged}->${logCount()} ${String(app2.stderr).slice(-120)}`);
    detail = `kills=${kills.length}`;
  } else if (ARM === 'reliquat_outlives_keeper') {
    const st = open(ws, decide(ws));
    await waitFor(() => initOf(st), 30_000);
    const f = factsOf(ws, st);
    const td = await runTool(st, `${python.join(' ')} ${RIG_DIR}/daemonize.py 90 reliq-daemon`, 't-daemon', 20_000);
    check('the tool returned (the daemon detached from the tool tree)', td && td.code === 0);
    await sleep(500);
    await kc.killKeeper(ws, 'memory-cap-rig-restart');
    await waitFor(() => !alive(f.keeperPid) && !alive(f.cliPid), 15_000);
    const scopes = scopeMod ? scopeMod.memberScopes(ws) : [];
    check('the scope outlives the keeper and is found by workspace id alone (no app state)', scopes.length === 1 && scopes[0].keeperPid === null && scopes[0].unit === f.unit, `scopes=${JSON.stringify(scopes.map((s) => s.unit))} unit=${f.unit}`);
    const procs = scopes[0] ? scopeMod.listScopeProcs(scopes[0]) : [];
    check('the detached daemon is a Reliquat (no live keeper to belong to)', procs.length >= 1 && procs.every((p) => p.role === 'reliquat') && procs.some((p) => /daemonize\.py/.test(p.cmdline)), procs.map((p) => `${p.pid}:${p.role}:${p.comm}`).join(' '));
    const mem = scopes[0] ? scopeMod.readScopeMemory(scopes[0]) : null;
    check('its memory is readable from sysfs (current > 0, max = hard)', mem && mem.currentBytes > 0 && mem.maxBytes !== null && Math.abs(mem.maxBytes - Math.round(HARD_GB * 1024 ** 3)) <= 65536, JSON.stringify(mem)?.slice(0, 160));
    // a restart while the old scope lives on: a NEW generation, no "unit already exists", both resolvable
    const st2 = open(ws, decide(ws));
    await waitFor(() => initOf(st2), 30_000);
    const f2 = factsOf(ws, st2);
    const scopes2 = scopeMod ? scopeMod.memberScopes(ws) : [];
    check('a restart while Reliquats keep the old scope starts a NEW generation in a NEW scope', f2.inRigScope && f2.unit !== f.unit && scopes2.length === 2, `old=${f.unit} new=${f2.unit} n=${scopes2.length}`);
    const newScope = scopes2.find((s) => s.unit === f2.unit);
    const td2 = await runTool(st2, `${python.join(' ')} ${RIG_DIR}/daemonize.py 90 reliq-daemon-2`, 't-daemon2', 20_000);
    await sleep(500);
    const procs2 = newScope ? scopeMod.listScopeProcs(newScope, f2.cliPid) : [];
    const roleOf = (re) => procs2.find((p) => re.test(p.cmdline))?.role ?? null;
    check('in the NEW scope (live keeper): keeper / cli classified, the old generation\'s daemon is not counted here', procs2.some((p) => p.role === 'keeper') && procs2.some((p) => p.role === 'cli') && !procs2.some((p) => /reliq-daemon\b(?!-2)/.test(p.cmdline)), procs2.map((p) => `${p.role}:${p.comm}`).join(' '));
    check('...and a daemon started BY the live session that left its tree is a Reliquat (not "session") while its keeper is alive', td2?.code === 0 && roleOf(/reliq-daemon-2/) === 'reliquat', `role=${roleOf(/reliq-daemon-2/)}`);
    detail = `generations=${scopes2.length}`;
  } else if (ARM === 'delete_stops_scope') {
    // AC: delete a member that left a detached process => the process is gone AND the scope is removed. The sequence is the call sites': no new keeper, keeper (+CLI) killed awaited, THEN the scope stop.
    const st = open(ws, decide(ws));
    await waitFor(() => initOf(st), 30_000);
    const f = factsOf(ws, st);
    const td = await runTool(st, `${python.join(' ')} ${RIG_DIR}/daemonize.py 120 ${ws}-daemon`, 't-daemon', 20_000);
    await sleep(500);
    const dpid = procsMarked(`${ws}-daemon`)[0];
    const dId = ident(dpid);
    check('setup: the member runs in its rig scope and left a DETACHED process in it', f.inRigScope && td?.code === 0 && !!dpid && cgOf(dpid) === cgOf(f.keeperPid), `unit=${f.unit} daemon=${dpid} cg=${cgOf(dpid)}`);
    const rep = await explicitStop(ws, 'workspace-deleted');
    await waitFor(() => !alive(dpid) && !armUnits(ws).length, 15_000);
    check('the detached process is GONE (pid+start identity)', !alive(dpid) || ident(dpid) !== dId, `daemon ${dpid} alive=${alive(dpid)}`);
    check('keeper and CLI are gone', !alive(f.keeperPid) && !alive(f.cliPid));
    check('the scope is REMOVED: no unit, no memberScopes entry, no cgroup directory', armUnits(ws).length === 0 && (scopeMod ? scopeMod.memberScopes(ws).length === 0 : true) && !fs.existsSync(f.cgroupDir ?? '/nonexistent-unit'), `units=${armUnits(ws)} dir=${f.cgroupDir && fs.existsSync(f.cgroupDir)}`);
    check('the report says what it did: Reliquats killed, THAT unit stopped', !!rep && rep.killed >= 1 && rep.stopped.includes(f.unit) && rep.kept.length === 0, JSON.stringify(rep));
    check('the app log has the stop line (workspace, reason) — the instrument can say yes', new RegExp(`scope-stop\\[${ws}\\] \\(workspace-deleted\\): killed [1-9]`).test(orchLog()));
    detail = `unit=${f.unit} killed=${rep?.killed}`;
  } else if (ARM === 'delete_all_generations') {
    // A restart keeps its Reliquats (new generation, old scope lives on): a delete must take BOTH generations — FI-1 names every unit of the member.
    const st = open(ws, decide(ws));
    await waitFor(() => initOf(st), 30_000);
    const f = factsOf(ws, st);
    await runTool(st, `${python.join(' ')} ${RIG_DIR}/daemonize.py 120 ${ws}-gen1`, 't-d1', 20_000);
    await sleep(500);
    await kc.killKeeper(ws, 'memory-cap-rig-restart');
    await waitFor(() => !alive(f.keeperPid) && !alive(f.cliPid), 15_000);
    const st2 = open(ws, decide(ws));
    await waitFor(() => initOf(st2), 30_000);
    const f2 = factsOf(ws, st2);
    await runTool(st2, `${python.join(' ')} ${RIG_DIR}/daemonize.py 120 ${ws}-gen2`, 't-d2', 20_000);
    await sleep(500);
    const d1 = procsMarked(`${ws}-gen1`)[0];
    const d2 = procsMarked(`${ws}-gen2`)[0];
    const scopes0 = scopeMod ? scopeMod.memberScopes(ws) : [];
    check('setup: TWO generations — the old scope (daemon only) lives on beside the live one', f2.inRigScope && f2.unit !== f.unit && scopes0.length === 2 && alive(d1) && alive(d2), `units=${scopes0.map((s) => s.unit)} d1=${d1} d2=${d2}`);
    const rep = await explicitStop(ws, 'workspace-deleted');
    await waitFor(() => !alive(d1) && !alive(d2) && !armUnits(ws).length, 15_000);
    check('both daemons are GONE', !alive(d1) && !alive(d2), `d1=${alive(d1)} d2=${alive(d2)}`);
    check('both scopes are REMOVED', armUnits(ws).length === 0 && (scopeMod ? scopeMod.memberScopes(ws).length === 0 : true), `units=${armUnits(ws)}`);
    check('the report names both units as stopped', !!rep && rep.stopped.includes(f.unit) && rep.stopped.includes(f2.unit), JSON.stringify(rep?.stopped));
    detail = `stopped=${rep?.stopped?.length}`;
  } else if (ARM === 'other_member_untouched') {
    // Three live members: A, B whose id EXTENDS A's ("ab" must not match "ab-cd"), C unrelated. Stopping A must leave B and C whole; then stopping B must leave C whole.
    const A = ws;
    const B = `${ws}-b`;
    const C = wsName('othc');
    wsList.push(B, C);
    const members = {};
    for (const w of [A, B, C]) {
      const s = open(w, decide(w));
      await waitFor(() => initOf(s), 30_000);
      await runTool(s, `${python.join(' ')} ${RIG_DIR}/daemonize.py 120 ${w}-dmn`, `t-d-${w.slice(-3)}`, 20_000);
      members[w] = { st: s, f: factsOf(w, s) };
    }
    await sleep(500);
    for (const w of [A, B, C]) { const m = members[w]; m.d = procsMarked(`${w}-dmn`)[0]; m.dId = ident(m.d); }
    const whole = (w) => { const m = members[w]; const act = m.f.unit ? spawnSync('systemctl', ['--user', 'is-active', m.f.unit], { encoding: 'utf8' }).stdout.trim() : ''; return alive(m.f.keeperPid) && ident(m.f.keeperPid) === m.f.keeperId && alive(m.f.cliPid) && ident(m.f.cliPid) === m.f.cliId && alive(m.d) && ident(m.d) === m.dId && act === 'active'; };
    check('setup: three members, each in its OWN scope with a detached process', [A, B, C].every((w) => members[w].f.inRigScope && !!members[w].d) && new Set([A, B, C].map((w) => members[w].f.unit)).size === 3, [A, B, C].map((w) => members[w].f.unit).join(' '));
    const repA = await explicitStop(A, 'workspace-deleted');
    await waitFor(() => !alive(members[A].d), 15_000);
    check('A is gone (detached process, keeper, unit)', !alive(members[A].d) && !alive(members[A].f.keeperPid) && armUnits(A).filter((u) => !u.includes(`${A}-b-`)).length === 0, JSON.stringify(repA));
    check('B (whose id EXTENDS A\'s) is WHOLE: keeper, CLI, detached process, unit — same identities', whole(B), `d=${alive(members[B].d)} unit=${members[B].f.unit}`);
    check('C (unrelated) is WHOLE', whole(C));
    check('A\'s report names only A\'s own unit', !!repA && repA.stopped.length === 1 && repA.stopped[0] === members[A].f.unit && repA.scopes.length === 1, JSON.stringify(repA));
    const repB = await explicitStop(B, 'workspace-deleted');
    await waitFor(() => !alive(members[B].d), 15_000);
    check('B is gone', !alive(members[B].d) && !alive(members[B].f.keeperPid) && !armUnits(B).length, JSON.stringify(repB));
    check('C is STILL whole after B\'s stop', whole(C));
    detail = `A=${repA?.killed}/${repA?.stopped?.length} B=${repB?.killed}/${repB?.stopped?.length}`;
  } else if (ARM === 'live_keeper_untouched') {
    // The caller did NOT stop the session first (or the stop is a no-op restart): a RUNNING member's detached jobs are not Reliquats to kill — nothing is touched.
    const st = open(ws, decide(ws));
    await waitFor(() => initOf(st), 30_000);
    const f = factsOf(ws, st);
    await runTool(st, `${python.join(' ')} ${RIG_DIR}/daemonize.py 120 ${ws}-daemon`, 't-daemon', 20_000);
    await sleep(500);
    const dpid = procsMarked(`${ws}-daemon`)[0];
    const dId = ident(dpid);
    const rep = await stopFor(ws, 'workspace-archived');
    await sleep(1500);
    check('keeper and CLI are ALIVE, same identities', alive(f.keeperPid) && ident(f.keeperPid) === f.keeperId && alive(f.cliPid) && ident(f.cliPid) === f.cliId);
    check('the running member\'s detached process is ALIVE (not a Reliquat while its keeper lives)', !!dpid && alive(dpid) && ident(dpid) === dId, `daemon=${dpid}`);
    check('the scope is still there and active', !!f.unit && spawnSync('systemctl', ['--user', 'is-active', f.unit], { encoding: 'utf8' }).stdout.trim() === 'active');
    check('the stop reports UNKNOWN (keeper alive), not "nothing to do"', stopMod ? /keeper is still alive/.test(rep?.unknown ?? '') && rep.stopped.length === 0 && rep.killed === 0 : true, JSON.stringify(rep));
    detail = `unit=${f.unit}`;
  } else if (ARM === 'app_restart_keeps_scopes') {
    // AC: restarting the app leaves every scope and its Reliquats intact. The "app" is a separate process (MC_PHASE=app) that starts the member + a detached process and is SIGKILLed; this process is the app that comes back.
    if (PHASE === 'app') {
      const st = open(ws, decide(ws));
      await waitFor(() => initOf(st), 30_000);
      const f = factsOf(ws, st);
      await runTool(st, `${python.join(' ')} ${RIG_DIR}/daemonize.py 120 ${ws}-daemon`, 't-daemon', 20_000);
      await sleep(500);
      const dpid = procsMarked(`${ws}-daemon`)[0];
      fs.writeFileSync(path.join(base, 'app.json'), JSON.stringify({ keeperPid: f.keeperPid, keeperId: f.keeperId, cliPid: f.cliPid, cliId: f.cliId, unit: f.unit, dpid, dId: ident(dpid) }));
      process.kill(process.pid, 'SIGKILL');
      await sleep(5000);
    }
    const app = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { env: { ...process.env, MC_PHASE: 'app' }, encoding: 'utf8', timeout: 120_000 });
    check('the first "app" died by SIGKILL', app.signal === 'SIGKILL', `signal=${app.signal} ${String(app.stderr).slice(-160)}`);
    const info = JSON.parse(readSafe(path.join(base, 'app.json')) ?? '{}');
    check('with the app GONE: keeper, CLI, detached process and scope are all intact', alive(info.keeperPid) && ident(info.keeperPid) === info.keeperId && alive(info.cliPid) && alive(info.dpid) && ident(info.dpid) === info.dId && armUnits(ws).length === 1, `unit=${info.unit} units=${armUnits(ws)}`);
    // the app that comes back: the boot path attaches to the live keeper, reads the scopes (what the Resources page / bus-status do) — and stops NOTHING
    const st2 = open(ws, decide(ws));
    await waitFor(() => st2.attached, 20_000);
    await sleep(1500);
    const scopes = scopeMod ? scopeMod.memberScopes(ws) : [];
    check('the restarted app re-ATTACHED to the same keeper (no new generation), the scope is the same one', st2.attached && scopes.length === 1 && scopes[0].unit === info.unit && pidFilePid(ws) === info.keeperPid, `scopes=${scopes.map((s) => s.unit)} keeper=${pidFilePid(ws)}`);
    check('the Reliquat survived the app restart, same identity', alive(info.dpid) && ident(info.dpid) === info.dId);
    check('keeper + CLI untouched by the restart', alive(info.keeperPid) && ident(info.keeperPid) === info.keeperId && alive(info.cliPid) && ident(info.cliPid) === info.cliId);
    check('nothing in the app log says a scope was stopped (restart is not an explicit stop)', !/scope-stop\[/.test(orchLog()), orchLog().split('\n').filter((l) => /scope-stop\[/.test(l)).slice(0, 2).join(' | '));
    detail = `unit=${info.unit}`;
  } else if (ARM === 'clear_then_fresh_start') {
    // /clear (and an account migration) are explicit stops, but the member LIVES ON: the next send starts a brand-new session in a brand-new scope, with none of the old conversation's detached jobs.
    const st = open(ws, decide(ws));
    await waitFor(() => initOf(st), 30_000);
    const f = factsOf(ws, st);
    await runTool(st, `${python.join(' ')} ${RIG_DIR}/daemonize.py 120 ${ws}-old`, 't-old', 20_000);
    await sleep(500);
    const dOld = procsMarked(`${ws}-old`)[0];
    check('setup: a detached process of the OLD conversation lives in the scope', !!dOld && cgOf(dOld) === cgOf(f.keeperPid), `old=${dOld}`);
    const rep = await explicitStop(ws, 'clear', { forbid: false });
    await waitFor(() => !alive(dOld) && !armUnits(ws).length, 15_000);
    check('the old conversation\'s detached process is GONE and its scope removed', !alive(dOld) && armUnits(ws).length === 0, JSON.stringify(rep));
    const st2 = open(ws, decide(ws));
    const up = await waitFor(() => initOf(st2), 30_000);
    const f2 = factsOf(ws, st2);
    check('the NEXT session starts normally, in a fresh rig scope, with a different keeper', up && f2.inRigScope && f2.keeperPid !== f.keeperPid && (scopeMod ? scopeMod.memberScopes(ws).length === 1 : true), `unit=${f2.unit} keeper ${f.keeperPid}->${f2.keeperPid}`);
    const t = await runTool(st2, 'echo fresh', 't-fresh');
    check('...and it runs a tool', t?.code === 0 && /fresh/.test(t.stdout));
    detail = `unit=${f2.unit}`;
  } else if (ARM === 'unit_stop_takes_spared') {
    // A process the Reliquat kill SPARES (an orphaned `claude` CLI: comm `claude`) is still in the member's scope after it: only the unit stop (THEN step) removes it.
    const st = open(ws, decide(ws));
    await waitFor(() => initOf(st), 30_000);
    const f = factsOf(ws, st);
    const orphan = `${base}/claude`;
    const tc = await runTool(st, `cp "$(command -v sleep)" "${orphan}" && setsid -f "${orphan}" 120 </dev/null >/dev/null 2>&1; true`, 't-orphan', 20_000);
    await runTool(st, `${python.join(' ')} ${RIG_DIR}/daemonize.py 120 ${ws}-daemon`, 't-daemon', 20_000);
    await sleep(500);
    const opid = procsMarked(orphan)[0];
    const dpid = procsMarked(`${ws}-daemon`)[0];
    check('setup: a detached `claude`-named orphan AND a plain daemon live in the member\'s scope', tc?.code === 0 && !!opid && !!dpid && readSafe(`/proc/${opid}/comm`)?.trim() === 'claude' && cgOf(opid) === cgOf(f.keeperPid) && cgOf(dpid) === cgOf(f.keeperPid), `orphan=${opid} daemon=${dpid}`);
    const rep = await explicitStop(ws, 'workspace-deleted');
    await waitFor(() => !alive(opid) && !alive(dpid) && !armUnits(ws).length, 15_000);
    check('the plain daemon is gone (killed by identity: report.killed counts it)', !alive(dpid) && !!rep && rep.killed >= 1, JSON.stringify(rep));
    check('the SPARED orphan is gone too — only the unit stop can have taken it', !alive(opid), `orphan=${opid}`);
    check('the unit is REMOVED and reported stopped', armUnits(ws).length === 0 && !!rep && rep.stopped.includes(f.unit) && rep.kept.length === 0, JSON.stringify(rep));
    detail = `killed=${rep?.killed} stopped=${rep?.stopped?.length}`;
  } else if (ARM === 'launcher_fails_plain') {
    // systemd-run exists on PATH (so the app believes it can scope) but FAILS (no user manager reachable…): the member must still start — uncapped, and saying so.
    const stub = path.join(base, 'stubbin');
    fs.mkdirSync(stub, { recursive: true });
    fs.writeFileSync(path.join(stub, 'systemd-run'), '#!/bin/sh\necho "Failed to connect to bus (rig stub)" >&2\nexit 1\n', { mode: 0o755 });
    const realPath = process.env.PATH;
    process.env.PATH = `${stub}:${realPath}`;
    scopeMod?.resetScopeSupportCache?.();
    const spec = decide(ws);
    check('the decision still says "scope" (support looked fine)', hasCap ? !!spec : true, JSON.stringify(spec ?? null));
    const tFail0 = Date.now();
    const st = open(ws, spec);
    const up = await waitFor(() => initOf(st), 30_000);
    const tFail = Date.now() - tFail0;
    process.env.PATH = realPath;
    const f = factsOf(ws, st);
    const failLine = orchLog().split('\n').find((l) => new RegExp(`memory-cap\\[${ws}\\].*launching it WITHOUT a scope`).test(l)) ?? '';
    check('a launcher that FAILS is handled at once (reason «exit 1», well under the 10 s hung-launcher wait)', hasCap ? /\(exit 1\b/.test(failLine) && !/hung/.test(failLine) && tFail < 8000 : true, `after ${tFail} ms: ${failLine.slice(-170)}`);
    check('the member STARTED anyway (an uncapped session beats none)', up && alive(f.keeperPid) && alive(f.cliPid), `errors=${st.errors.join('|')}`);
    check('...in no rig scope', !f.inRigScope, `cgroup=${cgOf(f.keeperPid)}`);
    const pr = await kc.probeKeeper(ws);
    check('the keeper says why: cap.state = no-scope', pr?.cap?.state === 'no-scope', JSON.stringify(pr?.cap ?? null));
    check('the app log says the member runs WITHOUT a scope', /launching it WITHOUT a scope/.test(orchLog()), '');
    check('...and WHY: the launcher\'s own stderr is in the line (not just "exit 1")', /launching it WITHOUT a scope/.test(orchLog()) && /rig stub/.test(orchLog().split('\n').find((l) => /launching it WITHOUT a scope/.test(l)) ?? ''), '');
    check('the app also reads the state back: the keeper is not in the scope ⇒ UNCAPPED, in the log', await waitFor(() => new RegExp(`memory-cap\\[${ws}\\]: the keeper is not in scope .* UNCAPPED`).test(orchLog()), 8000), '');
    check('tool commands are not wrapped (no cap, nothing to protect)', initOf(st)?.shellPrefix == null);
  } else if (ARM === 'launcher_hangs_plain') {
    // Review m5: systemd-run HANGS (never exits, never starts the keeper). The member must still start — plain, after ~10 s — and the app must say why. The hung launcher is killed (no stray process).
    const stub = path.join(base, 'stubbin');
    fs.mkdirSync(stub, { recursive: true });
    fs.writeFileSync(path.join(stub, 'systemd-run'), '#!/bin/sh\nexec sleep 300\n', { mode: 0o755 });
    const realPath = process.env.PATH;
    process.env.PATH = `${stub}:${realPath}`;
    scopeMod?.resetScopeSupportCache?.();
    const spec = decide(ws);
    check('the decision still says "scope" (systemd-run is on PATH)', hasCap ? !!spec : true, JSON.stringify(spec ?? null));
    const t0 = Date.now();
    const st = open(ws, spec);
    const up = await waitFor(() => initOf(st), 40_000);
    process.env.PATH = realPath;
    const f = factsOf(ws, st);
    check('the member STARTED anyway (plain), after the 10 s wait — not an error', up && alive(f.keeperPid) && alive(f.cliPid) && st.errors.length === 0, `after ${Date.now() - t0} ms errors=${st.errors.join('|')}`);
    check('...in no rig scope', !f.inRigScope, `cgroup=${cgOf(f.keeperPid)}`);
    check('the app log says systemd-run hung and the member runs WITHOUT a scope', /systemd-run hung\?.*WITHOUT a scope/.test(orchLog()), '');
    check('the hung launcher was killed (no `sleep 300` left under this arm)', survivorsOf(base).filter((p) => /sleep/.test(readSafe(`/proc/${p}/cmdline`) ?? '')).length === 0, '');
  } else if (ARM === 'slow_keeper_keeps_cap') {
    // Pre-review m6: systemd-run exec'd INTO the keeper and the keeper is merely SLOW to listen (12 s > the 10 s launcher wait: fleet load). A healthy capped keeper must not be killed and replaced by an uncapped one.
    const real = spawnSync('sh', ['-c', 'command -v systemd-run'], { encoding: 'utf8' }).stdout.trim();
    const stub = path.join(base, 'slowbin');
    fs.mkdirSync(stub, { recursive: true });
    const delay = path.join(stub, 'delay.cjs');
    fs.writeFileSync(delay, 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 12000);\n');
    fs.writeFileSync(path.join(stub, 'systemd-run'), `#!/bin/sh\nNODE_OPTIONS="--require ${delay}" exec ${real} "$@"\n`, { mode: 0o755 });
    const realPath = process.env.PATH;
    process.env.PATH = `${stub}:${realPath}`;
    scopeMod?.resetScopeSupportCache?.();
    const spec = decide(ws);
    check('the decision says "scope" (the shim is a real systemd-run behind a delayed keeper)', hasCap ? !!spec : true, JSON.stringify(spec ?? null));
    const t0 = Date.now();
    const st = open(ws, spec);
    const up = await waitFor(() => initOf(st), 60_000);
    const tUp = Date.now() - t0;
    process.env.PATH = realPath;
    const f = factsOf(ws, st);
    check('control: the keeper really was slower than the 10 s launcher wait (else the next checks prove nothing)', tUp > 10_500, `up after ${tUp} ms`);
    check('the member STARTED, IN its rig scope — not replaced by a plain keeper', up && f.inRigScope && alive(f.keeperPid) && alive(f.cliPid), `after ${tUp} ms cgroup=${cgOf(f.keeperPid)} errors=${st.errors.join('|')}`);
    check('the app log does NOT say the member runs WITHOUT a scope', !new RegExp(`memory-cap\\[${ws}\\].*WITHOUT a scope`).test(orchLog()), '');
    const pr = await kc.probeKeeper(ws);
    check('the keeper reports cap.state = active', pr?.cap?.state === 'active', JSON.stringify(pr?.cap ?? null));
    detail = `up after ${tUp} ms`;
  } else if (ARM === 'notice_kill_reported') {
    // #322: the cap kills commands ⇒ the member's event stream gets ONE notice row per kill, the coordinator ONE bus row per kill, the app log its line — over a REAL keeper in a REAL scope.
    check('the notice sink exists in this tree (memory-notice.ts + onMemorySoft + drainAllMemNotices)', await armSink([ws]), '');
    const st = open(ws, decide(ws));
    await waitFor(() => initOf(st), 30_000);
    const f = factsOf(ws, st);
    check('a scope exists: the keeper runs in a rig-prefixed .scope', f.inRigScope, `cgroup=${cgOf(f.keeperPid)}`);
    await runTool(st, `${python.join(' ')} ${RIG_DIR}/swarm.py 8 50 10 swarm-notice`, 't-swarm', 90_000);
    let lastN = -1;
    await waitFor(() => { const n = eventsOf(f.cgroupDir ?? '/nonexistent').oom_kill ?? 0; const stable = n === lastN && n > 0; lastN = n; return stable; }, 30_000, 1500);
    await sleep(2500); // the kernel-log lookup + delivery
    await notified(ws);
    const nKill = eventsOf(f.cgroupDir ?? '/nonexistent').oom_kill ?? 0;
    check('the cap killed commands', nKill >= 1, `oom_kill=${nKill}`);
    check('one record per kill', kills.length === nKill, `records=${kills.length} oom_kill=${nKill}`);
    const rows = killRows(ws);
    check('the member\'s event stream has ONE notice row per kill, worded «Command … killed: Plafond mémoire 0.25 GB reached»', rows.length === nKill && rows.every((r) => /^(Command .+|A command \(probably .+\)) killed: Plafond mémoire 0\.25 GB reached$/.test(r.ev.text)), `rows=${rows.length} ${rows[0]?.ev?.text?.slice(0, 90)}`);
    const bus = busRows(ws).filter((b) => b.kind === 'escalation');
    check('the coordinator has ONE escalation per kill, from the member to its coordinator', bus.length === nKill && bus.every((b) => b.recipient === 'rig-coordinator'), `escalations=${bus.length} kinds=${[...new Set(busRows(ws).map((b) => b.kind))]}`);
    check('...naming the workspace, the command and the level', bus.length > 0 && bus.every((b) => b.body.includes(ws) && /python3/.test(b.body) && /hard level \(0\.25 GB\)/.test(b.body)), (bus[0]?.body ?? '').slice(0, 200));
    check('the warning-level crossings on the way up were told apart: one `status` row + one stream row each, none of them a kill', busRows(ws).filter((b) => b.kind === 'status').length === softs.length && softRows(ws).length === softs.length, `status=${busRows(ws).filter((b) => b.kind === 'status').length} softRows=${softRows(ws).length} softs=${softs.length}`);
    const logged = (orchLog().match(new RegExp(`memory-cap\\[${ws}\\] killed`, 'g')) ?? []).length;
    check('the app log line exists once per kill', logged === nKill, `lines=${logged} oom_kill=${nKill}`);
    check('the rows are persisted for a reopened pane (one entry per record, kills and warnings)', (fakeWs.get(ws)?.sdkMemNotices?.length ?? 0) === nKill + softs.length && (fakeWs.get(ws)?.sdkMemNotices ?? []).filter((e) => e.level !== 'soft').length === nKill, `entries=${fakeWs.get(ws)?.sdkMemNotices?.length}`);
    // round 2 F6, the shipped gate with the switch OFF: a member of a run whose `liveness` is OFF still gets its row, the coordinator's message is «counted, not fired» (nothing on the bus)
    fakeWs.set('quiet-member', { id: 'quiet-member', name: 'quiet-member', branch: 'quiet-member', parentId: 'rig-coordinator', runId: 'run-quiet' });
    memNoticeMod?.handleMemRecord(sinkDeps, 'quiet-member', { kind: 'kill', source: 'kernel', seq: 1, at: Date.now(), level: 'hard', command: 'synthetic', pid: 1, rssBytes: null, candidates: [], unit: 'u.scope', hardBytes: 1 << 28 });
    await notified('quiet-member');
    check('liveness OFF for the run: the row is still told, nothing is written to the bus ("counted, not fired")', noticeEvents('quiet-member').length === 1 && busRows('quiet-member').length === 0 && sinkLogs.some((l) => /quiet-member.*would have told rig-coordinator.*counted, not fired/.test(l)), `rows=${noticeEvents('quiet-member').length} bus=${busRows('quiet-member').length} logs=${sinkLogs.length}`);
    const nfile = path.join(home, 'keepers', `${ws}.memnotices.jsonl`);
    kc.drainAllMemNotices?.((id) => fakeWs.has(id)); // a boot-style scan while the keeper is ALIVE and everything is delivered
    await sleep(500);
    check('a boot-style scan finds nothing new, and a LIVE keeper\'s notice file is never pruned (it is still appending)', fs.existsSync(nfile) && kills.length === nKill && busRows(ws).length === nKill + softs.length, `file=${fs.existsSync(nfile)} records=${kills.length} bus=${busRows(ws).length} softs=${softs.length}`);
    check('victims are named by the KERNEL log wherever the journal is readable', !journalReadable() || kills.every((k) => k.source === 'kernel'), JSON.stringify(kills.map((k) => k.source)));
    detail = `kills=${nKill} softs=${softs.length} rows=${rows.length} bus=${bus.length}`;
  } else if (ARM === 'notice_names_victim') {
    // #322 m2: a BIG command exits normally in the same window as a smaller one is OOM-killed unseen — the record must name the victim by PID, from the kernel's own line.
    check('control: the kernel log is readable on this host (else the inference is all there is)', journalReadable(), '');
    settings = { ...settings, capHardGb: 0.29, capSoftGb: 0.25 }; // the largest cap the rig rules allow (≤ 300 MB): room for the two commands of the race next to the keeper and the CLI
    check('the notice sink exists in this tree', await armSink([ws]), '');
    const st = open(ws, decide(ws), { rssMb: 0 });
    await waitFor(() => initOf(st), 30_000);
    const f = factsOf(ws, st);
    const sinceSec = Math.floor(Date.now() / 1000) - 2;
    // Twelve tiny detached tool-tree processes (adj 1000, ~1 MB) keep the kernel's candidate set NEVER EMPTY during the race: without them a spoiled round (the driver taken as collateral) can leave an OOM episode with no
    // tool candidate and the kernel takes the keeper (residual (d), measured on master #320 too) - which would end THIS arm for a reason that has nothing to do with naming. C (hundreds of MB) always outranks them.
    await runTool(st, 'for i in $(seq 12); do (setsid sleep 3600 >/dev/null 2>&1 &); done', 't-sentinels', 20_000);
    const ROUNDS = 6;
    // One tool command per round: if the keeper's own allocation at the moment the cap is full makes the kernel take the DRIVER too (a second OOM episode - measured), only that round is lost; rounds are
    // repeated (at most 14 attempts) until ROUNDS have completed, so the race is always run ROUNDS times - the product asserts below are not relaxed by a spoiled round.
    const victimPids = [];
    let completed = 0;
    for (let r = 0; r < 14 && completed < ROUNDS; r++) {
      const t = await runTool(st, `${python.join(' ')} ${RIG_DIR}/m2-race.py 1`, `t-m2-${r}`, 40_000);
      const mm = /m2: victims=([\d,]+)/.exec(t?.stdout ?? '');
      if (mm && /a_rc=0 c_rc=-9/.test(t?.stdout ?? '')) { victimPids.push(...mm[1].split(',')); completed += 1; }
      await sleep(1200); // the scope settles and the journal line lands
    }
    let nKillSeen = 0;
    const nKill = () => { const n = eventsOf(f.cgroupDir ?? '/nonexistent').oom_kill; if (n !== undefined) nKillSeen = n; return nKillSeen; };
    await waitFor(() => kills.length >= nKill() && nKill() > 0, 20_000);
    await sleep(2500);
    await notified(ws);
    const oracle = new Set(kernelKilledPids(f.unit, sinceSec).map(String));
    check('the race ran in at least 4 of 6 rounds (the big command exited normally (0), the small one was OOM-killed (-9)); a round the kernel spoiled by also taking the driver is not counted', completed >= 4, `completed=${completed}/${ROUNDS}`);
    check('the oracle (the kernel log read from OUTSIDE the scope) saw every real victim', victimPids.length > 0 && victimPids.every((p) => oracle.has(p)), `victims=${victimPids.join(',')} oracle=${[...oracle].join(',')}`);
    check('every kill has a record', kills.length === nKill() && kills.length >= completed, `records=${kills.length} oom_kill=${nKill()}`);
    const named = kills.filter((k) => oracle.has(String(k.pid)));
    check('EVERY record names a pid the kernel REALLY killed (oracle) — never the larger command that exited normally in the same window', kills.length > 0 && named.length === kills.length, `real ${named.length}/${kills.length}: ${kills.map((k) => `${k.pid}:${k.source}:${(k.command ?? 'null').slice(0, 20)}`).join(' ')}`);
    check('...and EVERY record says the KERNEL named it (no record degraded to a guess — two close kills must both be named)', kills.length > 0 && kills.every((k) => k.source === 'kernel'), `sources=${kills.map((k) => k.source ?? 'none').join(',')}`);
    check('...and every real victim of a completed round has a record naming it, kernel-sourced', victimPids.every((p) => kills.some((k) => String(k.pid) === p && k.source === 'kernel')), `victims=${victimPids.join(',')} records=${kills.map((k) => k.pid).join(',')}`);
    check('...none blames the big command (its 60 MB / sleep(1.0) command line is nowhere in the records)', kills.every((k) => !/sleep\(1\.0\)/.test(k.command ?? '')), kills.map((k) => k.command?.slice(0, 40)).join(' | '));
    check('the member\'s rows and the coordinator\'s escalations agree: one each per kill', killRows(ws).length === kills.length && busRows(ws).filter((b) => b.kind === 'escalation').length === kills.length, `rows=${killRows(ws).length} escalations=${busRows(ws).filter((b) => b.kind === 'escalation').length} records=${kills.length}`);
    const k = kills[0];
    detail = `rounds=${completed}/${ROUNDS} kernel=${kills.filter((x) => x.source === 'kernel').length}/${kills.length} real=${named.length}/${kills.length}`;
  } else if (ARM === 'notice_soft_reported') {
    // #322 D-Q2: the soft level is a keeper-watched WARNING on memory.current — one record per upward crossing, the same row + bus path as a kill, nothing killed or slowed.
    settings = { ...settings, capSoftGb: 0.15, capHardGb: HARD_GB };
    process.env.ORCHESTRA_MEMCAP_SOFT_MIN_INTERVAL_MS = '4500'; // the keeper inherits it: a 4.5 s rate bound instead of 30 s, so the arm can see both sides of it
    check('the notice sink exists in this tree', await armSink([ws]), '');
    const st = open(ws, decide(ws), { rssMb: 0 });
    await waitFor(() => initOf(st), 30_000);
    const f = factsOf(ws, st);
    const cur0 = Number(readSafe(path.join(f.cgroupDir ?? '/nonexistent', 'memory.current')));
    check('precondition: the scope starts BELOW the warning level (else nothing is a crossing)', cur0 < 0.15 * 1024 ** 3 * 0.9, `memory.current=${cur0}`);
    // R5 control FIRST: 130 MB of reclaimable PAGE CACHE pushes memory.current over the level, but it is not a working set — the kernel reclaims it before any kill — so it must NOT warn.
    const cacheFile = path.join(base, 'cache-fill.bin');
    st.send({ tool: `${python.join(' ')} ${RIG_DIR}/cache-fill.py ${cacheFile} 130 2.5`, id: 't-cache' });
    await sleep(1600);
    const curCache = Number(readSafe(path.join(f.cgroupDir ?? '/nonexistent', 'memory.current')));
    const inactive = Number((/^inactive_file (\d+)/m.exec(readSafe(path.join(f.cgroupDir ?? '/nonexistent', 'memory.stat')) ?? '') ?? [])[1] ?? 0);
    await waitFor(() => resultOf(st, 't-cache') || st.exited, 30_000, 100);
    await sleep(800);
    check('positive control: the page cache DID push raw memory.current over the warning level (the false alarm this guards against was real)', curCache > 0.15 * 1024 ** 3, `memory.current=${(curCache / 1048576).toFixed(0)} MB inactive_file=${(inactive / 1048576).toFixed(0)} MB level=${(0.15 * 1024).toFixed(0)} MB`);
    check('R5: …yet NO warning — the level keys on the working set (memory.current − inactive_file), not on page cache', softs.length === 0, `softs=${softs.length}`);
    const t0 = Date.now();
    const t = await runTool(st, `${python.join(' ')} ${RIG_DIR}/soft-cross.py 120 1.5 1.7 3 soft-notice`, 't-soft', 60_000);
    const wall = Date.now() - t0;
    await sleep(1500);
    await notified(ws);
    check('three crossings 3.2 s apart under a 4.5 s rate bound => TWO warnings (review F5): the middle crossing is swallowed and COUNTED, the third carries the count', softs.length === 2 && softs[0].suppressed === undefined && softs[1].suppressed === 1, `softs=${softs.length} suppressed=${softs.map((r) => r.suppressed)}`);
    check('each record carries the reading, the level and the hard cap', softs.every((r) => r.bytes >= r.softBytes && r.softBytes === Math.round(0.15 * 1024 ** 3) && r.hardBytes !== null), JSON.stringify(softs[0]));
    check('NOTHING was killed', kills.length === 0 && (eventsOf(f.cgroupDir ?? '/nonexistent').oom_kill ?? 0) === 0, `kills=${kills.length}`);
    check('NOTHING was slowed: no MemoryHigh (memory.high = max) and the tool ran at full speed', readSafe(path.join(f.cgroupDir ?? '/nonexistent', 'memory.high'))?.trim() === 'max' && t?.code === 0 && wall < 12_000, `wall=${wall} ms code=${t?.code}`);
    const rows = noticeEvents(ws);
    check('the member\'s stream has one row per warning', rows.length === 2 && rows.every((r) => /^Working set .+ GB \(reclaimable cache excluded\) — Plafond mémoire warning level \(0\.15 GB\) crossed; hard cap 0\.25 GB$/.test(r.ev.text)), rows.map((r) => r.ev.text).join(' | ').slice(0, 200));
    const bus = busRows(ws);
    check('the coordinator gets one `status` row per warning (not an escalation: nothing was lost)', bus.length === 2 && bus.every((b) => b.kind === 'status' && b.recipient === 'rig-coordinator'), `kinds=${bus.map((b) => b.kind)}`);
    detail = `softs=${softs.length}`;
  } else if (ARM === 'notice_app_closed') {
    // #322 m1: the kernel kills while the app is CLOSED and the keeper is gone before any reattach — the kill must still be reported, once. The "app" is a separate process that dies mid-turn.
    if (PHASE === 'app') {
      const st = open(ws, decide(ws));
      await waitFor(() => initOf(st), 30_000);
      const f = factsOf(ws, st);
      st.send({ tool: `${python.join(' ')} ${RIG_DIR}/swarm.py 8 50 10 swarm-app-closed`, id: 't-swarm' });
      await waitFor(() => st.lines.some((l) => l.toolStart === 't-swarm'), 15_000);
      fs.writeFileSync(path.join(base, 'app.json'), JSON.stringify({ keeperPid: f.keeperPid, keeperId: f.keeperId, cliPid: f.cliPid, cliId: f.cliId, cgroupDir: f.cgroupDir, unit: f.unit }));
      process.kill(process.pid, 'SIGKILL'); // the app crashes now, mid-turn
      await sleep(5000);
    }
    check('the notice sink exists in this tree', await armSink([ws]), '');
    const app = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { env: { ...process.env, MC_PHASE: 'app' }, encoding: 'utf8', timeout: 120_000 });
    check('the first "app" died by SIGKILL mid-turn', app.signal === 'SIGKILL', `signal=${app.signal} status=${app.status}`);
    const info = JSON.parse(readSafe(path.join(base, 'app.json')) ?? '{}');
    const killed = await waitFor(() => info.cgroupDir && (eventsOf(info.cgroupDir).oom_kill ?? 0) >= 1, 60_000, 200);
    let lastN = -1;
    await waitFor(() => { const n = eventsOf(info.cgroupDir).oom_kill ?? 0; const stable = n === lastN; lastN = n; return stable; }, 30_000, 2500);
    check('the kernel killed while NO app was attached', killed, `events=${JSON.stringify(info.cgroupDir ? eventsOf(info.cgroupDir) : null)}`);
    const nKill = eventsOf(info.cgroupDir).oom_kill ?? 0;
    const file = path.join(home, 'keepers', `${ws}.memnotices.jsonl`);
    const recs0 = fileRecords(file);
    const nFileKills = recs0.filter((r) => r.kind !== 'soft').length;
    const nFileSofts = recs0.filter((r) => r.kind === 'soft').length;
    check('the keeper had written every kill (and warning) to its durable file BEFORE telling anyone', fs.existsSync(file) && nFileKills === nKill, `file=${fs.existsSync(file)} kills=${nFileKills} softs=${nFileSofts} oom_kill=${nKill}`);
    // the keeper goes away BEFORE any app reattaches (linger expiry / the CLI ended): nothing is left to ask
    await kc.killKeeper(ws, 'memory-cap-rig-keeper-gone');
    check('the keeper and its CLI are gone — only the file remains', await waitFor(() => !alive(info.keeperPid) && !alive(info.cliPid), 15_000) && fs.existsSync(file), `keeper=${alive(info.keeperPid)} cli=${alive(info.cliPid)}`);
    // the app comes back — with the bus DOWN: the delivery must stay owed (m1: not lost); the in-order delivery stalls at the first record, whose row exists exactly once
    rigBusDown = true;
    kc.drainAllMemNotices?.((id) => fakeWs.has(id));
    await sleep(800);
    await notified(ws);
    check('bus down at the first scan: no bus row yet, the file is KEPT (it is the only copy), at most the first record\'s row exists (once)', busRows(ws).length === 0 && fs.existsSync(file) && noticeEvents(ws).length <= 1, `bus=${busRows(ws).length} file=${fs.existsSync(file)} rows=${noticeEvents(ws).length}`);
    // the bus is back: the next scan (the retry timer / the next attach) delivers
    rigBusDown = false;
    kc.drainAllMemNotices?.((id) => fakeWs.has(id));
    await sleep(1500);
    await notified(ws);
    const total = nFileKills + nFileSofts;
    const seqs = noticeEvents(ws).length;
    check('every kill is reported ONCE after the bus recovers (records, rows, escalations)', distinct(kills) === nKill && kills.every((r) => r.level === 'hard') && killRows(ws).length === nKill && busRows(ws).filter((b) => b.kind === 'escalation').length === nKill, `records=${distinct(kills)} killRows=${killRows(ws).length} escalations=${busRows(ws).filter((b) => b.kind === 'escalation').length} oom_kill=${nKill}`);
    check('...and every warning-level crossing too, once (a row + a `status` each)', distinct(softs) === nFileSofts && softRows(ws).length === nFileSofts && busRows(ws).filter((b) => b.kind === 'status').length === nFileSofts, `softs=${distinct(softs)}/${nFileSofts} rows=${softRows(ws).length}`);
    check('no record was delivered twice anywhere: rows and bus rows = records in the file', seqs === total && busRows(ws).length === total, `rows=${seqs} bus=${busRows(ws).length} file=${total}`);
    check('the app log has one line per kill', (orchLog().match(new RegExp(`memory-cap\\[${ws}\\] killed`, 'g')) ?? []).length === nKill);
    const killsBefore = kills.length;
    const softsBefore = softs.length;
    kc.drainAllMemNotices?.((id) => fakeWs.has(id));
    kc.drainAllMemNotices?.((id) => fakeWs.has(id));
    await sleep(800);
    await notified(ws);
    check('scanning again (restart after restart) reports NOTHING new: no duplicate record, row or bus message', kills.length === killsBefore && softs.length === softsBefore && noticeEvents(ws).length === total && busRows(ws).length === total, `records=${kills.length}+${softs.length} (before ${killsBefore}+${softsBefore}) rows=${noticeEvents(ws).length} bus=${busRows(ws).length} file=${total}`);
    check('the file is pruned once everything in it is delivered and no live keeper owns it', !fs.existsSync(file));
    detail = `kills=${nKill} keeper-gone`;
  } else if (ARM === 'notice_storm_no_wrong_certainty') {
    // Review-2 F2: the kernel rate-limits its `oom-kill:` dump, so a storm leaves FEWER journal lines than kills - a stale line must never be paired with a later kill and called kernel.
    check('the notice sink exists in this tree', await armSink([ws]), '');
    check('control: the kernel log is readable on this host', journalReadable(), '');
    const st = open(ws, decide(ws), { rssMb: 0 });
    await waitFor(() => initOf(st), 30_000);
    const f = factsOf(ws, st);
    const sinceSec = Math.floor(Date.now() / 1000) - 2;
    // Eight loops of four 400 MB children = up to 32 kills with tool-tree candidates alive at every OOM episode (a single back-to-back chain of one command at a time is NOT survivable - measured on master #320 too:
    // the next fork finds no tool candidate and the kernel takes the keeper; see session-keeper.md, residual risks).
    await runTool(st, `bash ${RIG_DIR}/storm.sh 8 4`, 't-storm', 120_000);
    let nKillSeen = 0;
    const nKill = () => { const n = eventsOf(f.cgroupDir ?? '/nonexistent').oom_kill; if (n !== undefined) nKillSeen = n; return nKillSeen; }; // the last reading while the scope exists
    await waitFor(() => kills.length >= nKill() && nKill() > 0, 30_000);
    await sleep(3000);
    await notified(ws);
    const oracle = new Set(kernelKilledPids(f.unit, sinceSec).map(String));
    const byKernel = kills.filter((k) => k.source === 'kernel');
    check('the cap\'s promise under a storm: the SESSION (keeper + CLI) survives, only tool commands die', alive(f.keeperPid) && ident(f.keeperPid) === f.keeperId && alive(f.cliPid) && ident(f.cliPid) === f.cliId, `keeper=${alive(f.keeperPid)} cli=${alive(f.cliPid)} cgroupDir=${f.cgroupDir ? 'ok' : 'null'} oracle=${oracle.size} records=${kills.length} keeperLog=${JSON.stringify((readSafe(path.join(home, 'keepers', `${ws}.log`)) ?? '').trim().split('\\n').slice(-6).join(' | ').slice(-700))} stdinErrors=${st.errors.join('|').slice(0, 200)}`);
    check('the storm killed many commands (the precondition that makes a ratelimit possible)', nKill() >= 12, `oom_kill=${nKill()}`);
    check('every kill has a record', kills.length === nKill(), `records=${kills.length} oom_kill=${nKill()}`);
    check('NEVER a wrong certainty: every record that says KERNEL names a pid the kernel really killed', byKernel.every((k) => oracle.has(String(k.pid))), `wrong: ${byKernel.filter((k) => !oracle.has(String(k.pid))).map((k) => k.pid).join(',') || 'none'}`);
    check('a kernel line names ONE kill: no two kernel-sourced records carry the same pid', new Set(byKernel.map((k) => k.pid)).size === byKernel.length, `kernel pids=${byKernel.map((k) => k.pid).join(',')}`);
    check('every other record is a labelled guess', kills.every((k) => k.source === 'kernel' || k.source === 'inferred'), `sources=${[...new Set(kills.map((k) => k.source ?? 'none'))]}`);
    check('the kernel path still names what it can: at least one record is kernel-named', byKernel.length >= 1, `kernel ${byKernel.length}/${kills.length}`);
    detail = `kills=${kills.length} kernel=${byKernel.length} oracle=${oracle.size}`;
  } else if (ARM === 'browser_contained') {
    // H2 review F1 (ledger Q5): a real headless Chromium started by a capped member's tool must STAY in the member's scope. Measured on this host: with DBUS_SESSION_BUS_ADDRESS in its env
    // Chromium moves its main process into its own transient scope (out of the cap); without it all 9 processes stay. The keeper removes the address from a capped member's CLI env.
    const chromium = process.env.CHROMIUM ?? '/usr/lib64/chromium-browser/chromium-browser';
    if (!fs.existsSync(chromium)) throw new Error(`VOID: no Chromium at ${chromium} (set CHROMIUM)`);
    const addr = process.env.DBUS_SESSION_BUS_ADDRESS;
    check('precondition: the driver has a session-bus address to hand the member (else nothing here proves anything)', !!addr, String(addr));
    // A browser tree needs ~190 MB: this one arm uses the largest cap the rig rules allow (≤ 300 MB: 0.29 GiB = 297 MiB) and a CLI stand-in that holds no extra RSS.
    settings = { ...settings, capHardGb: 0.29, capSoftGb: 0.2 };
    const st = open(ws, decide(ws), { rssMb: 0, extraEnv: { DBUS_SESSION_BUS_ADDRESS: addr ?? '', XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? '' } });
    await waitFor(() => initOf(st), 30_000);
    const f = factsOf(ws, st);
    const memberCg = cgOf(f.keeperPid);
    check('the member is in its scope', f.inRigScope || !hasCap, `unit=${f.unit}`);
    const t0 = await runTool(st, 'printf "%s" "${DBUS_SESSION_BUS_ADDRESS-unset}"', 't-env');
    check('the member\'s tool env has NO session-bus address (the keeper removed it)', t0?.stdout.trim() === 'unset', `saw=${t0?.stdout.trim().slice(0, 60)}`);
    const browserScript = (prof, extra) => `${extra}${chromium} --headless=new --no-sandbox --disable-gpu --no-first-run --disable-extensions --user-data-dir=${prof} --remote-debugging-port=0 about:blank >/dev/null 2>&1 &
sleep 5
for p in $(pgrep -f -- "[c]hromium-browser.*--user-data-dir=${prof}"); do echo "CG $p $(cut -d: -f3 /proc/$p/cgroup)"; done
for p in $(pgrep -f -- "[c]hromium-browser.*--user-data-dir=${prof}"); do kill -9 $p 2>/dev/null; done
echo DONE`;
    const parse = (r) => (r?.stdout ?? '').split('\n').filter((l) => l.startsWith('CG ')).map((l) => l.split(' ')).map(([, pid, cg]) => ({ pid: Number(pid), cg }));
    const prof1 = path.join(base, 'prof-contained'); fs.mkdirSync(prof1, { recursive: true });
    const r1 = await runTool(st, browserScript(prof1, ''), 't-browser', 90_000);
    const rows1 = parse(r1);
    check('a real headless Chromium ran (browser processes seen)', rows1.length >= 3, `n=${rows1.length}`);
    check('...and EVERY browser process is in the member\'s scope (the main process did not leave it)', rows1.length >= 3 && rows1.every((x) => x.cg === memberCg), JSON.stringify(rows1.filter((x) => x.cg !== memberCg)).slice(0, 200));
    // positive control (the instrument CAN see an escape): a FRESH member (an earlier browser's residue must not decide this), same cap, the address put back by hand
    const wsc = wsName('brc');
    wsList.push(wsc);
    const stc = open(wsc, decide(wsc), { rssMb: 0, extraEnv: { DBUS_SESSION_BUS_ADDRESS: addr ?? '', XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? '' } });
    await waitFor(() => initOf(stc), 30_000);
    const fc = factsOf(wsc, stc);
    const prof2 = path.join(base, 'prof-control'); fs.mkdirSync(prof2, { recursive: true });
    const r2 = await runTool(stc, browserScript(prof2, `export DBUS_SESSION_BUS_ADDRESS='${addr}'\n`), 't-browser2', 90_000);
    const rows2 = parse(r2);
    const memberCgC = cgOf(fc.keeperPid);
    check('control: with the address put back by hand the main process DOES leave the scope (the probe can see an escape)', rows2.length >= 1 && rows2.some((x) => x.cg !== memberCgC), JSON.stringify(rows2.map((x) => x.cg.split('/').pop())).slice(0, 200) + ` n=${rows2.length} tool=${JSON.stringify(r2 ? { code: r2.code, signal: r2.signal, out: r2.stdout.slice(-120) } : null)}`);
    detail = `inside=${rows1.filter((x) => x.cg === memberCg).length}/${rows1.length}`;
  } else if (ARM === 'not_applied_reported') {
    // A scope that EXISTS but whose cap is not the asked one (the verifier's probe seeded it: a systemd-run shim that DROPS one property). The keeper must report `not-applied` (never `active`),
    // the app must say «UNCAPPED» in its log, the tools must NOT be wrapped, and a scope with no memory.max is counted as «WITHOUT a limit» for bus-status.
    const realSR = spawnSync('sh', ['-c', 'command -v systemd-run'], { encoding: 'utf8' }).stdout.trim();
    const variants = [
      { tag: 'nomax', drop: 'MemoryMax=*', what: 'MemoryMax dropped (memory.max = max)' },
      { tag: 'noswap', drop: 'MemorySwapMax=*', what: 'MemorySwapMax=0 dropped (the swap escape is open)' },
    ];
    const realPath = process.env.PATH;
    for (const v of variants) {
      const wsv = wsName(`na${v.tag}`);
      wsList.push(wsv);
      const dir = path.join(base, `shim-${v.tag}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'systemd-run'), `#!/bin/bash\nargs=()\nprev=""\nfor a in "$@"; do\n  if [ "$prev" = "-p" ] && [[ "$a" == ${v.drop} ]]; then unset 'args[${'$'}{#args[@]}-1]'; prev=""; continue; fi\n  args+=("$a"); prev="$a"\ndone\nexec ${realSR} "${'$'}{args[@]}"\n`, { mode: 0o755 });
      process.env.PATH = `${dir}:${realPath}`;
      scopeMod?.resetScopeSupportCache?.();
      const stv = open(wsv, decide(wsv));
      const up = await waitFor(() => initOf(stv), 30_000);
      process.env.PATH = realPath;
      const f = factsOf(wsv, stv);
      check(`[${v.what}] the member started, IN its scope`, up && f.inRigScope, `cgroup=${cgOf(f.keeperPid)}`);
      const lim = f.cgroupDir ? readSafe(path.join(f.cgroupDir, v.tag === 'nomax' ? 'memory.max' : 'memory.swap.max'))?.trim() : null;
      check(`[${v.what}] precondition: the seeded limit really is open`, lim === 'max', `limit file=${lim}`);
      const pr = await kc.probeKeeper(wsv);
      check(`[${v.what}] the keeper reports cap.state = not-applied (never active)`, pr?.cap?.state === 'not-applied', JSON.stringify(pr?.cap ?? null));
      const klog = readSafe(path.join(home, 'keepers', `${wsv}.log`)) ?? '';
      if (v.tag === 'noswap') {
        // pre-review m4: memory.max IS enforced — the tools stay the first victims and the kills stay named; only the STATE says the cap leaks.
        check(`[${v.what}] the tools ARE still wrapped (memory.max is enforced: the kernel must pick a tool, not the CLI)`, !!initOf(stv)?.shellPrefix, `prefix=${initOf(stv)?.shellPrefix}`);
        check(`[${v.what}] the kill watch is on (the keeper logs its full-path line)`, /memory cap: NOT-APPLIED unit=/.test(klog), klog.split('\n').slice(-3).join(' | ').slice(-200));
      } else {
        check(`[${v.what}] the tools are NOT wrapped and no watch runs (nothing to protect without a cap)`, initOf(stv)?.shellPrefix == null && !/memory cap: NOT-APPLIED unit=/.test(klog), `prefix=${initOf(stv)?.shellPrefix}`);
      }
      check(`[${v.what}] the app log says UNCAPPED`, await waitFor(() => new RegExp(`memory-cap\\[${wsv}\\]: scope .* NOT applied.* UNCAPPED`).test(orchLog()), 8000), '');
      if (v.tag === 'nomax') {
        const cnt = scopeMod?.countMemberScopes();
        check('[no memory.max] bus-status would count it as a scope WITHOUT a limit', !!cnt && cnt.unlimited >= 1, JSON.stringify(cnt));
      }
    }
    process.env.PATH = realPath;
  } else if (ARM === 'wrapper_missing_no_scope') {
    // PRE-REVIEW MAJOR 4: with the limit applied and the tool wrapper unusable the kernel would kill the CLI first (the session). So: NO scope, said in the log, member still starts.
    if (WRAPPER) fs.rmSync(WRAPPER, { force: true });
    const spec = decide(ws);
    check('control: the decision itself still says "scope" (the switch is ON, the member is a fleet member)', hasCap ? !!spec : true, JSON.stringify(spec ?? null));
    const st = open(ws, spec);
    const up = await waitFor(() => initOf(st), 30_000);
    const f = factsOf(ws, st);
    check('the member STARTED', up && alive(f.keeperPid) && alive(f.cliPid));
    check('...in NO rig scope (an unprotected cap would kill the CLI, i.e. the session)', !f.inRigScope && armUnits(ws).length === 0, `cgroup=${cgOf(f.keeperPid)} units=${armUnits(ws)}`);
    check('the app log says why', /NOT creating the scope/.test(orchLog()), '');
    detail = `wrapper=${WRAPPER}`;
  }
} catch (e) {
  check(`arm threw`, false, String(e?.stack ?? e).slice(0, 400));
} finally {
  if (!CHILD_PHASE) await teardown(wsList);
}

const ok = checks.length > 0 && checks.every((c) => c.ok);
for (const c of checks) console.error(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
console.log(JSON.stringify({ arm: ARM, ok, subject: REPO === HERE_REPO ? 'this tree' : REPO, mutant: process.env.MC_MUTANT_TAG ?? null, detail, failed: checks.filter((c) => !c.ok).map((c) => c.name) }));
process.exit(0);
