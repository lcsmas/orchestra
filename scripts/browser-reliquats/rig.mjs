#!/usr/bin/env node
// Browser-Reliquat rig (#331, wave H ledger #329 track H10): the resource monitor (60 s pass) and every Pause dure stop the orphaned headless browsers a member left behind.
//
//   node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/.r2-register.mjs scripts/browser-reliquats/rig.mjs <arm | all> [--unfixed]
//   pnpm run test:browser-reliquats            (= all)           pnpm run test:browser-reliquats -- --unfixed   (the SAME rig against the tree BEFORE #331: must-FAIL)
//
// REAL path: REAL headless Chromium (/usr/bin/chromium-browser, profiles under the rig's scratch `<HOME>/.orchestra/agent-tmp/<ws>/tmp/brig<token>-…`), the REAL `sampleTick`
// (what the 60 s timer runs) with the production browser bridge (only the idle window is shortened: N = 6 s instead of 10 min), the REAL Pause dure (`orchestra run pause --hard`
// written by the built CLI, the PRODUCTION trap deps), the REAL built `run status` / `run resume` / `run release`, the REAL bus (scratch). Never a browser it did not launch, never a live
// ORCHESTRA_HOME / HOME / bus. THIS IS THE LEAK IT PREVENTS: every browser is stopped BY IDENTITY (pid + /proc start-time re-read) — also on failure (trap) — and `SURVIVORS arm=… procs=0`
// is printed after every arm, counting processes that carry the rig token in their argv OR their environment (a crashpad handler inherits the env, not the profile path).
//
// ONE ARM = ONE PROCESS (store / bus / logger singletons). Needs THE heavy-rig token (ledger #329 Briefing) and MemAvailable ≥ 6 GB.
// Exit: 0 every arm as expected · 1 an arm broke expectation · 3 VOID (host too loaded / tooling unavailable: nothing measured).

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REAL_HOME = process.env.BR_REAL_HOME ?? os.homedir();
const HERE_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SUBJECT = path.resolve(process.env.SUBJECT_REPO ?? HERE_REPO); // the tree whose src/ + built CLI the arm drives (--unfixed: the tree BEFORE #331)
const UNFIXED_SHA = process.env.BR_UNFIXED_SHA ?? '07dd2bfc'; // master with #325 merged, before #331: scope Reliquats exist, browsers are not handled
const CHROMIUM = process.env.BR_CHROMIUM ?? '/usr/bin/chromium-browser';
const WINDOW_MS = 6_000; // N, shortened for the rig (production: 10 min)
const FLAGS = ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-extensions', '--disable-background-networking'];

/** `mustRedden`: on the UNFIXED tree exactly these checks go RED (premises and the "must survive" controls stay green). */
const ARMS = {
  monitor: { mustRedden: ['pipe_orphan_stopped_at_once', 'pipe_group_dead', 'port_orphan_stopped_after_window', 'port_group_dead', 'client_gone_then_stopped_after_window', 'owner_told_once_per_pass', 'counter_counts_each_stop', 'stopped_browsers_leave_no_crashpad_handler', 'pipe_group_signalled'] },
  pause_dure: { mustRedden: ['pause_stops_the_orphaned_browsers', 'pause_group_dead', 'bilan_lists_the_browsers', 'bilan_lists_the_spared_client', 'run_status_lists_them', 'consigne_shows_them', 'reprise_relaunches_nothing'] },
};
const ARM = process.argv[2] ?? '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readSafe = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

// ═══ PARENT MODE ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
const RUN_TOKEN = process.env.BR_RUN_TOKEN ?? randomBytes(2).toString('hex');
const MARK = `brig${RUN_TOKEN}`;
const RIG_ROOT = path.join(REAL_HOME, '.cache', 'browser-reliquats-rig', RUN_TOKEN);
const armBase = (arm) => path.join(RIG_ROOT, createHash('sha1').update(arm).digest('hex').slice(0, 6));

/** Every process carrying the rig token in its argv OR its environment (identity: pid + start-time re-read from /proc). */
function tagged() {
  const out = [];
  for (const n of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(n) || Number(n) === process.pid) continue;
    try {
      const st = fs.readFileSync(`/proc/${n}/stat`, 'utf8');
      if (st.slice(st.lastIndexOf(')') + 2)[0] === 'Z') continue;
      let hit = false;
      try { hit = fs.readFileSync(`/proc/${n}/cmdline`, 'latin1').includes(MARK); } catch { /* */ }
      if (!hit) { try { hit = fs.readFileSync(`/proc/${n}/environ`, 'latin1').includes(`BROWSER_RIG=${MARK}`); } catch { /* */ } }
      if (hit) out.push({ pid: Number(n), start: st.slice(st.lastIndexOf(')') + 2).split(' ')[19] });
    } catch { /* gone */ }
  }
  return out;
}
function killTagged() {
  let killed = 0;
  for (const p of tagged()) {
    try {
      const st = fs.readFileSync(`/proc/${p.pid}/stat`, 'utf8');
      if (st.slice(st.lastIndexOf(')') + 2).split(' ')[19] !== p.start) continue; // identity re-read right before the signal
      process.kill(p.pid, 'SIGKILL');
      killed++;
    } catch { /* gone */ }
  }
  return killed;
}

