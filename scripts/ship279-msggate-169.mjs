// ship v0.5.279 gate 3a — #169 P4: `orchestra message` fleet-coordination refusal.
//
// Drives the REAL dispatchMessageRequest (bundled from workspaces.ts with esbuild
// + an electron stub — never a re-implementation) over a REAL SQLite bus, so the
// EFFECT-SIDE gate wiring is exercised: it resolves the TARGET's frozen `delivery`
// switch via busSwitch(db, resolveWaveRunId(target), 'delivery') and calls the pure
// decideMessageChannel. The unit test proves the pure predicate; the built-bundle
// broadcast-message.test.ts proves the CLI --emergency threading; THIS proves the
// real switch-read + refusal end-to-end from the shipped source.
//
// ARMS (each names the mutation that reddens it):
//   A1  target run delivery=ON, no --emergency        → REFUSED, error names `orchestra send`
//   A2  same target, WITH --emergency                 → DELIVERS (ok:true)  [escape 1]
//   A3  target run delivery=OFF (legacy), no emergency → DELIVERS (ok:true)  [escape 2, look-alike]
//   A4  target has NO run row at all (standalone)      → DELIVERS (ok:true)  [busSwitch missing=OFF]
//
// (The broadcast --to gating and the leading-`--emergency` parse are the built
// bundle's job — broadcast-message.test.ts drives dist-electron/cli.js against a
// real socket. This rig owns the switch-read that neither of those reaches.)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEsbuild() {
  try {
    return require_('esbuild');
  } catch {
    const store =
      fs.globSync?.(repoRoot + '/node_modules/.pnpm/esbuild@*/node_modules/esbuild') ?? [];
    if (store.length) return require_(store[0]);
    throw new Error('esbuild not resolvable — run `pnpm install` first');
  }
}
const { build } = loadEsbuild();

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'msggate-169-'));
process.env.ORCHESTRA_HOME = tmp;

const entry = path.join(tmp, 'entry.ts');
fs.writeFileSync(
  entry,
  `
export { dispatchMessageRequest, dispatchBroadcastMessageRequest, resolveWaveRunId } from ${JSON.stringify(path.join(repoRoot, 'src/main/workspaces.ts'))};
export { store } from ${JSON.stringify(path.join(repoRoot, 'src/main/store.ts'))};
export { initPlatform } from ${JSON.stringify(path.join(repoRoot, 'src/main/platform/index.ts'))};
export { initBus, getBus } from ${JSON.stringify(path.join(repoRoot, 'src/main/bus.ts'))};
export { startRun } from ${JSON.stringify(path.join(repoRoot, 'src/main/bus-runs.ts'))};
export { registerSdkDelivery } from ${JSON.stringify(path.join(repoRoot, 'src/main/sdk-delivery.ts'))};
export { MESSAGE_CHANNEL_REFUSAL } from ${JSON.stringify(path.join(repoRoot, 'src/shared/message-channel-gate.ts'))};
`,
);

