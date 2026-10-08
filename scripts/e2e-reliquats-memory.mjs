// #328 (wave H, ledger #329; epic #319; contract FI-1 v1) — a member's memory is read from ITS kernel scope, so a DETACHED process counts for the member that launched it.
// REAL keeper daemon (dist-electron/keeper.js) started under FI-1's production argv (`buildScopeLaunchArgv`) in a DISPOSABLE systemd user scope (MemoryMax 300M), a fake stream-json CLI
// that launches (a) a DETACHED allocator of a known size (a double-forked Reliquat), (b) a plain child; the REAL monitor tick (`sampleTick`, production deps), the REAL page grouping and the
// REAL built CLI `bus-status` are the instruments. NOT heavy (no browser / app / Docker; ≤ 300 MB per arm): no §Roster token needed — but it refuses below 3 GB MemAvailable.
//
// SAFETY (ledger D2): scratch ORCHESTRA_HOME/HOME/CLAUDE_CONFIG_DIR under ~/.cache; units are named `orchestra-rig-wh-h2-<ws>-<gen>.scope` (--collect, MemoryMax=300M, swap 0) and stopped BY NAME at
// the end (+ watchdog if the rig dies); NO existing process is ever moved into a scope; nothing outside the rig's own units/dirs is touched; every arm prints its SURVIVORS (rig-marked processes + leftover
// rig scopes) — red unless both are 0 (G5).
//
//   known_magnitude            ★ a detached ~100 MB process raises the member's measured memory by about that size (inert 0 MB control + plain-child control); the process-tree figure does NOT move
//   keeper_gone_reliquat_stays ★ the keeper dies, a Reliquat lives on: the tree walk sees NO row at all, the scope still counts it (memory + Reliquat count)
//   two_generations            ★ a restart while a Reliquat keeps the old scope alive: both generations are summed (checked against the rig's own sysfs read of the two units)
//   untracked_fallback           a member started WITHOUT a scope keeps the process-tree figure and reads « Reliquats not tracked »
//   bus_status_line            ★ the REAL built CLI `bus-status` prints the `reliquats:` line with the member's Reliquat count (labelled RSS); « Reliquats not tracked » for an unscoped member; a STRAY scope (no store entry, no live keeper) is counted through H1's real `countMemberScopes`, never read
//   page_snapshot              ★ the REAL Resources-page sampler (`sampleResources()`, only pty/events/statfs/platform stubbed): the IPC snapshot carries the member report and the page's own grouping reads the member's row from the SCOPE
//   browser_escapes_scope      ★ (review F1) keeper ← CLI ← browser ← helpers where the browser MAIN moves itself into its own systemd scope (real Chromium does): the main is in nobody's kernel bill — the row must ADD it
//   production_launch          ★ the PRODUCTION path: `memoryCapSpecFor` over a REAL scratch bus (run frozen memory_cap ON vs OFF) → `makeKeeperSpawn` launches the keeper in its scope (ON) or not (OFF, D-Q1): ON → the detached process is counted;
//                                OFF → « Reliquats not tracked », the tree figure stays
//
// Run all: node --experimental-strip-types --import ./scripts/.r2-register.mjs scripts/e2e-reliquats-memory.mjs     (RIG_REPO=<tree> = the must-FAIL run on master; RIG_ARMS=a,b subset)

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HERE_REPO = path.resolve(HERE, '..'); // the rig's OWN tree: unit naming + the production launch argv are rig infrastructure, not the subject
const REPO = path.resolve(process.env.RIG_REPO ?? HERE_REPO);
const ARM = process.argv[2] ?? '';
const ARMS = ['known_magnitude', 'keeper_gone_reliquat_stays', 'two_generations', 'untracked_fallback', 'bus_status_line', 'production_launch', 'page_snapshot', 'browser_escapes_scope'];
const MB = 1024 * 1024;
const REAL_HOME = os.homedir();
const RIG_BASE = path.resolve(process.env.RELIQUATS_RIG_HOME ?? path.join(REAL_HOME, '.cache', 'e2e-rlq'));
const UNIT_PREFIX = 'orchestra-rig-wh-h2-';
const UID = process.getuid?.() ?? 0;
const APP_SLICE = `/sys/fs/cgroup/user.slice/user-${UID}.slice/user@${UID}.service/app.slice`;

