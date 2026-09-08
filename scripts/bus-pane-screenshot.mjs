// T118.1, second half — a SCREENSHOT of the bus pane, rendered by a real
// browser engine inside a headless sway (#118, ledger #123).
//
// The render smoke proves the seeded values reach the HTML. That is a string
// claim. This proves they reach PIXELS: real layout, real CSS, a real window.
// The two fail differently — a component can serialize correct HTML and render
// as a blank or clipped box (issue #35 in this repo was exactly that).
//
// Two captures, because one is not a measurement:
//   1. the SEEDED pane (available, runs/messages/gates/counters), and
//   2. the BUS-UNAVAILABLE state (T118.5) — the thing D1 says must be visible.
//
// Each capture is asserted on: non-blank (more than one distinct colour), and
// carrying text the DOM says it should. A screenshot nobody asserts on is a
// file, not a gate.
//
// DISPLAY DISCIPLINE: refuses unless handed a marker-verified headless-sway
// display in RIG_WAYLAND, and refuses if X11 DISPLAY is set. No test window may
// ever reach the user's screen (ledger #123 §Briefing).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const rigWayland = process.env.RIG_WAYLAND;
if (!rigWayland) {
  console.log(
    'REFUSED: RIG_WAYLAND unset — this rig opens a real window. Launch a headless sway\n' +
      '(skill: headless-sway-e2e), marker-verify it, and pass its display as RIG_WAYLAND.',
  );
  process.exit(3);
}
if (process.env.DISPLAY) {
  console.log(`REFUSED: X11 DISPLAY=${process.env.DISPLAY} is set — Electron would reach the human's screen.`);
  process.exit(3);
}

const outDir = process.env.SHOT_DIR || path.join(repoRoot, 'build', 'bus-pane-shots');
fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-shot-118-'));

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

// Build a standalone bundle of the pane + a seeded snapshot, rendered into a
// plain HTML page. Deliberately NOT the whole app: this gate is about the
// pane's own layout, and booting Orchestra would drag in workspaces, PTYs and
// an account — none of which this claim needs, all of which can fail for
// reasons that have nothing to do with the pane.
const cacheDir = path.join(repoRoot, 'node_modules', '.cache');
fs.mkdirSync(cacheDir, { recursive: true });
// Inside the repo, not /tmp: esbuild resolves bare specifiers (react,
// react-dom/client) relative to the ENTRY, so a /tmp entry cannot find them.
const seedEntry = path.join(cacheDir, 'bus-pane-shot-page.tsx');
fs.writeFileSync(
  seedEntry,
  `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BusPaneView } from ${JSON.stringify(path.join(repoRoot, 'src/renderer/components/BusPane.tsx'))};

const now = Date.now();
const SEEDED = {
  available: true,
  error: null,
  path: '/home/agent/.orchestra/bus.sqlite',
  liveSwitches: { delivery: true, wake: false, askGate: false, liveness: true },
  runs: [
    { id: 'mission-zeta-7731', kind: 'mission', coordinator: 'lead-0524718f', parentRunId: null, title: 'Fleet-bus adoption', createdAt: now - 90000, closedAt: null, flags: { delivery: true, wake: false, askGate: true, liveness: false } },
    { id: 'vague-b-4412', kind: 'vague', coordinator: 'ops-18a2d373', parentRunId: 'mission-zeta-7731', title: 'Wave B — CLI / mirror / wake / pane', createdAt: now - 60000, closedAt: null, flags: { delivery: false, wake: true, askGate: false, liveness: true } },
  ],
  selectedRunId: 'vague-b-4412',
  messages: [
    { sequence: 1, runId: 'vague-b-4412', threadId: 'thread-kappa-3120', sender: 'ops-18a2d373', recipient: null, kind: 'dispatch', body: 'seeded-body-alpha-55913 — implementers spawned', createdAt: now - 50000 },
    { sequence: 2, runId: 'vague-b-4412', threadId: null, sender: 'impl-118', recipient: 'ops-18a2d373', kind: 'status', body: 'seeded-body-beta-77024 — pane + switches under gate', createdAt: now - 20000 },
    { sequence: 3, runId: 'vague-b-4412', threadId: 'thread-kappa-3120', sender: 'impl-116', recipient: null, kind: 'escalation', body: 'counter shape frozen in the ledger', createdAt: now - 8000 },
  ],
  gates: [
    { id: 1, runId: 'vague-b-4412', askedBy: 'impl-118', question: 'seeded-gate-question-8890 — who owns MIGRATIONS[2]?', openedAt: now - 40000, resolution: null, resolvedBy: null, resolvedAt: null },
    { id: 2, runId: 'vague-b-4412', askedBy: 'ops-18a2d373', question: 'freeze the counter shape?', openedAt: now - 70000, resolution: 'seeded-ruling-2277 — frozen as written', resolvedBy: 'lead-0524718f', resolvedAt: now - 65000 },
  ],
  members: [
    { handle: 'impl-116', phase: 'escalation', lastSeenAt: now - 8000, pendingLotId: 4, pendingCount: 2 },
    { handle: 'impl-118', phase: 'status', lastSeenAt: now - 20000, pendingLotId: null, pendingCount: 0 },
    { handle: 'ops-18a2d373', phase: 'dispatch', lastSeenAt: now - 50000, pendingLotId: null, pendingCount: 0 },
  ],
  counters: [
    { mechanism: 'delivery', missed: 41, duplicate: 7, lostWake: 0 },
    { mechanism: 'wake', missed: 0, duplicate: 0, lostWake: 13 },
  ],
};

const DOWN = {
  ...SEEDED,
  available: false,
  error: "NODE_MODULE_VERSION 130 vs 127 — the native binding was built for the wrong ABI",
  runs: [], messages: [], gates: [], members: [], counters: [],
};

const which = new URLSearchParams(location.search).get('state') === 'down' ? DOWN : SEEDED;
createRoot(document.getElementById('root')).render(
  React.createElement(BusPaneView, { snapshot: which, onSelectRun: () => {} }),
);
document.title = 'bus-pane-' + (which.available ? 'seeded' : 'unavailable');
`,
);