if (process.env.BR_CHILD !== '1') {
  const UNFIXED = process.argv.includes('--unfixed');
  const names = ARM === 'all' || ARM === '' || ARM.startsWith('--') ? Object.keys(ARMS) : [ARM];
  const avail = Number(/MemAvailable:\s+(\d+) kB/.exec(fs.readFileSync('/proc/meminfo', 'utf8'))[1]) / 1048576;
  if (process.env.BR_IGNORE_LOAD !== '1' && avail < 6) { console.log(`BROWSER-RELIQUATS: VOID — MemAvailable ${avail.toFixed(1)} GB < 6 (ledger D2); nothing was measured`); process.exit(3); }
  if (!fs.existsSync(CHROMIUM)) { console.log(`BROWSER-RELIQUATS: VOID — ${CHROMIUM} not found`); process.exit(3); }
  const build = (cwd) => { const r = spawnSync('pnpm', ['run', 'build:cli'], { cwd, encoding: 'utf8' }); if (r.status !== 0) { console.log(`BROWSER-RELIQUATS: VOID — build:cli failed in ${cwd}: ${(r.stdout + r.stderr).slice(-300)}`); process.exit(3); } };
  let subject = SUBJECT;
  let unfixedDir = null;
  if (UNFIXED) {
    const sha = spawnSync('git', ['rev-parse', `${UNFIXED_SHA}^{commit}`], { cwd: HERE_REPO, encoding: 'utf8' }).stdout.trim();
    if (!sha) { console.log(`BROWSER-RELIQUATS: VOID — the unfixed commit ${UNFIXED_SHA} is not in this repo (set BR_UNFIXED_SHA)`); process.exit(3); }
    unfixedDir = path.join(REAL_HOME, '.cache', 'browser-reliquats-rig', `unfixed-${sha.slice(0, 8)}-${RUN_TOKEN}`);
    const w = spawnSync('git', ['worktree', 'add', '--detach', unfixedDir, sha], { cwd: HERE_REPO, encoding: 'utf8' });
    if (w.status !== 0) { console.log(`BROWSER-RELIQUATS: VOID — cannot create the unfixed worktree: ${w.stderr.slice(-200)}`); process.exit(3); }
    fs.symlinkSync(path.join(HERE_REPO, 'node_modules'), path.join(unfixedDir, 'node_modules'));
    build(unfixedDir);
    subject = unfixedDir;
    console.log(`UNFIXED subject: ${sha.slice(0, 8)} (${unfixedDir})`);
  } else build(HERE_REPO);
  const results = [];
  fs.mkdirSync(RIG_ROOT, { recursive: true });
  const bail = () => { killTagged(); if (unfixedDir) { spawnSync('git', ['worktree', 'remove', '--force', unfixedDir], { cwd: HERE_REPO }); fs.rmSync(unfixedDir, { recursive: true, force: true }); } process.exit(130); };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, bail);
  for (const arm of names) {
    if (!ARMS[arm]) { console.error(`unknown arm: ${arm}`); process.exit(2); }
    const base = armBase(arm);
    const env = { PATH: process.env.PATH, HOME: path.join(base, 'home'), LANG: 'C.UTF-8', BR_REAL_HOME: REAL_HOME, BR_RUN_TOKEN: RUN_TOKEN, BR_CHILD: '1', SUBJECT_REPO: subject, BROWSER_RIG: MARK };
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', path.join(HERE_REPO, 'scripts', '.r2-register.mjs'), fileURLToPath(import.meta.url), arm], { env, encoding: 'utf8', timeout: 300_000, cwd: HERE_REPO });
    const line = (r.stdout ?? '').split('\n').reverse().find((l) => l.startsWith('{"arm"'));
    let res;
    try { res = line ? JSON.parse(line) : { ok: false, failed: [], error: `no result line (rc=${r.status}${r.signal ? ' ' + r.signal : ''}): ${(r.stderr ?? '').trim().slice(-300)}` }; } catch (e) { res = { ok: false, failed: [], error: `unparsable result: ${e}` }; }
    // G5: the survivors of THIS arm — counted BEFORE any cleanup, then stopped by identity
    const left = tagged().length;
    const reaped = killTagged();
    await sleep(500);
    const after = tagged().length;
    const failed = res.failed ?? [];
    const want = ARMS[arm].mustRedden;
    const asExpected = !res.error && (UNFIXED ? want.every((c) => failed.includes(c)) && failed.every((c) => want.includes(c)) : failed.length === 0 && !!res.ok);
    const clean = left === 0 && after === 0;
    results.push({ arm, ok: asExpected && clean });
    console.log(`${asExpected && clean ? 'PASS' : 'FAIL'} ${arm}${UNFIXED ? ` [unfixed: must redden ${want.join(', ')}]` : ''}${res.detail ? ` — ${res.detail}` : ''}${res.error ? ` — ${res.error}` : ''}${failed.length ? ` — RED: ${failed.join(', ')}` : ''}`);
    for (const l of (r.stderr ?? '').split('\n')) if (/^ {2}(ok  |FAIL) /.test(l) && (process.env.BR_VERBOSE || l.startsWith('  FAIL') || UNFIXED)) console.log(l);
    console.log(`SURVIVORS arm=${arm} procs=${left}${left ? `  ← LEAK (stopped by identity: ${reaped}; left after: ${after})` : ''}`);
  }
  const bad = results.filter((r) => !r.ok);
  if (unfixedDir) { spawnSync('git', ['worktree', 'remove', '--force', unfixedDir], { cwd: HERE_REPO }); fs.rmSync(unfixedDir, { recursive: true, force: true }); }
  fs.rmSync(RIG_ROOT, { recursive: true, force: true });
  console.log(`BROWSER-RELIQUATS RIG${UNFIXED ? ' [UNFIXED]' : ''}: ${results.length - bad.length}/${results.length} arms ${UNFIXED ? 'AS EXPECTED (must-FAIL)' : 'PASS'}${bad.length ? ` — FAILED: ${bad.map((r) => r.arm).join(', ')}` : ''}`);
  console.log(`TAGGED processes now: ${tagged().length}`);
  process.exit(bad.length ? 1 : 0);
}

