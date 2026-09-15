// #142 G5 — re-parenting a RUNNING workspace re-derives its run id, so its
// `.orchestra/bus-switches` notice must name the NEW run's FROZEN flags.
//
// THE CLAIM (ledger #135 D1a-bis / D3): a member re-parented under a second OPS
// whose run froze a DIFFERENT flag must, after the op, have a notice that names
// the NEW run's flags — and its next `send` (which reads $ORCHESTRA_RUN_ID,
// rebuilt at restart from resolveWaveRunId) lands in the NEW run.
//
// This rig proves the NOTICE half against the REAL `writeBusSwitchState` from
// workspaces.ts (bundled with esbuild + an electron stub, never a re-implementation)
// over a REAL SQLite bus with two run rows frozen at DIFFERENT flags. It drives the
// exact sequence the re-parent reconcile performs: baseline notice for the OLD run,
// then re-derive → write the notice for the NEW run.
//
// ARMS (each with its must-FAIL):
//   G5.1 baseline — notice for the OLD run (delivery=OFF) names delivery=OFF.
//   G5.2 re-parent — notice re-written for the NEW run (delivery=ON) now names
//        delivery=ON and NOT =OFF. must-FAIL (G5.mf): writing the notice for the
//        OLD run again still names delivery=OFF — proving the arm can tell the
//        two runs apart (a rig that always read one run would pass G5.2 vacuously).
//   G5.3 the two notices DIFFER on delivery — the re-derive actually changed the
//        frozen flag the agent reads (carry-forward 2/3: assert the transition,
//        with the OLD run as the same-command positive control).
//
// The wake half (the reader is woken to `check --run <newRun>`) and the send
// half (a `send` lands in the new run) are the packaged drive VERIFY-G owns; the
// pure run-derive (nearestOrchestratorId) is wave-run-id.test.ts and the restart
// env rebuild is the source-binding test.

import { execFileSync } from 'node:child_process';
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reparent-notice-142-'));
process.env.ORCHESTRA_HOME = tmp;

const entry = path.join(tmp, 'entry.ts');
fs.writeFileSync(
  entry,
  `
export { writeBusSwitchState } from ${JSON.stringify(path.join(repoRoot, 'src/main/workspaces.ts'))};
export { store } from ${JSON.stringify(path.join(repoRoot, 'src/main/store.ts'))};
export { initPlatform } from ${JSON.stringify(path.join(repoRoot, 'src/main/platform/index.ts'))};
export { initBus, getBus, closeBus } from ${JSON.stringify(path.join(repoRoot, 'src/main/bus.ts'))};
export { startRun } from ${JSON.stringify(path.join(repoRoot, 'src/main/bus-runs.ts'))};
`,
);

const cacheDir = path.join(repoRoot, 'node_modules', '.cache');
fs.mkdirSync(cacheDir, { recursive: true });
const bundle = path.join(cacheDir, 'reparent-notice-142.mjs');
const electronStub = path.join(cacheDir, 'reparent-notice-142-electron-stub.mjs');
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

