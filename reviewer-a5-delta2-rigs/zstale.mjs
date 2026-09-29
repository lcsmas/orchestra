// #171 — `orchestra promote` must refresh the promoted node's run env.
//
// THE BUG (ticket #171, 4× measured — one per wave since #134): `orchestra spawn`
// stamps the child env with the anchor run at SPAWN time (the PARENT's run);
// `orchestra promote` then flips the node into an orchestrator (its OWN run) but
// NEVER re-derives/refreshes the live session. So the running session keeps the
// PARENT's ORCHESTRA_RUN_ID until a manual `orchestra restart` — the standing
// remedy the ticket exists to remove.
//
// Both env builders (buildSdkEnv in agent-sdk.ts AND startAgentPty extraEnv in
// workspaces.ts) stamp `ORCHESTRA_RUN_ID = resolveWaveRunId(ws)` at launch, so
// what a RELAUNCHED session's /proc env carries IS `resolveWaveRunId` against the
// post-promote store. The ticket's arm 1 is: a LIVE promoted session's env reads
// the NEW run WITHOUT a manual restart — i.e. promote must RESTART the live idle
// session so it re-runs its env builder. This rig drives the REAL
// `dispatchPromoteRequest` (bundled from workspaces.ts with esbuild + an electron
// stub, never a re-implementation) over a REAL SQLite bus, with a fake live SDK
// session (registerSdkDelivery) and a STUBBED `./restart-workspace.ts` (esbuild
// resolve plugin) that RECORDS every dispatchRestartRequest — so the reconcile's
// restart WIRE is observable without a real claude process.
//
// ARMS (each names the mutation that reddens it):
//   R1 (arm 1 — THE ticket promise) — a LIVE, IDLE promoted node: promote must
//        invoke dispatchRestartRequest for it (conversation-preserving) so its env
//        re-reads ORCHESTRA_RUN_ID, and report it in `restarted`. resolveWaveRunId
//        flips parent→own (the value the relaunch stamps). MUTATION: deleting the
//        reconcile call (or its restart branch) → NO restart recorded → R1 reddens.
//        This is the arm the reviewer's F1 showed the old rig lacked: the notice
//        was already refreshed by startRunForPromoted, so a notice-only assertion
//        could not attribute the refresh to the reconcile.
//   R2 (arm 2 — working session deferred, never a mid-turn kill) — the SAME live
//        node but the stubbed restart returns {ok:false} (a working session's
//        mid-turn guard): promote must DOWNGRADE to markedStale (marker + flag),
//        NOT report `restarted`, and NEVER a second/forced teardown. MUTATION:
//        dropping the {ok:false}→mark-stale fallback → node neither restarted nor
//        stale → R2 reddens.
//   RD (descendant refresh) — promote a live node that HAS a LIVE CHILD. The child's
//        nearest orchestrator moves grandparent→promoted-parent, so the reconcile
//        restarts the CHILD too — its env then re-reads the new run. Asserts both the
//        parent AND the child are in `restarted`. MUTATION 2 (restart wire removed)
//        reddens this alongside R1. (NB: the notice-write at ws.ts:1931 is flag-only
//        and, for the promote path, converges with the D1b mission re-freeze — so it
//        is NOT independently flag-observable here; the RESTART is the load-bearing
//        arm-1 clause, and that is what RD/R1 pin. See the nomination's F1 answer.)
//   A3 (unchanged invariant) — a member spawned AFTER promote anchors to the
//        promoted node's run natively (no reconcile) — resolveWaveRunId only.
//
// The live /proc env of a REAL claude process is the packaged drive's domain; here
// the restart-invocation + the run-derive it feeds are the observable, exactly as
// the sibling #142 verify-reparent-run-notice.mjs splits notice(rig) vs send(packaged).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const repoRoot = process.env.REPO;

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

// Isolated home — ORCHESTRA_HOME/userData must be ours, never the human's.
const tmp = fs.mkdtempSync(path.join(os.homedir(), '.orchestra-zprobe-'));
process.env.ORCHESTRA_HOME = tmp;
process.env.ORCHESTRA_RUN_ID = 'HOSTFB-sentinel';