// ═══ ARM MODE ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
if (!ARMS[ARM]) { console.error(`unknown arm: ${ARM} (one of ${Object.keys(ARMS).join(', ')}, all)`); process.exit(2); }
const base = armBase(ARM);
if (!base.startsWith(path.join(REAL_HOME, '.cache', 'browser-reliquats-rig') + path.sep)) throw new Error(`refusing rig dir outside the rig cache root: ${base}`);
fs.rmSync(base, { recursive: true, force: true });
const home = path.join(base, 'home');
fs.mkdirSync(home, { recursive: true });
process.env.ORCHESTRA_HOME = home;
process.env.HOME = home; // os.homedir() — hence `<HOME>/.orchestra/agent-tmp`, the production attribution root — is the scratch dir
const { assertScratch } = await import(`${HERE_REPO}/scripts/session-budget/scratch-guard.mjs`);
const liveNames = fs.readdirSync(REAL_HOME).filter((n) => n.startsWith('.claude') || n.startsWith('.orchestra'));
const live = [...liveNames.map((n) => path.join(REAL_HOME, n)), path.join(REAL_HOME, '.config', 'orchestra')];
assertScratch('ORCHESTRA_HOME', home, base, live);
assertScratch('HOME', home, base, live);
const AGENT = path.join(os.homedir(), '.orchestra', 'agent-tmp');
if (!AGENT.startsWith(home + path.sep)) throw new Error(`agent-tmp root ${AGENT} is not under the scratch home`);
const CLI_JS = path.join(SUBJECT, 'dist-electron', 'cli.js');
if (!fs.existsSync(CLI_JS)) throw new Error(`${CLI_JS} is missing — build the subject first (the parent does)`);