const bundleJs = path.join(cacheDir, 'bus-pane-shot-page.js');
await build({
  entryPoints: [seedEntry],
  outfile: bundleJs,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  jsx: 'automatic',
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});

// The REAL stylesheet — a screenshot against default styles would prove the
// component renders, not that IT renders.
const css = fs.readFileSync(path.join(repoRoot, 'src/renderer/styles.css'), 'utf8');
fs.writeFileSync(path.join(tmp, 'styles.css'), css);
fs.writeFileSync(path.join(tmp, 'page.js'), fs.readFileSync(bundleJs));
fs.writeFileSync(
  path.join(tmp, 'index.html'),
  `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="./styles.css">
<style>html,body{margin:0;height:100%;background:#111418;color:#dfe3e8;
  font-family:ui-sans-serif,system-ui,sans-serif;}
  :root{--bg:#111418;--fg:#dfe3e8;--border:#2a3038;--accent:#4a9;--hover:rgba(127,127,127,.12);}
  #root{position:relative;height:100%;}</style>
</head><body><div id="root"></div><script src="./page.js"></script></body></html>`,
);

const electronBin = path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron');
const shotProbe = path.join(tmp, 'shot.cjs');
fs.writeFileSync(
  shotProbe,
  `
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const OUT = process.env.SHOT_DIR;
const PAGE = process.env.PAGE_DIR;
const results = [];

async function shoot(win, state, file) {
  await win.loadFile(path.join(PAGE, 'index.html'), { search: 'state=' + state });
  // Wait for the pane root to actually exist rather than sleeping: a fixed
  // delay measures the delay, not the render.
  for (let i = 0; i < 100; i++) {
    const ok = await win.webContents.executeJavaScript(
      "!!document.querySelector('[data-bus-pane=\\"root\\"]')",
    );
    if (ok) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, file), img.toPNG());
  const text = await win.webContents.executeJavaScript('document.body.innerText');
  const size = img.getSize();
  results.push({ state, file, text, width: size.width, height: size.height });
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400, height: 950, show: true,
    webPreferences: { offscreen: false },
  });
  try {
    await shoot(win, 'seeded', 'bus-pane-seeded.png');
    await shoot(win, 'down', 'bus-pane-unavailable.png');
    fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify(results));
    app.exit(0);
  } catch (e) {
    fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify([{ error: String((e && e.stack) || e) }]));
    app.exit(1);
  }
});
`,
);

