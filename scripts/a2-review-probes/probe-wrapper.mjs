// Reviewer probe (reviewer-a2-reaper): can the reaper kill a live workspace's SOLE keeper when that keeper
// is launched through a FORK-style wrapper (both wrapper + daemon carry `keeper.js <ws> <sock> <pid> <log>`)?
// Arms: direct (control: nothing may die) | wrapper (the attack) | dup (control: a real duplicate IS reaped).
// Own scratch home under ~/a2r-attack; every signal is filtered to pids in MY spawned trees.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const REPO = path.resolve(process.env.SUBJECT_REPO ?? '/home/lmas/a2r-cand');
const ARM = process.argv[2];
const REAL_HOME = '/home/lmas';
const base = path.join(REAL_HOME, 'a2r-attack', 'arms', ARM);
if (!base.startsWith(path.join(REAL_HOME, 'a2r-attack') + path.sep)) throw new Error('bad base');
fs.rmSync(base, { recursive: true, force: true });
const home = path.join(base, 'home');
fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
process.env.ORCHESTRA_HOME = home;
process.env.HOME = home;
const KEEPER_BIN = path.join(home, 'bin', 'keeper.js');
fs.copyFileSync(path.join(REPO, 'dist-electron', 'keeper.js'), KEEPER_BIN);

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-reviewer-probe', broadcast: () => {}, broadcastPtyData: () => {}, canBroadcast: () => true,
  isFocused: () => false, hasAttachedUi: () => false, notify: () => {}, openExternal: () => {}, showItemInFolder: () => {},
  openPath: () => {}, openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => home, getLogsDir: () => `${home}/logs`, getAppVersion: () => '0.0.0-probe', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});
(await import(`${REPO}/src/main/logger.ts`)).initLogger();
const kc = await import(`${REPO}/src/main/keeper-client.ts`);
const M = await import(`${REPO}/src/main/resource-monitor.ts`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stateOf = (pid) => { try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '')[0]; } catch { return null; } };
const alive = (pid) => { const s = stateOf(pid); return s !== null && s !== 'Z'; };
function ppidOf(pid) { try { return Number(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '').split(' ')[1]); } catch { return null; } }
function descendants(root) {
  const kids = new Map();
  for (const n of fs.readdirSync('/proc')) { if (!/^\d+$/.test(n)) continue; const pp = ppidOf(Number(n)); if (pp !== null) kids.set(pp, [...(kids.get(pp) ?? []), Number(n)]); }
  const out = [root]; for (let i = 0; i < out.length; i++) out.push(...(kids.get(out[i]) ?? []));
  return out;
}
const mine = new Set(); // roots I spawned
const inMine = (pid) => [...mine].some((r) => descendants(r).includes(pid));
async function waitFor(pred, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return true; await sleep(50); } return !!(await pred()); }
const pidFile = (ws) => path.join(home, 'keepers', `${ws}.pid`);
const pidFilePid = (ws) => { try { return JSON.parse(fs.readFileSync(pidFile(ws), 'utf8')).pid; } catch { return null; } };

/** Launch a keeper daemon the way launchKeeperDaemon does, optionally through a wrapper argv prefix. */
function launch(ws, { wrapper = [], sockOverride } = {}) {
  fs.mkdirSync(path.join(home, 'keepers'), { recursive: true });
  const sock = sockOverride ?? kc.keeperSocketPath(ws);
  const args = [KEEPER_BIN, ws, sock, kc.keeperPidFilePath(ws), path.join(home, 'keepers', `${ws}.log`)];
  const [cmd, ...pre] = wrapper.length ? [...wrapper, process.execPath] : [process.execPath];
  const child = spawn(cmd, [...pre, ...args], { detached: true, stdio: 'ignore', env: { PATH: process.env.PATH, HOME: home, ORCHESTRA_HOME: home } });
  child.unref();
  mine.add(child.pid);
  return child.pid;
}

const WS = `wsprobe-${ARM}-${process.pid}`;
const signals = [];
const warns = [];
const deps = {
  ...M.realResourceMonitorDeps(),
  liveWorkspaceIds: () => new Set([WS]),
  storeLoadedFromDisk: () => true,
  sleep: (ms) => sleep(Math.min(ms, 300)),
  warn: (m) => warns.push(m),
  info: (m) => warns.push(m),
  // SAFETY: never signal a pid outside the trees I spawned.
  signal: (pid, sig) => {
    if (!inMine(pid)) { signals.push({ pid, sig, refused: 'NOT-MINE' }); return false; }
    signals.push({ pid, sig });
    try { process.kill(pid, sig); return true; } catch { return false; }
  },
};

const out = { arm: ARM, ws: WS };
try {
  if (ARM === 'direct') {
    out.k = launch(WS);
  } else if (ARM === 'wrapper') {
    out.wrapper = launch(WS, { wrapper: ['timeout', '300'] });
  } else if (ARM === 'dup') {
    out.k1 = launch(WS, { sockOverride: path.join(home, 'keepers', `${WS}.other.sock`) }); // first, foreign socket
    await waitFor(() => pidFilePid(WS) === out.k1 || (pidFilePid(WS) && alive(pidFilePid(WS))), 5000);
    out.k2 = launch(WS); // last writer of the pid file = tracked
  } else throw new Error('unknown arm');
  const ok = await waitFor(() => { const p = pidFilePid(WS); return p && alive(p) && fs.existsSync(kc.keeperSocketPath(WS)); }, 8000)
    || (ARM === 'dup' && await waitFor(() => pidFilePid(WS) && alive(pidFilePid(WS)), 3000));
  if (!ok) throw new Error('setup: keeper never came up');
  if (ARM === 'dup') await sleep(500);

  const argvOfKeepers = M.realResourceMonitorDeps().keeperProcs();
  out.matchedKeeperProcs = argvOfKeepers.filter((p) => p.workspaceId === WS).map((p) => ({ pid: p.pid, ppid: ppidOf(p.pid) }));
  out.tracked = pidFilePid(WS);
  out.before = Object.fromEntries(descendants([...mine][0]).map((p) => [p, alive(p)]));

  await M.reapKeepersNow(deps);
  await sleep(500);
  out.signals = signals;
  out.after = Object.fromEntries(Object.keys(out.before).map((p) => [p, alive(Number(p))]));
  out.trackedAliveAfter = out.tracked ? alive(out.tracked) : null;
  out.reapLines = warns.filter((w) => /reaping|WITHHELD|ABORTED/.test(w));
  out.solekeeperKilled = out.tracked ? !alive(out.tracked) : null;
} catch (e) {
  out.error = String(e?.stack ?? e);
} finally {
  for (const r of mine) for (const p of descendants(r)) { try { if (inMine(p)) process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  await sleep(200);
  out.leftovers = [...mine].flatMap((r) => descendants(r)).filter(alive);
}
console.log(JSON.stringify(out));
process.exit(0);