const { initPlatform } = await import(`${SUBJECT}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-browser-reliquats-rig', broadcast: () => {}, broadcastPtyData: () => {}, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {}, openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => path.join(home, 'userData'), getLogsDir: () => `${home}/logs`, getAppVersion: () => '0.0.0-browser-reliquats-rig', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});
(await import(`${SUBJECT}/src/main/logger.ts`)).initLogger();
const { store } = await import(`${SUBJECT}/src/main/store.ts`);
const busMod = await import(`${SUBJECT}/src/main/bus.ts`);
const runsMod = await import(`${SUBJECT}/src/main/bus-runs.ts`);
const pauseMod = await import(`${SUBJECT}/src/main/bus-pause.ts`);
const { DEFAULT_BUS_SWITCHES } = await import(`${SUBJECT}/src/shared/bus-switches.ts`);
const trap = await import(`${SUBJECT}/src/main/pause-trap.ts`);
const host = await import(`${SUBJECT}/src/main/pause-trap-host.ts`);
const monitor = await import(`${SUBJECT}/src/main/resource-monitor.ts`);

// ── a scratch store + bus: lead ⊃ ops ⊃ a, and lead ⊃ other ⊃ b ──────────────────────────────────────────────────────────────
const T = RUN_TOKEN;
const ID = { lead: `rqL${T}`, ops: `rqO${T}`, other: `rqX${T}`, a: `rqA${T}`, b: `rqB${T}` };
const GHOST = `rqZ${T}`; // a workspace id the store does NOT know
const STORE_FILE = path.join(home, 'userData', 'orchestra', 'store.json');
fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
fs.writeFileSync(STORE_FILE, JSON.stringify({ repos: [], workspaces: [], accounts: [], selfTuneRuns: [] }));
await store.load?.();
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'rig', GIT_AUTHOR_EMAIL: 'r@r', GIT_COMMITTER_NAME: 'rig', GIT_COMMITTER_EMAIL: 'r@r' } }).trim();
const WT = Object.fromEntries(Object.entries(ID).map(([k]) => [k, path.join(base, `wt-${k}`)]));
for (const dir of Object.values(WT)) { fs.mkdirSync(dir, { recursive: true }); git(dir, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(dir, 'a.txt'), 'base\n'); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init'); }
const mk = (k, extra) => store.upsertWorkspace({ id: ID[k], name: ID[k], kind: 'scratch', repoPath: '', baseBranch: '', branch: ID[k], worktreePath: WT[k], status: 'idle', createdAt: Date.now(), hasInput: true, ...extra });
await mk('lead', { kind: 'orchestrator' });
await mk('ops', { kind: 'orchestrator', parentId: ID.lead });
await mk('other', { kind: 'orchestrator', parentId: ID.lead });
await mk('a', { parentId: ID.ops, lastTask: 'rig task of a' });
await mk('b', { parentId: ID.other, lastTask: 'rig task of b' });
for (let i = 0; i < 100 && !(readSafe(STORE_FILE) ?? '').includes(`"${ID.b}"`); i++) await sleep(50);
busMod.initBus();
const db = busMod.getBus();
const sw = { ...DEFAULT_BUS_SWITCHES, pause: true };
runsMod.startRun(db, { id: ID.lead, kind: 'mission', coordinator: ID.lead }, sw);
runsMod.startRun(db, { id: ID.ops, kind: 'vague', coordinator: ID.ops, parentRunId: ID.lead }, sw);
runsMod.startRun(db, { id: ID.other, kind: 'vague', coordinator: ID.other, parentRunId: ID.lead }, sw);

// ── observation: /proc and /proc/net/tcp, never the subject's own opinion ──────────────────────────────────────────────────────
const statOf = (pid) => { const s = readSafe(`/proc/${pid}/stat`); if (!s) return null; const r = s.slice(s.lastIndexOf(')') + 2).split(' '); return { pid, comm: s.slice(s.indexOf('(') + 1, s.lastIndexOf(')')), state: r[0], ppid: +r[1], pgrp: +r[2], start: +r[19] }; };
const allProcs = () => fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map((n) => statOf(+n)).filter(Boolean);
const idOf = (p) => `${p.pid}:${p.start}`;
const aliveId = (id) => { const [pid, st] = id.split(':'); const s = statOf(+pid); return !!s && s.state !== 'Z' && String(s.start) === st; };
const cmdOf = (pid) => (readSafe(`/proc/${pid}/cmdline`) ?? '').split('\0').filter(Boolean);
/** The identities of the browser's whole process group at this instant (the main process leads it: setsid). */
const groupIds = (mainPid) => { const m = statOf(mainPid); return m ? allProcs().filter((p) => p.pgrp === m.pgrp && p.state !== 'Z').map(idOf) : []; };
/** The crashpad handler a browser spawned (named in its children's argv, `--crashpad-handler-pid=N`): it is NOT in the ppid tree, so whether stopping the browser leaves it behind is a MEASUREMENT. */
const crashpadOf = (mainPid) => { const m = statOf(mainPid); if (!m) return null; for (const p of allProcs().filter((x) => x.pgrp === m.pgrp)) { const mm = /--crashpad-handler-pid=(\d+)/.exec(cmdOf(p.pid).join(' ')); if (mm) { const c = statOf(Number(mm[1])); if (c) return idOf(c); } } return null; }; // a Chromium child rewrites its title: its whole argv is ONE string (no NULs) — search the joined cmdline
const portOf = (profile) => { const f = readSafe(path.join(profile, 'DevToolsActivePort')); return f ? Number(f.split('\n')[0]) : null; };
/** ESTABLISHED sockets whose local port is `port` — read independently of the code under test. */
const establishedTo = (port) => ['tcp', 'tcp6'].reduce((n, f) => n + (readSafe(`/proc/net/${f}`) ?? '').split('\n').slice(1).filter((l) => { const c = l.trim().split(/\s+/); return c.length > 9 && c[3] === '01' && parseInt(c[1].split(':')[1], 16) === port; }).length, 0);
async function waitFor(pred, ms, step = 100) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return true; await sleep(step); } return !!(await pred()); }

// ── launching REAL browsers ──────────────────────────────────────────────────────────────────────────────────────────────────────
const profile = (ws, tag) => path.join(AGENT, ws, 'tmp', `${MARK}-${tag}`);
const benv = { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', BROWSER_RIG: MARK }; // the marker rides the ENVIRONMENT too: a crashpad handler inherits it though its argv carries no profile path
const q = (a) => `'${String(a).replace(/'/g, `'\\''`)}'`;
const launched = []; // identity of every browser MAIN this arm started (teardown by identity)
/** Find the main process of the browser started with this profile (no --type=). */
async function mainOf(prof) {
  let found = null;
  await waitFor(() => { found = allProcs().find((p) => { const a = cmdOf(p.pid); return a.some((x) => x === `--user-data-dir=${prof}`) && !a.some((x) => x.startsWith('--type=')); }) ?? null; return !!found; }, 20_000);
  if (!found) throw new Error(`browser with profile ${prof} did not start`);
  launched.push(idOf(found));
  return found;
}
/** An ORPHANED port-mode browser: started by a shell that exits at once, in its own session (the incident's shape). `extra` goes before the profile flag. */
async function orphanPort(prof, { profileFlag = true } = {}) {
  fs.mkdirSync(prof, { recursive: true });
  execFileSync('sh', ['-c', `setsid ${CHROMIUM} ${FLAGS.join(' ')} --remote-debugging-port=0 ${profileFlag ? `--user-data-dir=${q(prof)}` : ''} about:blank </dev/null >/dev/null 2>&1 &`], { env: benv, encoding: 'utf8' });
  const main = profileFlag ? await mainOf(prof) : await (async () => { let f = null; await waitFor(() => { f = allProcs().find((p) => cmdOf(p.pid).some((x) => x.includes('--remote-debugging-port=0')) && cmdOf(p.pid).includes('--no-first-run') && !cmdOf(p.pid).some((x) => x.startsWith('--type=')) && p.ppid <= 1 && !launched.includes(idOf(p)) && (readSafe(`/proc/${p.pid}/environ`) ?? '').includes(`BROWSER_RIG=${MARK}`)) ?? null; return !!f; }, 20_000); if (!f) throw new Error('default-profile browser did not start'); launched.push(idOf(f)); return f; })();
  if (profileFlag) await waitFor(() => portOf(prof) !== null, 20_000);
  await sleep(1500); // let the children (zygote, gpu, renderer, network) appear
  return main;
}
/** An ORPHANED pipe-mode browser whose pipe is NOT closed: a helper process (the leaked grandchild a real incident leaves) keeps the launcher's pipe ends open, so Chromium does not exit on EOF. */
async function orphanPipe(prof) {
  fs.mkdirSync(prof, { recursive: true });
  const launcher = `
    const { spawn } = require('child_process');
    const c = spawn(${JSON.stringify(CHROMIUM)}, ${JSON.stringify([...FLAGS, '--remote-debugging-pipe', `--user-data-dir=${prof}`, 'about:blank'])}, { detached: true, stdio: ['ignore','ignore','ignore','pipe','pipe'], env: process.env });
    const h = spawn('sleep', ['3600'], { detached: true, stdio: ['ignore','ignore','ignore', c.stdio[3], c.stdio[4]], env: process.env });
    c.unref(); h.unref(); setTimeout(() => process.exit(0), 800);`;
  spawn(process.execPath, ['-e', launcher], { env: benv, stdio: 'ignore' });
  const main = await mainOf(prof);
  await sleep(2500);
  return main;
}
/** A browser whose LAUNCHER IS ALIVE: a child of this very process. */
async function launcherAlive(prof) {
  fs.mkdirSync(prof, { recursive: true });
  const c = spawn(CHROMIUM, [...FLAGS, '--remote-debugging-port=0', `--user-data-dir=${prof}`, 'about:blank'], { env: benv, stdio: 'ignore', detached: false });
  const main = await mainOf(prof);
  await waitFor(() => portOf(prof) !== null, 20_000);
  await sleep(1500);
  return { main, child: c };
}

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) });
const profilesExist = (...ps) => ps.every((p) => fs.existsSync(p));

