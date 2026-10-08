#!/usr/bin/env node
// Reliquat rig (#325, wave H ledger #329, FI-1 v1 of the member scope #320): a Pause dure kills every process of the member's kernel scope that left its session's tree.
//
//   node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/.r2-register.mjs scripts/pause-trap/reliquat-rig.mjs <arm | all> [--unfixed]
//   pnpm run test:pause-reliquats            (= all)           pnpm run test:pause-reliquats -- --unfixed   (the SAME rig against the tree BEFORE #325: must-FAIL)
//
// REAL path: the REAL keeper bundle (dist-electron/keeper.js) launched by the REAL keeper-client into a REAL systemd user scope (`systemd-run --user --scope`, unit prefix
// `orchestra-rig-wh-h3-`, MemoryMax ≤ 300 MB, `--collect`), the REAL memory_cap decision over a scratch bus, a stand-in CLI that spawns tools the way the real CLI does (the real `claude` is
// ~330 MB RSS and cannot live in a ≤300 MB scope — ledger D2; the real-claude tool-tree path is proven by `pnpm run test:pause-trap`), the pause written by the REAL built
// `orchestra run pause --hard`, the host trap = the PRODUCTION `buildPauseTrapDeps()` (cliOf, killTrees, killReliquats over the real cgroup tree, snapshot; only the SDK-session-bound
// pieces — activity probe aside — `interrupt`/`arm`/`stopTask` are replaced: there is no SDK session behind the stand-in CLI), and the REAL built `run status` / `run resume` / `run release`.
// It NEVER pauses a real run: scratch ORCHESTRA_HOME/HOME, scratch bus, scratch store. Nothing existing is ever moved into a scope. Rig processes are stopped BY IDENTITY / scope NAME.
//
// ONE ARM = ONE PROCESS (the bus, the store and the logger are singletons per ORCHESTRA_HOME). `all` runs each arm in a child with an ALLOWLISTED env, then prints — per arm — the rig's
// SURVIVORS (processes carrying the arm's scratch dir, units carrying the rig prefix): must be 0 (ledger D2/G5).
// Exit: 0 every arm as expected · 1 an arm broke expectation · 3 VOID (host too loaded / tooling unavailable: nothing measured).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REAL_HOME = process.env.RQ_REAL_HOME ?? os.homedir(); // the child's HOME is the scratch dir: the real one travels in RQ_REAL_HOME
const HERE_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SUBJECT = path.resolve(process.env.SUBJECT_REPO ?? HERE_REPO); // the tree whose src/ + keeper bundle + CLI the arm drives (default: this one; --unfixed points at the tree BEFORE #325)
const RIG_DIR = path.join(HERE_REPO, 'scripts', 'pause-trap');
const MC_DIR = path.join(HERE_REPO, 'scripts', 'memory-cap');
const UNIT_PREFIX = 'orchestra-rig-wh-h3-';
const HARD_GB = 0.25; // 256 MiB — page-aligned, ≤ 300 MB (ledger D2)
const SOFT_GB = 0.2;
const UNFIXED_SHA = process.env.RQ_UNFIXED_SHA ?? '857ca2a6'; // the tip of H1's #320 checkpoint: the scope exists, the Pause dure does not kill what is in it

/** `mustRedden`: on the UNFIXED tree exactly these checks go RED (every other check — premises, controls — stays green). */
const ARMS = {
  reliquat_killed: { mustRedden: ['env_i_reliquat_killed', 'bilan_lists_the_killed_reliquat', 'bilan_attributes_to_the_reliquat_step', 'run_status_lists_it', 'consigne_shows_it', 'reprise_restarted_nothing'] },
  old_generation: { mustRedden: ['old_generation_reliquat_killed', 'new_generation_reliquat_killed', 'bilan_names_both_scopes'] },
  no_scope_unchanged: { mustRedden: [] },
};

const ARM = process.argv[2] ?? '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unitsNow = (glob) => {
  const r = spawnSync('systemctl', ['--user', 'list-units', '--all', '--no-legend', '--plain', glob], { encoding: 'utf8' });
  return (r.stdout ?? '').split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
};
const readSafe = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// PARENT MODE
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
const RUN_TOKEN = process.env.RQ_RUN_TOKEN ?? randomBytes(2).toString('hex');
const RIG_ROOT = path.join(REAL_HOME, '.cache', 'pause-reliquats', RUN_TOKEN); // under ~/.cache (btrfs, never /tmp)
const armBase = (arm) => path.join(RIG_ROOT, createHash('sha1').update(arm).digest('hex').slice(0, 6)); // short: a unix socket path must stay < ~100 bytes