const entry = path.join(tmp, 'entry.ts');
fs.writeFileSync(
  entry,
  `
export { dispatchPromoteRequest, dispatchMessageRequest, dispatchResolveHandleRequest, resolveWaveRunId, writeBusSwitchState } from ${JSON.stringify(path.join(repoRoot, 'src/main/workspaces.ts'))};
export { store } from ${JSON.stringify(path.join(repoRoot, 'src/main/store.ts'))};
export { initPlatform } from ${JSON.stringify(path.join(repoRoot, 'src/main/platform/index.ts'))};
export { initBus, getBus, closeBus } from ${JSON.stringify(path.join(repoRoot, 'src/main/bus.ts'))};
export { startRun, getRun, busSwitch } from ${JSON.stringify(path.join(repoRoot, 'src/main/bus-runs.ts'))};
export { sweepBusWake, busWakeCounters, setWakeRoster, setWakeDeliver, setWakeSwitchReader, setAskGateSwitchReader, __setBusReaderForTests, __resetBusWakeForTests, __armStartedForTests } from ${JSON.stringify(path.join(repoRoot, 'src/main/bus-wake.ts'))};
export { registerSdkDelivery } from ${JSON.stringify(path.join(repoRoot, 'src/main/sdk-delivery.ts'))};
// The reconcile's restart wire. Stubbed via the resolve plugin below so the rig
// RECORDS calls (and controls the {ok} result) instead of driving real claude.
export { __restartCalls, __setRestartResult } from ${JSON.stringify(path.join(repoRoot, 'src/main/restart-workspace.ts'))};
`,
);

const cacheDir = path.join(repoRoot, 'node_modules', '.cache');
fs.mkdirSync(cacheDir, { recursive: true });
const bundle = path.join(cacheDir, 'zprobe.mjs');
const electronStub = path.join(cacheDir, 'zprobe-electron-stub.mjs');

// STUB for the reconcile's dynamic `import('./restart-workspace.ts')`. Records
// every dispatchRestartRequest so R1 can assert the restart WIRE fired, and lets
// the arm control the result ({ok:true} = idle restart succeeded; {ok:false} =
// working session's mid-turn guard → the mark-stale fallback). No agent-sdk, no
// node-pty — the wire is what's under test, not sdkRestart's internals (those are
// agent-sdk's own tests). Exposes __restartCalls / __setRestartResult on the same
// module the shipped code imports, so the recording is authoritative.
const restartStub = path.join(cacheDir, 'zprobe-restart-stub.mjs');
fs.writeFileSync(
  restartStub,
  `
export const __restartCalls = [];
let __result = { ok: true, mode: 'structured', fresh: false };
export function __setRestartResult(r) { __result = r; }
export async function dispatchRestartRequest(input) {
  __restartCalls.push({ ...input });
  return { ...__result };
}
`,
);
fs.writeFileSync(
  electronStub,
  `
const noop = () => {};
class Stub { static getAllWindows() { return []; } constructor() {} on() {} }
export const app = { getPath: () => ${JSON.stringify(tmp)}, getVersion: () => '0.0.0-rig', getName: () => 'orchestra', on: noop, whenReady: () => Promise.resolve(), setPath: noop, quit: noop };
export const ipcMain = { handle: noop, on: noop, removeHandler: noop };
export const ipcRenderer = { invoke: noop, on: noop };
export const BrowserWindow = Stub;
export const WebContentsView = Stub;
export const BrowserView = Stub;
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
export default { app, ipcMain, BrowserWindow, WebContentsView, shell, dialog, Menu, screen, session };
`,
);

// Redirect EVERY resolution of `restart-workspace.ts` (the static entry re-export
// AND the reconcile's dynamic `import('./restart-workspace.ts')`) to the stub, so
// the restart wire is observable and agent-sdk/node-pty never enter the bundle.
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
const storeFile = path.join(tmp, 'orchestra', 'store.json');
fs.mkdirSync(path.dirname(storeFile), { recursive: true });

const schema = mod.initBus();
check('the bus opened for the promote-refresh rig', schema >= 2, 'schema v' + schema);
const busDb = mod.getBus();
check('getBus() is non-null after initBus()', !!busDb);

