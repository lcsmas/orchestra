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

// Isolated home — ORCHESTRA_HOME/userData must be ours, never the human's.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-refresh-171-'));
process.env.ORCHESTRA_HOME = tmp;

const entry = path.join(tmp, 'entry.ts');
fs.writeFileSync(
  entry,
  `
export { dispatchPromoteRequest, resolveWaveRunId, writeBusSwitchState } from ${JSON.stringify(path.join(repoRoot, 'src/main/workspaces.ts'))};
export { store } from ${JSON.stringify(path.join(repoRoot, 'src/main/store.ts'))};
export { initPlatform } from ${JSON.stringify(path.join(repoRoot, 'src/main/platform/index.ts'))};
export { initBus, getBus, closeBus } from ${JSON.stringify(path.join(repoRoot, 'src/main/bus.ts'))};
export { startRun } from ${JSON.stringify(path.join(repoRoot, 'src/main/bus-runs.ts'))};
export { registerSdkDelivery } from ${JSON.stringify(path.join(repoRoot, 'src/main/sdk-delivery.ts'))};
// The reconcile's restart wire. Stubbed via the resolve plugin below so the rig
// RECORDS calls (and controls the {ok} result) instead of driving real claude.
export { __restartCalls, __setRestartResult } from ${JSON.stringify(path.join(repoRoot, 'src/main/restart-workspace.ts'))};
`,
);

const cacheDir = path.join(repoRoot, 'node_modules', '.cache');
fs.mkdirSync(cacheDir, { recursive: true });
const bundle = path.join(cacheDir, 'promote-refresh-171.mjs');
const electronStub = path.join(cacheDir, 'promote-refresh-171-electron-stub.mjs');

// STUB for the reconcile's dynamic `import('./restart-workspace.ts')`. Records
// every dispatchRestartRequest so R1 can assert the restart WIRE fired, and lets
// the arm control the result ({ok:true} = idle restart succeeded; {ok:false} =
// working session's mid-turn guard → the mark-stale fallback). No agent-sdk, no
// node-pty — the wire is what's under test, not sdkRestart's internals (those are
// agent-sdk's own tests). Exposes __restartCalls / __setRestartResult on the same
// module the shipped code imports, so the recording is authoritative.
const restartStub = path.join(cacheDir, 'promote-refresh-171-restart-stub.mjs');
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
// A LEAD (top-level orchestrator, its own run frozen delivery=ON) so a member
// under it resolves to the LEAD run pre-promote (the ticket's spawn-under-LEAD).
const LEAD_ID = 'lead-171';
await mod.store.upsertWorkspace(ws(LEAD_ID, { canOrchestrate: true }));
mod.startRun(busDb, { id: LEAD_ID, kind: 'mission', coordinator: LEAD_ID }, {
  delivery: true, wake: true, askGate: true, liveness: true,
});
// Live switches OFF so a node's OWN freshly-frozen run names delivery=OFF — an
// authoritative flag transition vs the LEAD run's delivery=ON (not a cosmetic change).
await mod.store.setBusSwitches({ delivery: false, wake: false, askGate: false, liveness: false });

// ════════════════════════════════════════════════════════════════════════════
// R1 — arm 1 (THE ticket promise): a LIVE, IDLE promoted node is RESTARTED so its
// env re-reads the new run. This is the arm the reviewer's F1 showed was missing:
// the notice is already refreshed by startRunForPromoted, so ONLY the restart wire
// proves "the SESSION picks up the new run without a manual restart".
// ════════════════════════════════════════════════════════════════════════════
console.log('\n#171 R1 — a LIVE idle promoted node is RESTARTED (env re-reads the new run):');
const NODE_ID = 'live-node-171';
await mod.store.upsertWorkspace(ws(NODE_ID, { parentId: LEAD_ID }));
liveSet.add(NODE_ID); // a live structured session owns it
const r1Pre = mod.resolveWaveRunId(mod.store.getWorkspace(NODE_ID));
check('R1-pre: the live node resolves to the LEAD run before promote', r1Pre === LEAD_ID, `got ${r1Pre}`);
mod.__restartCalls.length = 0;
mod.__setRestartResult({ ok: true, mode: 'structured', fresh: false });
const r1 = await mod.dispatchPromoteRequest({ id: NODE_ID });
check('R1: promote ok', r1.ok === true, JSON.stringify(r1));
// THE load-bearing assertion: the reconcile invoked dispatchRestartRequest for the
// live node (so its relaunch re-reads ORCHESTRA_RUN_ID). Deleting the reconcile (or
// its restart branch) → zero restart calls → this reddens.
const r1Restart = mod.__restartCalls.find((c) => c.id === NODE_ID);
check(
  'R1: dispatchRestartRequest was INVOKED for the promoted live node (env refresh wire fired)',
  !!r1Restart,
  `restart calls: ${JSON.stringify(mod.__restartCalls)}`,
);
check(
  'R1: the restart is conversation-preserving (fresh:false, #111/#159)',
  r1Restart && r1Restart.fresh === false,
);
check('R1: promote reports the node in `restarted`', (r1.restarted ?? []).includes(NODE_ID),
  JSON.stringify(r1.restarted));
check('R1: NOT marked stale (an idle restart succeeded)', (r1.markedStale ?? []).length === 0);
const r1Post = mod.resolveWaveRunId(mod.store.getWorkspace(NODE_ID));
check(
  'R1: resolveWaveRunId(node) flipped LEAD→own (the run the relaunched env stamps)',
  r1Post === NODE_ID && r1Pre !== r1Post,
  `pre=${r1Pre} post=${r1Post}`,
);