const sockets = [];
async function teardown() {
  try { trap.stopPauseTrap(); } catch { /* not started */ }
  for (const s of sockets) { try { s.destroy(); } catch { /* */ } }
  // every browser main this arm started + the processes of its tree, by IDENTITY (re-read right before each signal). A process GROUP is only signalled when the browser main LEADS it
  // (`setsid`: pgrp == pid) and the group is not this rig's own: a browser started as a plain child shares its parent's group — signalling that group would kill the rig, its parents and the shell it runs in.
  const mine = statOf(process.pid);
  for (const id of launched) {
    const [pid, st] = id.split(':');
    const m = statOf(+pid);
    if (!m || String(m.start) !== st) continue;
    const table = allProcs();
    const victims = m.pgrp === m.pid && m.pgrp !== mine?.pgrp ? table.filter((p) => p.pgrp === m.pgrp) : (() => { const out = new Map([[m.pid, m]]); for (let grew = true; grew; ) { grew = false; for (const p of table) if (!out.has(p.pid) && out.has(p.ppid)) { out.set(p.pid, p); grew = true; } } return [...out.values()]; })();
    for (const g of victims) { if (g.pid === process.pid) continue; const cur = statOf(g.pid); if (cur && cur.start === g.start) { try { process.kill(g.pid, 'SIGKILL'); } catch { /* gone */ } } }
  }
  // the rig's own helpers (the pipe holders, a crashpad handler outside the group): whatever still carries this run's token — stopped by identity here AND counted by the parent afterwards
  killTagged();
  await sleep(500);
}

// ═══ the arms ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
let detail = '';
/** The REAL tick with the PRODUCTION deps (`productionDeps()`: what the 60 s timer runs — so the wiring that installs the bridge is exercised too). The Docker accounting is dropped (the host's daemon is not ours to ask);
 *  only the idle window / grace are shortened. On the UNFIXED tree `productionDeps()` carries no bridge: the plain tick. */
const tick = () => {
  const prod = { ...monitor.productionDeps() };
  delete prod.refreshContainers;
  delete prod.containerView;
  if (prod.browser) prod.browser = { ...prod.browser, deps: { ...prod.browser.deps, idleWindowMs: WINDOW_MS, graceMs: 2000 } };
  return monitor.sampleTick(prod);
};
const statusRows = (ws) => db.prepare("SELECT body, run_id FROM messages WHERE sender = 'host' AND kind = 'status' AND recipient = ? ORDER BY sequence").all(ws);
const cli = (...args) => { const r = spawnSync(process.execPath, [CLI_JS, ...args], { env: { PATH: process.env.PATH, HOME: home, ORCHESTRA_HOME: home, LANG: 'C.UTF-8' }, encoding: 'utf8', timeout: 60_000 }); return { rc: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }; };

