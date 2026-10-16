// #379 / ADR 0008 — the session key is registered at a FRESH keeper spawn and NEVER on an attach.
//
// Drives the REAL `makeKeeperSpawn` facade (src/main/keeper-client.ts) against a REAL keeper daemon (dist-electron/keeper.js) and a
// fake stream-json CLI that reports the sha256 of the ORCHESTRA_SESSION_KEY it was handed (never the key). The registry is the REAL
// one (src/main/session-identity.ts) over a scratch file. What the unit tests cannot prove: that the hook runs before the CLI exists,
// exactly once per fresh CLI, and that a facade ATTACHING to a live keeper leaves the live CLI's key the live one.
//
// Arms (ONE per process):
//   key_registered_before_cli — fresh start: hook runs ONCE, BEFORE the CLI's first byte; the CLI's key hash == the registry's;
//                               verify(live key)=ok. MUTANT (facade never calls the hook): calls=0 → red.
//   key_attach_keeps          — B attaches to A's live keeper+CLI with its OWN new key: hook NOT called, registry still vouches for A's
//                               key (B's is 'superseded'), the CLI is the same pid with A's key hash. MUTANT (hook also on attach): red.
//   key_replaced_on_fresh     — A's CLI dies (stdinEnd), B starts fresh: hook ran for B, A's key is now 'superseded', B's is 'ok'.
//   key_register_failure      — the hook THROWS: the start fails loudly (facade 'error'), NO CLI ever runs (no echo, no CLI pid).
//
// Rig hygiene: isolated ORCHESTRA_HOME/HOME under $TMPDIR; the keeper bundle is (re)built if stale and copied to $ORCHESTRA_HOME/bin/keeper.js.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARM = process.argv[2] ?? 'key_registered_before_cli';
const ARMS = ['key_registered_before_cli', 'key_attach_keeps', 'key_replaced_on_fresh', 'key_register_failure'];
if (!ARMS.includes(ARM)) {
  console.error(`unknown arm: ${ARM} (expected: ${ARMS.join(', ')})`);
  process.exit(2);
}

const tmpHome = path.join(process.env.KEYKEY_HOME ?? path.join(process.env.TMPDIR || os.tmpdir(), 'keeper-session-key-379'), ARM);
fs.rmSync(tmpHome, { recursive: true, force: true });
fs.mkdirSync(path.join(tmpHome, 'bin'), { recursive: true });
process.env.ORCHESTRA_HOME = tmpHome;
process.env.HOME = tmpHome;

const KEEPER_JS = path.join(REPO, 'dist-electron', 'keeper.js');
const srcs = ['src/keeper/index.ts', 'src/shared/keeper-protocol.ts'].map((s) => path.join(REPO, s));
if (!fs.existsSync(KEEPER_JS) || srcs.some((s) => fs.statSync(s).mtimeMs > fs.statSync(KEEPER_JS).mtimeMs)) {
  execFileSync(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.keeper.config.ts'], { cwd: REPO, stdio: 'ignore' });
}
fs.copyFileSync(KEEPER_JS, path.join(tmpHome, 'bin', 'keeper.js'));

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-keeper-session-key-379',
  broadcast: () => {}, broadcastPtyData: () => {}, canBroadcast: () => true,
  isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {},
  openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => tmpHome, getLogsDir: () => `${tmpHome}/logs`,
  getAppVersion: () => '0.0.0-keeper-session-key-379', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});
const kc = await import(`${REPO}/src/main/keeper-client.ts`);
const si = await import(`${REPO}/src/main/session-identity.ts`);
const registry = si.createSessionKeyRegistry(path.join(tmpHome, 'session-keys.json'));

const WS = `ws-key-${ARM}`;
const sha = (k) => crypto.createHash('sha256').update(k, 'utf8').digest('hex');
const FAKE_CLI = `
const crypto = require('node:crypto');
const startedAt = Date.now();
const keyHash = crypto.createHash('sha256').update(process.env.ORCHESTRA_SESSION_KEY || '', 'utf8').digest('hex');
process.on('SIGTERM', () => process.exit(0));
process.stdin.on('data', (d) => {
  for (const line of d.toString('utf8').split('\\n')) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.echo !== undefined) process.stdout.write(JSON.stringify({ type: 'assistant', echo: m.echo, pid: process.pid, keyHash, startedAt }) + '\\n');
  }
});
setInterval(() => {}, 1000); // EOF ignored: stdinEnd leaves a LIVE CLI under a shutting-down keeper (the dying window)
`;
const fakeCli = path.join(tmpHome, 'fake-cli.cjs');
fs.writeFileSync(fakeCli, FAKE_CLI);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const keeperPid = () => {
  try { return JSON.parse(fs.readFileSync(path.join(tmpHome, 'keepers', `${WS}.pid`), 'utf8')).pid; } catch { return null; }
};

