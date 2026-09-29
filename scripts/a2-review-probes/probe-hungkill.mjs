// Reviewer probe: killKeeper on a HUNG keeper (SIGSTOP) — is the CLI child orphaned when the keeper is SIGKILLed?
// Arms: normal (control: keeper AND cli die) | hung (keeper SIGSTOPped before killKeeper).
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(process.env.SUBJECT_REPO ?? '/home/lmas/a2r-probe');
const ARM = process.argv[2];
const REAL_HOME = '/home/lmas';
const base = path.join(REAL_HOME, 'a2r-attack', 'arms', `hungkill-${ARM}`);
fs.rmSync(base, { recursive: true, force: true });
const home = path.join(base, 'home');
fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
process.env.ORCHESTRA_HOME = home;
process.env.HOME = home;
fs.copyFileSync(path.join(REPO, 'dist-electron', 'keeper.js'), path.join(home, 'bin', 'keeper.js'));
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stateOf = (pid) => { try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '')[0]; } catch { return null; } };
const alive = (pid) => { const s = stateOf(pid); return s !== null && s !== 'Z'; };
const fakeCli = path.join(base, 'fake-cli.cjs');
fs.writeFileSync(fakeCli, `process.on('SIGTERM',()=>process.exit(0));process.stdin.on('data',()=>{});setInterval(()=>{},1000);`);
function procs() {
  const out = [];
  for (const n of fs.readdirSync('/proc')) { if (!/^\d+$/.test(n)) continue; try { out.push({ pid: Number(n), argv: fs.readFileSync(`/proc/${n}/cmdline`, 'utf8').split('\0').filter(Boolean) }); } catch { /* gone */ } }
  return out;
}
const WS = `wshung-${ARM}-${process.pid}`;
const cliPids = () => procs().filter((p) => p.argv[1] === fakeCli && p.argv[2] === WS).map((p) => p.pid);
const pidFilePid = () => { try { return JSON.parse(fs.readFileSync(kc.keeperPidFilePath(WS), 'utf8')).pid; } catch { return null; } };
async function waitFor(pred, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return true; await sleep(50); } return !!(await pred()); }

const out = { arm: ARM, ws: WS };
try {
  const h = kc.makeKeeperSpawn(WS)({ command: process.execPath, args: [fakeCli, WS], cwd: base, env: { PATH: process.env.PATH }, signal: new AbortController().signal });
  h.on('error', (e) => { out.facadeError = String(e?.message ?? e); });
  h.stdout.on('data', () => {});
  if (!(await waitFor(() => pidFilePid() && cliPids().length === 1, 15000))) throw new Error('setup: keeper+cli never came up');
  out.keeper = pidFilePid();
  out.cli = cliPids()[0];
  out.cliPpid = Number(fs.readFileSync(`/proc/${out.cli}/stat`, 'utf8').replace(/^.*\) /, '').split(' ')[1]);
  if (ARM === 'hung') process.kill(out.keeper, 'SIGSTOP');
  const t0 = Date.now();
  await kc.killKeeper(WS, 'probe');
  out.killMs = Date.now() - t0;
  await sleep(300);
  out.after = { keeperAlive: alive(out.keeper), cliAlive: alive(out.cli), cliPpidNow: (() => { try { return Number(fs.readFileSync(`/proc/${out.cli}/stat`, 'utf8').replace(/^.*\) /, '').split(' ')[1]); } catch { return null; } })(),
    sock: fs.existsSync(kc.keeperSocketPath(WS)), pidFile: fs.existsSync(kc.keeperPidFilePath(WS)) };
} catch (e) {
  out.error = String(e?.stack ?? e);
} finally {
  for (const p of cliPids()) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  if (out.keeper) { try { process.kill(out.keeper, 'SIGCONT'); process.kill(out.keeper, 'SIGKILL'); } catch { /* gone */ } }
  await sleep(200);
  out.leftovers = [out.keeper, ...cliPids()].filter((p) => p && alive(p));
}
console.log(JSON.stringify(out));
process.exit(0);
