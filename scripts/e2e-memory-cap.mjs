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
  const names = ARM === 'all' ? Object.keys(ARMS) : [ARM];
  const results = [];
  fs.mkdirSync(RIG_ROOT, { recursive: true });
  for (const arm of names) {
    if (!ARMS[arm]) { console.error(`unknown arm: ${arm}`); process.exit(2); }
    const base = armBase(arm);
    const env = {
      PATH: process.env.PATH, HOME: path.join(base, 'home'), LANG: 'C.UTF-8', SHELL: process.env.SHELL ?? '/bin/bash',
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, // systemd-run --user needs the user manager
      MC_REAL_HOME: REAL_HOME, MC_RUN_TOKEN: RUN_TOKEN, SUBJECT_REPO: process.env.SUBJECT_REPO, MC_MUTANT_TAG: process.env.MC_MUTANT_TAG,
      MC_KEEPER_BUNDLE: process.env.MC_KEEPER_BUNDLE,
    };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    const unitsBefore = new Set(unitsNow(`${UNIT_PREFIX}*`));
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', path.join(HERE_REPO, 'scripts', '.r2-register.mjs'), fileURLToPath(import.meta.url), arm], { env, encoding: 'utf8', timeout: 240_000, cwd: HERE_REPO });
    const line = (r.stdout ?? '').split('\n').reverse().find((l) => l.startsWith('{"arm"'));
    let res;
    try { res = line ? JSON.parse(line) : { ok: false, error: `no result line (rc=${r.status}${r.signal ? ' ' + r.signal : ''}): ${(r.stderr ?? '').trim().slice(-300)}` }; } catch (e) { res = { ok: false, error: `unparsable result: ${e}` }; }
    // G5: after EVERY run, the survivors of THIS arm — printed, not assumed.
    const procs = survivorsOf(base);
    const newUnits = unitsNow(`${UNIT_PREFIX}*`).filter((u) => !unitsBefore.has(u));
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
const PHASE = process.env.MC_PHASE ?? '1';
const base = armBase(ARM);
if (!base.startsWith(path.join(REAL_HOME, '.cache', 'memory-cap-rig') + path.sep)) throw new Error(`refusing rig dir outside the rig cache root: ${base}`);
if (PHASE !== 'app') fs.rmSync(base, { recursive: true, force: true });
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
  const srcs = ['src/keeper/index.ts', 'src/keeper/memory-watch.ts', 'src/shared/keeper-protocol.ts', 'src/shared/memory-scope.ts'].map((s) => path.join(REPO, s)).filter((s) => fs.existsSync(s));
  if (!fs.existsSync(KEEPER_JS) || srcs.some((s) => fs.statSync(s).mtimeMs > fs.statSync(KEEPER_JS).mtimeMs)) {
    execFileSync(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.keeper.config.ts'], { cwd: REPO, stdio: 'ignore' });
  }
}
fs.copyFileSync(KEEPER_JS, path.join(home, 'bin', 'keeper.js'));

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-memory-cap-rig',
  broadcast: () => {}, broadcastPtyData: () => {}, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
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
if (hasCap) {
  const { initBus, getBus } = await import(`${REPO}/src/main/bus.ts`);
  const { startRun } = await import(`${REPO}/src/main/bus-runs.ts`);
  const { DEFAULT_BUS_SWITCHES } = await import(`${REPO}/src/shared/bus-switches.ts`);
  initBus();
  const db = getBus();
  startRun(db, { id: 'run-on', kind: 'vague', coordinator: 'c' }, { ...DEFAULT_BUS_SWITCHES, memoryCap: true });
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
const wsList = [ws];
let detail = '';
try {
  if (ARM === 'kill_at_hard') {
    const spec = decide(ws);
    const st = open(ws, spec);
    await waitFor(() => initOf(st), 30_000);
    const f = factsOf(ws, st);
    check('a scope exists: the keeper runs in a rig-prefixed .scope', f.inRigScope, `cgroup=${cgOf(f.keeperPid)}`);
    check('the CLI is in the SAME scope as the keeper', f.cliPid && cgOf(f.cliPid) === cgOf(f.keeperPid), `cli=${cgOf(f.cliPid)}`);
    const maxB = Number(readSafe(path.join(f.cgroupDir ?? '/nonexistent', 'memory.max')));
    const want = Math.round(HARD_GB * 1024 ** 3);
    check('levels: memory.max = the Garde mémoire HARD level (±1 page)', Math.abs(maxB - want) <= 65536, `memory.max=${maxB} want=${want}`);
    check('no swap escape: memory.swap.max = 0', readSafe(path.join(f.cgroupDir ?? '/nonexistent', 'memory.swap.max'))?.trim() === '0');
    check('no soft throttle while Q2 is open: memory.high = max', readSafe(path.join(f.cgroupDir ?? '/nonexistent', 'memory.high'))?.trim() === 'max');
    const pol = f.unit ? spawnSync('systemctl', ['--user', 'show', '-p', 'OOMPolicy', '--value', f.unit], { encoding: 'utf8' }).stdout.trim() : '';
    check('never group-kill: OOMPolicy=continue', pol === 'continue', `OOMPolicy=${pol}`);
    check('victim protection (CLI side): the CLI keeps adj 0 and the keeper adj 0', f.init?.adj === 0 && Number(readSafe(`/proc/${f.keeperPid}/oom_score_adj`)) === 0, `cli=${f.init?.adj}`);
    const t1 = await runTool(st, 'cat /proc/self/oom_score_adj', 't-adj');
    check('victim protection (tool side): a Bash tool command runs at oom_score_adj 1000', t1?.stdout.trim() === '1000', `tool adj=${t1?.stdout.trim()} prefix=${f.init?.shellPrefix}`);
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
    const st = open(ws, spec);
    await waitFor(() => initOf(st), 30_000);
    const f = factsOf(ws, st);
    check('the keeper is NOT in a rig scope', !f.inRigScope && !(f.unit ?? '').startsWith('orchestra-ws-'), `cgroup=${cgOf(f.keeperPid)}`);
    check('no scope exists for the workspace', scopeMod ? scopeMod.memberScopes(ws).length === 0 : armUnits(ws).length === 0, `units=${armUnits(ws)}`);
    check('the tool wrapper is not installed in the CLI env (tool commands keep adj 0)', f.init?.shellPrefix == null);
    const pr = await kc.probeKeeper(ws);
    check('the keeper reports no cap', pr && pr.cap === undefined, JSON.stringify(pr?.cap ?? null));
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
    const st = open(ws, spec);
    const up = await waitFor(() => initOf(st), 30_000);
    process.env.PATH = realPath;
    const f = factsOf(ws, st);
    check('the member STARTED anyway (an uncapped session beats none)', up && alive(f.keeperPid) && alive(f.cliPid), `errors=${st.errors.join('|')}`);
    check('...in no rig scope', !f.inRigScope, `cgroup=${cgOf(f.keeperPid)}`);
    const pr = await kc.probeKeeper(ws);
    check('the keeper says why: cap.state = no-scope', pr?.cap?.state === 'no-scope', JSON.stringify(pr?.cap ?? null));
    check('the app log says the member runs WITHOUT a scope', /launching it WITHOUT a scope/.test(orchLog()), '');
    check('tool commands are not wrapped (no cap, nothing to protect)', initOf(st)?.shellPrefix == null);
  }
} catch (e) {
  check(`arm threw`, false, String(e?.stack ?? e).slice(0, 400));
} finally {
  if (PHASE !== 'app') await teardown(wsList);
}

const ok = checks.length > 0 && checks.every((c) => c.ok);
for (const c of checks) console.error(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
console.log(JSON.stringify({ arm: ARM, ok, subject: REPO === HERE_REPO ? 'this tree' : REPO, mutant: process.env.MC_MUTANT_TAG ?? null, detail, failed: checks.filter((c) => !c.ok).map((c) => c.name) }));
process.exit(0);