function memAvailableGb() {
  try { return Number(/MemAvailable:\s+(\d+) kB/.exec(fs.readFileSync('/proc/meminfo', 'utf8'))?.[1]) / 1048576; } catch { return null; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Every live process whose argv mentions `marker` (the rig's scratch dir) — this module's pid excluded. */
function marked(marker) {
  const out = [];
  for (const n of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(n) || Number(n) === process.pid) continue;
    try {
      const argv = fs.readFileSync(`/proc/${n}/cmdline`, 'utf8').split('\0').filter(Boolean);
      if (argv.some((a) => a.includes(marker))) out.push(Number(n));
    } catch { /* gone */ }
  }
  return out;
}
const rigUnitsLeft = () => spawnSync('systemctl', ['--user', 'list-units', '--all', `${UNIT_PREFIX}*`, '--no-legend', '--plain'], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l.trim().startsWith(UNIT_PREFIX));

// ═══ PARENT: one child process per arm, survivors printed after EACH run (G5) ═══════════════════════════════════════
if (!ARM) {
  const gb = memAvailableGb();
  if (process.env.RIG_SKIP_MEMCHECK !== '1' && (gb === null || gb <= 3)) {
    console.error(`SAFETY: MemAvailable ${gb === null ? 'unreadable' : gb.toFixed(1) + ' GB'} — refusing below 3 GB`);
    process.exit(2);
  }
  const runId = randomBytes(3).toString('hex'); // short: a unix socket path must stay < ~100 bytes
  const only = process.env.RIG_ARMS ? new Set(process.env.RIG_ARMS.split(',')) : null;
  const rows = [];
  for (const arm of ARMS) {
    if (only && !only.has(arm)) continue;
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--import', pathToFileURL(path.join(HERE, '.r2-register.mjs')).href, fileURLToPath(import.meta.url), arm], {
      env: { ...process.env, RIG_RUN_ID: runId }, encoding: 'utf8', timeout: 150_000,
    });
    const lastJson = (r.stdout ?? '').split('\n').reverse().find((l) => l.startsWith('{') && l.includes('"arm"'));
    let v = null;
    try { v = lastJson ? JSON.parse(lastJson) : null; } catch { /* below */ }
    const survivors = marked(path.join(RIG_BASE, runId)).length;
    const scopes = rigUnitsLeft().filter((l) => l.includes(`-${runId}-`)).length; // this run's units only: a concurrent run's are not a leak of ours
    console.log(`  survivors after ${arm}: rig processes=${survivors} rig scopes=${scopes}`);
    rows.push({ arm, ok: v?.ok === true && survivors === 0 && scopes === 0, detail: v ? (v.ok ? (survivors || scopes ? `LEAK processes=${survivors} scopes=${scopes}` : '') : v.why ?? v.abort ?? '') : `no verdict (exit ${r.status}) ${(r.stderr ?? '').split('\n').slice(-3).join(' ')}` });
  }
  for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.arm}${r.detail ? ` — ${r.detail}` : ''}`);
  const red = rows.filter((r) => !r.ok);
  if (red.length === 0) fs.rmSync(path.join(RIG_BASE, runId), { recursive: true, force: true });
  console.log(`RELIQUATS-MEMORY RIG: ${red.length === 0 ? 'ALL PASS' : `RED ${red.map((r) => r.arm).join(',')}`} (${rows.length - red.length}/${rows.length})${only ? ' PARTIAL(RIG_ARMS)' : ''} tree ${REPO}`);
  process.exit(red.length === 0 ? 0 : 1);
}
if (!ARMS.includes(ARM)) { console.error(`unknown arm: ${ARM} (expected: ${ARMS.join(', ')})`); process.exit(2); }

// ═══ ARM ════════════════════════════════════════════════════════════════════════════════════════════════════════════
const runId = process.env.RIG_RUN_ID || 'solo';
// Short dir: a unix socket path must stay < ~100 bytes or keeperSocketPath hashes it into /tmp.
const base = path.join(RIG_BASE, runId, createHash('sha1').update(ARM).digest('hex').slice(0, 4));
const live = [path.join(REAL_HOME, '.orchestra'), path.join(REAL_HOME, '.claude'), path.join(REAL_HOME, '.claude-mc'), path.join(REAL_HOME, '.config')];
if (!(base + path.sep).startsWith(path.join(REAL_HOME, '.cache') + path.sep) || live.some((l) => (base + path.sep).startsWith(l + path.sep) || l.startsWith(base + path.sep))) {
  console.error(`SAFETY: refusing scratch path ${base}`); process.exit(2);
}
fs.rmSync(base, { recursive: true, force: true });
const home = path.join(base, 'home');
fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
fs.mkdirSync(path.join(home, '.claude-scratch'), { recursive: true });
for (const k of Object.keys(process.env)) if (/^(ORCHESTRA_|CLAUDE_CONFIG_DIR|CLAUDECODE|CLAUDE_CODE_)/.test(k)) delete process.env[k];
process.env.ORCHESTRA_HOME = home;
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude-scratch');
process.env.ORCHESTRA_MEMORY_SCOPE_PREFIX = UNIT_PREFIX; // FI-1 (a): the rig's scopes are recognisable, and `memberScopes` looks for exactly these

const out = { arm: ARM, tree: REPO };
const fails = [];
const units = []; // every unit THIS arm named — stopped by name at the end
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function check(name, ok, got) { out[name] = got; if (!ok) fails.push(`${name}: got ${JSON.stringify(got)}`); return ok; }

// Watchdog in its OWN session: if this arm dies by ANY route or hangs, stop the arm's named units and SIGKILL everything whose argv mentions the arm dir.
const WATCHDOG = `
const fs = require('fs'), cp = require('child_process');
const [parent, dir, max, ...us] = process.argv.slice(1);
const t0 = Date.now();
const gone = (pid) => { try { process.kill(pid, 0); } catch { return true; } try { return /^\\d+ \\(.*\\) Z /.test(fs.readFileSync('/proc/' + pid + '/stat', 'utf8')); } catch { return true; } };
const sweep = () => {
  let list = us; try { list = list.concat(fs.readFileSync(dir + '/units.txt', 'utf8').split('\\n').filter(Boolean)); } catch {}
  for (const u of new Set(list)) if (u.startsWith('${UNIT_PREFIX}')) try { cp.spawnSync('systemctl', ['--user', 'stop', u], { stdio: 'ignore' }); } catch {}
  for (const n of fs.readdirSync('/proc')) { if (!/^\\d+$/.test(n) || Number(n) === process.pid) continue; try { if (fs.readFileSync('/proc/' + n + '/cmdline', 'utf8').split('\\0').some((a) => a.includes(dir))) process.kill(Number(n), 'SIGKILL'); } catch {} }
};
setInterval(() => { const dead = gone(Number(parent)); if (!dead && Date.now() - t0 < Number(max)) return; sweep(); if (!dead) try { process.kill(Number(parent), 'SIGKILL'); } catch {} setTimeout(sweep, 500); setTimeout(() => process.exit(0), 900); }, 250);
`;
const wd = spawn(process.execPath, ['-e', WATCHDOG, String(process.pid), base, '120000'], { detached: true, stdio: 'ignore' });
wd.unref();
const noteUnit = (u) => { units.push(u); fs.appendFileSync(path.join(base, 'units.txt'), `${u}\n`); };

const finish = async (extra = {}) => {
  // teardown BY NAME / identity: the arm's own units, then anything still marked with the arm dir
  for (const u of units) if (u.startsWith(UNIT_PREFIX)) spawnSync('systemctl', ['--user', 'stop', u], { stdio: 'ignore' });
  // leftovers marked with the arm dir: identity = (pid, start ticks) captured at listing and RE-READ right before the signal (a recycled pid is never signalled)
  const ident = (pid) => { try { return Number(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '').split(' ')[19]); } catch { return null; } };
  const listed = new Map();
  for (let i = 0; i < 40 && marked(base).filter((p) => p !== wd.pid).length > 0; i++) {
    if (i === 20) for (const p of marked(base)) if (p !== wd.pid) listed.set(p, ident(p));
    if (i === 21) for (const [p, t] of listed) if (t !== null && ident(p) === t) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
    await sleep(100);
  }
  const survivors = marked(base).filter((p) => p !== wd.pid);
  const scopes = rigUnitsLeft().filter((l) => units.some((u) => l.startsWith(u)));
  if (survivors.length || scopes.length) fails.push(`LEAK: processes=${survivors.join(',')} scopes=${scopes.join(',')}`);
  try { process.kill(wd.pid, 'SIGKILL'); } catch { /* gone */ }
  if (process.env.KEEP_RIG !== '1') fs.rmSync(base, { recursive: true, force: true });
  console.log(JSON.stringify({ ...out, ...extra, survivors: survivors.length, scopesLeft: scopes.length, ok: fails.length === 0, ...(fails.length ? { why: fails.join(' | ') } : {}) }));
  process.exit(fails.length === 0 ? 0 : 1);
};
const deadline = setTimeout(() => { fails.push('deadline: the arm hung'); void finish(); }, 100_000);
deadline.unref?.();

if (UID === 0 || !fs.existsSync(APP_SLICE)) { fails.push(`no user cgroup slice at ${APP_SLICE} — cannot run a scope rig here`); await finish(); }

// ── bundles: keeper daemon + built CLI of the tree under test ───────────────────────────────────────────────────────
const KEEPER_JS = path.join(REPO, 'dist-electron', 'keeper.js');
const kSrcs = ['src/keeper/index.ts', 'src/shared/keeper-protocol.ts'].map((s) => path.join(REPO, s));
if (!fs.existsSync(KEEPER_JS) || kSrcs.some((s) => fs.existsSync(s) && fs.statSync(s).mtimeMs > fs.statSync(KEEPER_JS).mtimeMs)) {
  execFileSync(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.keeper.config.ts'], { cwd: REPO, stdio: 'ignore' });
}
const KEEPER_BIN = path.join(home, 'bin', 'keeper.js');
fs.copyFileSync(KEEPER_JS, KEEPER_BIN);

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-e2e-reliquats', broadcast: () => {}, broadcastPtyData: () => true, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {}, openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => home, getLogsDir: () => `${home}/logs`, getAppVersion: () => '0.0.0-e2e-reliquats', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});
(await import(`${REPO}/src/main/logger.ts`)).initLogger();
const kc = await import(`${REPO}/src/main/keeper-client.ts`);
// What the app does at startup: lay down the Plafond mémoire tool wrapper. H1's decision creates NO scope without it (the kernel would kill the CLI first), so the production path only scopes with it in place.
try { kc.installKeeper?.(); } catch { /* the rig copied the keeper bundle itself; installKeeper also lays down the oom wrapper */ }
const { store } = await import(`${REPO}/src/main/store.ts`);
fs.mkdirSync(path.join(home, 'orchestra'), { recursive: true });
await store.load?.();
const scopeMod = await import(`${HERE_REPO}/src/shared/memory-scope.ts`); // H1's PURE half (unit naming + the production launch argv) — from the rig's tree, so a master subject still gets a scoped keeper
const rm = await import(`${REPO}/src/main/resource-monitor.ts`);
const resourcesShared = await import(`${REPO}/src/shared/resources.ts`);
const hasMemberMemory = fs.existsSync(path.join(REPO, 'src/shared/member-memory.ts'));
const memberShared = hasMemberMemory ? await import(`${REPO}/src/shared/member-memory.ts`) : null;
out.hasMemberMemory = hasMemberMemory;

// ── fake CLI: echo + (a) a DETACHED allocator (double fork: the sh exits, the allocator is reparented) (b) a plain child ─
const ALLOC = `const mb = Number(process.argv[2] || 0); if (mb > 0) { const b = Buffer.allocUnsafe(mb * 1048576); b.fill(1); globalThis.keep = b; } setInterval(() => {}, 1000);`;
const FAKE_CLI = `
const cp = require('child_process'), path = require('path');
const alloc = path.join(__dirname, 'alloc.cjs');
process.on('SIGTERM', () => process.exit(0));
process.stdin.on('data', (d) => {
  for (const line of d.toString('utf8').split('\\n')) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.detach !== undefined) cp.spawn('/bin/sh', ['-c', '"' + process.execPath + '" "' + alloc + '" ' + Number(m.detach) + ' </dev/null >/dev/null 2>&1 &'], { stdio: 'ignore' });
    if (m.child !== undefined) cp.spawn(process.execPath, [alloc, String(Number(m.child))], { stdio: 'ignore' });
    if (m.browser !== undefined) cp.spawn('/bin/bash', [path.join(__dirname, 'browser.sh'), String(m.browser.unit), String(m.browser.helperMb), String(m.browser.mainMb), process.execPath], { stdio: 'ignore' });
    process.stdout.write(JSON.stringify({ type: 'assistant', echo: m.echo ?? m.detach ?? m.child ?? (m.browser ? 'browser' : undefined), pid: process.pid }) + '\\n');
  }
});
setInterval(() => {}, 1000);
`;
const fakeCli = path.join(base, 'fake-cli.cjs');
fs.writeFileSync(fakeCli, FAKE_CLI);
fs.writeFileSync(path.join(base, 'alloc.cjs'), ALLOC);
// a stand-in for a Chromium: forks its helpers (they stay in the member's scope), THEN the main moves itself into its OWN transient systemd scope — exactly what real Chromium does (review F1, p4-browser.sh)
fs.writeFileSync(path.join(base, 'browser.sh'), `#!/bin/bash
unit="$1"; hmb="$2"; mmb="$3"; node_="$4"; dir="$(dirname "$0")"
"$node_" "$dir/alloc.cjs" "$hmb" &
"$node_" "$dir/alloc.cjs" "$hmb" &
sleep 1
exec systemd-run --user --scope --collect --quiet --unit="$unit" -p MemoryMax=300M -- "$node_" "$dir/alloc.cjs" "$mmb"
`);

const alive = (pid) => { try { process.kill(pid, 0); } catch { return false; } try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '')[0] !== 'Z'; } catch { return false; } };
async function waitFor(pred, ms, step = 100) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return true; await sleep(step); } return !!(await pred()); }
const pidFilePath = (ws) => path.join(home, 'keepers', `${ws}.pid`);
const pidFilePid = (ws) => { try { return JSON.parse(fs.readFileSync(pidFilePath(ws), 'utf8')).pid; } catch { return null; } };
const startTicksOf = (pid) => { try { return Number(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '').split(' ')[19]); } catch { return null; } };
const unitDir = (u) => path.join(APP_SLICE, u);
const sysfsMem = (u) => { try { return Number(fs.readFileSync(path.join(unitDir(u), 'memory.current'), 'utf8')); } catch { return null; } };

/** A REAL keeper daemon (same argv as launchKeeperDaemon), optionally wrapped in FI-1's PRODUCTION scope argv, with a fake CLI attached. */
async function startKeeper(ws, { scoped, gen, seed = true }) {
  fs.mkdirSync(path.join(home, 'keepers'), { recursive: true });
  // the member exists in the (scratch) store, as in production — `currentMemberMemory` asks about the store's workspaces plus the live keepers; the reaper never runs (tick() pins storeLoadedFromDisk=false)
  if (seed) await store.upsertWorkspace({ id: ws, name: ws, kind: 'scratch', repoPath: '', baseBranch: '', branch: ws, worktreePath: path.join(base, `wt-${ws}`), status: 'idle', createdAt: Date.now(), hasInput: true });
  const sock = kc.keeperSocketPath(ws);
  if (!sock.startsWith(home + path.sep)) throw new Error('VOID: socket path fell back to a hashed tmp name (rig dir too long)');
  const keeperArgs = [KEEPER_BIN, ws, sock, pidFilePath(ws), path.join(home, 'keepers', `${ws}.log`)];
  let cmd = process.execPath;
  let args = keeperArgs;
  let unit = null;
  if (scoped) {
    unit = scopeMod.memoryScopeUnitName(UNIT_PREFIX, ws, gen);
    if (!unit || !unit.startsWith(UNIT_PREFIX)) throw new Error(`bad unit name for ${ws}/${gen}`);
    noteUnit(unit);
    // FI-1's production argv builder; the only rig-specific parts are the unit name and the 300 MB ceiling (D2)
    ({ cmd, args } = scopeMod.buildScopeLaunchArgv({ unit, limits: { hardBytes: 300 * MB, softBytes: null, swapMaxBytes: 0 }, cmd: process.execPath, args: keeperArgs }));
  }
  const k = spawn(cmd, args, { detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  k.unref();
  if (!(await waitFor(() => pidFilePid(ws) !== null && alive(pidFilePid(ws)), 25_000))) throw new Error(`setup: keeper for ${ws} never owned its pid file`);
  const keeperPid = pidFilePid(ws);
  const s = net.connect(sock);
  await new Promise((res, rej) => { s.once('connect', res); s.once('error', rej); });
  let buf = '';
  const acks = [];
  s.on('data', (d) => {
    buf += d.toString('utf8');
    for (const l of buf.split('\n').slice(0, -1)) {
      try { const f = JSON.parse(l); if (f.t === 'stdout') for (const sl of Buffer.from(f.b64, 'base64').toString('utf8').split('\n')) { if (sl.trim().startsWith('{')) acks.push(JSON.parse(sl)); } } catch { /* partial */ }
    }
    buf = buf.slice(buf.lastIndexOf('\n') + 1);
  });
  s.write(JSON.stringify({ t: 'hello', wsId: ws }) + '\n');
  await sleep(150);
  s.write(JSON.stringify({ t: 'spawn', command: process.execPath, args: [fakeCli, ws], cwd: base, env: { PATH: process.env.PATH, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? '', DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? '' } }) + '\n'); // the member's env carries the session bus, as a real member's does: that is how a browser reaches systemd to move itself into its own scope
  const k0 = { ws, keeperPid, keeperTicks: startTicksOf(keeperPid), unit, sock: s, acks };
  const send = (obj) => s.write(JSON.stringify({ t: 'stdin', b64: Buffer.from(`${JSON.stringify(obj)}\n`).toString('base64') }) + '\n');
  k0.send = send;
  send({ echo: 'up' });
  if (!(await waitFor(() => acks.some((a) => a.echo === 'up'), 25_000))) throw new Error(`setup: the fake CLI of ${ws} never answered`);
  k0.cliPid = acks.find((a) => a.echo === 'up').pid;
  return k0;
}
/** SIGKILL a keeper BY IDENTITY (pid + start ticks re-read right before the signal). */
function killKeeper(k) {
  if (startTicksOf(k.keeperPid) === k.keeperTicks) process.kill(k.keeperPid, 'SIGKILL');
  else throw new Error(`refusing to signal pid ${k.keeperPid}: start ticks changed`);
}

/** THE INSTRUMENT: one REAL monitor tick with the production deps (docker off, store never "loaded" so the reaper refuses by construction). On master `productionDeps()` carries no member read → no `members` block. */
async function tick() {
  const lines = [];
  const deps = { ...rm.productionDeps(), refreshContainers: undefined, containerView: undefined, appendLine: (l) => lines.push(l), electronProcs: () => [], storeLoadedFromDisk: () => false, warn: () => {}, info: () => {} };
  const line = await rm.sampleTick(deps);
  return line;
}
const mem = (line, ws) => {
  const t = line.sessions.find((s) => s.workspaceId === ws) ?? null;
  const m = line.members?.tracked?.find((x) => x.wsId === ws) ?? null;
  return { tree: t ? t.rssBytes : null, scope: m ? m.bytes : null, reliquats: m ? m.reliquats : null, reliquatBytes: m ? m.reliquatBytes : null, scopes: m ? m.scopes : 0, member: m && m.bytes !== null ? m.bytes : t ? t.rssBytes : null, hasMembers: !!line.members, untracked: line.members?.untracked ?? null };
};
const busModPath = (db) => db?.name ?? ''; // better-sqlite3 exposes the opened file as `.name`
const mb = (n) => (n === null || n === undefined ? null : Math.round(n / MB));
/** poll the real tick until `pred(mem)` holds (the allocator needs a moment to fault its pages in) — returns the last mem reading. */
async function until(ws, pred, ms = 15_000) {
  let m = null;
  await waitFor(async () => { m = mem(await tick(), ws); return pred(m); }, ms, 400);
  return m;
}

const N = 100; // MB — the known magnitude
const PAGE = Number(execFileSync('getconf', ['PAGESIZE']).toString().trim()); // the rig's own truth reads /proc/<pid>/statm in pages
/** Workspace ids carry the RUN id: two concurrent runs (mine, a verifier's) never share a unit, so `memberScopes` never sums the other run's scopes. */
const WS = (name) => `${name}-${runId}`;
try {
  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  if (ARM === 'known_magnitude') {
    const ws = WS('wh2-km');
    const k = await startKeeper(ws, { scoped: true, gen: scopeMod.newScopeGen(Date.now()) });
    const m0 = await until(ws, (m) => m.tree !== null && (!hasMemberMemory || m.scope !== null));
    check('baseline_tree_present', m0.tree !== null, mb(m0.tree));
    // control 1 (known-INERT): a detached process that allocates NOTHING — the scope must move by its bare runtime, the tree by nothing
    k.send({ detach: 0 });
    const m1 = await until(ws, (m) => (m.reliquats ?? 0) >= 1 || !hasMemberMemory, 8_000);
    // known-GOOD: a detached process holding N MB
    k.send({ detach: N });
    const m2 = await until(ws, (m) => m.member !== null && m1.member !== null && m.member - m1.member >= 0.85 * N * MB, 15_000);
    const dInert = mb(m1.member - m0.member);
    const dKnown = mb(m2.member - m1.member);
    const dTree = mb((m2.tree ?? 0) - (m0.tree ?? 0));
    out.baseline_mb = mb(m0.member); out.inert_delta_mb = dInert; out.known_delta_mb = dKnown; out.tree_delta_mb = dTree; out.reliquats = m2.reliquats; out.reliquat_mb = mb(m2.reliquatBytes);
    check('detached_raises_member_memory_by_about_N', dKnown >= 0.85 * N && dKnown <= 1.5 * N, dKnown);
    check('tree_walk_does_not_see_it', Math.abs(dTree) <= 25, dTree); // the master behaviour, shown by the instrument itself
    check('reliquat_counted', m2.reliquats === 2, m2.reliquats); // the inert one + the N MB one
    check('reliquat_bytes_cover_N', (m2.reliquatBytes ?? 0) >= 0.85 * N * MB, mb(m2.reliquatBytes));
    // control 3 (known-visible-to-both): a PLAIN child of the CLI is in the tree AND in the scope — the scope reader must not lose what the tree sees
    k.send({ child: 50 });
    const m3 = await until(ws, (m) => m.tree !== null && m2.tree !== null && m.tree - m2.tree >= 0.8 * 50 * MB, 12_000);
    check('plain_child_seen_by_tree', mb((m3.tree ?? 0) - (m2.tree ?? 0)) >= 40, mb((m3.tree ?? 0) - (m2.tree ?? 0)));
    check('plain_child_seen_by_scope', mb((m3.member ?? 0) - (m2.member ?? 0)) >= 40, mb((m3.member ?? 0) - (m2.member ?? 0)));
    check('plain_child_is_not_a_reliquat', m3.reliquats === 2, m3.reliquats);
    // the page: the same members report folded by the real grouping
    if (hasMemberMemory) {
      const line = await tick();
      const sdk = { ptyId: `${ws}:sdk`, workspaceId: ws, kind: 'sdk', remote: false, cpuPct: 0, memBytes: line.sessions.find((s) => s.workspaceId === ws).rssBytes, procCount: 1, processes: [] };
      const row = resourcesShared.groupSessionsByWorkspace([sdk], null, line.members).rows[0];
      const scopeBytes = line.members.tracked.find((x) => x.wsId === ws)?.bytes;
      // the row IS the scope's meter (it holds the keeper tree AND the Reliquats — nothing is added on top); the tree figure is what master shows
      check('page_row_reads_the_scope', scopeBytes != null && row.memBytes === scopeBytes && row.memBytes !== sdk.memBytes && row.reliquats?.count === 2, { rowMb: mb(row.memBytes), scopeMb: mb(scopeBytes), treeMb: mb(sdk.memBytes), reliquats: row.reliquats?.count });
    } else check('page_row_reads_the_scope', false, 'no member-memory module in this tree');
    // honesty of the scope itself: the kernel meter is what the rig's OWN sysfs read says
    const sys = sysfsMem(k.unit);
    check('scope_read_matches_own_sysfs_read', sys !== null && m3.scope !== null && Math.abs(sys - m3.scope) <= 40 * MB, { sysMb: mb(sys), readMb: mb(m3.scope) });
  }
  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  if (ARM === 'keeper_gone_reliquat_stays') {
    const ws = WS('wh2-gone');
    const k = await startKeeper(ws, { scoped: true, gen: scopeMod.newScopeGen(Date.now()) });
    k.send({ detach: N });
    const before = await until(ws, (m) => m.member !== null && m.member >= (N + 20) * MB, 15_000);
    out.dbgBefore = { procs: fs.readFileSync(path.join(unitDir(k.unit), 'cgroup.procs'), 'utf8').split('\n').filter(Boolean).map((p) => `${p}:${fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0').slice(0, 3).map((a) => path.basename(a)).join(' ')}`), keeperPid: k.keeperPid, cliPid: k.cliPid };
    killKeeper(k);
    check('keeper_is_dead', await waitFor(() => !alive(k.keeperPid), 8_000), alive(k.keeperPid));
    await sleep(500);
    out.dbgAfter = (() => { try { return fs.readFileSync(path.join(unitDir(k.unit), 'cgroup.procs'), 'utf8').split('\n').filter(Boolean); } catch (e) { return String(e.message); } })();
    out.dbg = { pidfile: pidFilePid(ws), stat: (() => { try { return fs.readFileSync(`/proc/${k.keeperPid}/stat`, 'utf8').replace(/^.*\) /, '').slice(0, 12); } catch { return 'gone'; } })(), roots: kc.listKeeperRoots() };
    const after = await until(ws, (m) => (m.reliquats ?? 0) >= 1, 8_000);
    const line = await tick();
    out.before_mb = mb(before.member); out.after = { scope_mb: mb(after.scope), reliquats: after.reliquats, tree_row: line.sessions.some((s) => s.workspaceId === ws) };
    check('tree_walk_has_no_row_for_the_member', line.sessions.some((s) => s.workspaceId === ws) === false, line.sessions.map((s) => s.workspaceId));
    check('scope_still_counts_the_reliquat', (after.scope ?? 0) >= 0.85 * N * MB, mb(after.scope));
    check('reliquat_count_includes_the_leftover', (after.reliquats ?? 0) >= 1 && (after.reliquatBytes ?? 0) >= 0.85 * N * MB, { n: after.reliquats, mb: mb(after.reliquatBytes) });
  }
  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  if (ARM === 'two_generations') {
    const ws = WS('wh2-gen');
    const t0 = Date.now();
    const a = await startKeeper(ws, { scoped: true, gen: scopeMod.newScopeGen(t0) });
    a.send({ detach: N });
    await until(ws, (m) => (m.reliquats ?? 0) >= 1 && m.member >= (N + 20) * MB, 15_000);
    killKeeper(a);
    await waitFor(() => !alive(a.keeperPid), 8_000);
    for (const p of [kc.keeperSocketPath(ws), pidFilePath(ws)]) { try { fs.unlinkSync(p); } catch { /* gone */ } }
    const b = await startKeeper(ws, { scoped: true, gen: scopeMod.newScopeGen(t0 + 5_000) });
    const m = await until(ws, (x) => x.scopes === 2, 10_000);
    const sumSys = (sysfsMem(a.unit) ?? 0) + (sysfsMem(b.unit) ?? 0);
    out.scopes = m.scopes; out.read_mb = mb(m.scope); out.sysfs_sum_mb = mb(sumSys);
    check('two_scopes_found', m.scopes === 2, m.scopes);
    check('bytes_are_the_sum_of_both', m.scope !== null && Math.abs(m.scope - sumSys) <= 40 * MB && m.scope >= 0.85 * N * MB, { readMb: mb(m.scope), sysMb: mb(sumSys) });
    check('old_generation_reliquat_counted', (m.reliquats ?? 0) >= 1, m.reliquats);
  }
  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  if (ARM === 'untracked_fallback') {
    const ws = WS('wh2-plain');
    const k = await startKeeper(ws, { scoped: false });
    k.send({ detach: N });
    await waitFor(() => marked(path.join(base, 'alloc.cjs')).length > 0, 8_000);
    await sleep(1500);
    const line = await tick();
    const m = mem(line, ws);
    out.tree_mb = mb(m.tree); out.members = line.members ?? null;
    check('members_block_present', m.hasMembers, m.hasMembers);
    check('member_is_untracked', Array.isArray(m.untracked) && m.untracked.includes(ws) && m.scope === null, m.untracked);
    check('tree_figure_kept', m.tree !== null && m.tree > 0, mb(m.tree));
    if (memberShared && line.members) {
      const txt = memberShared.formatReliquatsLine(line.members, (id) => id);
      out.line = txt;
      check('line_says_not_tracked', /Reliquats not tracked/.test(txt), txt);
      const sdk = { ptyId: `${ws}:sdk`, workspaceId: ws, kind: 'sdk', remote: false, cpuPct: 0, memBytes: m.tree, procCount: 1, processes: [] };
      const row = resourcesShared.groupSessionsByWorkspace([sdk], null, line.members).rows[0];
      check('page_row_keeps_tree_figure', row.memBytes === m.tree && row.reliquats === null, { rowMb: mb(row.memBytes), treeMb: mb(m.tree), reliquats: row.reliquats });
    }
  }
  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  if (ARM === 'page_snapshot') {
    const ws = WS('wh2-pg');
    const k = await startKeeper(ws, { scoped: true, gen: scopeMod.newScopeGen(Date.now()) });
    const m0 = await until(ws, (m) => m.tree !== null && (!hasMemberMemory || m.scope !== null));
    k.send({ detach: N });
    const m1 = await until(ws, (m) => m.member !== null && m0.member !== null && m.member - m0.member >= 0.85 * N * MB, 15_000);
    const r = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--experimental-strip-types', '--import', path.join(HERE, 'rss-page-size', 'register-resources-stubs.mjs'), path.join(HERE, 'reliquats-memory', 'drive-page.mjs')], {
      encoding: 'utf8', timeout: 60_000, env: { PATH: process.env.PATH, HOME: home, ORCHESTRA_HOME: home, ORCHESTRA_MEMORY_SCOPE_PREFIX: UNIT_PREFIX, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? '', RIG_REPO: REPO, RIG_REAL_HOME: REAL_HOME, WS: ws },
    });
    const j = (r.stdout ?? '').split('\n').find((l) => l.startsWith('PAGE-JSON '));
    const page = j ? JSON.parse(j.slice('PAGE-JSON '.length)) : null;
    out.page = page; out.driverExit = r.status;
    check('driver_ran', !!page, (r.stderr ?? '').slice(-300));
    if (page) {
      check('snapshot_carries_members', page.hasMembers === true && page.view !== null, { hasMembers: page.hasMembers, view: page.view && { bytes: mb(page.view.bytes), reliquats: page.view.reliquats } });
      check('row_is_the_scope_meter_not_the_tree', !!page.row && page.view?.bytes != null && page.row.memBytes === page.view.bytes && page.row.memBytes !== page.sdkMemBytes, { rowMb: mb(page.row?.memBytes), scopeMb: mb(page.view?.bytes), treeMb: mb(page.sdkMemBytes) });
      check('row_carries_the_reliquat', page.row?.reliquats?.count === 1 && (page.row?.reliquats?.bytes ?? 0) >= 0.85 * N * MB, page.row?.reliquats);
      check('row_above_baseline_by_about_N', !!page.row && page.row.memBytes - (m0.scope ?? m0.member) >= 0.85 * N * MB, { risenMb: mb((page.row?.memBytes ?? 0) - (m0.scope ?? m0.member ?? 0)) });
    }
    void m1;
  }
  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  if (ARM === 'browser_escapes_scope') {
    const ws = WS('esc');
    const k = await startKeeper(ws, { scoped: true, gen: scopeMod.newScopeGen(Date.now()) });
    await until(ws, (m) => m.tree !== null && (!hasMemberMemory || m.scope !== null));
    // the browser main's own unit: NOT a member-shaped name (no `-<gen>` tail), so `memberScopes` / `countMemberScopes` never take it for a member scope
    const escUnit = `${UNIT_PREFIX}esc_${runId}.scope`;
    noteUnit(escUnit);
    const HELPER = 30, MAIN = 80;
    k.send({ browser: { unit: escUnit, helperMb: HELPER, mainMb: MAIN } });
    await waitFor(() => fs.existsSync(path.join(unitDir(escUnit), 'cgroup.procs')), 15_000, 200);
    await sleep(2500); // the helpers and the main fault their pages in
    const line = await tick();
    const m = mem(line, ws);
    const view = line.members?.tracked?.find((x) => x.wsId === ws) ?? null;
    // independent truth, read by the rig itself: the keeper's whole tree by the GLOBAL ppid chain, split by cgroup
    const table = [];
    for (const n of fs.readdirSync('/proc')) { if (!/^\d+$/.test(n)) continue; try { const st = fs.readFileSync(`/proc/${n}/stat`, 'utf8'); const f = st.slice(st.lastIndexOf(')') + 2).split(' '); const rss = Number(fs.readFileSync(`/proc/${n}/statm`, 'utf8').split(' ')[1]) * PAGE; table.push({ pid: Number(n), ppid: Number(f[1]), rss }); } catch { /* gone */ } }
    const desc = new Set([k.keeperPid]); for (let grew = true; grew;) { grew = false; for (const p of table) if (!desc.has(p.pid) && desc.has(p.ppid)) { desc.add(p.pid); grew = true; } }
    const cgOf = (pid) => { try { return fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8').split('\n').find((l) => l.startsWith('0::'))?.slice(3) ?? null; } catch { return null; } };
    const inEsc = [...desc].filter((p) => cgOf(p)?.endsWith(escUnit)).map((p) => table.find((t) => t.pid === p)?.rss ?? 0);
    const escTruth = inEsc.reduce((a, b) => a + b, 0);
    out.escUnitProcs = inEsc.length; out.escTruthMb = mb(escTruth); out.billMb = mb(view?.bytes); out.outsideMb = mb(view?.outsideBytes); out.reliquats = view?.reliquats ?? null;
    check('the_main_really_left_the_scope', inEsc.length >= 1 && escTruth >= 0.85 * MAIN * MB, { n: inEsc.length, mb: mb(escTruth) });
    check('helpers_are_not_reliquats', view?.reliquats === 0, { reliquats: view?.reliquats, procs: view?.reliquatProcs?.map((p) => `${p.comm}:${p.pid}`) }); // FI-1 v1.9: a helper whose parent left the scope still reaches the keeper by the GLOBAL ppid chain — a healthy member has 0 Reliquats
    check('escaped_main_is_billed', !!view && view.outsideBytes >= 0.85 * MAIN * MB && Math.abs(view.outsideBytes - escTruth) <= 25 * MB, { outsideMb: mb(view?.outsideBytes), truthMb: mb(escTruth) });
    if (memberShared) {
      const sdk = { ptyId: `${ws}:sdk`, workspaceId: ws, kind: 'sdk', remote: false, cpuPct: 0, memBytes: line.sessions.find((s) => s.workspaceId === ws)?.rssBytes ?? 0, procCount: 1, processes: [] };
      const row = resourcesShared.groupSessionsByWorkspace([sdk], null, line.members).rows[0];
      check('row_covers_the_escaped_main', !!view && row.memBytes >= (view.bytes ?? 0) + 0.85 * MAIN * MB, { rowMb: mb(row.memBytes), billMb: mb(view?.bytes), truthMb: mb(escTruth) });
    } else check('row_covers_the_escaped_main', false, 'no member-memory module in this tree');
  }
  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  if (ARM === 'production_launch') {
    const capPath = path.join(REPO, 'src/main/memory-cap-switch.ts');
    const capMod = fs.existsSync(capPath) ? await import(`${REPO}/src/main/memory-cap-switch.ts`) : null;
    const { initBus, getBus } = await import(`${REPO}/src/main/bus.ts`);
    const { startRun } = await import(`${REPO}/src/main/bus-runs.ts`);
    const { DEFAULT_BUS_SWITCHES } = await import(`${REPO}/src/shared/bus-switches.ts`);
    initBus();
    const db = getBus();
    if (!db || !String(busModPath(db)).startsWith(home)) { fails.push('SAFETY: no scratch bus'); await finish(); }
    startRun(db, { id: 'run-on', kind: 'vague', coordinator: 'c' }, { ...DEFAULT_BUS_SWITCHES, memoryCap: true });
    startRun(db, { id: 'run-off', kind: 'vague', coordinator: 'c' }, { ...DEFAULT_BUS_SWITCHES });
    const settings = store.getMemoryGuardSettings();
    /** What agent-sdk.ts does at a session start: decide from the run's FROZEN switch, then hand the spec to makeKeeperSpawn (the keeper is launched in its scope iff a spec comes back). */
    const launch = async (ws, run) => {
      await store.upsertWorkspace({ id: ws, name: ws, kind: 'scratch', repoPath: '', baseBranch: '', branch: ws, worktreePath: path.join(base, `wt-${ws}`), status: 'idle', createdAt: Date.now(), hasInput: true, parentId: 'coord' });
      const spec = capMod ? capMod.memoryCapSpecFor({ wsId: ws, runId: run, ws: store.getWorkspace(ws), remote: false, settings }) : undefined;
      if (spec && !spec.unit.startsWith(UNIT_PREFIX)) throw new Error(`REFUSING to launch: unit ${spec.unit} is not a rig unit (${UNIT_PREFIX}*)`); // BEFORE the keeper exists, not after
      if (spec) noteUnit(spec.unit);
      const st = { out: '', exited: false };
      const h = kc.makeKeeperSpawn(ws, () => {}, undefined, spec)({ command: process.execPath, args: [fakeCli, ws], cwd: base, env: { PATH: process.env.PATH }, signal: new AbortController().signal });
      h.stdout.on('data', (d) => { st.out += d.toString('utf8'); });
      h.on('exit', () => { st.exited = true; });
      h.stdin.write(JSON.stringify({ echo: 'up' }) + '\n');
      if (!(await waitFor(() => st.out.includes('"echo":"up"'), 25_000))) throw new Error(`setup: the CLI of ${ws} never answered`);
      return { ws, spec, send: (o) => h.stdin.write(JSON.stringify(o) + '\n') };
    };
    const on = await launch(WS('pl-on'), 'run-on');
    const off = await launch(WS('pl-off'), 'run-off');
    out.decisionOn = capMod?.memoryCapDecisionFor ? (({ createScope, reason, support }) => ({ createScope, reason, support }))(capMod.memoryCapDecisionFor({ wsId: on.ws, runId: 'run-on', ws: store.getWorkspace(on.ws), remote: false, settings })) : null;
    out.specOn = on.spec ? { unit: on.spec.unit, hardMb: mb(on.spec.limits?.hardBytes) } : null;
    out.specOff = off.spec ?? null;
    check('switch_ON_run_gets_a_scope', !!capMod && !!on.spec, out.specOn);
    check('switch_OFF_run_gets_none', off.spec === undefined, out.specOff);
    const m0 = await until(on.ws, (m) => m.tree !== null && (!hasMemberMemory || m.scope !== null));
    on.send({ detach: N });
    off.send({ detach: N });
    const m1 = await until(on.ws, (m) => m.member !== null && m0.member !== null && m.member - m0.member >= 0.85 * N * MB, 15_000);
    const line = await tick();
    const mOff = mem(line, off.ws);
    out.on_delta_mb = mb((m1.member ?? 0) - (m0.member ?? 0)); out.on_tree_delta_mb = mb((m1.tree ?? 0) - (m0.tree ?? 0));
    check('ON_detached_raises_member_by_about_N', (m1.member ?? 0) - (m0.member ?? 0) >= 0.85 * N * MB && (m1.member ?? 0) - (m0.member ?? 0) <= 1.5 * N * MB, out.on_delta_mb);
    check('ON_reliquat_counted', m1.reliquats === 1, m1.reliquats);
    check('ON_tree_walk_blind', Math.abs((m1.tree ?? 0) - (m0.tree ?? 0)) <= 25 * MB, out.on_tree_delta_mb);
    check('OFF_not_tracked_tree_figure', mOff.scope === null && Array.isArray(mOff.untracked) && mOff.untracked.includes(off.ws) && mOff.tree !== null, { untracked: mOff.untracked, treeMb: mb(mOff.tree) });
    if (memberShared && line.members) {
      const txt = memberShared.formatReliquatsLine(line.members, (id) => id);
      out.line = txt;
      check('line_names_the_tracked_and_the_untracked', txt.includes(`${on.ws} ×1`) && /Reliquats not tracked for 1 member/.test(txt), txt);
    }
  }
  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  if (ARM === 'bus_status_line') {
    const busMod = await import(`${REPO}/src/main/bus.ts`);
    busMod.initBus();
    if (busMod.getBus() && !String(busMod.busPath()).startsWith(home)) { fails.push(`SAFETY: bus resolved outside scratch: ${busMod.busPath()}`); await finish(); }
    const hooks = await import(`${REPO}/src/main/hooks-server.ts`);
    await hooks.startHooksServer();
    const sock = hooks.getHookSocketPath();
    const CLI = path.join(REPO, 'dist-electron', 'cli.js');
    if (!fs.existsSync(CLI)) { fails.push(`${CLI} not built (pnpm run build:cli)`); await finish(); }
    const cli = (args) => new Promise((resolve) => {
      const p = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, HOME: home, ORCHESTRA_HOME: home, ORCHESTRA_SOCK: sock }, stdio: ['ignore', 'pipe', 'pipe'] });
      let so = '', se = '';
      p.stdout.on('data', (c) => (so += c)); p.stderr.on('data', (c) => (se += c));
      p.on('close', (code) => resolve({ code, stdout: so, stderr: se }));
    });
    const reliquatsLine = async () => { const r = await cli(['bus-status']); return { code: r.code, line: r.stdout.split('\n').find((l) => l.startsWith('reliquats:')) ?? null, stderr: r.stderr.slice(0, 200) }; };
    // phase A — an UNSCOPED member only: « Reliquats not tracked »
    const scWs = WS('bs-sc');
    const plain = await startKeeper(WS('bs-pl'), { scoped: false });
    plain.send({ detach: 10 });
    await sleep(1800); // the route's member read is short-cached (1.5 s): let it expire
    const a = await reliquatsLine();
    out.phaseA = a.line;
    check('A_line_present', a.code === 0 && a.line !== null, a);
    check('A_not_tracked', /Reliquats not tracked/.test(a.line ?? ''), a.line);
    // phase B — add a SCOPED member holding a ~100 MB Reliquat
    const sc = await startKeeper(scWs, { scoped: true, gen: scopeMod.newScopeGen(Date.now()) });
    sc.send({ detach: N });
    await waitFor(async () => { await sleep(1700); const r = await reliquatsLine(); return /1 live/.test(r.line ?? '') && new RegExp(`${scWs} ×1 · (\\d+) MB`).test(r.line ?? '') && Number(new RegExp(`${scWs} ×1 · (\\d+) MB`).exec(r.line)[1]) >= 0.85 * N; }, 20_000, 100);
    const b = await reliquatsLine();
    out.phaseB = b.line;
    check('B_count_per_member', (b.line ?? '').includes(`${scWs} ×1 · `), b.line);
    check('B_size_labelled_RSS', new RegExp(`${scWs} ×1 · \\d+ MB RSS`).test(b.line ?? ''), b.line);
    check('B_size_about_N', (() => { const x = new RegExp(`${scWs} ×1 · (\\d+) MB`).exec(b.line ?? ''); return !!x && Number(x[1]) >= 0.85 * N && Number(x[1]) <= 2 * N; })(), b.line);
    check('B_untracked_remainder_named', /Reliquats not tracked for 1 member/.test(b.line ?? ''), b.line);
    check('B_one_member_tracked', /1 member tracked/.test(b.line ?? ''), b.line);
    check('B_no_stray_yet', !/not in the store/.test(b.line ?? ''), b.line);
    // phase C — a STRAY scope: a workspace that is in no store and has no live keeper, whose detached process lives on (deleted workspace / crashed keeper). H1's REAL `countMemberScopes` counts it; nothing reads it.
    const gone = await startKeeper(WS('bs-st'), { scoped: true, gen: scopeMod.newScopeGen(Date.now() + 7_000), seed: false });
    gone.send({ detach: 20 });
    await sleep(1500);
    killKeeper(gone);
    await waitFor(() => !alive(gone.keeperPid), 8_000);
    await waitFor(async () => { await sleep(1700); return /1 scope of workspaces not in the store was not read/.test((await reliquatsLine()).line ?? ''); }, 15_000, 100);
    const c = await reliquatsLine();
    out.phaseC = c.line;
    check('C_stray_scope_counted_not_read', /1 scope of workspaces not in the store was not read/.test(c.line ?? ''), c.line);
    check('C_member_figures_unchanged', (c.line ?? '').includes(`${scWs} ×1 · `) && /1 member tracked/.test(c.line ?? ''), c.line);
  }
} catch (e) {
  fails.push(`arm threw: ${(e && e.stack) || e}`);
}
await finish();
