// Issue #124 S1 — the FACADE decision: a restart never attaches to a dying CLI.
//
// keeper.test.ts proves the DAEMON reports `shuttingDown`; nothing there proves the
// CLIENT acts on it. This drives the REAL `makeKeeperSpawn` facade against a REAL keeper
// daemon (dist-electron/keeper.js) and a fake stream-json CLI — no agent-sdk, no `claude`.
//
// The fake CLI ignores stdin-EOF (so a `stdinEnd` leaves the keeper `shuttingDown` with the
// CLI still alive — the dying window, pinned open) but exits on SIGTERM (so the fixed
// facade's `killKeeper` completes fast).
//
// Arms (ONE per process):
//   facade_refuses_dying — A is live; A.stdin.end() → stdinEnd → keeper shuttingDown.
//                          POSITIVE CONTROL: probeKeeper must read shuttingDown:true first
//                          (else the window never opened and the arm proves nothing).
//                          Then a NEW facade B connects. FIXED: B refuses the dying keeper
//                          (kill + launch fresh) → B's stdin is echoed by a NEW keeper+CLI
//                          pid, old pids dead, onAttached NOT called. MUTANT (facade ignores
//                          shuttingDown): B attaches to the dying keeper → same pids,
//                          onAttached fires, no echo (keeper answers `err: shutting down`).
//   facade_attaches_live — the MIRROR: a healthy live keeper (A still attached, not
//                          shutting down) MUST still be attached, not killed — the legit
//                          relaunch-reattach case. B attaches: same keeper+CLI pid,
//                          onAttached fires, echo works. MUTANT (facade always refuses)
//                          reddens THIS arm.
//
// Rig hygiene: isolated ORCHESTRA_HOME/HOME; the keeper bundle is (re)built if stale and
// copied to $ORCHESTRA_HOME/bin/keeper.js (what installKeeper() does at app start).

import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARM = process.argv[2] ?? 'facade_refuses_dying';
const ARMS = ['facade_refuses_dying', 'facade_attaches_live'];
if (!ARMS.includes(ARM)) {
  console.error(`unknown arm: ${ARM} (expected: ${ARMS.join(', ')})`);
  process.exit(2);
}

const tmpHome = path.join(process.env.FACADE_HOME ?? '/tmp/keeper-facade-124', ARM);
fs.rmSync(tmpHome, { recursive: true, force: true });
fs.mkdirSync(path.join(tmpHome, 'bin'), { recursive: true });
process.env.ORCHESTRA_HOME = tmpHome;
process.env.HOME = tmpHome;

// The daemon bundle: rebuild when missing/stale (same rule as keeper.test.ts), then install.
const KEEPER_JS = path.join(REPO, 'dist-electron', 'keeper.js');
const srcs = ['src/keeper/index.ts', 'src/shared/keeper-protocol.ts'].map((s) => path.join(REPO, s));
if (!fs.existsSync(KEEPER_JS) || srcs.some((s) => fs.statSync(s).mtimeMs > fs.statSync(KEEPER_JS).mtimeMs)) {
  execFileSync(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.keeper.config.ts'], { cwd: REPO, stdio: 'ignore' });
}
fs.copyFileSync(KEEPER_JS, path.join(tmpHome, 'bin', 'keeper.js'));

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-keeper-facade-124',
  broadcast: () => {}, broadcastPtyData: () => {}, canBroadcast: () => true,
  isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {},
  openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => tmpHome, getLogsDir: () => `${tmpHome}/logs`,
  getAppVersion: () => '0.0.0-keeper-facade-124', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});
const kc = await import(`${REPO}/src/main/keeper-client.ts`);