// ── A fake live SDK session, so the reconcile takes the LIVE (restart) branch ──
// `sdkSessionLive(id)` reads this via the registered delivery. A node in `liveSet`
// is a live STRUCTURED session (isRunning — the PTY probe — stays false, so the
// live surface is structured, i.e. the sdkRestart mid-turn-guard surface).
const liveSet = new Set();
mod.registerSdkDelivery({
  hasSession: (id) => liveSet.has(id),
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
/** A minimal-but-valid Workspace record for the rig. */
function ws(id, over) {
  return {
    id,
    name: id,
    branch: id,
    kind: 'worktree',
    worktreePath: over?.worktreePath ?? worktreeFor(id),
    repoPath: '/tmp/rig-repo',
    base: 'master',
    status: 'idle',
    createdAt: Date.now(),
    ...over,
  };
}


const CLI = process.env.CLI;
import { spawnSync } from 'node:child_process';
let TI = 0;
const id = (c) => `${c.repeat(8)}-000${TI}-4000-8000-${c.repeat(12)}`;
const ON = { delivery: true, wake: true, askGate: false, liveness: false };
const TOPOS = {
  newPlainLead: { nodes: [['a', {}], ['b', { parentId: 'a', canOrchestrate: true }], ['c', { parentId: 'a' }], ['d', { parentId: 'b' }], ['e', {}]], runs: [['a', 'mission', null], ['b', 'vague', 'a']] },
  oldPlainLead: { nodes: [['a', {}], ['b', { parentId: 'a', canOrchestrate: true }], ['c', { parentId: 'a' }], ['d', { parentId: 'b' }], ['e', {}]], runs: [['b', 'mission', null]] },
  orchLead:     { nodes: [['a', { canOrchestrate: true }], ['b', { parentId: 'a', canOrchestrate: true }], ['c', { parentId: 'a' }], ['d', { parentId: 'b' }], ['e', {}]], runs: [['a', 'mission', null], ['b', 'vague', 'a']] },
  legacyOrchLead: { nodes: [['a', { canOrchestrate: true }], ['b', { parentId: 'a', canOrchestrate: true }], ['c', { parentId: 'a' }], ['d', { parentId: 'b' }], ['e', {}]], runs: [['b', 'vague', 'a']] },
};

const out = [];
TI++;
const T = TOPOS.newPlainLead;
const recs = [];
for (const [c, over] of T.nodes) { const rec = ws(id(c), { ...over, parentId: over.parentId ? id(over.parentId) : undefined }); recs.push(rec); await mod.store.upsertWorkspace(rec); }
for (const [c, kind, parent] of T.runs) mod.startRun(busDb, { id: id(c), kind, coordinator: id(c), parentRunId: parent ? id(parent) : null }, ON);
const dir = path.join(tmp, 'userData', 'orchestra'); fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ workspaces: recs.map((r) => ({ id: r.id, name: r.name, kind: r.kind, parentId: r.parentId, canOrchestrate: r.canOrchestrate })) }));
const OPS = recs.find((r) => r.id.startsWith('bb')), LEAD = recs.find((r) => r.id.startsWith('aa'));
async function trial(label, marker) {
  const wt = path.join(tmp, 'wt', OPS.id + label); fs.mkdirSync(path.join(wt, '.orchestra'), { recursive: true });
  if (marker) fs.writeFileSync(path.join(wt, '.orchestra', 'bus-run-stale'), 'stale run: this workspace was promoted; restart it to pick up the new run\n');
  const m = await mod.dispatchMessageRequest({ from: OPS.id, to: LEAD.id, text: 'stale-window ' + label });
  const env = { PATH: process.env.PATH, HOME: tmp, ORCHESTRA_HOME: tmp, ORCHESTRA_WS_ID: OPS.id, ORCHESTRA_RUN_ID: OPS.id, ORCHESTRA_WORKSPACE_PATH: wt };
  const sr = spawnSync(process.execPath, [CLI, 'send', '--type', 'status', '--to', LEAD.id, 'x ' + label], { env, cwd: wt, encoding: 'utf8' });
  const em = await mod.dispatchMessageRequest({ from: OPS.id, to: LEAD.id, text: 'emerg ' + label, emergency: true });
  console.log(`STALE-WINDOW ${label}: OPS->LEAD message ok=${m.ok} ${m.ok ? '' : String(m.error).slice(0, 50)} | send rc=${sr.status} ${String(sr.stderr).slice(0, 90).replace(/\n/g, ' ')} | message --emergency ok=${em.ok}`);
}
await trial('no-marker', false);
await trial('stale-marker', true);
await new Promise((r) => setTimeout(r, 300));
mod.closeBus();
fs.rmSync(tmp, { recursive: true, force: true });
