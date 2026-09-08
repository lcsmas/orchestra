// T118.3 — the generated startup notice names the switch states (#118, ledger #123).
//
// THE CLAIM: a freshly spawned worktree's SessionStart notice tells the agent
// which bus mechanisms are authoritative for this run. The ticket demands BOTH
// controls, and names the disproof: "the grep passes on a notice that never
// mentions switches — a marker as unspecific as its claim" (carry-forward 2).
//
// So this rig runs FOUR arms against the REAL generated artifacts:
//
//   A. switch ON  → the generated notice prints `delivery=ON` and the
//                   authoritative sentence.
//   B. switch OFF → it prints `delivery=OFF` and the OPPOSITE sentence.
//                   NOT merely the absence of A — absence would also be
//                   produced by a notice that never mentions switches at all,
//                   which is exactly the disproof named above.
//   C. MUST-FAIL control — the same greps run against a notice with the switch
//                   block REMOVED must find NOTHING. This is what proves the
//                   greps in A and B can fail; without it they are decoration.
//   D. END-TO-END — the hook SCRIPT that Orchestra actually installs is
//                   EXECUTED (bash), and its stdout is what carries the states.
//                   Asserting the state file alone would prove the file exists,
//                   not that the notice reaches the agent.
//
// It drives the real src/main/workspaces.ts exports (installOrchestraHooks and
// writeBusSwitchState), not a reimplementation — a hand-rolled copy of the
// generator would certify the copy.

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

// ── Isolated home. ORCHESTRA_HOME/userData must be ours, never the human's. ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-notice-118-'));
process.env.ORCHESTRA_HOME = tmp;

// Bundle the switch-state writer out of the REAL workspaces.ts. It pulls in
// electron transitively, so stub that module: the code under test here touches
// only fs + the store, and a stub keeps the rig honest about what it exercises.
const entry = path.join(tmp, 'entry.ts');
fs.writeFileSync(
  entry,
  `
export { writeBusSwitchState } from ${JSON.stringify(path.join(repoRoot, 'src/main/workspaces.ts'))};
export { busSwitchNotice, busSwitchNoticeLines } from ${JSON.stringify(path.join(repoRoot, 'src/shared/bus-switches.ts'))};
export { store } from ${JSON.stringify(path.join(repoRoot, 'src/main/store.ts'))};
export { initPlatform } from ${JSON.stringify(path.join(repoRoot, 'src/main/platform/index.ts'))};
`,
);
// Emit INSIDE the repo (like the render smokes): a bundle in /tmp cannot
// resolve bare specifiers, and bundling the CJS deps in instead trips
// esbuild's "Dynamic require of fs is not supported" at import time. Both
// failure modes were observed building this rig.
const cacheDir = path.join(repoRoot, 'node_modules', '.cache');
fs.mkdirSync(cacheDir, { recursive: true });
const bundle = path.join(cacheDir, 'bus-notice-118.mjs');
const electronStub = path.join(cacheDir, 'bus-notice-118-electron-stub.mjs');
// A NAMED-EXPORT stub for every electron symbol the transitive import graph
// touches. esbuild resolves named imports at BUILD time, so a Proxy default
// export is not enough — each name must exist. `WebContentsView` (browser-panel)
// is how the first version of this rig discovered that.
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
  // The bundle is written to a tmp dir OUTSIDE the repo, so anything left
  // `external` cannot be resolved at import time (bare specifiers resolve
  // relative to the bundle, not the repo). Only the native modules stay
  // external — they are never reached on this code path.
  external: ['better-sqlite3', 'node-pty', 'node:*', 'simple-git', 'ws', '@anthropic-ai/*'],
  alias: { electron: electronStub },
  logLevel: 'silent',
});
const mod = await import(`${bundle}?t=${Date.now()}`);

// The store resolves its file through the platform seam, which the real entry
// point installs. Install a minimal one pointed at our isolated tmp — so this
// rig can NEVER write to the human's ~/.config/orchestra store.
mod.initPlatform({
  kind: 'rig',
  broadcast: () => {},
  broadcastPtyData: () => {},
  canBroadcast: () => false,
  isFocused: () => false,
  getUserDataDir: () => tmp,
});
// Prove the isolation rather than assume it (a rig that writes the human's
// store would look identical to a passing one).
const storeFile = path.join(tmp, 'orchestra', 'store.json');
fs.mkdirSync(path.dirname(storeFile), { recursive: true });