const cacheDir = path.join(repoRoot, 'node_modules', '.cache');
fs.mkdirSync(cacheDir, { recursive: true });
const bundle = path.join(cacheDir, 'msggate-169.mjs');
const electronStub = path.join(cacheDir, 'msggate-169-electron-stub.mjs');
const restartStub = path.join(cacheDir, 'msggate-169-restart-stub.mjs');
fs.writeFileSync(
  restartStub,
  `export const __restartCalls = [];
export async function dispatchRestartRequest(input){ __restartCalls.push({...input}); return {ok:true}; }`,
);
fs.writeFileSync(
  electronStub,
  `const noop = () => {};
class Stub { static getAllWindows() { return []; } constructor() {} on() {} }
export const app = { getPath: () => ${JSON.stringify(tmp)}, getVersion: () => '0.0.0-rig', getName: () => 'orchestra', on: noop, whenReady: () => Promise.resolve(), setPath: noop, quit: noop };
export const ipcMain = { handle: noop, on: noop, removeHandler: noop };
export const ipcRenderer = { invoke: noop, on: noop };
export const BrowserWindow = Stub; export const WebContentsView = Stub; export const BrowserView = Stub;
export const shell = { openExternal: noop, showItemInFolder: noop };
export const dialog = { showOpenDialog: noop, showMessageBox: noop };
export const Menu = { setApplicationMenu: noop, buildFromTemplate: () => ({}) };
export const MenuItem = Stub;
export const nativeTheme = { on: noop, shouldUseDarkColors: false };
export const nativeImage = { createFromPath: () => ({}) };
export const clipboard = { writeText: noop, readText: () => '' };
export const screen = { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }), on: noop };
export const session = { defaultSession: { webRequest: { onBeforeSendHeaders: noop } }, fromPartition: () => ({}) };
export const safeStorage = { isEncryptionAvailable: () => false, encryptString: noop, decryptString: noop };
export const globalShortcut = { register: noop, unregisterAll: noop };
export const powerMonitor = { on: noop };
export const Notification = Stub;
export const protocol = { handle: noop, registerSchemesAsPrivileged: noop };
export const net = { fetch: () => Promise.reject(new Error('stub')) };
export const contextBridge = { exposeInMainWorld: noop };
export default { app, ipcMain, BrowserWindow, WebContentsView, shell, dialog, Menu, screen, session };`,
);

const restartRedirect = {
  name: 'restart-redirect',
  setup(b) {
    b.onResolve({ filter: /restart-workspace\.ts$/ }, () => ({ path: restartStub }));
  },
};

await build({
  entryPoints: [entry],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['better-sqlite3', 'node-pty', 'node:*', 'simple-git', 'ws', '@anthropic-ai/*'],
  alias: { electron: electronStub },
  plugins: [restartRedirect],
  logLevel: 'silent',
});
const mod = await import(`${bundle}?t=${Date.now()}`);

mod.initPlatform({
  kind: 'rig',
  broadcast: () => {},
  broadcastPtyData: () => {},
  canBroadcast: () => false,
  isFocused: () => false,
  getUserDataDir: () => tmp,
});
fs.mkdirSync(path.join(tmp, 'orchestra'), { recursive: true });
const schema = mod.initBus();
check('bus opened', schema >= 2, 'schema v' + schema);
const busDb = mod.getBus();
check('getBus() non-null', !!busDb);

// No live sessions → a delivered send falls back to an inbox write (ok:true,
// delivery:'inbox'). That is enough: ok:true means the gate ALLOWED it, which is
// what the escape arms assert. hasSession=false everywhere.
mod.registerSdkDelivery({
  hasSession: () => false,
  send: async () => {},
  sendAwaitingStart: async () => 'started',
  start: async () => {},
  stop: async () => {},
});

function worktreeFor(id) {
  const wt = path.join(tmp, id);
  fs.mkdirSync(path.join(wt, '.orchestra'), { recursive: true });
  return wt;
}
function ws(id, over) {
  return { id, name: id, branch: id, kind: 'worktree', worktreePath: worktreeFor(id),
    repoPath: '/tmp/rig-repo', base: 'master', status: 'idle', createdAt: Date.now(), ...over };
}

const SENDER = 'sender-169';
await mod.store.upsertWorkspace(ws(SENDER));

// ── A1/A2: a target whose OWN run has delivery=ON ──
const ON_TARGET = 'on-target-169';
await mod.store.upsertWorkspace(ws(ON_TARGET, { canOrchestrate: true }));
mod.startRun(busDb, { id: ON_TARGET, kind: 'mission', coordinator: ON_TARGET }, {
  delivery: true, wake: true, askGate: true, liveness: true,
});
const onRun = mod.resolveWaveRunId(mod.store.getWorkspace(ON_TARGET));
check('A0: the ON target resolves to its own delivery=ON run', onRun === ON_TARGET, `got ${onRun}`);

