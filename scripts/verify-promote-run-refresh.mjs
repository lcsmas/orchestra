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
// what the SESSION's /proc env would carry after a relaunch IS `resolveWaveRunId`
// evaluated against the post-promote store, and what the FROZEN switch notice
// names is `writeBusSwitchState(worktree, thatRun)`. This rig drives the REAL
// `dispatchPromoteRequest` (bundled from workspaces.ts with esbuild + an electron
// stub, never a re-implementation) over a REAL SQLite bus, and asserts:
//
//   A1 (arm 1, the fix) — after promote, resolveWaveRunId(member) === the member's
//        OWN id (not the parent OPS run), AND its `.orchestra/bus-switches` notice
//        is rewritten to name the member's OWN run. This is exactly the run id the
//        relaunched session's env would stamp — the refresh the manual restart used
//        to supply, now automatic.
//   A1-pre — BEFORE promote, resolveWaveRunId(member) === the parent OPS run and the
//        notice names the OPS run (the same-command baseline that proves A1 is a
//        real transition, not a constant).
//   MUT (must-FAIL / mutation) — the UNFIXED promote (flip canOrchestrate + start
//        the run row, but SKIP the reconcile — the pre-#171 body) leaves the notice
//        naming the PARENT OPS run: arm 1 FAILS through this same rig. This proves
//        the reconcile wire is load-bearing and A1 is non-vacuous across the fix
//        boundary.
//   A3 (unchanged) — a member spawned AFTER the promote resolves to the promoted
//        OPS's own run natively (no reconcile needed) — the "members anchor to the
//        OPS run" invariant the fix must not disturb.
//
// The "the LIVE session is actually restarted / a working session is deferred"
// halves are the source-binding gate (reparent-run-binding.test.ts, the #171 arms)
// + the packaged drive; a cold member here takes the notice-only reconcile branch,
// so this rig proves the RUN-DERIVE + NOTICE the env reads, with a real mutation.

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
`,
);

const cacheDir = path.join(repoRoot, 'node_modules', '.cache');
fs.mkdirSync(cacheDir, { recursive: true });
const bundle = path.join(cacheDir, 'promote-refresh-171.mjs');
const electronStub = path.join(cacheDir, 'promote-refresh-171-electron-stub.mjs');
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
const storeFile = path.join(tmp, 'orchestra', 'store.json');
fs.mkdirSync(path.dirname(storeFile), { recursive: true });

const schema = mod.initBus();
check('the bus opened for the promote-refresh rig', schema >= 2, 'schema v' + schema);
const busDb = mod.getBus();
check('getBus() is non-null after initBus()', !!busDb);

// ── Seed: an OPS parent (its own run frozen) + a cold MEMBER child under it ───
const OPS_ID = 'ops-parent-171';
const MEMBER_ID = 'member-child-171';

function worktreeFor(id) {
  const wt = path.join(tmp, id);
  fs.mkdirSync(path.join(wt, '.orchestra'), { recursive: true });
  return wt;
}
const opsWt = worktreeFor(OPS_ID);
const memberWt = worktreeFor(MEMBER_ID);

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

// The OPS is a promoted worktree (canOrchestrate) → its own run anchor.
await mod.store.upsertWorkspace(ws(OPS_ID, { worktreePath: opsWt, canOrchestrate: true }));
// The MEMBER is a plain worktree parented under the OPS → resolves to the OPS run.
await mod.store.upsertWorkspace(ws(MEMBER_ID, { worktreePath: memberWt, parentId: OPS_ID }));

// Freeze the OPS run row so its notice/flags exist (delivery ON, like a live wave).
mod.startRun(busDb, { id: OPS_ID, kind: 'mission', coordinator: OPS_ID }, {
  delivery: true,
  wake: true,
  askGate: true,
  liveness: true,
});

const memberNoticeFile = path.join(memberWt, '.orchestra', 'bus-switches');
const readMemberNotice = () =>
  fs.existsSync(memberNoticeFile) ? fs.readFileSync(memberNoticeFile, 'utf8') : '';

// ── A1-pre — baseline: BEFORE promote the member belongs to the OPS run ───────
console.log('\n#171 A1-pre — BEFORE promote: the member resolves to the PARENT OPS run:');
const preRun = mod.resolveWaveRunId(mod.store.getWorkspace(MEMBER_ID));
check('resolveWaveRunId(member) === the OPS run before promote', preRun === OPS_ID, `got ${preRun}`);
// Write the member's notice for its pre-promote run (what spawn-time stamped).
await mod.writeBusSwitchState(memberWt, preRun);
const preNotice = readMemberNotice();
check('the pre-promote member notice exists', preNotice.length > 0);
// The OPS run was frozen delivery=ON, so the pre-promote member notice (naming the
// OPS run) names delivery=ON — the authoritative discriminator below.
check(
  'the pre-promote notice names delivery=ON (the OPS run it belongs to)',
  preNotice.includes('bus switch delivery=ON'),
);
// Set the LIVE switches to delivery=OFF so the member's OWN run — frozen by the
// promote's startRunForPromoted at CURRENT live switches — names delivery=OFF. A
// genuinely different frozen flag makes the post-notice transition unambiguous
// (not a cosmetic rewrite of the same flags).
await mod.store.setBusSwitches({ delivery: false, wake: false, askGate: false, liveness: false });

// ── Promote the member (the SHIPPED dispatchPromoteRequest) ───────────────────
console.log('\n#171 promote — dispatchPromoteRequest({ id: member }):');
const res = await mod.dispatchPromoteRequest({ id: MEMBER_ID });
check('promote returned ok', res.ok === true, JSON.stringify(res));
check(
  'promote reports NO stale/restart for a COLD member (notice-only reconcile branch)',
  (res.restarted ?? []).length === 0 && (res.markedStale ?? []).length === 0,
  `restarted=${JSON.stringify(res.restarted)} markedStale=${JSON.stringify(res.markedStale)}`,
);

// ── A1 — the fix: after promote the member is its OWN run + notice refreshed ──
console.log('\n#171 A1 — AFTER promote: the member resolves to its OWN run + notice refreshed:');
const postRun = mod.resolveWaveRunId(mod.store.getWorkspace(MEMBER_ID));
check(
  'resolveWaveRunId(member) === the member OWN id after promote (this is what the relaunched env stamps)',
  postRun === MEMBER_ID,
  `got ${postRun} (expected ${MEMBER_ID})`,
);
check('the run flipped (parent OPS run → member own run)', preRun !== postRun);
const postNotice = readMemberNotice();
check(
  'the member notice was REWRITTEN by the reconcile for the member OWN run (delivery=OFF now)',
  postNotice.includes('bus switch delivery=OFF') && !postNotice.includes('bus switch delivery=ON'),
  'the reconcile must writeBusSwitchState for the new anchor so a relaunch reads the right run',
);
check(
  'the notice TRANSITIONED ON→OFF (the frozen flag the agent reads actually changed)',
  preNotice.includes('bus switch delivery=ON') && postNotice.includes('bus switch delivery=OFF'),
  'a promote that left the notice on the OLD run would show delivery=ON both times',
);

// ── A3 — a member spawned AFTER the promote anchors to the OPS's OWN run ──────
// (unchanged invariant: a NEW plain member under the freshly-promoted OPS resolves
// to the OPS run, natively, with no reconcile.)
console.log('\n#171 A3 — a NEW member under the promoted OPS anchors to its run natively:');
const LATE_MEMBER = 'late-member-171';
await mod.store.upsertWorkspace(ws(LATE_MEMBER, { parentId: MEMBER_ID }));
const lateRun = mod.resolveWaveRunId(mod.store.getWorkspace(LATE_MEMBER));
check(
  'a member spawned after promote anchors to the promoted OPS run',
  lateRun === MEMBER_ID,
  `got ${lateRun}`,
);

// ── MUT — must-FAIL: the UNFIXED promote (no reconcile) leaves the stale notice ─
// Reproduce the pre-#171 body on a SECOND member: flip canOrchestrate + start the
// run row (what old promote did), but SKIP the reconcile (no notice rewrite). The
// arm-1 notice assertion must FAIL — proving the reconcile is what makes A1 real.
console.log('\n#171 MUT — must-FAIL: the pre-#171 promote (no reconcile) leaves the stale notice:');
const MEMBER2_ID = 'member2-child-171';
const member2Wt = worktreeFor(MEMBER2_ID);
await mod.store.upsertWorkspace(ws(MEMBER2_ID, { worktreePath: member2Wt, parentId: OPS_ID }));
const pre2Run = mod.resolveWaveRunId(mod.store.getWorkspace(MEMBER2_ID));
await mod.writeBusSwitchState(member2Wt, pre2Run); // spawn-time notice = OPS run
const member2NoticeFile = path.join(member2Wt, '.orchestra', 'bus-switches');
const pre2Notice = fs.readFileSync(member2NoticeFile, 'utf8');
// The UNFIXED promote effect: capability flip + run row, NO reconcile/notice-rewrite.
await mod.store.upsertWorkspace({ ...mod.store.getWorkspace(MEMBER2_ID), canOrchestrate: true });
mod.startRun(busDb, { id: MEMBER2_ID, kind: 'vague', coordinator: MEMBER2_ID }, {
  delivery: true,
  wake: true,
  askGate: true,
  liveness: true,
});
const post2Notice = fs.readFileSync(member2NoticeFile, 'utf8');
// The mutant leaves the notice UNCHANGED (still the OPS run) even though the node's
// resolved run has moved to its own id — the exact #171 stale-env symptom.
const post2Run = mod.resolveWaveRunId(mod.store.getWorkspace(MEMBER2_ID));
const mutantWouldFailArm1 = post2Run === MEMBER2_ID && post2Notice === pre2Notice;
check(
  'the UNFIXED promote leaves the notice on the OLD run while the resolved run moved (arm 1 would FAIL)',
  mutantWouldFailArm1,
  `post2Run=${post2Run} noticeChanged=${post2Notice !== pre2Notice}`,
);
check(
  'and the FIXED promote (member above) DID rewrite the notice — the discriminator between fixed and unfixed',
  postNotice !== preNotice && post2Notice === pre2Notice,
  'if both changed or both stayed, the rig cannot tell the fix from the mutant',
);

mod.closeBus();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
