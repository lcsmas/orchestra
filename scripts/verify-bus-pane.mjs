// T118.4 / T118.5 under REAL Electron — #118, ledger #123.
//
// The unit suite proves the SHAPES (an unavailable snapshot differs from a quiet
// one; the channel table declares only reads). Neither is the shipped claim.
// The shipped claims are behavioural and only exist under Electron, because
// `src/main/bus-pane.ts` imports `electron`, the store and the platform seam:
//
//   T118.5 — with `getBus() === null`, `busSnapshot()` RETURNS the unavailable
//            state rather than throwing, so the pane renders it. Its MUST-PASS
//            counterpart runs in the same process: with a bus open and SEEDED,
//            the same function returns `available: true` and the seeded values.
//            Without that second arm, "returns unavailable" would also be true
//            of a function that returns unavailable unconditionally — a null
//            from an unaudited instrument (carry-forward 4).
//
//   T118.4 — `registerBusPaneIpc()` REFUSES a `writes: true` channel at
//            runtime, and registers exactly the enumerated channels on the real
//            ipcMain.
//
// Boots with `env -i` and NO DISPLAY/WAYLAND_DISPLAY (ledger #123 §Briefing),
// so no window can reach the user's screen.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-pane-electron-118-'));

// The caller MUST hand us a marker-verified headless-sway display. Refusing
// when it is absent is the point: defaulting to the inherited WAYLAND_DISPLAY
// is exactly how a test window reaches the human's screen.
const rigWayland = process.env.RIG_WAYLAND;
if (!rigWayland) {
  console.log(
    'REFUSED: RIG_WAYLAND is unset. This gate boots Electron, which needs a compositor;\n' +
      'run it inside a headless sway (skill: headless-sway-e2e) and pass that display as\n' +
      'RIG_WAYLAND, marker-verified. It will not fall back to the inherited display.',
  );
  process.exit(3);
}
if (process.env.DISPLAY) {
  console.log(`REFUSED: X11 DISPLAY=${process.env.DISPLAY} is set — Electron would fall back to X11 and reach the human's screen.`);
  process.exit(3);
}