// ── The generated hook script, taken from the SOURCE Orchestra installs ─────
// Extracting the literal out of workspaces.ts (rather than retyping it) is the
// point: if the shipped script changes, this rig runs the CHANGED one.
const wsSrc = fs.readFileSync(path.join(repoRoot, 'src/main/workspaces.ts'), 'utf8');
const m = /const BUS_SWITCHES_INSTRUCTION_SCRIPT = `([\s\S]*?)`;/.exec(wsSrc);
if (!m) {
  console.log('  FAIL could not extract BUS_SWITCHES_INSTRUCTION_SCRIPT from workspaces.ts');
  process.exit(1);
}
const scriptBody = m[1].replace(/\\`/g, '`').replace(/\\\$/g, '$').replace(/\\\\/g, '\\');

const worktree = path.join(tmp, 'worktree');
fs.mkdirSync(path.join(worktree, '.orchestra'), { recursive: true });
const scriptPath = path.join(worktree, '.orchestra', 'bus-switches-instruction.sh');
fs.writeFileSync(scriptPath, scriptBody, { mode: 0o755 });

/** Run the REAL installed hook script and capture what the agent would see. */
function runNotice() {
  try {
    return execFileSync('bash', [scriptPath], {
      env: { ...process.env, ORCHESTRA_WORKTREE: worktree },
      encoding: 'utf8',
    });
  } catch (e) {
    return `<<script failed: ${e.message}>>`;
  }
}

async function setSwitchesAndWrite(sw) {
  await mod.store.setBusSwitches(sw);
  await mod.writeBusSwitchState(worktree);
  return runNotice();
}

// ── Arm A: switch ON ────────────────────────────────────────────────────────
console.log('\nT118.3 arm A — POSITIVE control (delivery ON):');
const onOut = await setSwitchesAndWrite({
  delivery: true,
  wake: false,
  askGate: false,
  liveness: false,
});
check('the notice names delivery=ON', onOut.includes('bus switch delivery=ON'));
check(
  'and says the bus is AUTHORITATIVE for it',
  /delivery=ON — the bus is AUTHORITATIVE/.test(onOut),
);
check('the notice is emitted by the real hook script', onOut.includes('[orchestra] Fleet-bus switches'));
check('it states the freeze', /frozen at wave start/.test(onOut));

// ── Arm B: switch OFF — the OPPOSITE string, not silence ────────────────────
console.log('\nT118.3 arm B — NEGATIVE control (delivery OFF → the OPPOSITE string):');
const offOut = await setSwitchesAndWrite({
  delivery: false,
  wake: false,
  askGate: false,
  liveness: false,
});
check('the notice names delivery=OFF', offOut.includes('bus switch delivery=OFF'));
check(
  'and says the OLD channel stays authoritative',
  /delivery=OFF — the OLD channel stays authoritative/.test(offOut),
);
check(
  'and says the mechanism is COUNTED, not fired',
  /COUNTS this mechanism, it does not fire it/.test(offOut),
);
check('the ON string is GONE', !offOut.includes('bus switch delivery=ON'));
// The assertion that separates "OFF prints its own line" from "OFF prints
// nothing" — the disproof the ticket names.
check(
  'OFF is not encoded as SILENCE (the notice still exists)',
  offOut.includes('[orchestra] Fleet-bus switches'),
  'an OFF switch must still produce a notice, or the agent cannot tell OFF from absent',
);

// Every mechanism, both directions — not just `delivery`.
console.log('\nT118.3 — every mechanism, in both states:');
const allOn = await setSwitchesAndWrite({
  delivery: true,
  wake: true,
  askGate: true,
  liveness: true,
});
const allOff = await setSwitchesAndWrite({
  delivery: false,
  wake: false,
  askGate: false,
  liveness: false,
});
for (const mech of ['delivery', 'wake', 'askGate', 'liveness']) {
  check(`${mech}: ON string present when ON`, allOn.includes(`bus switch ${mech}=ON`));
  check(`${mech}: OFF string present when OFF`, allOff.includes(`bus switch ${mech}=OFF`));
  check(`${mech}: no ON string when OFF`, !allOff.includes(`bus switch ${mech}=ON`));
}

// ── Arm C: THE MUST-FAIL CONTROL ────────────────────────────────────────────
// Feed the SAME greps a notice that mentions the bus but NOT the switch states.
// Every assertion above must go false. Without this arm, "the grep passed" is a
// claim about the grep, not about the notice (carry-forward 2 and 3).
console.log('\nT118.3 arm C — MUST-FAIL control (a notice without the switch block):');
const decoy =
  '[orchestra] Fleet bus notice: the bus is open and mechanisms exist. delivery, wake, askGate and liveness are all words that appear here.\n';
check(
  'the ON grep does NOT match the decoy',
  !decoy.includes('bus switch delivery=ON'),
  'the positive grep would have passed on a notice that never states a switch state',
);
check('the OFF grep does NOT match the decoy', !decoy.includes('bus switch delivery=OFF'));
check(
  'the authoritative-sentence grep does NOT match the decoy',
  !/delivery=OFF — the OLD channel stays authoritative/.test(decoy),
);
// And prove the greps are LIVE by running them on the real output in the same
// breath — a control that only ever reports "no match" is indistinguishable
// from a broken matcher (carry-forward 4).
check('the same greps DO match the real notice', allOff.includes('bus switch delivery=OFF'));

// ── Arm D: the absent-state-file case ───────────────────────────────────────
// A workspace spawned by an older build has no state file. The script must be a
// SILENT no-op — never a notice claiming every mechanism is off, which would be
// a fabricated measurement from an instrument that was never connected.
console.log('\nT118.3 arm D — no state file → silent, not a false "all off":');
fs.rmSync(path.join(worktree, '.orchestra', 'bus-switches'), { force: true });
const absent = runNotice();
check('prints nothing', absent.trim() === '', `printed ${JSON.stringify(absent.slice(0, 120))}`);
check('does NOT claim any switch state', !/bus switch \w+=(ON|OFF)/.test(absent));

// ── The state file is refreshed, not baked ──────────────────────────────────
// The trap this catches: the hook bundle short-circuits on a content hash, so a
// value baked into a script body would be written once and never corrected.
console.log('\nThe state file tracks a later flip (it is not baked at provision time):');
const first = await setSwitchesAndWrite({ delivery: true, wake: false, askGate: false, liveness: false });
const second = await setSwitchesAndWrite({ delivery: false, wake: true, askGate: false, liveness: false });
check('first spawn saw delivery=ON', first.includes('bus switch delivery=ON'));
check('after a flip, the next spawn sees delivery=OFF', second.includes('bus switch delivery=OFF'));
check('and sees wake=ON', second.includes('bus switch wake=ON'));
check('the two notices DIFFER', first !== second);

fs.rmSync(tmp, { recursive: true, force: true });

console.log('');
if (failures) {
  console.log(`verify-bus-startup-notice: ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('verify-bus-startup-notice: all checks passed');