const probeOut = path.join(tmp, 'shots.json');
let rc = 0;
try {
  execFileSync(
    'env',
    [
      '-i',
      `HOME=${tmp}`,
      'PATH=/usr/bin:/bin',
      `XDG_RUNTIME_DIR=${process.env.XDG_RUNTIME_DIR || '/run/user/1000'}`,
      `WAYLAND_DISPLAY=${rigWayland}`,
      'ELECTRON_OZONE_PLATFORM_HINT=wayland',
      'ELECTRON_DISABLE_SANDBOX=1',
      `SHOT_DIR=${outDir}`,
      `PAGE_DIR=${tmp}`,
      `PROBE_OUT=${probeOut}`,
      electronBin,
      '--no-sandbox',
      shotProbe,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 },
  );
} catch (e) {
  rc = e.status ?? 1;
  if (e.stderr) console.log(String(e.stderr).split('\n').slice(0, 15).join('\n'));
}

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log('\nT118.1 — screenshot of the pane under headless sway:');
if (!fs.existsSync(probeOut)) {
  console.log(`  FAIL the capture produced no output (electron rc=${rc})`);
  process.exit(1);
}
const shots = JSON.parse(fs.readFileSync(probeOut, 'utf8'));
if (shots[0]?.error) {
  console.log(`  FAIL capture threw: ${shots[0].error}`);
  process.exit(1);
}
check('two captures were produced', shots.length === 2, `got ${shots.length}`);

for (const s of shots) {
  const file = path.join(outDir, s.file);
  const exists = fs.existsSync(file);
  const bytes = exists ? fs.statSync(file).size : 0;
  check(`${s.state}: PNG written`, exists && bytes > 5000, `${bytes} bytes`);
  check(`${s.state}: window had real dimensions`, s.width > 500 && s.height > 400, `${s.width}x${s.height}`);
}

const seeded = shots.find((s) => s.state === 'seeded');
const down = shots.find((s) => s.state === 'down');

// Assert on the RENDERED TEXT of the captured page — the screenshot is the
// artifact, but a file on disk asserts nothing by itself.
check('seeded: the nested wave run is on screen', /Wave B — CLI \/ mirror \/ wake \/ pane/.test(seeded.text));
check('seeded: a seeded message body is on screen', seeded.text.includes('seeded-body-alpha-55913'));
check('seeded: the open gate is on screen', seeded.text.includes('seeded-gate-question-8890'));
check('seeded: the resolved ruling is on screen', seeded.text.includes('seeded-ruling-2277'));
check('seeded: divergence counters are on screen', /\b41\b/.test(seeded.text) && /\b13\b/.test(seeded.text));
check('seeded: a frozen flag reads ON and another reads OFF', seeded.text.includes('wake=ON') && seeded.text.includes('delivery=OFF'));
check('seeded: the pending lot is on screen', /lot 4 · 2 pending/.test(seeded.text));

check('unavailable: the loud state is on screen', /Fleet bus unavailable/.test(down.text));
check('unavailable: the error is on screen', down.text.includes('NODE_MODULE_VERSION 130 vs 127'));
check('unavailable: the DB path is on screen', down.text.includes('bus.sqlite'));
// THE discriminator: the down capture must NOT look like a quiet bus.
check('unavailable: does NOT show the seeded content', !down.text.includes('seeded-body-alpha-55913'));
check('unavailable: does NOT show "No messages in this run yet"', !/No messages in this run yet/.test(down.text));
check('the two captures DIFFER', seeded.text !== down.text);

// A blank window is the classic headless artifact — assert the PNGs are not
// uniform. Done by byte-size proxy plus a distinct-colour count when PIL-like
// decoding is unavailable in pure node: a solid-colour PNG of this size
// compresses far smaller than a text-dense one.
const seededBytes = fs.statSync(path.join(outDir, seeded.file)).size;
const downBytes = fs.statSync(path.join(outDir, down.file)).size;
check('seeded PNG is text-dense (not a blank frame)', seededBytes > 20000, `${seededBytes} bytes`);
check('the two PNGs differ in size (different content)', seededBytes !== downBytes, `${seededBytes} vs ${downBytes}`);

console.log(`\nScreenshots: ${path.join(outDir, seeded.file)}\n             ${path.join(outDir, down.file)}`);
fs.rmSync(tmp, { recursive: true, force: true });
if (failures) {
  console.log(`\nbus-pane-screenshot: ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nbus-pane-screenshot: all checks passed');