const WS = `ws-facade-${ARM}`;
const FAKE_CLI = `
process.on('SIGTERM', () => process.exit(0));
process.stdin.on('data', (d) => {
  for (const line of d.toString('utf8').split('\\n')) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.echo !== undefined) process.stdout.write(JSON.stringify({ type: 'assistant', echo: m.echo, pid: process.pid }) + '\\n');
  }
});
// EOF is deliberately IGNORED: stdinEnd must leave the keeper shutting down with a LIVE CLI.
setInterval(() => {}, 1000);
`;
const fakeCli = path.join(tmpHome, 'fake-cli.cjs');
fs.writeFileSync(fakeCli, FAKE_CLI);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const keeperPid = () => {
  try { return JSON.parse(fs.readFileSync(path.join(tmpHome, 'keepers', `${WS}.pid`), 'utf8')).pid; } catch { return null; }
};
const spawnOpts = { command: process.execPath, args: [fakeCli], cwd: tmpHome, env: { PATH: process.env.PATH }, signal: new AbortController().signal };

/** Open a facade; collect stdout text, errors and whether it ATTACHED (vs spawned). */
function open(label) {
  const st = { label, out: '', errors: [], attached: false, attachedPid: undefined };
  const h = kc.makeKeeperSpawn(WS, (pid) => { st.attached = true; st.attachedPid = pid; })(spawnOpts);
  h.stdout.on('data', (d) => { st.out += d.toString('utf8'); });
  h.on('error', (e) => st.errors.push(String(e?.message ?? e)));
  st.h = h;
  return st;
}
async function waitFor(pred, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(50); }
  return pred();
}
const echoPid = (st, tag) => {
  const m = st.out.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((j) => j && j.echo === tag);
  return m ? m.pid : null;
};

const result = { arm: ARM };
let A = null, B = null;
try {
  A = open('A');
  A.h.stdin.write(JSON.stringify({ echo: 'one' }) + '\n');
  const aUp = await waitFor(() => echoPid(A, 'one') !== null, 15_000);
  const oldCli = echoPid(A, 'one');
  const oldKeeper = keeperPid();
  Object.assign(result, { aUp, oldKeeper, oldCli });
  if (!aUp || !oldKeeper || !oldCli) throw new Error('setup: A never came up');

  if (ARM === 'facade_refuses_dying') {
    A.h.stdin.end(); // graceful close → stdinEnd frame → keeper shuttingDown (CLI ignores EOF)
    await sleep(400);
    const probe = await kc.probeKeeper(WS);
    result.probeShuttingDown = probe?.shuttingDown === true;
    result.probeRunning = probe?.running === true;
    // POSITIVE CONTROL: the dying window must actually exist, or the arm proves nothing.
    if (!(result.probeShuttingDown && result.probeRunning && alive(oldCli))) throw new Error('control failed: dying window never opened');
  }

  B = open('B');
  B.h.stdin.write(JSON.stringify({ echo: 'two' }) + '\n');
  const bEcho = await waitFor(() => echoPid(B, 'two') !== null, 20_000);
  const newCli = echoPid(B, 'two');
  const newKeeper = keeperPid();
  await sleep(300);
  Object.assign(result, {
    bEcho, newKeeper, newCli, onAttached: B.attached, bErrors: B.errors.slice(0, 2),
    sameKeeper: newKeeper === oldKeeper, sameCli: newCli === oldCli,
    oldKeeperAlive: alive(oldKeeper), oldCliAlive: alive(oldCli),
  });
  if (ARM === 'facade_refuses_dying') {
    // Fresh keeper + fresh CLI served B; the dying pair is gone; B did not attach.
    result.ok = bEcho && !result.sameKeeper && !result.sameCli && !result.oldKeeperAlive && !result.oldCliAlive && !B.attached;
  } else {
    // Healthy keeper: B ATTACHED to the very same keeper+CLI and was served by it.
    result.ok = bEcho && result.sameKeeper && result.sameCli && B.attached === true && B.errors.length === 0;
  }
} catch (e) {
  result.ok = false;
  result.error = String(e?.message ?? e);
} finally {
  await kc.killKeeper(WS).catch(() => {});
  for (const pid of [result.oldKeeper, result.oldCli, result.newKeeper, result.newCli]) {
    if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  }
}
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