await build({
  entryPoints: [entry],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['better-sqlite3', 'node-pty', 'node:*', 'simple-git', 'ws', '@anthropic-ai/*'],
  alias: { electron: electronStub },
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
// Prove isolation rather than assume it.
const storeFile = path.join(tmp, 'orchestra', 'store.json');
fs.mkdirSync(path.dirname(storeFile), { recursive: true });

const schema = mod.initBus();
check('the bus opened for the reparent-notice rig', schema >= 2, 'schema v' + schema);
const busDb = mod.getBus();
check('getBus() is non-null after initBus()', !!busDb);

const worktree = path.join(tmp, 'worktree');
fs.mkdirSync(path.join(worktree, '.orchestra'), { recursive: true });
const noticeFile = path.join(worktree, '.orchestra', 'bus-switches');

/** Freeze a run at `sw`, then write the notice FOR THAT RUN and return the file. */
async function seedRunAndWriteNotice(runId, sw) {
  await mod.store.setBusSwitches(sw);
  // startRun is INSERT-OR-IGNORE — the first call for a runId freezes `sw`.
  mod.startRun(busDb, { id: runId, kind: 'vague', coordinator: 'ops-rig' }, sw);
  await mod.writeBusSwitchState(worktree, runId);
  return fs.readFileSync(noticeFile, 'utf8');
}

/** Re-derive: write the notice for an ALREADY-FROZEN run (no re-freeze) — the
 *  exact call the re-parent reconcile makes for the NEW anchor. */
async function writeNoticeForRun(runId) {
  await mod.writeBusSwitchState(worktree, runId);
  return fs.readFileSync(noticeFile, 'utf8');
}

const OLD_RUN = 'ops-old-run';
const NEW_RUN = 'ops-new-run';

// Seed BOTH runs, frozen at OPPOSITE delivery flags. The member starts under the
// OLD OPS (delivery OFF); a re-parent moves it under the NEW OPS (delivery ON).
console.log('\n#142 G5.1 — baseline: member under the OLD run (delivery OFF):');
const oldNotice = await seedRunAndWriteNotice(OLD_RUN, {
  delivery: false,
  wake: false,
  askGate: false,
  liveness: false,
});
check('OLD notice names delivery=OFF', oldNotice.includes('bus switch delivery=OFF'));
check('OLD notice does NOT name delivery=ON', !oldNotice.includes('bus switch delivery=ON'));

// Freeze the NEW run at delivery ON (a genuinely different frozen flag).
await mod.store.setBusSwitches({ delivery: true, wake: false, askGate: false, liveness: false });
mod.startRun(busDb, { id: NEW_RUN, kind: 'vague', coordinator: 'ops-new' }, {
  delivery: true,
  wake: false,
  askGate: false,
  liveness: false,
});

console.log('\n#142 G5.2 — re-parent: notice re-written for the NEW run (delivery ON):');
const newNotice = await writeNoticeForRun(NEW_RUN);
check('NEW notice names delivery=ON', newNotice.includes('bus switch delivery=ON'));
check('NEW notice does NOT name delivery=OFF', !newNotice.includes('bus switch delivery=OFF'));
check(
  'NEW notice says the bus is AUTHORITATIVE for delivery',
  /delivery=ON — the bus is AUTHORITATIVE/.test(newNotice),
);

console.log('\n#142 G5.3 — the transition: the two notices DIFFER on delivery:');
check(
  'the re-parent changed the frozen delivery flag the agent reads',
  oldNotice.includes('bus switch delivery=OFF') && newNotice.includes('bus switch delivery=ON'),
  'a re-parent that left the notice on the OLD run would show the same flag both times',
);

// ── THE MUST-FAIL CONTROL (G5.mf) ────────────────────────────────────────────
// Re-derive back to the OLD run: the notice must return to delivery=OFF. This is
// the same-command positive control that proves G5.2 is a real MEASUREMENT — the
// rig can tell the two runs apart, so "names delivery=ON" was not a constant.
console.log('\n#142 G5.mf — MUST-FAIL control: writing for the OLD run again names OFF:');
const backToOld = await writeNoticeForRun(OLD_RUN);
check(
  'writing the notice for the OLD run again names delivery=OFF (not ON)',
  backToOld.includes('bus switch delivery=OFF') && !backToOld.includes('bus switch delivery=ON'),
  'if this still said ON, the rig would be reading one fixed run and G5.2 would be vacuous',
);

// The greps are LIVE (carry-forward 4): they matched OFF on the OLD run and ON on
// the NEW run in this same run of the rig.
check(
  'the same delivery greps discriminate ON vs OFF in one execution',
  newNotice.includes('bus switch delivery=ON') && backToOld.includes('bus switch delivery=OFF'),
);

mod.closeBus();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