let failures = 0;
const report = (label, ok, detail = '') => {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

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

// Bundle the REAL pane module (plus the bits the probe needs to seed a bus) into
// CJS that Electron's main process can require. `electron`, `better-sqlite3` and
// `node-pty` stay external so the probe uses the RUNTIME's own copies — that is
// the point of running under Electron at all (ABI 130, not node's 127).
const entry = path.join(tmp, 'entry.ts');
fs.writeFileSync(
  entry,
  `
export { busSnapshot, registerBusPaneIpc, BUS_PANE_IPC_CHANNELS, registerBusCounterSource } from ${JSON.stringify(path.join(repoRoot, 'src/main/bus-pane.ts'))};
export { initBus, closeBus, getBus, openBus, send, openGate, busPath } from ${JSON.stringify(path.join(repoRoot, 'src/main/bus.ts'))};
export { startRun } from ${JSON.stringify(path.join(repoRoot, 'src/main/bus-runs.ts'))};
export { initPlatform } from ${JSON.stringify(path.join(repoRoot, 'src/main/platform/index.ts'))};
`,
);
const bundle = path.join(repoRoot, 'node_modules', '.cache', 'bus-pane-electron-118.cjs');
fs.mkdirSync(path.dirname(bundle), { recursive: true });
await build({
  entryPoints: [entry],
  outfile: bundle,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  external: ['electron', 'better-sqlite3', 'node-pty'],
  logLevel: 'silent',
});

const outFile = path.join(tmp, 'probe-out.json');
const probe = path.join(tmp, 'probe.cjs');
fs.writeFileSync(
  probe,
  `
const fs = require('node:fs');
const path = require('node:path');
const out = [];
const check = (label, ok, detail) => out.push({ label, ok: !!ok, detail: detail == null ? '' : String(detail) });
const finish = (code) => {
  try { fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify(out)); } catch (e) {}
  require('electron').app.exit(code);
};

(async () => {
  try {
    const { app, ipcMain } = require('electron');
    await app.whenReady();
    const m = require(${JSON.stringify(bundle)});

    m.initPlatform({
      kind: 'rig',
      broadcast: () => {},
      broadcastPtyData: () => {},
      canBroadcast: () => false,
      isFocused: () => false,
      getUserDataDir: () => process.env.ORCHESTRA_HOME,
    });

    // ── ARM 1 (T118.5): the bus is NOT open. getBus() === null. ─────────────
    check('precondition: getBus() is null', m.getBus() === null, String(m.getBus()));
    let down;
    try {
      down = m.busSnapshot(null);
      check('busSnapshot() did NOT throw with the bus down', true);
    } catch (e) {
      check('busSnapshot() did NOT throw with the bus down', false, (e && e.stack) || e);
      return finish(1);
    }
    check('available === false', down.available === false, JSON.stringify(down.available));
    check('carries a diagnosable error', typeof down.error === 'string' && down.error.length > 10, down.error);
    check('carries the bus path', typeof down.path === 'string' && down.path.endsWith('bus.sqlite'), down.path);
    check('no runs/messages leak through', down.runs.length === 0 && down.messages.length === 0);

    // ── ARM 2 (the MUST-PASS control): open + SEED, same function. ──────────
    // Proves arm 1 measured the bus being down, not a function that always
    // says unavailable.
    const version = m.initBus();
    check('bus opened under Electron (constructed, not required)', version >= 1, 'schema v' + version);
    const db = m.getBus();
    check('getBus() is non-null after initBus()', !!db);

    m.startRun(db, { id: 'seeded-run-9931', kind: 'vague', coordinator: 'ops-probe-771', title: 'Seeded 9931' }, { delivery: true, wake: false, askGate: false, liveness: false });
    m.send(db, { runId: 'seeded-run-9931', sender: 'probe-sender-4417', kind: 'status', body: 'probe-body-6653' });
    m.openGate(db, 'seeded-run-9931', 'ops-probe-771', 'probe-gate-question-2208');

    const up = m.busSnapshot('seeded-run-9931');
    check('available === true once the bus is open', up.available === true);
    check('the SEEDED run is present', up.runs.some((r) => r.id === 'seeded-run-9931'));
    check('the SEEDED message body is present', up.messages.some((x) => x.body === 'probe-body-6653'));
    check('the SEEDED gate is present', up.gates.some((g) => g.question === 'probe-gate-question-2208'));
    check('the run carries its FROZEN flags', up.runs.find((r) => r.id === 'seeded-run-9931').flags.delivery === true);
    check(
      'the two arms DIFFER (arm 1 was not a false unavailable)',
      down.available !== up.available,
    );

    // ── ARM 3 (T118.5 again): a bus that is open but has a BROKEN table. ────
    // The catch-all path: a query that throws must become the unavailable
    // state, not a crashed pane.
    db.exec('DROP TABLE messages');
    const broken = m.busSnapshot('seeded-run-9931');
    check('a throwing query yields available:false, not an exception', broken.available === false, JSON.stringify(broken).slice(0, 160));

    // ── ARM 4 (T118.4): the registrar, for real. ────────────────────────────
    const seen = [];
    const origHandle = ipcMain.handle.bind(ipcMain);
    ipcMain.handle = (ch, fn) => { seen.push(ch); return origHandle(ch, fn); };
    m.registerBusPaneIpc();
    const enumerated = m.BUS_PANE_IPC_CHANNELS.map((c) => c.channel).sort();
    check('registers exactly the enumerated channels', JSON.stringify(seen.slice().sort()) === JSON.stringify(enumerated), seen.join(',') + ' vs ' + enumerated.join(','));
    check('every enumerated channel declares writes:false', m.BUS_PANE_IPC_CHANNELS.every((c) => c.writes === false));

    // The MUST-FAIL arm for the registrar: inject a write entry and require the
    // refusal. Without this the "no writers" check is a claim about the table's
    // current contents, not about the guard.
    m.BUS_PANE_IPC_CHANNELS.push({ channel: 'bus:resolveGate', writes: true, what: 'v2 write' });
    let refused = false;
    let refusalMsg = '';
    try { m.registerBusPaneIpc(); } catch (e) { refused = true; refusalMsg = String(e && e.message); }
    check('registerBusPaneIpc REFUSES a writes:true channel', refused, refusalMsg);
    check('the refusal names the offending channel', refusalMsg.includes('bus:resolveGate'), refusalMsg);
    check('the refusal is not registered', !seen.includes('bus:resolveGate'));

    m.closeBus();
    finish(0);
  } catch (e) {
    check('probe threw', false, (e && e.stack) || e);
    finish(1);
  }
})();
`,
);

const electronBin = path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron');
if (!fs.existsSync(electronBin)) {
  console.log(`  FAIL electron binary not found at ${electronBin} — run \`pnpm install\``);
  process.exit(1);
}

// `env -i`: an ALLOWLIST, never `env -u` (containment is an allowlist). No
// DISPLAY, no WAYLAND_DISPLAY — a non-UI Electron gate must not be able to open
// a window on the human's screen even by accident.
let rc = 0;
try {
  execFileSync(
    'env',
    [
      '-i',
      `HOME=${tmp}`,
      `PATH=/usr/bin:/bin`,
      // Electron refuses to start with no compositor at all ("Missing X server
      // or $DISPLAY"), so a display is REQUIRED even for a windowless probe.
      // It must be a headless sway the caller marker-verified as its own —
      // never the human's. RIG_WAYLAND is that display; DISPLAY (X11) stays
      // ABSENT, because Electron falls back to X11 and would reach the human's
      // screen even with a correct WAYLAND_DISPLAY.
      `XDG_RUNTIME_DIR=${process.env.XDG_RUNTIME_DIR || '/run/user/1000'}`,
      `WAYLAND_DISPLAY=${rigWayland}`,
      'ELECTRON_OZONE_PLATFORM_HINT=wayland',
      `ORCHESTRA_HOME=${tmp}`,
      `PROBE_OUT=${outFile}`,
      'ELECTRON_DISABLE_SANDBOX=1',
      electronBin,
      '--no-sandbox',
      probe,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 },
  );
} catch (e) {
  rc = e.status ?? 1;
  if (e.stderr) console.log(String(e.stderr).split('\n').slice(0, 12).join('\n'));
}

if (!fs.existsSync(outFile)) {
  console.log(`  FAIL the probe produced no output (electron rc=${rc}) — nothing was measured`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}
const results = JSON.parse(fs.readFileSync(outFile, 'utf8'));
console.log('\nT118.4 / T118.5 under real Electron (headless, DISPLAY absent):');
// A rig that produced an EMPTY result list would print nothing and exit 0 —
// the tidy zero of a dead collector. Require a floor.
if (results.length < 15) {
  failures++;
  console.log(`  FAIL the probe reported only ${results.length} checks — expected >= 15`);
}
for (const r of results) report(r.label, r.ok, r.detail);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('');
if (failures) {
  console.log(`verify-bus-pane: ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log(`verify-bus-pane: all ${results.length} checks passed`);