console.log('\n#169 A1 — message to a delivery-ON target, NO --emergency → REFUSED:');
const a1 = await mod.dispatchMessageRequest({ from: SENDER, to: ON_TARGET, text: 'switch to bus please' });
check('A1: refused (ok:false)', a1.ok === false, JSON.stringify(a1));
check("A1: refusal NAMES `orchestra send`", (a1.error || '').includes("Use 'orchestra send' instead"),
  a1.error);
check('A1: refusal is the exported literal (not a paraphrase)', a1.error === mod.MESSAGE_CHANNEL_REFUSAL);

console.log('\n#169 A2 — SAME target, WITH --emergency → DELIVERS (escape 1):');
const a2 = await mod.dispatchMessageRequest({ from: SENDER, to: ON_TARGET, text: 'HALT bus wedged', emergency: true });
check('A2: delivered (ok:true) despite delivery=ON', a2.ok === true, JSON.stringify(a2));

// ── A3: a legacy target whose OWN run has delivery=OFF ──
console.log('\n#169 A3 — message to a delivery-OFF (legacy) target, no emergency → DELIVERS (look-alike):');
const OFF_TARGET = 'off-target-169';
await mod.store.upsertWorkspace(ws(OFF_TARGET, { canOrchestrate: true }));
mod.startRun(busDb, { id: OFF_TARGET, kind: 'mission', coordinator: OFF_TARGET }, {
  delivery: false, wake: false, askGate: false, liveness: false,
});
const offRun = mod.resolveWaveRunId(mod.store.getWorkspace(OFF_TARGET));
check('A3-pre: the OFF target resolves to its own delivery=OFF run', offRun === OFF_TARGET, `got ${offRun}`);
const a3 = await mod.dispatchMessageRequest({ from: SENDER, to: OFF_TARGET, text: 'ordinary coordination' });
check('A3: delivered (ok:true) — delivery=OFF is never refused', a3.ok === true, JSON.stringify(a3));

// ── A4: a plain standalone target with NO run row ──
console.log('\n#169 A4 — message to a standalone target with NO run row → DELIVERS (missing run = OFF):');
const NORUN_TARGET = 'norun-target-169';
await mod.store.upsertWorkspace(ws(NORUN_TARGET));
const a4 = await mod.dispatchMessageRequest({ from: SENDER, to: NORUN_TARGET, text: 'hello standalone' });
check('A4: delivered (ok:true) — a missing run row reads as delivery=OFF', a4.ok === true, JSON.stringify(a4));

// ── A5/A6: BROADCAST (--to) is gated per target through the SAME dispatch ──
console.log('\n#169 A5 — `--to` broadcast of coordination text to a delivery-ON target → REFUSED per target:');
const b5 = await mod.dispatchBroadcastMessageRequest({ from: SENDER, to: [ON_TARGET], text: 'everyone switch to bus' });
check('A5: broadcast overall ok:false (a target refused)', b5.ok === false, JSON.stringify(b5));
const b5row = (b5.results || []).find((r) => r.id === ON_TARGET) || (b5.results || [])[0];
check('A5: the delivery-ON target row is a refusal naming `orchestra send`',
  !!b5row && b5row.ok === false && (b5row.error || '').includes("Use 'orchestra send' instead"),
  JSON.stringify(b5.results));

console.log('\n#169 A6 — `--emergency --to` broadcast → DELIVERS per target (the #86 group-stop escape):');
const b6 = await mod.dispatchBroadcastMessageRequest({ from: SENDER, to: [ON_TARGET], text: 'HALT ALL', emergency: true });
check('A6: broadcast overall ok:true with --emergency', b6.ok === true, JSON.stringify(b6));
const b6row = (b6.results || [])[0];
check('A6: the delivery-ON target row delivered (emergency bypass reached the wire)',
  !!b6row && b6row.ok === true, JSON.stringify(b6.results));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
