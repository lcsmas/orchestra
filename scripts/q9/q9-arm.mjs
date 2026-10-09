// Q9 research arms (H1, wave H): derived from scripts/e2e-memory-cap.mjs (same harness: real keeper bundle, real systemd scope, stand-in CLI), unit prefix orchestra-rig-wh-h1-q9-. NOT a gate.
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
const HERE_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO = path.resolve(process.env.SUBJECT_REPO ?? HERE_REPO);
const RIG_DIR = path.join(HERE_REPO, 'scripts', 'memory-cap'); // the stand-in CLI and helpers are the rig's own
const UNIT_PREFIX = 'orchestra-rig-wh-h1-q9-';
const HARD_GB = 0.25; // 256 MiB — page-aligned, ≤ 300 MB (ledger D2)
const SOFT_GB = 0.2;

/** mustFailOnMaster: asserts the cap EXISTS (a scope, a kill, a record) — RED on a tree without it. The others are controls: GREEN on both. */
const ARM = process.argv[2] ?? '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unitsNow = (glob) => {
  const r = spawnSync('systemctl', ['--user', 'list-units', '--all', '--no-legend', '--plain', glob], { encoding: 'utf8' });
  return (r.stdout ?? '').split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
};

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

// ARM MODE
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
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

// ═══ the arms ═══════════════════════════════════════════════════════════════════════════════════════════════════════
const ws = wsName(ARM.slice(0, 4));
/** A fake session-bus address handed to the member: the arms that assert on the CLI env need no real bus (the browser arm uses the real one). */
const FAKE_BUS = 'unix:path=/nonexistent/orchestra-rig-bus';
const wsList = [ws];
let detail = '';
let data = null;
const sentinels_safe = (f) => { try { return f(); } catch { return null; } };
try {
  if (ARM === 'chain') {
    // The keeper path: a member (stand-in CLI, rssMb 0) in a real scope, then a one-at-a-time chain of OOM-killed hog tools (residual (d)).
    const P = (k, d) => process.env[k] ?? d;
    const tools = Number(P('Q9_TOOLS', 30)), gap = Number(P('Q9_GAP', 300)), mb = Number(P('Q9_MB', 400)), sent = Number(P('Q9_SENTINELS', 0)), layout = P('Q9_LAYOUT', 'single');
    if (P('Q9_VARIANT', '') === 'noklog') process.env.ORCHESTRA_Q9_NO_KLOG = '1';
    if (P('Q9_VARIANT', '') === 'nowatch') process.env.ORCHESTRA_Q9_NO_WATCH = '1';
    if (layout !== 'single') { process.env.ORCHESTRA_Q9_LAYOUT = layout; process.env.ORCHESTRA_Q9_WRAP = path.join(HERE_REPO, 'scripts', 'q9', 'layout-wrap.sh'); }
    const st = open(ws, decide(ws), { rssMb: 0, extraEnv: { DBUS_SESSION_BUS_ADDRESS: FAKE_BUS, STANDIN_CLI_RESULT_ALLOC_MB: P('Q9_CLI_ALLOC', '0'), STANDIN_CLI_TICK_MS: P('Q9_CLI_TICK', '0') } });
    await waitFor(() => initOf(st), 30_000);
    const f = factsOf(ws, st);
    const sDir = layout !== 'single' && f.cgroupDir ? path.dirname(f.cgroupDir) : f.cgroupDir; // the scope
    const wDir = layout !== 'single' && sDir ? path.join(sDir, 'w') : f.cgroupDir; // where the cap (and its oom events) live
    const unitName = sDir ? path.basename(sDir) : null;
    const tp = await runTool(st, 'cat /proc/self/cgroup', 't-cg', 20_000);
    const placement = { keeper: cgOf(f.keeperPid)?.split('/').slice(-2).join('/') ?? null, cli: cgOf(f.cliPid)?.split('/').slice(-2).join('/') ?? null, tool: (tp?.stdout ?? '').trim().split('/').slice(-2).join('/') };
    const tStart = new Date();
    let sentStart = 0;
    const sleepers = () => survivorsOf(base).filter((pid) => (readSafe(`/proc/${pid}/cmdline`) ?? '').startsWith('sleep\x003600')).length;
    if (sent > 0) { await runTool(st, `for i in $(seq ${sent}); do setsid -f sleep 3600 </dev/null >/dev/null 2>&1; done`, 't-sent', 30_000); await sleep(400); sentStart = sleepers(); }
    const e0 = wDir ? eventsOf(wDir) : {};
    let done = 0, lostAt = null; const sigs = [];
    for (let i = 0; i < tools; i++) {
      const r = await runTool(st, `python3 -c 'b = bytearray(b"\\xa5") * (${mb} * 1024 * 1024)'`, `t${i}`, 60_000);
      sigs.push(r ? (r.signal ?? r.code) : null);
      await sleep(80);
      if (!alive(f.keeperPid) || !alive(f.cliPid) || st.exited) { lostAt = i + 1; break; }
      done = i + 1;
      if (gap) await sleep(gap);
    }
    await sleep(500);
    const ev = wDir ? eventsOf(wDir) : {};
    data = { layout, placement, tools, gap, mb, sentinels: sent, unit: unitName, tools_survived_chain: done, lost_at: lostAt, keeper_alive: alive(f.keeperPid), cli_alive: alive(f.cliPid), oom_kill: (ev.oom_kill ?? null) !== null ? (ev.oom_kill - (e0.oom_kill ?? 0)) : null, oom_events: ev.oom != null ? ev.oom - (e0.oom ?? 0) : null, sentinels_start: sentStart, sentinels_end: sentinels_safe(sleepers), t_start: tStart.toISOString(), t_end: new Date().toISOString(), first_sigs: sigs.slice(0, 8) };
    check('arm completed (the data is the result)', true);
    detail = `layout=${layout} lost_at=${lostAt} keeper=${data.keeper_alive} cli=${data.cli_alive} oom_kill=${data.oom_kill} sentinels ${sentStart}->${data.sentinels_end}`;
  } else if (ARM === 'bare') {
    // No keeper at all: a bare node parent at adj 0 in its own disposable scope runs the same chain; activity = none | tick:<ms> | spin:<ms>.
    const P = (k, d) => process.env[k] ?? d;
    const tools = P('Q9_TOOLS', '30'), gap = P('Q9_GAP', '300'), mb = P('Q9_MB', '400'), activity = P('Q9_ACTIVITY', 'none'), sent = P('Q9_SENTINELS', '0');
    const unit = `${UNIT_PREFIX}bare${randomBytes(2).toString('hex')}.scope`;
    const tStart = new Date();
    const pollOut = path.join(base, 'poll.txt');
    const cgd = `/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}`;
    const poller = P('Q9_POLL', '0') === '1' ? spawn('python3', [path.join(HERE_REPO, 'scripts', 'q9', 'poll.py'), cgd, '120', pollOut], { stdio: 'ignore' }) : null;
    const r = spawnSync('systemd-run', ['--user', '--scope', '--collect', `--unit=${unit}`, '-p', `MemoryMax=${Math.round(HARD_GB * 1024 ** 3)}`, '-p', 'MemorySwapMax=0', '-p', 'OOMPolicy=continue', '--', process.execPath, path.join(HERE_REPO, 'scripts', 'q9', 'bare-parent.cjs'), tools, gap, mb, activity, sent], { env: { PATH: process.env.PATH, HOME: home, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, Q9_MARK: base }, encoding: 'utf8', timeout: 240_000 });
    const lines = (r.stdout ?? '').split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const finished = lines.some((l) => l.done);
    const toolsDone = lines.filter((l) => l.tool !== undefined).length;
    let windows = null;
    if (poller) {
      await waitFor(() => poller.exitCode !== null, 130_000, 200);
      const rows = (readSafe(pollOut) ?? '').trim().split('\n').filter(Boolean).map((l) => l.split(' ').map(Number));
      windows = [];
      const lim = Math.round(HARD_GB * 1024 ** 3);
      for (let j = 1; j < rows.length; j++) {
        if (rows[j][2] > rows[j - 1][2]) {
          const m = rows.findIndex((x, idx) => idx > j && x[1] < lim * 0.5);
          if (m > 0) windows.push(+((rows[m][0] - rows[j][0]) / 1e6).toFixed(2));
        }
      }
    }
    data = { layout: 'bare', windows_ms: windows, activity, sentinels: Number(sent), unit, tools: Number(tools), tools_completed: toolsDone, parent_survived: finished, rc: r.status, signal: r.signal, t_start: tStart.toISOString(), t_end: new Date().toISOString(), sig_tail: lines.slice(-2) };
    check('arm completed (the data is the result)', true);
    detail = `bare activity=${activity} survived=${finished} tools=${toolsDone}/${tools} rc=${r.status}`;
  }
} catch (e) {
  check(`arm threw`, false, String(e?.stack ?? e).slice(0, 400));
} finally {
  if (!CHILD_PHASE) await teardown(wsList);
}

const ok = checks.length > 0 && checks.every((c) => c.ok);
for (const c of checks) console.error(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
console.log(JSON.stringify({ arm: ARM, ok, subject: REPO === HERE_REPO ? 'this tree' : REPO, mutant: process.env.MC_MUTANT_TAG ?? null, detail, data, failed: checks.filter((c) => !c.ok).map((c) => c.name) }));
process.exit(0);