/** Processes carrying the arm's scratch dir or the run token in their env / argv / cwd — the rig's own marker. Identity is re-read from /proc. */
function survivorsOf(base) {
  const out = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${name}/cmdline`, 'latin1');
      const hit = cmd.includes(base) || cmd.includes(`rqrig${RUN_TOKEN}`) || fs.readFileSync(`/proc/${name}/environ`, 'latin1').includes(base) || fs.readlinkSync(`/proc/${name}/cwd`).startsWith(base);
      if (hit) out.push(Number(name));
    } catch { /* gone / not ours */ }
  }
  return out;
}

if (process.env.RQ_CHILD !== '1') {
  const UNFIXED = process.argv.includes('--unfixed');
  const names = ARM === 'all' || ARM === '' || ARM.startsWith('--') ? Object.keys(ARMS) : [ARM];
  const avail = Number(/MemAvailable:\s+(\d+) kB/.exec(fs.readFileSync('/proc/meminfo', 'utf8'))[1]) / 1048576;
  if (process.env.RQ_IGNORE_LOAD !== '1' && avail < 6) { console.log(`PAUSE-RELIQUATS: VOID — MemAvailable ${avail.toFixed(1)} GB < 6 (ledger D2); nothing was measured`); process.exit(3); }
  if (!spawnSync('sh', ['-c', 'command -v systemd-run'], { encoding: 'utf8' }).stdout.trim()) { console.log('PAUSE-RELIQUATS: VOID — no systemd-run on PATH'); process.exit(3); }
  if (spawnSync('systemd-run', ['--user', '--scope', '--collect', '--quiet', `--unit=${UNIT_PREFIX}probe-${RUN_TOKEN}.scope`, '--', 'true'], { encoding: 'utf8' }).status !== 0) { console.log('PAUSE-RELIQUATS: VOID — the systemd user manager is unreachable (systemd-run --user failed)'); process.exit(3); }
  // Rebuild what the run EXECS (a stale bundle reproduces perfectly in isolation).
  const build = (cwd) => { for (const s of ['build:cli', 'build:keeper']) { const r = spawnSync('pnpm', ['run', s], { cwd, encoding: 'utf8' }); if (r.status !== 0) { console.log(`PAUSE-RELIQUATS: VOID — ${s} failed in ${cwd}: ${(r.stdout + r.stderr).slice(-300)}`); process.exit(3); } } };
  let subject = SUBJECT;
  let unfixedDir = null;
  if (UNFIXED) {
    const sha = spawnSync('git', ['rev-parse', `${UNFIXED_SHA}^{commit}`], { cwd: HERE_REPO, encoding: 'utf8' }).stdout.trim();
    if (!sha) { console.log(`PAUSE-RELIQUATS: VOID — the unfixed commit ${UNFIXED_SHA} is not in this repo (set RQ_UNFIXED_SHA)`); process.exit(3); }
    unfixedDir = path.join(REAL_HOME, '.cache', 'pause-reliquats', `unfixed-${sha.slice(0, 8)}-${RUN_TOKEN}`);
    const w = spawnSync('git', ['worktree', 'add', '--detach', unfixedDir, sha], { cwd: HERE_REPO, encoding: 'utf8' });
    if (w.status !== 0) { console.log(`PAUSE-RELIQUATS: VOID — cannot create the unfixed worktree: ${w.stderr.slice(-200)}`); process.exit(3); }
    fs.symlinkSync(path.join(HERE_REPO, 'node_modules'), path.join(unfixedDir, 'node_modules'));
    build(unfixedDir);
    subject = unfixedDir;
    console.log(`UNFIXED subject: ${sha.slice(0, 8)} (${unfixedDir})`);
  } else build(HERE_REPO);
  const results = [];
  fs.mkdirSync(RIG_ROOT, { recursive: true });
  for (const arm of names) {
    if (!ARMS[arm]) { console.error(`unknown arm: ${arm}`); process.exit(2); }
    const base = armBase(arm);
    const env = {
      PATH: process.env.PATH, HOME: path.join(base, 'home'), LANG: 'C.UTF-8', SHELL: process.env.SHELL ?? '/bin/bash',
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, // systemd-run --user needs the user manager
      RQ_REAL_HOME: REAL_HOME, RQ_RUN_TOKEN: RUN_TOKEN, SUBJECT_REPO: subject, RQ_CHILD: '1',
    };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    const unitsBefore = new Set(unitsNow(`${UNIT_PREFIX}*`));
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', path.join(HERE_REPO, 'scripts', '.r2-register.mjs'), fileURLToPath(import.meta.url), arm], { env, encoding: 'utf8', timeout: 300_000, cwd: HERE_REPO });
    const line = (r.stdout ?? '').split('\n').reverse().find((l) => l.startsWith('{"arm"'));
    let res;
    try { res = line ? JSON.parse(line) : { ok: false, failed: [], error: `no result line (rc=${r.status}${r.signal ? ' ' + r.signal : ''}): ${(r.stderr ?? '').trim().slice(-300)}` }; } catch (e) { res = { ok: false, failed: [], error: `unparsable result: ${e}` }; }
    // G5: after EVERY run, the survivors of THIS arm — printed BEFORE any cleanup, then cleaned by identity / unit NAME.
    const procs = survivorsOf(base);
    const newUnits = unitsNow(`${UNIT_PREFIX}*`).filter((u) => !unitsBefore.has(u));
    const leaked = { procs: procs.length, units: newUnits.length };
    for (const u of newUnits) spawnSync('systemctl', ['--user', 'stop', u], { encoding: 'utf8' }); // by NAME: it starts with OUR prefix and did not exist before this arm
    for (const pid of procs) { try { const c = fs.readFileSync(`/proc/${pid}/cmdline`, 'latin1'); if (c.includes(base) || c.includes(`rqrig${RUN_TOKEN}`) || fs.readFileSync(`/proc/${pid}/environ`, 'latin1').includes(base)) process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    // expectation: fixed tree ⇒ every check green; unfixed tree ⇒ EXACTLY the named checks red
    const failed = res.failed ?? [];
    const want = ARMS[arm].mustRedden;
    const asExpected = !res.error && (UNFIXED ? want.length > 0 ? want.every((c) => failed.includes(c)) && failed.every((c) => want.includes(c)) : failed.length === 0 : failed.length === 0 && !!res.ok);
    const clean = leaked.procs === 0 && leaked.units === 0;
    results.push({ arm, ok: asExpected && clean });
    console.log(`${asExpected && clean ? 'PASS' : 'FAIL'} ${arm}${UNFIXED ? ` [unfixed: ${want.length ? 'must redden ' + want.join(', ') : 'control, stays green'}]` : ''}${res.detail ? ` — ${res.detail}` : ''}${res.error ? ` — ${res.error}` : ''}${failed.length ? ` — RED: ${failed.join(', ')}` : ''}`);
    for (const l of (r.stderr ?? '').split('\n')) if (/^ {2}(ok  |FAIL) /.test(l) && (process.env.RQ_VERBOSE || l.startsWith('  FAIL') || UNFIXED)) console.log(l);
    console.log(`SURVIVORS arm=${arm} procs=${leaked.procs} scopes=${leaked.units}${clean ? '' : '  ← LEAK (cleaned by the parent)'}`);
  }
  const bad = results.filter((r) => !r.ok);
  if (unfixedDir) { spawnSync('git', ['worktree', 'remove', '--force', unfixedDir], { cwd: HERE_REPO }); fs.rmSync(unfixedDir, { recursive: true, force: true }); }
  fs.rmSync(RIG_ROOT, { recursive: true, force: true });
  console.log(`PAUSE-RELIQUATS RIG${UNFIXED ? ' [UNFIXED]' : ''}: ${results.length - bad.length}/${results.length} arms ${UNFIXED ? 'AS EXPECTED (must-FAIL)' : 'PASS'}${bad.length ? ` — FAILED: ${bad.map((r) => r.arm).join(', ')}` : ''}`);
  console.log(`LEFTOVER rig scopes now: ${unitsNow(`${UNIT_PREFIX}*`).length}`);
  process.exit(bad.length ? 1 : 0);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// ARM MODE
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
if (!ARMS[ARM]) { console.error(`unknown arm: ${ARM} (one of ${Object.keys(ARMS).join(', ')}, all)`); process.exit(2); }
const base = armBase(ARM);
if (!base.startsWith(path.join(REAL_HOME, '.cache', 'pause-reliquats') + path.sep)) throw new Error(`refusing rig dir outside the rig cache root: ${base}`);
fs.rmSync(base, { recursive: true, force: true });
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
assertScratch('HOME', home, base, live);

const KEEPER_JS = path.join(SUBJECT, 'dist-electron', 'keeper.js');
const CLI_JS = path.join(SUBJECT, 'dist-electron', 'cli.js');
for (const f of [KEEPER_JS, CLI_JS]) if (!fs.existsSync(f)) throw new Error(`${f} is missing — build the subject first (the parent does)`);
fs.copyFileSync(KEEPER_JS, path.join(home, 'bin', 'keeper.js'));

const { initPlatform } = await import(`${SUBJECT}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-pause-reliquats-rig',
  broadcast: () => {}, broadcastPtyData: () => {}, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {}, openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => path.join(home, 'userData'), getLogsDir: () => `${home}/logs`, getAppVersion: () => '0.0.0-pause-reliquats-rig', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});