// ════════════════════════════════════════════════════════════════════════════
// R2 — arm 2 (working session): the restart is REFUSED ({ok:false}, the mid-turn
// guard) → promote DOWNGRADES to mark-stale, never a mid-turn kill.
// ════════════════════════════════════════════════════════════════════════════
console.log('\n#171 R2 — a WORKING live node: restart refused → deferred (mark-stale), never killed:');
const WORKING_ID = 'working-node-171';
await mod.store.upsertWorkspace(ws(WORKING_ID, { parentId: LEAD_ID }));
liveSet.add(WORKING_ID);
mod.__restartCalls.length = 0;
// The working session's mid-turn guard throws → dispatchRestartRequest returns {ok:false}.
mod.__setRestartResult({ ok: false, error: 'restart failed: The agent is working — interrupt it first, then restart.' });
const r2 = await mod.dispatchPromoteRequest({ id: WORKING_ID });
check('R2: promote ok', r2.ok === true, JSON.stringify(r2));
check(
  'R2: the restart WAS attempted (the guard lives in sdkRestart, not a pre-kill) — one call',
  mod.__restartCalls.some((c) => c.id === WORKING_ID),
);
check(
  'R2: a refused restart DOWNGRADES to markedStale (not silently left on the old run)',
  (r2.markedStale ?? []).includes(WORKING_ID),
  JSON.stringify(r2),
);
check('R2: NOT reported restarted (the restart was refused)', !(r2.restarted ?? []).includes(WORKING_ID));
check(
  'R2: the stale marker file was written (CLI send-refusal armed)',
  fs.existsSync(path.join(tmp, WORKING_ID, '.orchestra', 'bus-run-stale')),
);
check(
  'R2: the working node is flagged busRunStale in the store',
  mod.store.getWorkspace(WORKING_ID).busRunStale === true,
);

// ════════════════════════════════════════════════════════════════════════════
// RD — the DESCENDANT-notice arm that catches the ws.ts:1931 newAnchorId mutation.
// Promote a live node that HAS a COLD CHILD. startRunForPromoted writes ONLY the
// promoted node's notice, so the CHILD's notice is written EXCLUSIVELY by the
// reconcile's writeBusSwitchState(ws.worktreePath, newAnchorId). Mutating that to
// oldAnchorId leaves the child naming the OLD (LEAD) run → this reddens.
// ════════════════════════════════════════════════════════════════════════════
console.log('\n#171 RD — a promoted node\'s LIVE CHILD is ALSO reconciled (restarted) so ITS env refreshes:');
// A promote re-anchors not just the node but every descendant whose nearest
// orchestrator changes (child: grandparent→promoted parent). The reconcile walks
// the whole snapshotted subtree, so a LIVE child is restarted too — its env then
// re-reads the new run. Deleting the reconcile (mutation 2) reddens this alongside R1.
const RD_LEAD = 'rd-lead-171';
const RD_PARENT = 'rd-parent-171';
const RD_CHILD = 'rd-child-171';
await mod.store.upsertWorkspace(ws(RD_LEAD, { canOrchestrate: true }));
await mod.store.upsertWorkspace(ws(RD_PARENT, { parentId: RD_LEAD })); // NOT yet orch
await mod.store.upsertWorkspace(ws(RD_CHILD, { parentId: RD_PARENT }));
liveSet.add(RD_PARENT);
liveSet.add(RD_CHILD);
mod.startRun(busDb, { id: RD_LEAD, kind: 'mission', coordinator: RD_LEAD }, {
  delivery: true, wake: true, askGate: true, liveness: true,
});
const rdChildPre = mod.resolveWaveRunId(mod.store.getWorkspace(RD_CHILD));
check('RD-pre: the live child resolves to the grandparent RD_LEAD run', rdChildPre === RD_LEAD, `got ${rdChildPre}`);
mod.__restartCalls.length = 0;
mod.__setRestartResult({ ok: true, mode: 'structured', fresh: false });
const rd = await mod.dispatchPromoteRequest({ id: RD_PARENT });
check('RD: promote ok', rd.ok === true, JSON.stringify(rd));
// BOTH the promoted parent AND the live child must be restarted (each env refreshes).
check(
  'RD: the promoted parent was restarted (its own env refresh)',
  mod.__restartCalls.some((c) => c.id === RD_PARENT) && (rd.restarted ?? []).includes(RD_PARENT),
  `restarts=${JSON.stringify(mod.__restartCalls.map((c) => c.id))}`,
);
check(
  'RD: the LIVE CHILD was ALSO restarted (its anchor moved grandparent→promoted-parent)',
  mod.__restartCalls.some((c) => c.id === RD_CHILD) && (rd.restarted ?? []).includes(RD_CHILD),
  `restarts=${JSON.stringify(mod.__restartCalls.map((c) => c.id))} restarted=${JSON.stringify(rd.restarted)}`,
);
check(
  'RD: resolveWaveRunId(child) flipped grandparent→promoted-parent (the run its relaunch stamps)',
  mod.resolveWaveRunId(mod.store.getWorkspace(RD_CHILD)) === RD_PARENT && rdChildPre !== RD_PARENT,
);

// ════════════════════════════════════════════════════════════════════════════
// A3 — unchanged invariant: a member spawned AFTER promote anchors to the promoted
// node's run natively (no reconcile) — the fix must not disturb this.
// ════════════════════════════════════════════════════════════════════════════
console.log('\n#171 A3 — a NEW member under a promoted node anchors to its run natively:');
const LATE = 'late-member-171';
await mod.store.upsertWorkspace(ws(LATE, { parentId: NODE_ID }));
check(
  'a member spawned after promote anchors to the promoted node run',
  mod.resolveWaveRunId(mod.store.getWorkspace(LATE)) === NODE_ID,
);

mod.closeBus();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