try {
  if (ARM === 'monitor') {
    const pPipe = profile(ID.a, 'pipe'), pIdle = profile(ID.a, 'idle'), pClient = profile(ID.a, 'client'), pAlive = profile(ID.a, 'alive'), pOut = path.join(base, 'elsewhere', `${MARK}-out`), pGhost = profile(GHOST, 'ghost');
    const aPipe = await orphanPipe(pPipe);
    const bIdle = await orphanPort(pIdle);
    const cClient = await orphanPort(pClient);
    const dAlive = await launcherAlive(pAlive);
    const eOut = await orphanPort(pOut);
    const fGhost = await orphanPipe(pGhost);
    const gDefault = await orphanPort(path.join(base, 'default-profile-unused'), { profileFlag: false });
    const client = net.connect(portOf(pClient), '127.0.0.1');
    sockets.push(client);
    await new Promise((res, rej) => { client.once('connect', () => res()); client.once('error', rej); });
    await sleep(500);
    const ids = { aPipe: idOf(aPipe), bIdle: idOf(bIdle), cClient: idOf(cClient), dAlive: idOf(dAlive.main), eOut: idOf(eOut), fGhost: idOf(fGhost), gDefault: idOf(gDefault) };
    const groups = { aPipe: groupIds(aPipe.pid), bIdle: groupIds(bIdle.pid), cClient: groupIds(cClient.pid) };
    const crash = { aPipe: crashpadOf(aPipe.pid), bIdle: crashpadOf(bIdle.pid), cClient: crashpadOf(cClient.pid) };
    check('premise: seven REAL headless Chromium are alive, each with its own process group (>1 process)', Object.values(ids).every(aliveId) && Object.values(groups).every((g) => g.length > 1), JSON.stringify(Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length]))));
    check('premise: every browser has a crashpad handler outside its ppid tree (the thing whose fate we measure)', Object.values(crash).every((c) => c && aliveId(c)), JSON.stringify(crash));
    check('premise: the orphans really are orphans (ppid init) and the launcher-alive browser is a child of this process', [aPipe, bIdle, cClient, eOut, fGhost, gDefault].every((p) => { const pp = statOf(p.pid).ppid; return pp <= 1 || statOf(pp)?.comm === 'systemd'; }) && statOf(dAlive.main.pid).ppid === process.pid, [aPipe, bIdle, dAlive.main].map((p) => statOf(p.pid).ppid).join(',')); // orphans reparent to init or to the user manager (a subreaper), like the production decision
    check('premise: a REAL client is connected to c\'s debugging port; nobody is connected to b\'s', establishedTo(portOf(pClient)) >= 1 && establishedTo(portOf(pIdle)) === 0, `c=${establishedTo(portOf(pClient))} b=${establishedTo(portOf(pIdle))}`);
    check('premise: the pipe browsers are in pipe mode, the others in port mode; the default-profile one has NO --user-data-dir', cmdOf(aPipe.pid).includes('--remote-debugging-pipe') && cmdOf(bIdle.pid).includes('--remote-debugging-port=0') && !cmdOf(gDefault.pid).some((x) => x.startsWith('--user-data-dir')));
    // ── TICK 1 (t0): the pipe orphan goes at once; nothing else yet ──
    // who gets a signal FROM THE PASS: Chromium's children exit by themselves when their browser dies, so "the group is dead" cannot tell a group kill from a main-only kill — the signals can
    const signalled = new Set();
    const aliveBeforeTick1 = groups.aPipe.filter(aliveId).map((g) => Number(g.split(':')[0]));
    const realKill = process.kill.bind(process);
    process.kill = (pid, sig) => { if (typeof pid === 'number' && (sig === 'SIGTERM' || sig === 'SIGKILL')) signalled.add(pid); return realKill(pid, sig); };
    try { await tick(); } finally { process.kill = realKill; }
    check('pipe_group_signalled: the pass signalled EVERY member of the pipe orphan\'s group (not just the main process — the rest exiting by itself is Chromium\'s doing)', aliveBeforeTick1.length > 1 && aliveBeforeTick1.filter((p) => signalled.has(p)).length >= Math.ceil(aliveBeforeTick1.length * 0.9), `${aliveBeforeTick1.filter((p) => signalled.has(p)).length}/${aliveBeforeTick1.length} signalled`);
    check('pipe_orphan_stopped_at_once: the pipe-mode orphan of a member is stopped on the FIRST pass', !aliveId(ids.aPipe), ids.aPipe);
    check('pipe_group_dead: ...its whole process group with it (zygote, gpu, renderers, network)', groups.aPipe.every((g) => !aliveId(g)), `${groups.aPipe.filter(aliveId).length} left of ${groups.aPipe.length}`);
    check('the port-mode orphan is NOT stopped before the idle window (survives pass 1)', aliveId(ids.bIdle), ids.bIdle);
    check('must survive (pass 1): client-connected, launcher-alive, outside agent-tmp, unknown workspace, default profile', [ids.cClient, ids.dAlive, ids.eOut, ids.fGhost, ids.gDefault].every(aliveId), JSON.stringify(Object.entries(ids).filter(([, v]) => !aliveId(v)).map(([k]) => k)));
    // ── TICK 2 (t0 + window): the idle port orphan goes; the client-connected one stays ──
    await sleep(WINDOW_MS + 600);
    await tick();
    check('port_orphan_stopped_after_window: the port-mode orphan with no client is stopped once N has passed', !aliveId(ids.bIdle), ids.bIdle);
    check('port_group_dead: ...its whole process group too', groups.bIdle.every((g) => !aliveId(g)), `${groups.bIdle.filter(aliveId).length} left of ${groups.bIdle.length}`);
    check('the port-mode orphan with a LIVE CLIENT survives the window (the main process and its group — Chromium retires an idle renderer or two by itself)', aliveId(ids.cClient) && groups.cClient.filter(aliveId).length >= groups.cClient.length - 2, `${groups.cClient.filter(aliveId).length}/${groups.cClient.length}`);
    // ── TICK 3: long past the window, the client still there ──
    await sleep(WINDOW_MS + 600);
    await tick();
    check('still protected by its client two windows later; the other four untouched', [ids.cClient, ids.dAlive, ids.eOut, ids.fGhost, ids.gDefault].every(aliveId));
    // ── the client leaves: the window RESTARTS at the last sighting ──
    client.destroy();
    await waitFor(() => establishedTo(portOf(pClient)) === 0, 5000);
    await tick();
    check('the window restarts at the client\'s departure: not stopped on the very next pass', aliveId(ids.cClient));
    await sleep(WINDOW_MS + 600);
    await tick();
    check('client_gone_then_stopped_after_window: ...and stopped one window after the client left', !aliveId(ids.cClient) && groups.cClient.every((g) => !aliveId(g)), ids.cClient);
    await sleep(1500);
    check('stopped_browsers_leave_no_crashpad_handler: no crashpad handler of a stopped browser is left behind (it is outside the ppid tree)', Object.values(crash).every((c) => !aliveId(c)), JSON.stringify(Object.entries(crash).map(([k, c]) => [k, c, aliveId(c)])));
    // ── what the member and the page are told ──
    const rows = statusRows(ID.a);
    check('owner_told_once_per_pass: the owning member got ONE bus status per pass that stopped something (3), naming how many and the profile prefix; nobody else got any', rows.length === 3 && rows.every((r) => /stopped 1 orphaned headless browser\(s\)/.test(r.body) && r.body.includes(path.join(AGENT, ID.a) + '/')) && statusRows(ID.b).length === 0 && statusRows(ID.lead).length === 0, `${rows.length} rows: ${rows.map((r) => r.body.slice(0, 60)).join(' | ')}`);
    const view = monitor.getBrowserReliquatView?.();
    check('counter_counts_each_stop: the Resources counter reads 3 for this workspace (pipe, idle port, ex-client port) and nothing for the others', view?.byWorkspace?.[ID.a]?.stopped === 3 && view.total === 3, JSON.stringify(view));
    check('the profile directories are left in place (stopped, never deleted)', profilesExist(pPipe, pIdle, pClient, pAlive, pOut, pGhost));
    detail = '7 real Chromium; stopped 3 (pipe now, idle port + ex-client port after N), kept 4';
    void fGhost; void gDefault;
  } else if (ARM === 'pause_dure') {
    const pPipe = profile(ID.a, 'pipe'), pPort = profile(ID.a, 'port'), pClient = profile(ID.a, 'client'), pAlive = profile(ID.a, 'alive'), pOut = path.join(base, 'elsewhere', `${MARK}-out`), pB = profile(ID.b, 'b-pipe');
    const aPipe = await orphanPipe(pPipe);
    const aPort = await orphanPort(pPort); // idle for seconds only: a Pause dure does not wait N minutes
    const aClient = await orphanPort(pClient);
    const aAlive = await launcherAlive(pAlive);
    const aOut = await orphanPort(pOut);
    const bPipe = await orphanPipe(pB); // another run's member: not paused
    const client = net.connect(portOf(pClient), '127.0.0.1');
    sockets.push(client);
    await new Promise((res, rej) => { client.once('connect', () => res()); client.once('error', rej); });
    const ids = { aPipe: idOf(aPipe), aPort: idOf(aPort), aClient: idOf(aClient), aAlive: idOf(aAlive.main), aOut: idOf(aOut), bPipe: idOf(bPipe) };
    const groups = { aPipe: groupIds(aPipe.pid), aPort: groupIds(aPort.pid) };
    check('premise: six REAL headless Chromium alive (the two to be stopped have a multi-process group); a REAL client on aClient\'s port', Object.values(ids).every(aliveId) && Object.values(groups).every((g) => g.length > 1) && establishedTo(portOf(pClient)) >= 1);
    // ── THE PAUSE DURE (the REAL built CLI; the PRODUCTION trap deps — only what needs an SDK session is replaced) ──
    const deps = host.buildPauseTrapDeps();
    deps.interrupt = async () => 'idle';
    delete deps.arm;
    delete deps.stopTask;
    trap.startPauseTrap(deps);
    const p = cli('run', 'pause', '--hard', '--run', ID.ops, '--as', ID.lead);
    check('the pause is written by the REAL built CLI (rc 0, hard)', p.rc === 0 && /PAUSED|paused/i.test(p.out), p.out.trim().slice(0, 120));
    const trapAt = () => pauseMod.getRunPause(db, ID.ops)?.trapAt ?? null;
    check('trap_stamped: the host trap finished', await waitFor(() => trapAt() !== null, 90_000, 200), `trapAt=${trapAt()}`);
    await sleep(500);
    check('pause_stops_the_orphaned_browsers: the paused member\'s pipe-mode AND idle port-mode orphans are dead', !aliveId(ids.aPipe) && !aliveId(ids.aPort), `${ids.aPipe}:${aliveId(ids.aPipe)} ${ids.aPort}:${aliveId(ids.aPort)}`);
    check('pause_group_dead: ...their whole process groups', groups.aPipe.every((g) => !aliveId(g)) && groups.aPort.every((g) => !aliveId(g)));
    check('must survive: the browser with a live CLIENT, the one with a live launcher, the one outside agent-tmp, ANOTHER run\'s member\'s browser', [ids.aClient, ids.aAlive, ids.aOut, ids.bPipe].every(aliveId), JSON.stringify(Object.entries(ids).filter(([, v]) => !aliveId(v)).map(([k]) => k)));
    const bil = (ws) => { const pp = pauseMod.getRunPause(db, ID.ops); const row = db.prepare('SELECT * FROM pause_records WHERE run_id = ? AND ws_id = ? AND paused_at = ? ORDER BY id DESC LIMIT 1').get(ID.ops, ws, pp?.pausedAt ?? -1); return row ? JSON.parse(row.activity ?? 'null') : null; };
    const rq = bil(ID.a)?.reliquats;
    const mineKilled = (rq?.killed ?? []).filter((k) => String(k.scope).startsWith('browser:'));
    check('bilan_lists_the_browsers: the Bilan lists both with command, pid, start-time and start (scope browser:pipe / browser:port), the profile in cwd', mineKilled.length === 2 && mineKilled.every((k) => k.cmd.includes('--user-data-dir=') && k.pid > 0 && k.startTicks > 0 && k.startedAt > 0 && String(k.cwd).startsWith(AGENT)) && mineKilled.some((k) => k.scope === 'browser:pipe') && mineKilled.some((k) => k.scope === 'browser:port'), JSON.stringify(mineKilled.map((k) => [k.pid, k.scope])));
    check('bilan_lists_the_spared_client: the browser kept for its live client is listed as left running on purpose', (rq?.spared ?? []).some((s) => s.pid === aClient.pid && /client is connected/.test(s.reason)), JSON.stringify(rq?.spared ?? []).slice(0, 160));
    check('the Bilan of a member with NO browser Reliquat (the OPS) carries no `reliquats` key at all', bil(ID.ops) !== null && !('reliquats' in bil(ID.ops)), JSON.stringify(Object.keys(bil(ID.ops) ?? {})));
    const st = cli('run', 'status', '--run', ID.ops);
    check('run_status_lists_them: `orchestra run status` (built CLI) prints each stopped browser with command, pid and start', new RegExp(`reliquat killed: \\S*chromium-browser .* pid ${aPipe.pid} started \\d{4}-\\d\\d-\\d\\dT`).test(st.out) && new RegExp(`pid ${aPort.pid} started`).test(st.out), st.out.split('\n').filter((l) => /Reliquat|reliquat/.test(l)).join(' | ').slice(0, 240));
    const rs = cli('run', 'resume', '--run', ID.ops, '--as', ID.lead);
    await waitFor(() => db.prepare("SELECT 1 FROM messages WHERE kind = 'reprise' AND recipient = ?").get(ID.ops), 40_000, 200);
    const r2 = cli('run', 'release', ID.a, '--run', ID.ops, '--as', ID.ops);
    const body = db.prepare("SELECT body FROM messages WHERE kind = 'reprise' AND recipient = ? ORDER BY sequence DESC LIMIT 1").get(ID.a)?.body ?? '';
    check('consigne_shows_them: the member\'s Consigne de reprise lists the stopped browsers (command, pid) — LISTED, NOT re-run', body.includes('Reliquats') && body.includes(`${MARK}-pipe`) && /LISTED, NOT re-run/.test(body), `resume rc=${rs.rc} release rc=${r2.rc} body=${body.slice(0, 160).replace(/\n/g, ' | ')}`);
    check('reprise_relaunches_nothing: the stopped browsers stay dead after the Reprise; profiles left in place', !aliveId(ids.aPipe) && !aliveId(ids.aPort) && profilesExist(pPipe, pPort, pClient, pAlive, pOut, pB));
    detail = '6 real Chromium; the Pause stopped 2 (pipe + idle port), kept 4, listed in the Bilan';
    void bPipe;
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