(await import(`${SUBJECT}/src/main/logger.ts`)).initLogger();
const kc = await import(`${SUBJECT}/src/main/keeper-client.ts`);
const capSwitch = await import(`${SUBJECT}/src/main/memory-cap-switch.ts`);
const scopeMod = await import(`${SUBJECT}/src/main/memory-scope.ts`);
const { store } = await import(`${SUBJECT}/src/main/store.ts`);
const busMod = await import(`${SUBJECT}/src/main/bus.ts`);
const runsMod = await import(`${SUBJECT}/src/main/bus-runs.ts`);
const pauseMod = await import(`${SUBJECT}/src/main/bus-pause.ts`);
const { DEFAULT_BUS_SWITCHES } = await import(`${SUBJECT}/src/shared/bus-switches.ts`);
const trap = await import(`${SUBJECT}/src/main/pause-trap.ts`);
const host = await import(`${SUBJECT}/src/main/pause-trap-host.ts`);
try { kc.installKeeper(); } catch { /* the rig copies the bundle itself; installKeeper also lays down the oom wrapper */ }

// ── a scratch store + bus: lead ⊃ ops ⊃ a, and lead ⊃ other ⊃ b (another run, another workspace) ──────────────────────
const T = RUN_TOKEN;
const ID = { lead: `rqL${T}`, ops: `rqO${T}`, other: `rqX${T}`, a: `rqA${T}`, b: `rqB${T}` };
const STORE_FILE = path.join(home, 'userData', 'orchestra', 'store.json');
fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
fs.writeFileSync(STORE_FILE, JSON.stringify({ repos: [], workspaces: [], accounts: [], selfTuneRuns: [] })); // an EXISTING install: the trap refuses a store not loaded from disk
await store.load?.();
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'rig', GIT_AUTHOR_EMAIL: 'r@r', GIT_COMMITTER_NAME: 'rig', GIT_COMMITTER_EMAIL: 'r@r' } }).trim();
const WT = Object.fromEntries(Object.entries(ID).map(([k, id]) => [k, path.join(base, `wt-${k}`)]));
for (const dir of Object.values(WT)) { fs.mkdirSync(dir, { recursive: true }); git(dir, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(dir, 'a.txt'), 'base\n'); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init'); }
fs.writeFileSync(path.join(WT.a, 'untracked.txt'), 'UNTRACKED-WORK\n');
const mk = (k, extra) => store.upsertWorkspace({ id: ID[k], name: ID[k], kind: 'scratch', repoPath: '', baseBranch: '', branch: ID[k], worktreePath: WT[k], status: 'idle', createdAt: Date.now(), hasInput: true, ...extra });
await mk('lead', { kind: 'orchestrator' });
await mk('ops', { kind: 'orchestrator', parentId: ID.lead });
await mk('other', { kind: 'orchestrator', parentId: ID.lead });
await mk('a', { parentId: ID.ops, lastTask: 'rig task of a' });
await mk('b', { parentId: ID.other, lastTask: 'rig task of b' });
for (let i = 0; i < 100 && !(readSafe(STORE_FILE) ?? '').includes(`"${ID.b}"`); i++) await sleep(50);
const CAP_ON = ARM !== 'no_scope_unchanged';
busMod.initBus();
const db = busMod.getBus();
const sw = { ...DEFAULT_BUS_SWITCHES, pause: true, memoryCap: CAP_ON };
runsMod.startRun(db, { id: ID.lead, kind: 'mission', coordinator: ID.lead }, sw);
runsMod.startRun(db, { id: ID.ops, kind: 'vague', coordinator: ID.ops, parentRunId: ID.lead }, sw);
runsMod.startRun(db, { id: ID.other, kind: 'vague', coordinator: ID.other, parentRunId: ID.lead }, sw);
await store.setMemoryGuardSettings({ ...store.getMemoryGuardSettings(), capSoftGb: SOFT_GB, capHardGb: HARD_GB });
const settings = store.getMemoryGuardSettings();

// ── observation helpers (read from /proc and cgroupfs, never from the subject's own opinion) ───────────────────────
const ticks = (pid) => { const s = readSafe(`/proc/${pid}/stat`); return s ? s.slice(s.lastIndexOf(')') + 2).split(' ')[19] : null; };
const ident = (pid) => (pid ? `${pid}:${ticks(pid)}` : null);
const alive = (pid) => { if (!pid) return false; const s = readSafe(`/proc/${pid}/stat`); return !!s && s.slice(s.lastIndexOf(')') + 2)[0] !== 'Z'; };
const aliveId = (id) => { if (!id) return false; const [pid, t] = id.split(':'); return alive(Number(pid)) && ticks(Number(pid)) === t; };
const cgOf = (pid) => { const t = readSafe(`/proc/${pid}/cgroup`); const l = t?.split('\n').find((x) => x.startsWith('0::')); return l ? l.slice(3) : null; };
const ppidOf = (pid) => { const s = readSafe(`/proc/${pid}/stat`); return s ? Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[1]) : null; };
const pidFilePid = (ws) => { try { return JSON.parse(fs.readFileSync(path.join(home, 'keepers', `${ws}.pid`), 'utf8')).pid; } catch { return null; } };
async function waitFor(pred, ms, step = 50) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return true; await sleep(step); } return !!(await pred()); }
/** Every live process whose cmdline carries `needle` (identity: pid + start-time). */
function findByCmd(needle) {
  const out = [];
  for (const n of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(n) || Number(n) === process.pid) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${n}/cmdline`, 'latin1');
      if (!cmd.includes(needle) || !cmd.includes('daemonize.py') || cmd.includes('env\0-i')) continue; // the daemon itself: not the tool shell that launched it, not `env -i` before its exec
      const s = readSafe(`/proc/${n}/stat`);
      if (!s || s.slice(s.lastIndexOf(')') + 2)[0] === 'Z') continue;
      out.push(Number(n));
    } catch { /* gone */ }
  }
  return out;
}
const DAEMON = path.join(base, 'daemonize.py'); // double-fork + setsid, fds on /dev/null, then sleep (H1's helper, copied under the scratch dir: a short path keeps the marker visible in `run status`)
fs.copyFileSync(path.join(MC_DIR, 'daemonize.py'), DAEMON);
const PY = '/usr/bin/python3';
const mark = (tag) => `rqrig${T}${tag}`;
/** The commands the SESSION runs as tools: an `env -i` double-forked daemon (invisible to ppid / session / CLAUDE_PID), and — the positive control of the legacy path — a daemon that kept its env. */
const envIDaemon = (tag) => `env -i ${PY} ${DAEMON} 600 ${mark(tag)}`;
const legacyDaemon = (tag) => `${PY} ${DAEMON} 600 ${mark(tag)}`;

const sessions = new Map();
/** A facade (what the SDK's query() gets) over the stand-in CLI, hosted by the REAL keeper — launched exactly as agent-sdk.ts does (`makeKeeperSpawn(ws, onAttach, undefined, spec)`). */
function open(k, { sidecar = true } = {}) {
  const ws = ID[k];
  const spec = capSwitch.memoryCapSpecFor({ wsId: ws, runId: k === 'b' ? ID.other : ID.ops, hasCoordinator: true, remote: false, settings });
  const st = { ws, spec, lines: [], attached: false, exited: false, errors: [] };
  const h = kc.makeKeeperSpawn(ws, () => { st.attached = true; }, undefined, spec)({
    command: process.execPath, args: [path.join(RIG_DIR, 'reliquat-standin-cli.cjs')], cwd: WT[k],
    env: { PATH: process.env.PATH, HOME: home, SHELL: process.env.SHELL ?? '/bin/bash', STANDIN_CLI_RSS_MB: '60', STANDIN_SIDECAR: sidecar ? '1' : '0' }, signal: new AbortController().signal,
  });
  let buf = '';
  h.stdout.on('data', (d) => { buf += d.toString('utf8'); let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { st.lines.push(JSON.parse(l)); } catch { /* not json */ } } });
  h.on('error', (e) => st.errors.push(String(e?.message ?? e)));
  h.on('exit', () => { st.exited = true; });
  st.h = h;
  st.send = (o) => h.stdin.write(JSON.stringify(o) + '\n');
  sessions.set(ws, st);
  return st;
}
const initOf = (st) => st.lines.find((l) => l.type === 'system' && l.subtype === 'init');
const resultOf = (st, id) => st.lines.find((l) => l.type === 'user' && l.tool_result?.id === id)?.tool_result;
async function runTool(st, cmd, id, ms = 30_000) { st.send({ tool: cmd, id }); await waitFor(() => resultOf(st, id) || st.exited, ms, 100); return resultOf(st, id) ?? null; }
function factsOf(k, st) {
  const ws = ID[k];
  const kp = pidFilePid(ws);
  const init = initOf(st);
  const dir = kp ? cgOf(kp) : null;
  const unit = dir && dir.endsWith('.scope') ? path.basename(dir) : null;
  return { keeperPid: kp, keeperId: ident(kp), cliPid: init?.pid ?? null, cliId: ident(init?.pid), sidecarPid: init?.sidecar ?? null, sidecarId: ident(init?.sidecar), cg: dir, unit, inRigScope: !!unit && unit.startsWith(UNIT_PREFIX) };
}

// ── the REAL built CLI (the subject's) ──────────────────────────────────────────────────────────────────────────────
function cli(...args) {
  const r = spawnSync(process.execPath, [CLI_JS, ...args], { env: { PATH: process.env.PATH, HOME: home, ORCHESTRA_HOME: home, LANG: 'C.UTF-8' }, encoding: 'utf8', timeout: 60_000 });
  return { rc: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
const trapAt = () => pauseMod.getRunPause(db, ID.ops)?.trapAt ?? null;
const bilanOf = (ws) => { const p = pauseMod.getRunPause(db, ID.ops); const row = db.prepare('SELECT * FROM pause_records WHERE run_id = ? AND ws_id = ? AND paused_at = ? ORDER BY id DESC LIMIT 1').get(ID.ops, ws, p?.pausedAt ?? -1); return row ? { activity: JSON.parse(row.activity ?? 'null'), killed: JSON.parse(row.killed_json ?? 'null'), error: row.error } : null; };

const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) }); };

/** THE PRODUCTION trap deps; only what needs an SDK session behind the stand-in CLI is replaced (the keeper's CLI is not the real one: nothing to interrupt/attach/stop through). */
function startTrap() {
  const deps = host.buildPauseTrapDeps();
  deps.interrupt = async () => 'idle';
  delete deps.arm;
  delete deps.stopTask;
  trap.startPauseTrap(deps);
  return deps;
}

async function teardown() {
  try { trap.stopPauseTrap(); } catch { /* not started */ }
  for (const ws of sessions.keys()) { try { kc.forbidKeeperLaunch?.(ws); await kc.killKeeper(ws, 'pause-reliquats-rig'); } catch { /* best effort */ } }
  await sleep(300);
  for (const ws of sessions.keys()) for (const u of unitsNow(`${UNIT_PREFIX}${ws}-*`)) spawnSync('systemctl', ['--user', 'stop', u], { encoding: 'utf8' }); // by NAME: rig prefix + this arm's ws id
  await sleep(300);
  // whatever the rig launched and a scope stop did not reach (no scope in the control arm, a daemon of an UNFIXED subject that left it): by IDENTITY, re-read from /proc right before the signal —
  // its cmdline carries the rig marker, or its environment carries this arm's scratch HOME (the keeper's children: the stand-in CLI's sidecar)
  const needleHome = `HOME=${home}\0`;
  for (const n of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(n) || Number(n) === process.pid) continue;
    try {
      const mine = fs.readFileSync(`/proc/${n}/cmdline`, 'latin1').includes(`rqrig${T}`) || fs.readFileSync(`/proc/${n}/environ`, 'latin1').includes(needleHome);
      if (mine) process.kill(Number(n), 'SIGKILL');
    } catch { /* gone / not ours */ }
  }
}

let detail = '';
try {
  if (ARM === 'reliquat_killed') {
    const a = open('a');
    const b = open('b');
    await waitFor(() => initOf(a) && initOf(b), 40_000);
    const fa = factsOf('a', a);
    const fb = factsOf('b', b);
    check('premise: a’s keeper runs in a rig-prefixed scope', fa.inRigScope, `cgroup=${fa.cg}`);
    check('premise: a’s CLI and its MCP-like sidecar are in the SAME scope', fa.cliPid && fa.sidecarPid && cgOf(fa.cliPid) === fa.cg && cgOf(fa.sidecarPid) === fa.cg, `cli=${cgOf(fa.cliPid)} sidecar=${cgOf(fa.sidecarPid)}`);
    check('premise: b (another run) has its OWN scope', fb.inRigScope && fb.unit !== fa.unit, `b=${fb.unit}`);
    // the SESSION starts the processes (as tools, the way the real CLI runs Bash)
    await runTool(a, envIDaemon('a-envi'), 'ta-envi');
    await runTool(a, legacyDaemon('a-legacy'), 'ta-legacy');
    await runTool(b, envIDaemon('b-envi'), 'tb-envi');
    const outside = spawn(PY, [DAEMON, '600', mark('outside')], { detached: true, stdio: 'ignore', env: { PATH: process.env.PATH } }); // a HUMAN's process: started by the rig itself, in NO member scope
    outside.unref();
    await sleep(800);
    const [rA] = findByCmd(mark('a-envi'));
    const [lA] = findByCmd(mark('a-legacy'));
    const [rB] = findByCmd(mark('b-envi'));
    const [oS] = findByCmd(mark('outside'));
    check('premise: the env -i daemon is ALIVE, in a’s scope, NOT a child of the CLI', rA && cgOf(rA) === fa.cg && ppidOf(rA) !== fa.cliPid, `pid=${rA} cg=${cgOf(rA)} ppid=${ppidOf(rA)}`);
    check('premise: it carries NO environment at all (CLAUDE_PID stripped: invisible to the legacy env proof)', rA && (readSafe(`/proc/${rA}/environ`) ?? 'x') === '', `environ=${JSON.stringify((readSafe(`/proc/${rA}/environ`) ?? '').slice(0, 40))}`);
    check('premise: the control daemon (kept its env) is alive in a’s scope and carries CLAUDE_PID', lA && cgOf(lA) === fa.cg && /CLAUDE_PID=/.test(readSafe(`/proc/${lA}/environ`) ?? ''), `pid=${lA}`);
    check('premise: b’s daemon is alive in b’s scope; the human’s process is alive in NO member scope', rB && cgOf(rB) === fb.cg && oS && !(cgOf(oS) ?? '').includes(UNIT_PREFIX), `b=${cgOf(rB)} outside=${cgOf(oS)}`);
    const scopeA = scopeMod.memberScopes(ID.a);
    const roles = Object.fromEntries(scopeMod.listScopeProcs(scopeA[0], fa.cliPid).map((p) => [p.pid, p.role]));
    check('premise: FI-1 classifies the daemon `reliquat`, the keeper `keeper`, the CLI `cli`, the sidecar `session`', roles[rA] === 'reliquat' && roles[fa.keeperPid] === 'keeper' && roles[fa.cliPid] === 'cli' && roles[fa.sidecarPid] === 'session', JSON.stringify(roles));
    const ids = { rA: ident(rA), lA: ident(lA), rB: ident(rB), oS: ident(oS) };
    const before = { aKeeper: fa.keeperId, aCli: fa.cliId, aSide: fa.sidecarId, bKeeper: fb.keeperId, bCli: fb.cliId };
    // ── THE PAUSE DURE (the REAL built CLI) ────────────────────────────────────────────────────────────────────────
    startTrap();
    const p = cli('run', 'pause', '--hard', '--run', ID.ops, '--as', ID.lead);
    check('the pause is written by the REAL built CLI (rc 0, hard)', p.rc === 0 && /PAUSED|paused/i.test(p.out), p.out.trim().slice(0, 120));
    const done = await waitFor(() => trapAt() !== null, 90_000, 200);
    check('trap_stamped: the host trap finished (pause_trap_at set)', done, `trapAt=${trapAt()}`);
    await sleep(500);
    // ── what a user / the OS can see ───────────────────────────────────────────────────────────────────────────────
    check('env_i_reliquat_killed: the detached, double-forked, env -i daemon the session started is DEAD', !aliveId(ids.rA), `still alive: ${ids.rA}`);
    check('the control daemon (kept its env, killed by the legacy env proof) is dead too', !aliveId(ids.lA), `alive: ${ids.lA}`);
    check('keeper SURVIVES (same pid + start-time)', aliveId(before.aKeeper), before.aKeeper);
    check('CLI SURVIVES (same pid + start-time)', aliveId(before.aCli), before.aCli);
    check('MCP-like sidecar SURVIVES (same pid + start-time)', aliveId(before.aSide), before.aSide);
    check('a HUMAN’s process outside every scope is untouched', aliveId(ids.oS), ids.oS);
    check('ANOTHER workspace (b, another run): keeper, CLI AND its Reliquat are untouched', aliveId(before.bKeeper) && aliveId(before.bCli) && aliveId(ids.rB), `${before.bKeeper} ${before.bCli} ${ids.rB}`);
    const bil = bilanOf(ID.a);
    const killedRq = bil?.activity?.reliquats?.killed ?? [];
    const mine = killedRq.find((k) => (k.cmd ?? '').includes(mark('a-envi')));
    check('bilan_lists_the_killed_reliquat: command, pid, start-time, start of the daemon are in the Bilan (activity.reliquats)', !!mine && mine.pid === rA && String(mine.startTicks) === ids.rA.split(':')[1] && Number.isFinite(mine.startedAt) && mine.startedAt > 0, JSON.stringify(mine ?? killedRq.slice(0, 1)).slice(0, 200));
    check('bilan_attributes_to_the_reliquat_step: it was the RELIQUAT step, not the tree walk (the env -i daemon is absent from killed_json.killed)', !!mine && !(bil?.killed?.killed ?? []).some((k) => (k.cmd ?? '').includes(mark('a-envi'))), '');
    check('...while the legacy daemon is attributed to the TREE kill (killed_json.killed, via env)', (bil?.killed?.killed ?? []).some((k) => (k.cmd ?? '').includes(mark('a-legacy'))), '');
    check('the Bilan never lists the session as a Reliquat', !killedRq.some((k) => k.pid === fa.keeperPid || k.pid === fa.cliPid || k.pid === fa.sidecarPid), '');
    const st = cli('run', 'status', '--run', ID.ops);
    check('run_status_lists_it: `orchestra run status` (built CLI) prints the Reliquat with command, pid and start', new RegExp(`reliquat killed: .*daemonize\\.py.* pid ${rA} started \\d{4}-\\d\\d-\\d\\dT`).test(st.out), st.out.split('\n').filter((l) => /Reliquat/.test(l)).join(' | ').slice(0, 220));
    // ── the Reprise: the Consigne shows it (listed, never re-run) ───────────────────────────────────────────────────
    const rs = cli('run', 'resume', '--run', ID.ops, '--as', ID.lead);
    await waitFor(() => db.prepare("SELECT 1 FROM messages WHERE kind = 'reprise' AND recipient = ?").get(ID.ops), 40_000, 200); // the host releases the coordinator first (its sweep)
    const r2 = cli('run', 'release', ID.a, '--run', ID.ops, '--as', ID.ops);
    const body = db.prepare("SELECT body FROM messages WHERE kind = 'reprise' AND recipient = ? ORDER BY sequence DESC LIMIT 1").get(ID.a)?.body ?? '';
    check('consigne_shows_it: the member’s Consigne de reprise lists the killed Reliquat (command, pid) — LISTED, NOT re-run', body.includes('Reliquats') && body.includes(mark('a-envi')) && /LISTED, NOT re-run/.test(body), `resume rc=${rs.rc} release rc=${r2.rc} body=${body.slice(0, 160).replace(/\n/g, ' | ')}`);
    check('reprise_restarted_nothing: the daemon is still dead after the Reprise', !aliveId(ids.rA), '');
    detail = `scope=${fa.unit} reliquat=${rA}`;
  } else if (ARM === 'old_generation') {
    const a1 = open('a');
    await waitFor(() => initOf(a1), 40_000);
    const f1 = factsOf('a', a1);
    await runTool(a1, envIDaemon('gen1'), 't-gen1');
    await sleep(600);
    const [r1] = findByCmd(mark('gen1'));
    const id1 = ident(r1);
    await kc.killKeeper(ID.a, 'pause-reliquats-rig-restart'); // the member restarts: the old keeper + CLI go, the daemon keeps the OLD scope alive
    await waitFor(() => !alive(f1.keeperPid) && !alive(f1.cliPid), 20_000);
    check('premise: the old scope outlives the keeper (a Reliquat holds it) and is found by workspace id alone', scopeMod.memberScopes(ID.a).length === 1 && scopeMod.memberScopes(ID.a)[0].keeperPid === null && !!r1 && aliveId(id1), `scopes=${scopeMod.memberScopes(ID.a).map((s) => s.unit)}`);
    const a2 = open('a');
    await waitFor(() => initOf(a2), 40_000);
    const f2 = factsOf('a', a2);
    await runTool(a2, envIDaemon('gen2'), 't-gen2');
    await sleep(600);
    const [r2] = findByCmd(mark('gen2'));
    const id2 = ident(r2);
    check('premise: a restart while Reliquats keep the old scope starts a NEW generation in a NEW scope (two scopes, both resolvable)', f2.inRigScope && f2.unit !== f1.unit && scopeMod.memberScopes(ID.a).length === 2, `old=${f1.unit} new=${f2.unit}`);
    check('premise: both daemons are alive, each in ITS scope', aliveId(id1) && aliveId(id2) && cgOf(r1)?.endsWith(f1.unit) && cgOf(r2)?.endsWith(f2.unit), `${cgOf(r1)} ${cgOf(r2)}`);
    const keep = { keeper: f2.keeperId, cli: f2.cliId, side: f2.sidecarId };
    startTrap();
    cli('run', 'pause', '--hard', '--run', ID.ops, '--as', ID.lead);
    check('trap_stamped', await waitFor(() => trapAt() !== null, 90_000, 200), `trapAt=${trapAt()}`);
    await sleep(500);
    check('old_generation_reliquat_killed: the daemon that kept the OLD scope alive is dead', !aliveId(id1), id1);
    check('new_generation_reliquat_killed: the daemon of the CURRENT scope is dead', !aliveId(id2), id2);
    check('the CURRENT session (keeper, CLI, sidecar) survives', aliveId(keep.keeper) && aliveId(keep.cli) && aliveId(keep.side), JSON.stringify(keep));
    const rq = bilanOf(ID.a)?.activity?.reliquats;
    check('bilan_names_both_scopes: the Bilan names both scopes it looked at', (rq?.scopes ?? []).length === 2, JSON.stringify(rq?.scopes));
    detail = `old=${f1.unit} new=${f2.unit}`;
  } else if (ARM === 'no_scope_unchanged') {
    const a = open('a');
    await waitFor(() => initOf(a), 40_000);
    const fa = factsOf('a', a);
    check('premise: memory_cap OFF ⇒ the decision is "no scope"', a.spec === undefined, JSON.stringify(a.spec ?? null));
    check('premise: the keeper is in NO rig scope and the member has no scope at all', !fa.inRigScope && scopeMod.memberScopes(ID.a).length === 0, `cgroup=${fa.cg}`);
    await runTool(a, envIDaemon('a-envi'), 'ta-envi');
    await runTool(a, legacyDaemon('a-legacy'), 'ta-legacy');
    await sleep(800);
    const [rA] = findByCmd(mark('a-envi'));
    const [lA] = findByCmd(mark('a-legacy'));
    check('premise: both daemons are alive', !!rA && !!lA, `${rA} ${lA}`);
    const ids = { rA: ident(rA), lA: ident(lA) };
    startTrap();
    cli('run', 'pause', '--hard', '--run', ID.ops, '--as', ID.lead);
    check('trap_stamped', await waitFor(() => trapAt() !== null, 90_000, 200), `trapAt=${trapAt()}`);
    await sleep(500);
    check('no scope ⇒ today’s behaviour: the env -i daemon is NOT touched (the documented limit stays for an uncapped member)', aliveId(ids.rA), ids.rA);
    check('the legacy daemon IS still killed by the tree walk (the trap ran)', !aliveId(ids.lA), ids.lA);
    check('keeper + CLI untouched', aliveId(fa.keeperId) && aliveId(fa.cliId), `${fa.keeperId} ${fa.cliId}`);
    const bil = bilanOf(ID.a);
    check('the Bilan row carries NO `reliquats` key at all (byte-identical to before #325)', bil && !('reliquats' in (bil.activity ?? {})), JSON.stringify(Object.keys(bil?.activity ?? {})));
    detail = 'no scope';
  }
} catch (e) {
  check('arm threw', false, String(e?.stack ?? e).slice(0, 400));
} finally {
  await teardown();
}

const ok = checks.length > 0 && checks.every((c) => c.ok);
for (const c of checks) console.error(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
console.log(JSON.stringify({ arm: ARM, ok, subject: SUBJECT === HERE_REPO ? 'this tree' : SUBJECT, detail, failed: checks.filter((c) => !c.ok).map((c) => c.name.split(':')[0]), checks: checks.length }));
process.exit(0);