/** A facade whose spawn env carries `key` and whose before-fresh-spawn hook registers it (counting calls). */
function open(label, key, hook) {
  const st = { label, key, out: '', errors: [], attached: false, hookCalls: 0, hookAt: null };
  const spawnOpts = { command: process.execPath, args: [fakeCli], cwd: tmpHome, env: { PATH: process.env.PATH, ORCHESTRA_SESSION_KEY: key }, signal: new AbortController().signal };
  const h = kc.makeKeeperSpawn(
    WS,
    () => { st.attached = true; },
    undefined,
    undefined,
    () => { st.hookCalls++; st.hookAt = Date.now(); (hook ?? (() => registry.register(WS, key)))(); },
  )(spawnOpts);
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
const echoOf = (st, tag) => st.out.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((j) => j && j.echo === tag) ?? null;

const K1 = si.mintSessionKey();
const K2 = si.mintSessionKey();
const result = { arm: ARM };
let A = null, B = null;
try {
  if (ARM === 'key_register_failure') {
    A = open('A', K1, () => { throw new Error('registry write failed (rig)'); });
    A.h.stdin.write(JSON.stringify({ echo: 'one' }) + '\n');
    await waitFor(() => A.errors.length > 0, 20_000);
    await sleep(500);
    result.hookCalls = A.hookCalls;
    result.errors = A.errors.slice(0, 1);
    result.cliEchoed = echoOf(A, 'one') !== null;
    result.registryHolds = registry.has(WS);
    result.ok = A.hookCalls === 1 && A.errors.some((e) => /registry write failed/.test(e)) && !result.cliEchoed && !result.registryHolds;
  } else {
    A = open('A', K1);
    A.h.stdin.write(JSON.stringify({ echo: 'one' }) + '\n');
    const aUp = await waitFor(() => echoOf(A, 'one') !== null, 20_000);
    const a = echoOf(A, 'one');
    if (!aUp || !a) throw new Error('setup: A never came up');
    result.aHookCalls = A.hookCalls;
    result.aHookBeforeCli = A.hookAt !== null && A.hookAt <= a.startedAt;
    result.aCliKeyIsRegistered = a.keyHash === sha(K1) && registry.verify(WS, K1) === 'ok';

    if (ARM === 'key_registered_before_cli') {
      result.ok = A.hookCalls === 1 && result.aHookBeforeCli && result.aCliKeyIsRegistered && !A.attached;
    } else if (ARM === 'key_attach_keeps') {
      B = open('B', K2); // attaches to the live keeper+CLI; its own key K2 must NOT become the live one
      B.h.stdin.write(JSON.stringify({ echo: 'two' }) + '\n');
      const bUp = await waitFor(() => echoOf(B, 'two') !== null, 20_000);
      const b = echoOf(B, 'two');
      await sleep(200);
      Object.assign(result, {
        bUp, onAttached: B.attached, bHookCalls: B.hookCalls, samePid: !!b && b.pid === a.pid, cliStillHasK1: !!b && b.keyHash === sha(K1),
        registryVouchesK1: registry.verify(WS, K1) === 'ok', k2Refused: registry.verify(WS, K2) === 'superseded',
      });
      result.ok = result.aHookCalls === 1 && result.aCliKeyIsRegistered && bUp && B.attached === true && B.hookCalls === 0 && result.samePid && result.cliStillHasK1 && result.registryVouchesK1 && result.k2Refused;
    } else {
      // key_replaced_on_fresh: A closes (CLI ignores EOF → keeper shuttingDown), B must start FRESH and take over the key.
      A.h.stdin.end();
      await sleep(400);
      B = open('B', K2);
      B.h.stdin.write(JSON.stringify({ echo: 'two' }) + '\n');
      const bUp = await waitFor(() => echoOf(B, 'two') !== null, 25_000);
      const b = echoOf(B, 'two');
      await sleep(200);
      Object.assign(result, {
        bUp, onAttached: B.attached, bHookCalls: B.hookCalls, newPid: !!b && b.pid !== a.pid,
        bCliKeyIsRegistered: !!b && b.keyHash === sha(K2) && registry.verify(WS, K2) === 'ok', k1Superseded: registry.verify(WS, K1) === 'superseded',
      });
      result.ok = result.aCliKeyIsRegistered && bUp && !B.attached && B.hookCalls === 1 && result.newPid && result.bCliKeyIsRegistered && result.k1Superseded;
    }
  }
} catch (e) {
  result.ok = false;
  result.error = String(e?.message ?? e);
} finally {
  await kc.killKeeper(WS).catch(() => {});
  const pids = [keeperPid()];
  for (const st of [A, B]) {
    const m = st ? [...st.out.matchAll(/"pid":(\d+)/g)].map((x) => Number(x[1])) : [];
    pids.push(...m);
  }
  for (const pid of pids) if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
